// The tools the hub gives a bot in its owner's chats: look at the computers joined to the hub, run a command on one,
// and follow or stop what runs. They are plain objects (name, description, JSON-Schema parameters, run), so any brain
// can offer them to its model: the DSH plugin turns them into DSH tools (plugin/brain.js), the echo brain calls them
// itself.
//
// Running a command asks first, by the computer's policy on the hub (ask, always, never: Settings on the page), and
// then the computer's own policy has the last word (node-agent.js). Only owners' chats get these tools: the computers
// are the owner's.

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
        const node = pick(args.computer)
        if (!nodes.online(node.id)) throw new Error(`${node.name} is offline. It has to be on, with DSH (or dsh-hub node) running.`)
        if (node.policy === 'never') throw new Error(`The owner has switched off running commands on ${node.name}.`)
        if (node.policy !== 'always') {
          const decision = await hub.ask({
            chat, user, bot, signal, node,
            title: `Run on ${node.name}?`,
            summary: args.why || `Run a command on ${node.name}`,
            detail: args.command,
            meta: [args.shell && `shell: ${args.shell}`, args.cwd && `in: ${args.cwd}`].filter(Boolean).join(' · '),
            always: `Always allow on ${node.name}`,
          })
          if (decision === 'always') nodes.update(node.id, { policy: 'always' })
          else if (decision !== 'approved') {
            return { ran: false, reason: decision === 'denied' ? 'The owner denied it. Do not try again unless they ask.' :
              decision === 'expired' ? 'Nobody answered in time.' : 'It was cancelled.' }
          }
        }
        const job = await nodes.run({ node, command: args.command, cwd: args.cwd, shell: args.shell, by: user.name, chat: chat.id })
        hub.jobCard(chat, job, bot)
        await job.wait(Math.min(MAX_WAIT, args.wait_seconds ?? WAIT), signal)
        const answer = result(job)
        if (!job.done) answer.note = `Still running as job ${job.id}. Check it with computer_job, or tell the owner it runs on.`
        return answer
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
  if (name === 'computer_job') return args.job ? `checking job ${args.job}` : 'looking at the jobs'
  if (name === 'computer_job_cancel') return `stopping job ${args.job ?? ''}`.trim()
  return `using ${name}`
}
