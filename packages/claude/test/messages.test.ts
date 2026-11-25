/*
 * test/messages.test.ts — `readMessages`, the one opinion of what a transcript line means.
 *
 * A streamed reply is several lines with one message id; a skill colors its
 * whole turn; the editor's tag block is not what a person typed.
 */

import { test, expect } from 'bun:test'
import { readMessages } from '../index.ts'

const reply = (id: string, timestamp: string, usage: object) => JSON.stringify({ type: 'assistant', timestamp, message: { id, usage } })
const U = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 }

test('a skill colors its whole turn, and a turn carries across a chunk', () => {
  const prompt = (text: string) => JSON.stringify({ type: 'user', timestamp: 'T', message: { role: 'user', content: text } })
  const load   = (dir: string) => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${dir}\n\n# x` }] } })
  const result = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })
  const lines = [
    prompt('<command-message>fix-next</command-message>\n<command-name>/fix-next</command-name>'),
    load('/repo/.claude/skills/fix-next'),
    reply('m1', 'T1', U), result, reply('m2', 'T2', U),
    prompt('next thing'), reply('m3', 'T3', U),
  ].map(l => l + '\n')
  const whole = readMessages(lines.join(''))
  expect(whole.messages.map(m => m.skills)).toEqual([['fix-next'], ['fix-next'], []])

  const head = readMessages(lines.slice(0, 4).join(''))
  const tail = readMessages(lines.slice(4).join(''), { skills: head.file.skills })
  expect(tail.messages.map(m => m.skills)).toEqual([['fix-next'], []])

  // The editor's tag block is longer than the 200 kept characters, so the
  // typing after it is the prompt and the block is nothing.
  const wrapped = `<ide_selection>The user selected lines 58 to 58 from /repo/x.ts:\n${'ir\n'.repeat(100)}</ide_selection> fix the selected loop`
  expect(readMessages([prompt(wrapped), reply('m9', 'T9', U)].map(l => l + '\n').join('')).file.firstPrompt).toBe('fix the selected loop')
  expect(readMessages([prompt('<ide_opened_file>a.ts</ide_opened_file>'), prompt('then this')].map(l => l + '\n').join('')).file.firstPrompt).toBe('then this')
  const blocks = JSON.stringify({ type: 'user', timestamp: 'T', message: { role: 'user', content: [{ type: 'text', text: '<ide_opened_file>a.ts</ide_opened_file>' }, { type: 'image' }, { type: 'text', text: 'second block typing' }] } })
  expect(readMessages(blocks + '\n').file.firstPrompt).toBe('second block typing')
})

test('a streamed reply is one message, and a half-written last line waits for the next chunk', () => {
  const a = JSON.stringify({ type: 'assistant', timestamp: 'T1', message: { id: 'm1', usage: U, content: [{ type: 'tool_use', name: 'Read' }] } })
  const b = JSON.stringify({ type: 'assistant', timestamp: 'T2', message: { id: 'm1', usage: U, content: [{ type: 'tool_use', name: 'Bash' }] } })
  const { messages, consumed } = readMessages(`${a}\n${b}\n{"type":"assistant","mess`)
  expect(messages.length).toBe(1)
  expect(messages[0].tools).toEqual(['Read', 'Bash'])
  expect(consumed).toBe(Buffer.byteLength(`${a}\n${b}\n`))
})
