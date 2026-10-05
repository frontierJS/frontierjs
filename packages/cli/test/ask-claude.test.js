// ─── ask-claude.test.js — the output panel handed to Claude Code ────────────
//
// `runAsk` is driven against a FAKE `claude`: a script that records the argv and
// the stdin it was given and answers in stream-json. The real CLI costs money
// and needs a login, and what this module owns is the argv, the prompt and the
// reading — the read-only and hooks-off flags were measured against the real
// one when they were written, and the fake pins that they are still passed.

import { describe, test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ASK_BASH, ASK_MAX_LINES, ASK_MAX_RULES, ASK_RULES, askArgv, askPrompt, readAskEvent, runAsk } from '../core/ask-claude.js'

const SESSION = '5acea7bb-3850-44cf-81dc-97688510acda'
const dir     = mkdtempSync(join(tmpdir(), 'fli-ask-claude-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fakeClaude(lines, { exit = 0, stderr = '' } = {}) {
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

async function ask(opts) {
  const events = []
  const out = runAsk({ root: dir, prompt: 'the prompt', ...opts, onEvent: e => events.push(e) })
  if (out.error) return { error: out.error, events }
  const code = await out.done
  return { code, events }
}

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

})

describe('askPrompt', () => {

  test('a first question carries the ground rules, where I am, the tree and the output', () => {
    const p = askPrompt({
      question: 'why did this fail?',
      output:   '$ fli test:done\n✗ snapshots',
      context:  { panel: 'release', 'release-app': 'example', empty: '' },
      git:      '## main\n M ISSUES.md',
    })
    expect(p).toContain('read-only')
    expect(p).toContain('Question: why did this fail?')
    expect(p).toContain('- release-app: example')
    expect(p).not.toContain('empty:')
    expect(p).toContain(' M ISSUES.md')
    expect(p).toContain('✗ snapshots')
  })

  test('no question asks the default one', () => {
    expect(askPrompt({ output: 'x' })).toContain('Question: What does this output say')
  })

  test('edited instructions replace the default ones; blank ones fall back to them', () => {
    const p = askPrompt({ output: 'x', rules: '  Answer in one sentence.  ' })
    expect(p.startsWith('Answer in one sentence.\n\n')).toBe(true)
    expect(p).not.toContain(ASK_RULES)
    expect(askPrompt({ output: 'x', rules: '   ' })).toContain(ASK_RULES)
    expect(askPrompt({ output: 'x', rules: 'y'.repeat(ASK_MAX_RULES + 50) })).not.toContain('y'.repeat(ASK_MAX_RULES + 1))
  })

  test('a follow-up drops the ground rules, edited or not, and names the output as new', () => {
    expect(askPrompt({ output: 'x', rules: 'Answer in one sentence.', followUp: true })).not.toContain('one sentence')
    const p = askPrompt({ question: 'and now?', output: 'later line', followUp: true })
    expect(p).not.toContain('read-only')
    expect(p).toContain('Output since my last question')
  })

  test('a long output keeps its TAIL and says how much was cut', () => {
    const lines = Array.from({ length: ASK_MAX_LINES + 10 }, (_, i) => `line ${i}`)
    const p = askPrompt({ output: lines.join('\n') })
    expect(p).toContain(`the first 10 cut`)
    expect(p).not.toContain('line 9\n')
    expect(p).toContain(`line ${ASK_MAX_LINES + 9}`)
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
      { type: 'read', file: 'ISSUES.md' },
    ])
    expect(readAskEvent({ type: 'rate_limit_event' })).toEqual([])
  })

  test('a result says whether it answered, and counts what read-only refused', () => {
    expect(readAskEvent({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.04, num_turns: 3,
      permission_denials: [{ tool_name: 'Bash' }] })).toEqual([
      { type: 'result', ok: true, stop: 'success', cost: 0.04, turns: 3, denied: 1 },
    ])
    expect(readAskEvent({ type: 'result', subtype: 'error_max_budget_usd' })[0].ok).toBe(false)
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
    expect(seen.argv).toEqual(askArgv())
  })

  test('a follow-up passes the session through', async () => {
    const fake = fakeClaude([])
    await ask({ bin: fake.bin, session: SESSION })
    expect(fake.seen().argv.slice(-2)).toEqual(['--resume', SESSION])
  })

  test('a session id that is not one is refused before anything starts', async () => {
    const { error } = await ask({ bin: '/nonexistent', session: '--dangerously-skip-permissions' })
    expect(error).toContain('not a session id')
  })

  test('a failing claude says what it said on stderr, rather than answering nothing', async () => {
    const fake = fakeClaude([], { exit: 1, stderr: 'Invalid API key · Please run /login\n' })
    const { code, events } = await ask({ bin: fake.bin })
    expect(code).toBe(1)
    expect(events).toEqual([{ type: 'error', text: 'Invalid API key · Please run /login' }])
  })

  test('no claude on the machine is said in those words', async () => {
    const { events } = await ask({ bin: join(dir, 'no-such-claude') })
    expect(events[0].type).toBe('error')
    expect(events[0].text).toContain('not installed or not on PATH')
  })

})
