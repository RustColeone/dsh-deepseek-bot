// How a chat message reads to a bot's model, wherever the bot runs (the hub, or a computer of its own).

/**
 * What the message says, with what others said since this bot last spoke (group chats), who else is in the chat
 * (`others`: the other bots' names), and its attachments.
 */
export function messageText ({ message, context, solo, others = [] }) {
  let text = message.text
  if (context.length) {
    text = `[Said in this chat since you last spoke]\n${context.map(line => `${line.who}: ${line.text}`).join('\n')}\n\n` +
      `[Now, ${message.sender}]\n${text}`
  } else if (!solo) {
    text = `${message.sender}: ${text}`
  }
  if (!solo && others.length) text = `[Also in this chat: ${others.join(', ')}]
${text}`
  for (const file of message.files || []) {
    text += `\n[Attached: ${file.name} (${file.mime}, ${Math.max(1, Math.round(file.size / 1024))} KB), ` +
      (file.local ? `on this computer at ${file.local}]` : `hub file id ${file.id}]`)
  }
  return text
}
