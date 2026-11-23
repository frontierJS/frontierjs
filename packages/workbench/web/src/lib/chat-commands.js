// web/src/lib/chat-commands.js -- the composer's slash commands, ported from serpgrid's.
//
// A command is the composer's, run in the browser through the verbs lib/chat.js already
// has: a name, what it takes, one line of help and a run. `/` as the box's first character
// opens the list (`commandAt`); Enter runs what is typed (`runCommand`). A command's answer
// is for its sender alone, a line under the box and never a post: `{ text, tone, keep? }`,
// where `keep` leaves the typed text in the box because the command could not act.
// A word that names no command is sent as text, and `//` sends a message that begins with `/`.
// Nothing here is a permission boundary: each run is a call the server grades.

import { goto } from '@frontierjs/sierra/router'
import { isEmoji, glyphOf } from './emoji.js'
import { leaveChannel, setCustomStatus, setMuted, setStatus, STATUS } from './chat.js'

const ago = (n, unit) => new Date(Date.now() + n * (unit === 'h' ? 3_600_000 : 60_000))

const presence = (name) => ({
  name, takes: name === 'dnd' ? '[2h]' : '', help: name === 'dnd' ? 'Do not disturb, for a time if you give one: /dnd 2h' : `Set your status to ${STATUS[name].label}`,
  async run(rest) {
    const m = /^(\d+)\s*(m|h)\b/i.exec(rest.trim())
    if (name === 'dnd' && rest.trim() && !m) return { keep: true, tone: 'warning', text: 'Say how long as minutes or hours: /dnd 30m, /dnd 2h.' }
    await setStatus(name, name === 'dnd' && m ? ago(Number(m[1]), m[2].toLowerCase()) : null)
    return { tone: 'success', text: `You are ${STATUS[name].label}${name === 'dnd' && m ? ` for ${m[1]}${m[2].toLowerCase()}` : ''}.` }
  },
})

export const COMMANDS = [
  presence('away'), presence('online'), presence('dnd'), presence('offline'),
  {
    name: 'status', takes: '[:emoji:] [text]', help: 'Set your status line; /status alone clears it',
    async run(rest) {
      const words = rest.trim().split(/\s+/).filter(Boolean)
      const named = /^:([a-z0-9_+-]+):$/i.exec(words[0] ?? '')
      if (named && !isEmoji(named[1])) return { keep: true, tone: 'warning', text: `No emoji called :${named[1]}:.` }
      const emoji = named ? named[1] : ''
      if (named) words.shift()
      const text = words.join(' ').slice(0, 100)
      await setCustomStatus({ emoji, text, expiresAt: null })
      return { tone: 'success', text: emoji || text ? `Status set: ${[emoji ? glyphOf(emoji) : '', text].filter(Boolean).join(' ')}` : 'Status cleared.' }
    },
  },
  {
    name: 'mute', takes: '', help: 'Mute this room',
    async run(_rest, ctx) {
      if (!ctx.membership) return { keep: true, tone: 'warning', text: 'You are not in this room.' }
      if (ctx.membership.muted) return { tone: 'info', text: 'This room is already muted.' }
      await setMuted(ctx.channelId, true)
      return { tone: 'success', text: 'Muted. Its count stays off the rail; a mention still reaches you.' }
    },
  },
  {
    name: 'unmute', takes: '', help: 'Unmute this room',
    async run(_rest, ctx) {
      if (!ctx.membership?.muted) return { tone: 'info', text: 'This room is not muted.' }
      await setMuted(ctx.channelId, false)
      return { tone: 'success', text: 'Unmuted.' }
    },
  },
  {
    name: 'leave', takes: '', help: 'Leave this channel',
    async run(_rest, ctx) {
      if (!ctx.membership) return { keep: true, tone: 'warning', text: 'You are not in this room.' }
      if (ctx.channel?.type === 'direct' || ctx.channel?.type === 'group') return { keep: true, tone: 'warning', text: 'A direct message cannot be left. /mute keeps it quiet.' }
      await leaveChannel(ctx.channelId, ctx.memberships)
      goto('/messages/')
      return null
    },
  },
  {
    name: 'search', takes: '[words]', help: 'Search messages',
    async run(rest) {
      const q = rest.trim()
      goto(q ? `/messages/search/?q=${encodeURIComponent(q)}` : '/messages/search/')
      return null
    },
  },
  {
    name: 'help', takes: '', help: 'List the commands',
    async run() { return { tone: 'info', text: COMMANDS.map(c => '/' + c.name).join(' · ') + '. Start a message with // to send one that begins with /.' } },
  },
]
const byName = new Map(COMMANDS.map(c => [c.name, c]))

/**
 * What the box holds, read as a command: `{ command, name, rest }`, `{ literal }` for a `//`
 * message (its first `/` dropped), or null when it is text, which includes a `/word` that
 * names no command.
 */
export function readCommand(text) {
  const s = String(text ?? '')
  if (s.startsWith('//')) return { literal: s.slice(1) }
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(s.trim())
  const command = m && byName.get(m[1].toLowerCase())
  return command ? { command, name: command.name, rest: m[2] ?? '' } : null
}

/** The list for a `/name` being typed (no space yet): `{ prefix, items, index }`, or null. */
export function commandAt(text) {
  const m = /^\/(\w*)$/.exec(String(text ?? ''))
  if (!m) return null
  const q = m[1].toLowerCase()
  const items = COMMANDS.filter(c => c.name.startsWith(q))
  return items.length ? { prefix: q, items, index: 0 } : null
}

/**
 * Run what the box holds: `{ answer }` (null when the command moved the screen), `{ literal }`
 * to send as text, or null when it is not a command. A failure is an answer that keeps the box.
 */
export async function runCommand(text, ctx) {
  const read = readCommand(text)
  if (!read) return null
  if (read.literal != null) return { literal: read.literal }
  try { return { answer: await read.command.run(read.rest, ctx) } }
  catch (e) { return { answer: { keep: true, tone: 'danger', text: e?.message ?? String(e) } } }
}
