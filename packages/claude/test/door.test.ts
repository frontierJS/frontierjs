/*
 * test/door.test.ts — `claudeDoor` against a FAKE `claude`.
 *
 * Each scenario is a script of stream-json frames the fake prints, with an
 * optional stderr, exit code and sleep. Every reply the door can produce goes
 * through `checkReply`: the contract is the door's, and a reason outside the
 * set, a wrong `retryable` or an empty model is what this file exists to catch.
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkReply } from '@frontierjs/toolbelt/ask'
import type { Question, Reason } from '@frontierjs/toolbelt/ask'

import { claudeDoor } from '../index.ts'
import type { ClaudeDoorOptions, ClaudeReply } from '../index.ts'

const dir = mkdtempSync(join(tmpdir(), 'frontierjs-door-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const INIT   = { type: 'system', subtype: 'init', session_id: '5acea7bb-3850-44cf-81dc-97688510acda', model: 'claude-haiku-fake' }
const result = (over: object = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'four', num_turns: 1, total_cost_usd: 0.002,
  usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, output_tokens: 7 }, ...over,
})

// The fake records what it was given, including the mcp file as it stood while it ran.
function fake(frames: object[], { exit = 0, stderr = '', sleep = 0 } = {}) {
  const bin = join(dir, `claude-${Math.random().toString(36).slice(2)}`)
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs')
const input = fs.readFileSync(0, 'utf8')
const argv = process.argv.slice(2)
const i = argv.indexOf('--mcp-config')
let mcp = null
if (i >= 0) mcp = { path: argv[i + 1], mode: fs.statSync(argv[i + 1]).mode & 0o777, body: fs.readFileSync(argv[i + 1], 'utf8') }
fs.writeFileSync(${JSON.stringify(bin + '.seen')}, JSON.stringify({ argv, input, cwd: process.cwd(), mcp }))
for (const l of ${JSON.stringify(frames)}) process.stdout.write(JSON.stringify(l) + '\\n')
if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)})
setTimeout(() => process.exit(${exit}), ${sleep})
`)
  chmodSync(bin, 0o755)
  return { bin, seen: () => JSON.parse(readFileSync(bin + '.seen', 'utf8')) }
}

const text: Question   = { prompt: 'What is 2+2?' }
const schema: Question = { prompt: 'Give a number.', schema: { type: 'object', properties: { n: { type: 'number' } } } }

async function ask(f: ReturnType<typeof fake>, q: Question = text, opts: ClaudeDoorOptions = {}, call = {}) {
  const reply = await claudeDoor({ bin: f.bin, ...opts })(q, call) as ClaudeReply
  expect(checkReply(reply, q)).toEqual([])
  return reply
}
const reasonOf = (r: ClaudeReply) => r.ok ? null : r.failure.reason

describe('answered', () => {
  test('a text answer: the init frame names the model, usage sums cached input, cost and turns reported', async () => {
    const f = fake([INIT, result()])
    const r = await ask(f)
    expect(r).toMatchObject({ ok: true, door: 'claude', model: 'claude-haiku-fake', answer: 'four', costUsd: 0.002,
      usage: { inputTokens: 18, outputTokens: 7 }, run: { session: null, turns: 1, denials: [] } })
    expect(f.seen().input).toBe('What is 2+2?')
  })

  test('a schema answer is the structured output, and the schema goes on argv', async () => {
    const f = fake([INIT, result({ result: '', structured_output: { n: 4 } })])
    const r = await ask(f, schema)
    expect(r).toMatchObject({ ok: true, answer: { n: 4 } })
    const argv = f.seen().argv
    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1])).toEqual(schema.schema)
  })

  test('a kept session reports its id; an unkept one does not', async () => {
    const f = fake([INIT, result()])
    expect((await ask(f, text, { persist: true })).run.session).toBe(INIT.session_id)
    expect(f.seen().argv).not.toContain('--no-session-persistence')
    expect((await ask(f)).run.session).toBeNull()
    expect(f.seen().argv).toContain('--no-session-persistence')
  })

  test('resume implies persist and goes on argv', async () => {
    const f = fake([INIT, result()])
    const r = await ask(f, text, { resume: INIT.session_id })
    expect(r.run.session).toBe(INIT.session_id)
    const argv = f.seen().argv
    expect(argv[argv.indexOf('--resume') + 1]).toBe(INIT.session_id)
    expect(argv).not.toContain('--no-session-persistence')
  })

  test('the call model wins over the built model, and with no init frame the requested model is still named', async () => {
    const f = fake([result()])
    const built = await ask(f, text, { model: 'sonnet' })
    expect(built.model).toBe('sonnet')
    const argv = f.seen().argv
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet')
    const called = await ask(f, text, { model: 'sonnet' }, { model: 'haiku' })
    expect(called.model).toBe('haiku')
    expect(f.seen().argv[f.seen().argv.indexOf('--model') + 1]).toBe('haiku')
    expect((await ask(f)).model).toBe('default')
  })

  test('denials are listed as the tool and what it tried, cut at 200', async () => {
    const f = fake([INIT, result({ permission_denials: [
      { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } },
      { tool_name: 'Write', tool_input: { file_path: '/a/b' } },
      { tool_name: 'Bash', tool_input: { command: 'x'.repeat(500) } },
    ] })])
    const r = await ask(f)
    expect(r.run.denials.slice(0, 2)).toEqual(['Bash: rm -rf x', 'Write: /a/b'])
    expect(r.run.denials[2]).toHaveLength(200)
  })

  test('onEvent hears the drawn events', async () => {
    const f = fake([INIT, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u', name: 'Read', input: { file_path: 'x' } }] } }, result()])
    const seen: string[] = []
    await ask(f, text, { onEvent: e => seen.push(e.type) })
    expect(seen).toEqual(['session', 'tool', 'read', 'result'])
  })
})

describe('unanswered', () => {
  test('a missing program is not_set_up', async () => {
    const r = await ask({ bin: join(dir, 'nope'), seen: () => null })
    expect(reasonOf(r)).toBe('not_set_up')
    expect(r.model).toBe('default')
  })

  test('the caller aborting is aborted, and a signal already aborted never starts', async () => {
    const f = fake([INIT], { sleep: 30_000 })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 300)
    const t0 = Date.now()
    const r = await ask(f, text, {}, { signal: ctl.signal })
    expect(reasonOf(r)).toBe('aborted')
    expect(Date.now() - t0).toBeLessThan(10_000)
    const done = new AbortController(); done.abort()
    const g = fake([INIT, result()])
    expect(reasonOf(await ask(g, text, {}, { signal: done.signal }))).toBe('aborted')
    expect(existsSync(g.bin + '.seen')).toBe(false)
  })

  test('the wall clock is timeout, and the group is killed', async () => {
    const f = fake([INIT], { sleep: 30_000 })
    const t0 = Date.now()
    const r = await ask(f, text, { timeoutMs: 300 })
    expect(reasonOf(r)).toBe('timeout')
    expect(r.ok === false && r.failure.retryable).toBe(true)
    expect(Date.now() - t0).toBeLessThan(10_000)
  })

  const rows: Array<[string, object[], Reason, Question?, { stderr?: string, exit?: number }?]> = [
    ['stderr naming login, no frame',              [],                                                                       'signed_out', text, { stderr: 'Please run /login', exit: 1 }],
    ['a result naming login',                      [INIT, result({ is_error: true, result: 'Not logged in · Please run /login' })], 'signed_out'],
    ['error_max_budget_usd',                       [INIT, result({ subtype: 'error_max_budget_usd', is_error: true, result: undefined })], 'cut_off'],
    ['error_max_turns',                            [INIT, result({ subtype: 'error_max_turns', is_error: true, result: undefined })],       'cut_off'],
    ['error_max_structured_output_retries',        [INIT, result({ subtype: 'error_max_structured_output_retries', is_error: true })],     'no_answer', schema],
    ['error_during_execution',                     [INIT, result({ subtype: 'error_during_execution', is_error: true })],                  'model_error'],
    ['a usage limit',                              [INIT, result({ is_error: true, result: '5-hour usage limit reached' })],               'rate_limited'],
    ['overloaded',                                 [INIT, result({ is_error: true, result: 'API Error: 529 overloaded' })],                'rate_limited'],
    ['an unknown model',                           [INIT, result({ is_error: true, result: 'There\'s an issue with the selected model (nope). It may not exist' })], 'model_gone'],
    ['a prompt that is too long',                  [INIT, result({ is_error: true, result: 'Prompt is too long' })],                       'too_long'],
    ['any other is_error',                         [INIT, result({ is_error: true, result: 'something odd' })],                            'model_error'],
    ['success with a schema and no structure',     [INIT, result({ result: 'The answer is 4' })],                                          'no_answer', schema],
    ['no result frame and a clean exit',           [INIT],                                                                                 'lost'],
    ['no result frame and a crash',                [],                                                                                     'lost', text, { stderr: 'boom', exit: 2 }],
  ]
  for (const [name, frames, reason, q, extra] of rows) {
    test(`${name} is ${reason}`, async () => {
      const r = await ask(fake(frames, extra), q ?? text)
      expect(reasonOf(r)).toBe(reason)
      expect(r.model).toBeTruthy()
    })
  }

  test('retryable comes from the table, not the door', async () => {
    const r = await ask(fake([INIT, result({ is_error: true, result: 'Prompt is too long' })]))
    expect(r.ok === false && r.failure.retryable).toBe(false)
    const l = await ask(fake([INIT]))
    expect(l.ok === false && l.failure.retryable).toBe(true)
  })
})

describe('the agent and its headers', () => {
  const agent = { server: 'app', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer s3cret-token' } }

  test('no header value reaches argv; the mcp file is 0600, holds them, and is gone afterwards', async () => {
    const f = fake([INIT, result()])
    await ask(f, text, { agent })
    const seen = f.seen()
    expect(seen.argv.join('\n')).not.toContain('s3cret-token')
    expect(seen.mcp.mode).toBe(0o600)
    expect(JSON.parse(seen.mcp.body)).toEqual({ mcpServers: { app: { type: 'http', url: agent.url, headers: agent.headers } } })
    expect(seen.argv[seen.argv.indexOf('--allowedTools') + 1]).toBe('mcp__app')
    expect(existsSync(seen.mcp.path)).toBe(false)
    expect(seen.cwd).toBe(seen.mcp.path.replace(/\/mcp\.json$/, ''))
  })

  test('a header value in the detail or a denial is redacted', async () => {
    const f = fake([INIT, result({ is_error: true, result: 'upstream said Bearer s3cret-token is bad', permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'curl -H Bearer s3cret-token' } }] })])
    const r = await ask(f, text, { agent })
    expect(r.ok === false && r.failure.detail).toBe('upstream said [redacted] is bad')
    expect(r.run.denials).toEqual(['Bash: curl -H [redacted]'])
  })
})

describe('the posture', () => {
  test('--tools is derived from allow, cwd is a throwaway dir that is removed, a given cwd is kept', async () => {
    const f = fake([INIT, result()])
    await ask(f, text, { allow: ['Read', 'Bash(rg:*)', 'Bash(ls:*)'] })
    const seen = f.seen()
    expect(seen.argv[seen.argv.indexOf('--tools') + 1]).toBe('Read,Bash')
    expect(seen.argv[seen.argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(seen.argv[seen.argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(existsSync(seen.cwd)).toBe(false)
    await ask(f, text, { cwd: dir })
    expect(f.seen().cwd).toBe(dir)
    expect(existsSync(dir) && statSync(dir).isDirectory()).toBe(true)
  })

  test('a handler that throws cannot lose the answer, and a bad resume id is not_set_up rather than a throw', async () => {
    const f = fake([INIT, result()])
    expect((await ask(f, text, { onEvent: () => { throw new Error('host bug') } })).ok).toBe(true)
    expect(reasonOf(await ask(f, text, { resume: '--dangerously-skip-permissions' }))).toBe('not_set_up')
  })
})
