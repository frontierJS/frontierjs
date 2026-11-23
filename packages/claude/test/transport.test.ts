/*
 * test/transport.test.ts — the argv, the stdin and the stream reading.
 *
 * `runAsk` is driven against a FAKE `claude`: a script that records the argv and
 * the stdin it was given and answers in stream-json. The real program costs money
 * and needs a login, and what this package owns is the argv and the reading —
 * the read-only and hooks-off flags were measured against the real one when they
 * were written, and the fake pins that they are still passed. What the recorded
 * runs read as is `replay.test.ts`.
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as claude from '../index.ts'
import { ASK_BASH, ASK_EFFORT, DRAW_BUDGET_USD, EFFORTS, WORK_BUDGET_USD, askArgv, askInput, sessionArgv, readAskEvent, runAsk } from '../index.ts'
import type { Agent, AskEvent, RunAskOptions } from '../index.ts'

const SESSION = '5acea7bb-3850-44cf-81dc-97688510acda'
const dir     = mkdtempSync(join(tmpdir(), 'frontierjs-claude-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fakeClaude(lines: object[], { exit = 0, stderr = '' } = {}) {
  const bin = join(dir, `claude-${Math.random().toString(36).slice(2)}`)
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs')
const input = fs.readFileSync(0, 'utf8')
fs.writeFileSync(${JSON.stringify(bin + '.seen')}, JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd() }))
for (const l of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(l) + '\\n')
if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)})
process.exit(${exit})
`)
  chmodSync(bin, 0o755)
  return { bin, seen: () => JSON.parse(readFileSync(bin + '.seen', 'utf8')) }
}

async function ask(opts: Partial<RunAskOptions>): Promise<{ code?: number | null, error?: string, events: AskEvent[] }> {
  const events: AskEvent[] = []
  const out = runAsk({ root: dir, prompt: 'the prompt', ...opts, onEvent: e => events.push(e) })
  if ('error' in out) return { error: out.error, events }
  const code = await out.done
  return { code, events }
}

describe('sessionArgv', () => {
  test('a host session: stream-json both ways, prompts to the host, hooks and replays on, no budget', () => {
    const argv = sessionArgv()
    for (const f of ['-p', '--verbose', '--include-partial-messages', '--include-hook-events', '--replay-user-messages']) expect(argv).toContain(f)
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(argv[argv.indexOf('--input-format') + 1]).toBe('stream-json')
    expect(argv[argv.indexOf('--permission-prompt-tool') + 1]).toBe('stdio')
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user,project,local')
    for (const f of ['--settings', '--max-budget-usd', '--resume', '--model', '--effort', '--permission-mode']) expect(argv).not.toContain(f)
  })
  test('model, effort, mode and resume when given; a value that is not one is dropped', () => {
    const argv = sessionArgv({ session: SESSION, model: 'haiku', effort: 'low', permissionMode: 'plan' })
    expect(argv.slice(-8)).toEqual(['--model', 'haiku', '--effort', 'low', '--permission-mode', 'plan', '--resume', SESSION])
    const bad = sessionArgv({ session: 'nope', effort: 'huge', permissionMode: 'yolo' })
    for (const f of ['--resume', '--effort', '--permission-mode']) expect(bad).not.toContain(f)
  })
  test('bypass is reachable mid-session only when the host allows it', () => {
    expect(sessionArgv()).not.toContain('--allow-dangerously-skip-permissions')
    expect(sessionArgv({ allowBypass: true })).toContain('--allow-dangerously-skip-permissions')
    expect(sessionArgv({ allowBypass: true })).not.toContain('--dangerously-skip-permissions')
  })
})

describe('askArgv', () => {

  test('read-only and hooks off: the built-ins named, Bash narrowed, no MCP, no hooks', () => {
    const argv = askArgv()
    expect(argv).toContain('-p')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash')
    expect(argv).toContain('--strict-mcp-config')
    expect(JSON.parse(argv[argv.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true })
    for (const p of ASK_BASH) expect(argv).toContain(`Bash(${p})`)
    expect(argv.some(a => /^(Edit|Write)/.test(a))).toBe(false)
    expect(argv).not.toContain('--resume')
  })

  test('a follow-up resumes by id', () => {
    const argv = askArgv({ session: SESSION })
    expect(argv.slice(-2)).toEqual(['--resume', SESSION])
  })

  test('work: every tool, no prompts, the budget stated, hooks off unless asked', () => {
    const argv = askArgv({ work: { budget: 25 } })
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('25')
    expect(argv).not.toContain('--tools')
    expect(JSON.parse(argv[argv.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true })
    expect(askArgv({ work: { hooks: true } })).not.toContain('--settings')
    expect(askArgv({ work: {} })[askArgv({ work: {} }).indexOf('--max-budget-usd') + 1]).toBe(String(WORK_BUDGET_USD))
    expect(askArgv({ work: {}, session: SESSION }).slice(-2)).toEqual(['--resume', SESSION])
    expect(askArgv({ work: {}, session: SESSION, fork: true }).slice(-3)).toEqual(['--resume', SESSION, '--fork-session'])
    expect(askArgv({ work: {}, fork: true })).not.toContain('--fork-session')
  })

  test('draw: no tool, the system prompt replaced, no settings file, hooks or MCP, the budget stated', () => {
    const argv = askArgv({ draw: { system: 'draw it', budget: 5 } })
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('draw it')
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(argv).toContain('--strict-mcp-config')
    expect(JSON.parse(argv[argv.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true })
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('5')
    expect(argv).not.toContain('--allowedTools')
    const fallback = askArgv({ draw: { system: 'x' } })
    expect(fallback[fallback.indexOf('--max-budget-usd') + 1]).toBe(String(DRAW_BUDGET_USD))
  })

  test('agent: no built-in tool, the one MCP server the caller names, nothing else allowed', () => {
    const argv = askArgv({ agent: { url: 'http://127.0.0.1:1/mcp', server: 'app' } })
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(JSON.parse(argv[argv.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { app: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } })
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__app')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    const nameless = { url: 'http://127.0.0.1:1/mcp' } as Agent
    expect(() => askArgv({ agent: nameless })).toThrow('names its MCP server')
    expect(runAsk({ root: dir, prompt: 'x', agent: nameless })).toEqual({ error: 'an agent names its MCP server' })
  })

  test('effort is passed when named and left to the account when not', () => {
    expect(askArgv()).not.toContain('--effort')
    expect(askArgv({ work: {} })).not.toContain('--effort')
    const argv = askArgv({ edit: '/app', effort: 'low' })
    expect(argv[argv.indexOf('--effort') + 1]).toBe('low')
  })

})

describe('readAskEvent', () => {

  test('init → session, text and tool calls → lines, thinking → nothing', () => {
    expect(readAskEvent({ type: 'system', subtype: 'init', session_id: SESSION })).toEqual([{ type: 'session', id: SESSION }])
    expect(readAskEvent({ type: 'assistant', message: { content: [
      { type: 'thinking', thinking: '…' },
      { type: 'text', text: 'It failed because…' },
      { type: 'tool_use', name: 'Bash', input: { command: 'git status --short\nsecond line' } },
      { type: 'tool_use', name: 'Read', input: { file_path: 'ISSUES.md' } },
    ] } })).toEqual([
      { type: 'text', text: 'It failed because…' },
      { type: 'tool', text: 'Bash git status --short' },
      { type: 'tool', text: 'Read ISSUES.md' },
      { type: 'read', file: 'ISSUES.md' } as AskEvent,
    ])
    expect(readAskEvent({ type: 'rate_limit_event' })).toEqual([])
  })

  test('a result says whether it answered, and counts what read-only refused', () => {
    expect(readAskEvent({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.04, num_turns: 3,
      permission_denials: [{ tool_name: 'Bash' }] })).toEqual([
      { type: 'result', ok: true, stop: 'success', cost: 0.04, turns: 3, denied: 1 },
    ])
    expect(readAskEvent({ type: 'result', subtype: 'error_max_budget_usd' })[0]).toMatchObject({ ok: false })
  })

})

describe('runAsk', () => {

  test('the prompt goes on stdin, the root is the cwd, and the stream is read into events', async () => {
    const fake = fakeClaude([
      { type: 'system', subtype: 'init', session_id: SESSION },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } },
      { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 1 },
    ])
    const { code, events } = await ask({ bin: fake.bin })
    expect(code).toBe(0)
    expect(events.map(e => e.type)).toEqual(['session', 'text', 'result'])
    const seen = fake.seen()
    expect(seen.input).toBe('the prompt')
    expect(seen.cwd).toBe(dir)
    expect(seen.argv).toEqual(askArgv({ effort: ASK_EFFORT }))
  })

  test('a follow-up passes the session through', async () => {
    const fake = fakeClaude([])
    await ask({ bin: fake.bin, session: SESSION })
    const argv = fake.seen().argv
    expect(argv[argv.indexOf('--resume') + 1]).toBe(SESSION)
  })

  test('effort defaults to ASK_EFFORT, takes any of EFFORTS, and refuses anything else before starting', async () => {
    const fake = fakeClaude([])
    await ask({ bin: fake.bin })
    let argv = fake.seen().argv
    expect(argv[argv.indexOf('--effort') + 1]).toBe(ASK_EFFORT)
    for (const effort of EFFORTS) {
      await ask({ bin: fake.bin, effort })
      argv = fake.seen().argv
      expect(argv[argv.indexOf('--effort') + 1]).toBe(effort)
    }
    const { error } = await ask({ bin: '/nonexistent', effort: '--dangerously-skip-permissions' })
    expect(error).toContain('no such effort')
  })

  test('a session id that is not one is refused before anything starts', async () => {
    const { error } = await ask({ bin: '/nonexistent', session: '--dangerously-skip-permissions' })
    expect(error).toContain('not a session id')
  })

  test('an ask with images goes in as one stream-json message: the prompt, then each image', async () => {
    const fake = fakeClaude([{ type: 'result', subtype: 'success', is_error: false }])
    const images = [{ type: 'image/png', data: 'iVBORw0KGgo=' }, { type: 'image/jpeg', data: '/9j/4AAQ' }]
    const { code } = await ask({ bin: fake.bin, images })
    expect(code).toBe(0)
    const seen = fake.seen()
    expect(seen.argv).toEqual(askArgv({ effort: ASK_EFFORT, images: true }))
    expect(seen.argv.slice(-2)).toEqual(['--input-format', 'stream-json'])
    expect(seen.input.endsWith('\n')).toBe(true)
    expect(JSON.parse(seen.input)).toEqual({ type: 'user', message: { role: 'user', content: [
      { type: 'text', text: 'the prompt' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
    ] } })
  })

  test('with no images the prompt stays plain text and the input format is left alone', () => {
    expect(askInput('hi')).toBe('hi')
    expect(askInput('hi', [])).toBe('hi')
    expect(askArgv()).not.toContain('--input-format')
    expect(askArgv({ edit: '/app', images: true })).toContain('--input-format')
  })

  test('a failing claude says what it said on stderr, rather than answering nothing', async () => {
    const fake = fakeClaude([], { exit: 1, stderr: 'Invalid API key · Please run /login\n' })
    const { code, events } = await ask({ bin: fake.bin })
    expect(code).toBe(1)
    expect(events).toEqual([{ type: 'error', text: 'Invalid API key · Please run /login' }])
  })

  test('a work run starts with the work argv: fork, an appended prompt, partials, no effort when null', async () => {
    const fake = fakeClaude([{ type: 'result', subtype: 'success', is_error: false }])
    const work = { budget: 7, hooks: true, permission: 'auto', settingSources: 'project,local', mcp: false, addDirs: ['/main'] }
    const { code } = await ask({ bin: fake.bin, work, session: SESSION, fork: true, effort: null, model: 'opus', partial: true, appendSystem: 'context' })
    expect(code).toBe(0)
    const argv = fake.seen().argv
    expect(argv).toEqual([...askArgv({ work, session: SESSION, fork: true, model: 'opus' }), '--include-partial-messages', '--append-system-prompt', 'context'])
    expect(argv).not.toContain('--effort')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto')
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('project,local')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv.slice(argv.indexOf('--add-dir'), argv.indexOf('--add-dir') + 2)).toEqual(['--add-dir', '/main'])
    expect(argv).not.toContain('--settings')
  })

  test('a frame tap hears each parsed stdout line before it is read into events', async () => {
    const lines = [{ type: 'system', subtype: 'init', session_id: SESSION }, { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 1.5 }]
    const fake = fakeClaude(lines)
    const frames: unknown[] = []
    const exits: unknown[] = []
    const out = runAsk({ root: dir, prompt: 'p', bin: fake.bin, onFrame: f => frames.push(f), onExit: (c, s) => exits.push([c, s]) })
    if ('error' in out) throw new Error(out.error)
    await out.done
    expect(frames).toEqual(lines)
    expect(exits).toEqual([[0, null]])
  })

  test('with a log the child writes the file itself and exit reports code and signal once', async () => {
    const fake = fakeClaude([{ type: 'result', subtype: 'success', is_error: false }], { exit: 3, stderr: 'said so\n' })
    const log = join(dir, 'run.log')
    writeFileSync(log, 'before\n')
    const exits: unknown[] = []
    const out = runAsk({ root: dir, prompt: 'p', bin: fake.bin, log, onExit: (c, s) => exits.push([c, s]) })
    if ('error' in out) throw new Error(out.error)
    expect(await out.done).toBe(3)
    expect(exits).toEqual([[3, null]])
    const text = readFileSync(log, 'utf8')
    expect(text.startsWith('before\n')).toBe(true)
    expect(text).toContain('"type":"result"')
    expect(text).toContain('said so')
  })

  test('a log run whose claude is missing says so and still exits once', async () => {
    const events: AskEvent[] = []
    const exits: unknown[] = []
    const out = runAsk({ root: dir, prompt: 'p', bin: join(dir, 'no-such-claude'), log: join(dir, 'gone.log'), onEvent: e => events.push(e), onExit: (c, s) => exits.push([c, s]) })
    if ('error' in out) throw new Error(out.error)
    expect(await out.done).toBe(null)
    expect(events[0].type === 'error' && events[0].text).toContain('not installed or not on PATH')
    expect(exits).toEqual([[null, null]])
  })

  test('no claude on the machine is said in those words', async () => {
    const { events } = await ask({ bin: join(dir, 'no-such-claude') })
    const [first] = events
    expect(first.type).toBe('error')
    expect(first.type === 'error' && first.text).toContain('not installed or not on PATH')
  })

})

// This package says HOW to call claude and nothing about WHAT to say. A rule or a
// prompt that lands here again is a second owner of the words.
describe('the transport carries no prompt', () => {
  test('no export is a rule, a prompt, a handoff, a kind or a scope', () => {
    const words = Object.keys(claude).filter(name => /_RULES$|Prompt$|^HANDOFF_|_KINDS$|_SCOPES$/.test(name))
    expect(words, `${words.join(', ')} belong with the product that says them (cli/core/plan-prompt.js, edit-prompt.js, ask-prompt.js), not in @frontierjs/claude`).toEqual([])
  })
})
