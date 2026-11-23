/*
 * test/session.test.ts — `Session`, one long-lived process, against a FAKE
 * `claude`: a script that answers `initialize`, echoes each consumed message
 * (`isReplay`), asks one `can_use_tool` when the message says ASK, and exits
 * mid-turn when it says DIE. The real program costs money and needs a login;
 * what its frames look like is `protocol.test.ts`'s replay of the recordings.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, type SessionEvent } from '../index.ts'

const dir = mkdtempSync(join(tmpdir(), 'frontierjs-claude-session-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const bin = join(dir, 'claude')
writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
fs.writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify({ argv: process.argv.slice(2), entry: process.env.CLAUDE_CODE_ENTRYPOINT ?? null, claudecode: process.env.CLAUDECODE ?? null }))
const answers = new Map()
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.type === 'control_request') {
    const r = m.request.subtype === 'initialize' ? { commands: [{ name: 'compact', description: 'Compact' }], models: [{ value: 'haiku', displayName: 'Haiku' }] }
      : m.request.subtype === 'get_context_usage' ? { totalTokens: 10, maxTokens: 100, percentage: 10 } : {}
    return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: r } })
  }
  if (m.type === 'control_response') { out(m); return answers.get(m.response.request_id)?.(m.response.response) }
  const text = m.message.content.map((b) => b.text).join('')
  out({ type: 'user', message: m.message, isReplay: true })
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'haiku', permissionMode: 'default', slash_commands: ['compact', 'review'] })
  if (text.includes('DIE')) { process.stderr.write('fell over\\n'); process.exit(3) }
  if (!text.includes('ASK')) return out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 })
  out({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1', permission_suggestions: [{ type: 'addRules' }] } })
  answers.set('p1', (d) => {
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: d.behavior !== 'allow', content: d.message ?? 'ok' }] } })
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 2 })
  })
})
`)
chmodSync(bin, 0o755)

function open(extra: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const events: SessionEvent[] = []
  const heard: Record<string, unknown[]> = { commands: [], models: [], usage: [], init: [] }
  let exited = 0
  const s = new Session({
    cwd: dir, command: bin, host: 'Testbed', env: { ...process.env, CLAUDECODE: '1' },
    onEvent: e => events.push(e),
    onCommands: c => heard.commands.push(c), onModels: m => heard.models.push(m),
    onUsage: u => heard.usage.push(u), onInit: i => heard.init.push(i),
    onExit: () => { exited++ },
    ...extra,
  })
  const until = async (type: string, n = 1) => {
    for (let i = 0; i < 200 && events.filter(e => e.type === type).length < n; i++) await Bun.sleep(10)
    return events.filter(e => e.type === type)
  }
  return { s, events, heard, until, exited: () => exited }
}

describe('a session', () => {
  test('a turn: the argv a live chat takes, the child labelled as the host\'s, the init and the lists heard, the end', async () => {
    const { s, until, heard, events } = open()
    s.send('hello')
    await until('end')
    expect(s.running).toBe(false)
    const seen = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'))
    expect(seen.argv).toContain('--replay-user-messages')
    expect(seen).toMatchObject({ entry: 'sdk-ts', claudecode: null })
    expect(events.map(e => e.type)).toEqual(['session', 'result', 'end'])
    expect(heard.init).toEqual([{ model: 'haiku', commands: ['compact', 'review'], skills: [] }])
    expect((heard.commands.at(-1) as { name: string }[]).map(c => c.name)).toEqual(['compact', 'review'])
    expect(heard.models).toEqual([[{ value: 'haiku', displayName: 'Haiku', efforts: [] }]])
    for (let i = 0; i < 50 && !heard.usage.length; i++) await Bun.sleep(10)
    expect(heard.usage).toEqual([{ total: 10, max: 100, percent: 10 }])
    s.end()
  })

  test('a prompt: carded with the host\'s addition, refused for a choice it cannot carry, answered once, the deny named', async () => {
    const { s, until, events } = open({ card: a => ({ seenBy: a.tool }) })
    s.send('ASK')
    const [perm] = await until('permission')
    expect(perm).toMatchObject({ request: 'p1', tool: 'Bash', text: 'ls', toolUse: 't1', card: { always: true, seenBy: 'Bash' } })
    expect(s.asking).toBe(true)
    expect(s.cards()).toEqual([{ request: 'p1', tool: 'Bash', always: true, seenBy: 'Bash' }])
    expect(() => s.answer('p1', 'maybe')).toThrow('allow or deny')
    expect(() => s.answer('p1', 'allow', undefined, { answers: { x: 'y' } })).toThrow('AskUserQuestion')
    expect(s.answer('p1', 'deny', 'not now')).toEqual({ behavior: 'deny', message: 'The person using Testbed denied this Bash call, so it did not run. Their note: not now' })
    expect(() => s.answer('p1', 'allow')).toThrow('not waiting')
    await until('end')
    expect(events.filter(e => e.type === 'answered')).toEqual([{ type: 'answered', request: 'p1', behavior: 'deny' }])
    expect(events.find(e => e.type === 'refused')).toMatchObject({ id: 't1' })
    s.end()
  })

  test('a process that dies mid-turn: the error with its stderr, the end, the host told first', async () => {
    const { s, until, events, exited } = open()
    s.send('DIE')
    await until('end')
    expect(exited()).toBe(1)
    expect(events.find(e => e.type === 'error')).toMatchObject({ text: expect.stringContaining('exited mid-turn (code 3): fell over') })
    expect(s.running).toBe(false)
  })

  test('a program that is not there says so, and ending a session on purpose reports no death', async () => {
    const gone = open({ command: join(dir, 'nothing') })
    gone.s.send('hello')
    expect((await gone.until('error'))[0]).toMatchObject({ text: `${join(dir, 'nothing')} is not installed or not on PATH` })
    const quiet = open()
    quiet.s.end()
    for (let i = 0; i < 100 && !quiet.exited(); i++) await Bun.sleep(10)
    expect(quiet.exited()).toBe(1)
    expect(quiet.events).toEqual([])
  })
})
