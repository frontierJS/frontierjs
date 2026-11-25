/*
 * test/transcript.test.ts — a transcript folded into turns, `readTranscript`'s refusals, and `readToolCalls`.
 */

import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldTranscript, readToolCalls, readTranscript } from '../index.ts'

const user = (text: string) => JSON.stringify({ type: 'user', sessionId: 's1', cwd: '/repo', timestamp: 'T0', message: { content: text } })
const reply = (id: string, content: object[]) => JSON.stringify({ type: 'assistant', message: { id, model: 'm', usage: { input_tokens: 1, output_tokens: 5 }, content } })

test('a streamed reply counts once, a tool call is a name and a summary, and its result a size', () => {
  const text = [
    user('fix it'),
    reply('a', [{ type: 'text', text: 'on it' }]),
    reply('a', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/x.ts' } }]),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'abcd' }] } }),
    '{not json',
  ].join('\n')
  const r = foldTranscript(text)
  if (!r.ok) throw new Error(r.reason)
  const [turn] = r.value.turns
  expect(r.value.cwd).toBe('/repo')
  expect(turn.messages).toBe(1)
  expect(turn.tokens.output).toBe(5)
  expect(turn.tools).toEqual([{ id: 't1', name: 'Read', summary: '/repo/x.ts', result: { ok: true, bytes: 4 } }])
})

test('a file with no transcript line is unreadable, and a path outside projects/ is refused', () => {
  expect(foldTranscript('nothing\nhere').ok).toBe(false)
  const dir = mkdtempSync(join(tmpdir(), 'claude-transcript-'))
  try {
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
    writeFileSync(join(dir, 'outside.jsonl'), user('x'))
    writeFileSync(join(dir, 'projects', 'p', 'in.jsonl'), user('x'))
    const outside = readTranscript(join(dir, 'outside.jsonl'), { configDir: dir })
    expect(outside.ok ? '' : outside.reason).toContain('not inside')
    expect(readTranscript(join(dir, 'projects', 'p', 'in.jsonl'), { configDir: dir }).ok).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readToolCalls keeps each call once with its input and its result text, and marks a subagent\'s', () => {
  const side = JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'b', content: [{ type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'ui-hazards' } }, { type: 'text', text: 'aside' }] } })
  const text = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 's1' }),
    user('fix FJS-1'),
    reply('a', [{ type: 'text', text: 'on it' }]),
    reply('a', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } }]),
    reply('a', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } }]),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: '1 fail' }] }] } }),
    side,
  ].join('\n')
  const r = readToolCalls(text)
  if (!r.ok) throw new Error(r.reason)
  expect(r.value).toMatchObject({ sessionId: 's1', cwd: '/repo', startedAt: 'T0', prompt: 'fix FJS-1', replies: ['on it'] })
  expect(r.value.calls.map(c => [c.name, c.input, c.sidechain, c.result])).toEqual([
    ['Bash', { command: 'bun test' }, false, { error: true, text: '1 fail' }],
    ['Skill', { skill: 'ui-hazards' }, true, null],
  ])
  expect(readToolCalls('nothing').ok).toBe(false)
})
