// A brain with no model, for trying the hub out without DSH or an API key: two bots that answer by rule.
//
//   computers                     lists the computers (computers_list)
//   run <computer>: <command>     runs a command there, asking you first (computer_run)
//   send to <computer>            with files attached: copies them to that computer's inbox (computer_send_file)
//   get <computer>: <path>        brings a file from there into the chat (computer_get_file)
//   job <id>                      how a job is going (computer_job)
//   anything else                 is said back, a word at a time, so the page's streaming shows
//
// In a chat with both bots, @Echo or @Parrot picks who answers; "everyone" asks both.
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('stopped')) }, { once: true })
})

export function echoBrain () {
  const bots = [
    { name: 'echo', display: 'Echo', description: 'Says back what you say, and runs commands on your computers.' },
    { name: 'parrot', display: 'Parrot', description: 'Says it back too, louder.' },
  ]
  return {
    bots: () => bots,
    async reply ({ bot, message, context, tools, sink, signal }) {
      const text = message.text.replace(/@\w+/g, '').trim()
      const tool = name => tools.find(item => item.name === name)
      const use = async (name, args) => {
        if (!tool(name)) return 'Only an owner\'s chats can use the computers.'
        sink.activity(`using ${name}`)
        try { return '```json\n' + JSON.stringify(await tool(name).run(args, signal), null, 2) + '\n```' } catch (error) { return `⚠️ ${error.message}` }
      }
      let match
      if (/^computers?$/i.test(text)) return use('computers_list', {})
      if ((match = /^run\s+([^:]+):\s*([\s\S]+)$/i.exec(text))) {
        return use('computer_run', { computer: match[1].trim(), command: match[2].trim(), why: 'You asked the echo bot to run it.' })
      }
      if ((match = /^send\s+(?:it\s+|this\s+)?to\s+(.+)$/i.exec(text))) {
        if (!message.files?.length) return 'Attach the file to send with that message.'
        const said = []
        for (const file of message.files) {
          said.push(await use('computer_send_file', { computer: match[1].trim(), file: file.id, why: 'You asked the echo bot to send it.' }))
        }
        return said.join('\n\n')
      }
      if ((match = /^get\s+([^:]+):\s*(.+)$/i.exec(text))) {
        return use('computer_get_file', { computer: match[1].trim(), path: match[2].trim(), why: 'You asked the echo bot for it.' })
      }
      if ((match = /^job\s+(j[0-9a-f]+)$/i.exec(text))) return use('computer_job', { job: match[1] })
      const heard = context.length ? `(I also heard ${context.length} other message${context.length > 1 ? 's' : ''}.) ` : ''
      const words = `${heard}${bot === 'parrot' ? text.toUpperCase() + '!' : text}`.split(/(\s+)/)
      let said = ''
      for (const word of words) {
        said += word
        sink.stream(said)
        await sleep(25, signal)
      }
      return { text: said || '…', data: { model: 'echo' } }
    },
    forget () {},
    close () {},
  }
}
