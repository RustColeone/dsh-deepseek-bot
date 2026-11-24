// The tools the hub gives a bot in its owner's chats: look at the computers joined to the hub, run a command on one,
// move files between the hub and a computer, and follow or stop what runs. They are plain objects (name, description, JSON-Schema parameters, run), so any brain
// can offer them to its model: the DSH plugin turns them into DSH tools (plugin/brain.js), the echo brain calls them
// itself.
//
// Running a command or moving a file asks first, by the computer's policy on the hub (ask, always, never: Settings on
// the page), and then the computer's own policy has the last word (node-agent.js). Only owners' chats get these
// tools: the computers are the owner's.
import { megabytes } from './nodes.js'

const WAIT = 20 // seconds computer_run waits for a command to finish before leaving it running as a job
const MAX_WAIT = 120

function summary (node) {
  const info = node.info || {}
  const gpus = (info.gpus || []).map(gpu => gpu.name + (gpu.memoryMB ? ` (${Math.round(gpu.memoryMB / 1024)} GB)` : '')).join(', ')
  return {
    name: node.name, online: node.online, policy: node.policy, running_jobs: node.running,
    system: [info.os || info.platform, info.arch].filter(Boolean).join(' '), hostname: info.hostname,
    cpu: info.cpu ? `${info.cpu} (${info.cores} threads)` : undefined, memory_gb: info.memoryGB,
    gpus: gpus || undefined, shell: info.shell, home: info.home, tools: Object.keys(info.tools || {}),
  }
}

