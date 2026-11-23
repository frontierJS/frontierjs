/*
 * test/replay.test.ts — each recorded run's stdout through `readAskEvent`.
 *
 * The page-facing events, minus `delta` and `status`, pinned per recording; the
 * deltas are checked to add up to the reply. A re-record that reads differently
 * fails here, beside the census pin in `fixtures.test.ts`.
 */

import { test, expect } from 'bun:test'
import { readAskEvent, type AskEvent } from '../index.ts'
import { load } from './census.ts'

const read = (file: string): AskEvent[] => load(file).filter(f => f.dir === 'out').flatMap(f => readAskEvent(f.line))
const drawn = (events: AskEvent[]) => events.filter(e => e.type !== 'delta' && e.type !== 'status')
const said  = (events: AskEvent[], type: 'delta' | 'text') => events.flatMap(e => e.type === type ? [e.text] : []).join('')

const FILE = '/home/user/project/notes.txt'
const ok = (cost: number, turns: number): AskEvent => ({ type: 'result', ok: true, stop: 'success', cost, turns, denied: 0 })

test('read-only: a Read, its result, the answer', () => {
  expect(drawn(read('read-only.jsonl'))).toEqual([
    { type: 'session', id: 'session-1' },
    { type: 'tool',    text: `Read ${FILE}` },
    { type: 'read',    id: 'toolu-1', file: FILE },
    { type: 'landed',  id: 'toolu-1' },
    { type: 'text',    text: 'The launch is on Tuesday, according to notes.txt.' },
    ok(0.00033736, 2),
  ])
})

test('edit: the Read before the Edit, and the Edit as an undo reverses it', () => {
  expect(drawn(read('edit.jsonl'))).toEqual([
    { type: 'session', id: 'session-2' },
    { type: 'tool',    text: `Read ${FILE}` },
    { type: 'read',    id: 'toolu-2', file: FILE },
    { type: 'landed',  id: 'toolu-2' },
    { type: 'tool',    text: `Edit ${FILE}` },
    { type: 'edit',    id: 'toolu-3', file: FILE, old: 'Bring the blue folder.', new: 'Bring the green folder.', all: false },
    { type: 'landed',  id: 'toolu-3' },
    { type: 'text',    text: 'done' },
    ok(0.0005568200000000001, 3),
  ])
})

test('resumed: the earlier session id, no tool', () => {
  expect(drawn(read('resumed.jsonl'))).toEqual([
    { type: 'session', id: 'session-1' },
    { type: 'text',    text: 'notes.txt' },
    ok(0.00040817999999999996, 1),
  ])
})

test('chats: the tool calls, statuses while waiting, and deltas that add up to the reply', () => {
  const permission = read('chat-permission.jsonl'), question = read('chat-question.jsonl')
  expect(drawn(permission)).toEqual([
    { type: 'session', id: 'session-3' },
    { type: 'tool',    text: "Bash printf 'hi' > /home/user/project/hello.txt && cat /home/user/project/hello.txt" },
    { type: 'landed',  id: 'toolu-4' },
    { type: 'text',    text: 'done' },
    ok(0.0007589200000000001, 2),
  ])
  expect(drawn(question)).toEqual([
    { type: 'session', id: 'session-4' },
    { type: 'tool',    text: 'ToolSearch' },
    { type: 'landed',  id: 'toolu-5' },
    { type: 'tool',    text: 'AskUserQuestion' },
    { type: 'landed',  id: 'toolu-6' },
    { type: 'text',    text: 'Pear' },
    ok(0.00129198, 3),
  ])
  for (const events of [permission, question]) {
    expect(said(events, 'delta')).toBe(said(events, 'text'))
    expect(events.some(e => e.type === 'status')).toBe(true)
  }
})
