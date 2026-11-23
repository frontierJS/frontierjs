/*
 * test/fixtures.test.ts — the recorded stream-json runs have the shape the
 * package will read.
 *
 * `bun test/record.ts` made the five files under test/fixtures from the
 * installed `claude`; this replays them with no `claude` present. It asserts the
 * recorded shape only; what the reader makes of them is `replay.test.ts`. A re-record that
 * changes a census fails here until the pin below is updated on purpose, which
 * is how a protocol change reaches review.
 */

import { test, expect } from 'bun:test'
import { census, load, resultOf, type Frame } from './census.ts'
import version from './fixtures/version.json'

const ONE_SHOT = ['read-only.jsonl', 'edit.jsonl', 'resumed.jsonl']
const CHATS = ['chat-permission.jsonl', 'chat-question.jsonl']

const CENSUS: Record<string, string[]> = {
  'read-only.jsonl': [
    'out assistant', 'out rate_limit_event', 'out result/success', 'out system/init',
    'out system/ui_invalidate', 'out user',
  ],
  'edit.jsonl': [
    'out assistant', 'out rate_limit_event', 'out result/success', 'out system/init',
    'out system/ui_invalidate', 'out user',
  ],
  'resumed.jsonl': [
    'out assistant', 'out rate_limit_event', 'out result/success', 'out system/init',
  ],
  'chat-permission.jsonl': [
    'in control_request:initialize', 'in control_response:success', 'in user',
    'out assistant', 'out control_request:can_use_tool', 'out control_response:success',
    'out rate_limit_event', 'out result/success',
    'out stream_event:content_block_delta', 'out stream_event:content_block_start',
    'out stream_event:content_block_stop', 'out stream_event:message_delta',
    'out stream_event:message_start', 'out stream_event:message_stop',
    'out system/init', 'out system/status', 'out system/thinking_tokens', 'out system/ui_invalidate',
    'out user',
  ],
  'chat-question.jsonl': [
    'in control_request:initialize', 'in control_response:success', 'in user',
    'out assistant', 'out control_request:can_use_tool', 'out control_response:success',
    'out rate_limit_event', 'out result/success',
    'out stream_event:content_block_delta', 'out stream_event:content_block_start',
    'out stream_event:content_block_stop', 'out stream_event:message_delta',
    'out stream_event:message_start', 'out stream_event:message_stop',
    'out system/init', 'out system/status', 'out system/ui_invalidate',
    'out user',
  ],
}

const frames = (file: string) => load(file)
const answered = (f: Frame) => f.dir === 'in' && f.line.type === 'control_response'
const asked = (f: Frame) => f.dir === 'out' && f.line.type === 'control_request' && f.line.request?.subtype === 'can_use_tool'

test('every fixture line is a tagged frame', () => {
  for (const file of Object.keys(CENSUS)) {
    const all = frames(file)
    expect(all.length).toBeGreaterThan(3)
    for (const f of all) {
      expect(['in', 'out']).toContain(f.dir)
      expect(typeof f.line.type).toBe('string')
    }
  }
})

test('each fixture has the census pinned for it', () => {
  for (const file of Object.keys(CENSUS)) expect({ file, census: census(frames(file)) }).toEqual({ file, census: CENSUS[file] })
})

test('the version file names the program the fixtures came from', () => {
  expect(version.claude).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)$/)
  const init = frames('read-only.jsonl').find(f => f.line.subtype === 'init')!
  expect(`${init.line.claude_code_version} (Claude Code)`).toBe(version.claude)
})

test('a one-shot run writes nothing to stdin and ends in a successful result', () => {
  for (const file of ONE_SHOT) {
    const all = frames(file)
    expect(all.some(f => f.dir === 'in')).toBe(false)
    const last = all.at(-1)!
    expect(last.line.type).toBe('result')
    expect(last.line.subtype).toBe('success')
    expect(last.line.is_error).toBe(false)
    expect(typeof last.line.result).toBe('string')
  }
})

test('the read-only run reads the file and answers from it', () => {
  const all = frames('read-only.jsonl')
  const tools = all.flatMap(f => f.line.type === 'assistant' ? f.line.message.content : []).filter((b: any) => b.type === 'tool_use')
  expect(tools.map((b: any) => b.name)).toEqual(['Read'])
  expect(resultOf(all)!.result).toContain('Tuesday')
})

test('the edit run changes the file with Edit', () => {
  const all = frames('edit.jsonl')
  const tools = all.flatMap(f => f.line.type === 'assistant' ? f.line.message.content : []).filter((b: any) => b.type === 'tool_use')
  expect(tools.map((b: any) => b.name)).toContain('Edit')
  expect(JSON.stringify(tools.find((b: any) => b.name === 'Edit').input)).toContain('green')
})

test('the resumed run keeps the session of the run it resumed', () => {
  const session = (file: string) => frames(file).find(f => f.line.subtype === 'init')!.line.session_id
  expect(session('resumed.jsonl')).toBe(session('read-only.jsonl'))
  expect(session('edit.jsonl')).not.toBe(session('read-only.jsonl'))
  expect(resultOf(frames('resumed.jsonl'))!.result).toContain('notes.txt')
})

test('a chat sends initialize first and its message after the answer', () => {
  for (const file of CHATS) {
    const all = frames(file)
    expect(all[0]!.dir).toBe('in')
    expect(all[0]!.line.request.subtype).toBe('initialize')
    const answer = all.findIndex(f => f.dir === 'out' && f.line.type === 'control_response' && f.line.response.request_id === all[0]!.line.request_id)
    const message = all.findIndex(f => f.dir === 'in' && f.line.type === 'user')
    expect(answer).toBeGreaterThan(0)
    expect(message).toBeGreaterThan(answer)
    expect(all.at(-1)!.line.type).toBe('result')
  }
})

test('the permission chat holds a can_use_tool request and its allow', () => {
  const all = frames('chat-permission.jsonl')
  const at = all.findIndex(asked)
  const request = all[at]!.line
  expect(request.request.tool_name).toBe('Bash')
  expect(request.request.input.command).toContain('hello.txt')
  expect(request.request.tool_use_id).toMatch(/^toolu-/)
  const reply = all.find(answered)!
  expect(all.indexOf(reply)).toBeGreaterThan(at)
  expect(reply.line.response.request_id).toBe(request.request_id)
  expect(reply.line.response.response.behavior).toBe('allow')
  expect(reply.line.response.response.updatedInput).toEqual(request.request.input)
})

test('the question chat holds an AskUserQuestion request and its answer', () => {
  const all = frames('chat-question.jsonl')
  const at = all.findIndex(asked)
  const request = all[at]!.line
  expect(request.request.tool_name).toBe('AskUserQuestion')
  expect(request.request.requires_user_interaction).toBe(true)
  const [q] = request.request.input.questions
  expect(q.options.map((o: any) => o.label)).toEqual(['Apple', 'Pear'])
  const reply = all.find(answered)!
  expect(all.indexOf(reply)).toBeGreaterThan(at)
  expect(reply.line.response.request_id).toBe(request.request_id)
  expect(reply.line.response.response.updatedInput.answers).toEqual({ [q.question]: 'Pear' })
  const seen = all.find(f => f.dir === 'out' && f.line.type === 'user' && JSON.stringify(f.line.message).includes('Your questions have been answered'))
  expect(seen).toBeDefined()
})