/** The tools for one chat of one account. `hub` gives approvals, job cards and the nodes. */
export function computerTools (hub, { chat, user, bot } = {}) {
  const nodes = hub?.nodes
  const pick = name => {
    const node = nodes.find(name)
    if (!node) {
      const known = nodes.list().map(item => item.name)
      throw new Error(known.length ? `No computer is called "${name}". The computers are: ${known.join(', ')}.`
        : 'No computer has joined this hub yet. The owner can add one on the page: Computers, Add a computer.')
    }
    return node
  }
  const result = (job, characters = 6000) => job.view(characters)
  const usable = name => {
    const node = pick(name)
    if (!nodes.online(node.id)) throw new Error(`${node.name} is offline. It has to be on, with DSH (or dsh-hub node) running.`)
    if (node.policy === 'never') throw new Error(`The owner has switched off bots using ${node.name}.`)
    return node
  }
  /** Ask the owner unless the computer's policy is always. Returns null when allowed, else why not (for the model). */
  const permit = async (node, card, signal) => {
    if (node.policy === 'always') return null
    const decision = await hub.ask({ chat, user, bot, signal, node, always: `Always allow on ${node.name}`, ...card })
    if (decision === 'always') nodes.update(node.id, { policy: 'always' })
    if (decision === 'approved' || decision === 'always') return null
    return { ran: false, reason: decision === 'denied' ? 'The owner denied it. Do not try again unless they ask.' :
      decision === 'expired' ? 'Nobody answered in time.' : 'It was cancelled.' }
  }
  const follow = async (job, seconds, signal, note) => {
    hub.jobCard(chat, job, bot)
    await job.wait(Math.min(MAX_WAIT, seconds), signal)
    const answer = result(job)
    if (!job.done) answer.note = note
    return answer
  }
  const by = { by: user?.name, owner: user?.id, chat: chat?.id, bot }

  return [
    {
      name: 'computers_list',
      description: 'List the computers joined to this hub: which are online, their system, processor, memory, GPUs, ' +
        'the tools found on them (ffmpeg, video2x, python…) and how many jobs run on each. Use it to choose a computer.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run () {
        return { computers: nodes.list().map(summary) }
      },
    },
    {
      name: 'computer_run',
      description: 'Run a shell command on one of the computers (PowerShell on Windows unless shell says otherwise, ' +
        'bash elsewhere). The owner may be asked to approve it first. Waits up to wait_seconds for it to finish; a ' +
        'longer command keeps running as a job: follow it with computer_job, stop it with computer_job_cancel. ' +
        'Its output is shown to the owner in the chat as it runs.',
      parameters: {
        type: 'object',
        properties: {
          computer: { type: 'string', description: 'The computer\'s name, as computers_list gives it.' },
          command: { type: 'string', description: 'The command line to run.' },
          why: { type: 'string', description: 'One short sentence for the owner: what this does and why.' },
          shell: { type: 'string', enum: ['powershell', 'pwsh', 'cmd', 'bash', 'sh'], description: 'Optional: the shell.' },
          cwd: { type: 'string', description: 'Optional: the folder on that computer to run it in (default: its home folder).' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT, description: `Optional: how long to wait (default ${WAIT}).` },
        },
        required: ['computer', 'command'],
        additionalProperties: false,
      },
      async run (args, signal) {
        const node = usable(args.computer)
        const refused = await permit(node, {
          title: `Run on ${node.name}?`,
          summary: args.why || `Run a command on ${node.name}`,
          detail: args.command,
          meta: [args.shell && `shell: ${args.shell}`, args.cwd && `in: ${args.cwd}`].filter(Boolean).join(' · '),
        }, signal)
        if (refused) return refused
        const job = await nodes.run({ node, command: args.command, cwd: args.cwd, shell: args.shell, ...by })
        return follow(job, args.wait_seconds ?? WAIT, signal,
          `Still running as job ${job.id}. Check it with computer_job, or tell the owner it runs on.`)
      },
    },
    {
      name: 'computer_send_file',
      description: 'Copy a file kept on the hub (one attached in this chat, or one brought back with computer_get_file) ' +
        'to one of the computers, into its inbox folder. The result\'s result.path is where it is on that computer: use ' +
        'that path in computer_run. A big file keeps copying as a job (follow it with computer_job). The owner may be ' +
        'asked to approve it first.',
      parameters: {
        type: 'object',
        properties: {
          computer: { type: 'string', description: 'The computer\'s name, as computers_list gives it.' },
          file: { type: 'string', description: 'The hub file id (f…), as given with the attachment.' },
          why: { type: 'string', description: 'One short sentence for the owner: what the file is for there.' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT, description: 'Optional: how long to wait for the copy (default 60).' },
        },
        required: ['computer', 'file'],
        additionalProperties: false,
      },
      async run (args, signal) {
        const node = usable(args.computer)
        const file = hub.store.file(String(args.file || ''))
        if (!file || file.owner !== user.id) throw new Error(`No file ${args.file} on the hub (use the id given with the attachment).`)
        const refused = await permit(node, {
          title: `Send a file to ${node.name}?`,
          summary: args.why || `Copy ${file.name} to ${node.name}`,
          detail: `${file.name} (${megabytes(file.size)}) → ${node.name}'s inbox`,
        }, signal)
        if (refused) return refused
        const job = await nodes.send({ node, file, ...by })
        return follow(job, args.wait_seconds ?? 60, signal,
          `Still copying as job ${job.id}. Wait for it with computer_job before using the file there.`)
      },
    },
    {
      name: 'computer_get_file',
      description: 'Bring a file from one of the computers to the hub and post it in this chat, so the owner can open ' +
        'it here (a video plays in the chat). The result gives its hub file id, for computer_send_file to another ' +
        'computer. A folder has to be zipped first. A big file keeps coming as a job; it is posted when it arrives. ' +
        'The owner may be asked to approve it first.',
      parameters: {
        type: 'object',
        properties: {
          computer: { type: 'string', description: 'The computer\'s name, as computers_list gives it.' },
          path: { type: 'string', description: 'The file\'s path on that computer (absolute, or from its home folder).' },
          why: { type: 'string', description: 'One short sentence for the owner: what the file is.' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT, description: 'Optional: how long to wait for it (default 60).' },
        },
        required: ['computer', 'path'],
        additionalProperties: false,
      },
      async run (args, signal) {
        const node = usable(args.computer)
        const refused = await permit(node, {
          title: `Bring a file from ${node.name}?`,
          summary: args.why || `Copy a file from ${node.name} to this chat`,
          detail: `${node.name}: ${args.path}`,
        }, signal)
        if (refused) return refused
        const job = await nodes.fetch({ node, path: String(args.path), limit: hub.maxUploadMB * 1024 * 1024, ...by })
        return follow(job, args.wait_seconds ?? 60, signal,
          `Still coming as job ${job.id}; it is posted in the chat when it arrives.`)
      },
    },
    {
      name: 'computer_job',
      description: 'How a job started with computer_run is going: its status, exit code and the end of its output. ' +
        'Can wait for it a while first. Without job, lists the jobs of this hub (running ones first).',
      parameters: {
        type: 'object',
        properties: {
          job: { type: 'string', description: 'The job id (j…).' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT, description: 'Optional: wait up to this long for it to end.' },
          output_chars: { type: 'integer', minimum: 0, maximum: 50000, description: 'Optional: how much of the output\'s end to read (default 6000).' },
        },
        additionalProperties: false,
      },
      async run (args, signal) {
        if (!args.job) {
          const jobs = nodes.jobList().slice(0, 30).sort((one, other) => Number(one.done) - Number(other.done))
          return { jobs: jobs.map(job => job.view()) }
        }
        const job = nodes.job(args.job)
        if (!job) throw new Error(`No job ${args.job} (the hub forgets old jobs, and all jobs when it restarts).`)
        if (args.wait_seconds) await job.wait(args.wait_seconds, signal)
        return result(job, args.output_chars ?? 6000)
      },
    },
    {
      name: 'computer_job_cancel',
      description: 'Stop a running job (and everything it started) on its computer.',
      parameters: {
        type: 'object',
        properties: { job: { type: 'string', description: 'The job id (j…).' } },
        required: ['job'],
        additionalProperties: false,
      },
      async run (args) {
        const job = nodes.job(args.job)
        if (!job) throw new Error(`No job ${args.job}.`)
        await nodes.cancel(job.id)
        await job.wait(10)
        return result(job, 2000)
      },
    },
  ]
}

/** One line for the page saying what a bot is doing with a tool. */
export function activity (name, args = {}) {
  if (name === 'computers_list') return 'looking at the computers'
  if (name === 'computer_run') return `running a command on ${args.computer ?? 'a computer'}`
  if (name === 'computer_send_file') return `sending a file to ${args.computer ?? 'a computer'}`
  if (name === 'computer_get_file') return `bringing a file from ${args.computer ?? 'a computer'}`
  if (name === 'computer_job') return args.job ? `checking job ${args.job}` : 'looking at the jobs'
  if (name === 'computer_job_cancel') return `stopping job ${args.job ?? ''}`.trim()
  return `using ${name}`
}
