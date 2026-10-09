// api/test/workbench.test.ts — pins, runs and their logs, against a FAKE claude.
//
// The real CLI costs money and needs a login; what `core/workbench.ts` owns is
// the pin file, the detached run writing its own log, and the fold of that log
// into a transcript and a status. The fake records its argv and stdin and
// answers in stream-json, so every one of those is exercised as a process.

import { describe, test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkbench, pinId } from '../src/core/workbench.ts'

const SESSION = '5acea7bb-3850-44cf-81dc-97688510acda'
const tmp = mkdtempSync(join(tmpdir(), 'basecamp-workbench-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function repo(name: string) {
  const dir = join(tmp, 'repos', name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}

function fakeClaude({ sleep = 0, exit = 0 } = {}) {
  const bin = join(tmp, `claude-${Math.random().toString(36).slice(2)}`)
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs')
const input = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(bin + '.seen')}, JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd(), port: process.env.PORT ?? null }) + '\\n')
const out = l => process.stdout.write(JSON.stringify(l) + '\\n')
out({ type: 'system', subtype: 'init', session_id: ${JSON.stringify(SESSION)} })
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } }] } })
setTimeout(() => {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'did: ' + input }] } })
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.12, num_turns: 3 })
  process.exit(${exit})
}, ${sleep})
`)
  chmodSync(bin, 0o755)
  const seen = () => readFileSync(bin + '.seen', 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return { bin, seen }
}

async function until(fn: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await Bun.sleep(25) }
  throw new Error('timed out')
}

describe('pins', () => {

  test('a git checkout pins once; anything else is refused by name', () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-pins') })
    const dir = repo('alpha')
    const first = wb.pin(dir)
    expect('pin' in first && first.pin.id).toBe(pinId(dir))
    expect(wb.pin(dir)).toEqual(first)
    expect(wb.readPins()).toHaveLength(1)
    expect(wb.pin(tmp)).toEqual({ refused: expect.stringContaining('not a git checkout') })
    expect(wb.pin('relative/path')).toEqual({ refused: expect.stringContaining('not an absolute path') })
  })

  test('configure grades the budget and names; hooks is a boolean', () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-config') })
    const r = wb.pin(repo('beta'))
    if (!('pin' in r)) throw new Error(r.refused)
    expect(wb.configure(r.pin.id, { budget: 0 })).toEqual({ refused: expect.stringContaining('budget') })
    expect(wb.configure(r.pin.id, { budget: 25, hooks: true, name: ' Beta ' })).toMatchObject({ budget: 25, hooks: true, name: 'Beta' })
  })

})

describe('runs', () => {

  test('a message runs claude in the checkout, folds into a transcript, and the next one resumes', async () => {
    const { bin, seen } = fakeClaude()
    const wb = createWorkbench({ dir: join(tmp, 'wb-run'), bin, env: { PORT: 8120 } })
    const dir = repo('gamma')
    const r = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id

    expect(await wb.send(id, 'fix the tests')).toEqual({ queued: 0 })
    await until(async () => (await wb.status(wb.getPin(id)!)).state === 'done' && !wb.getPin(id)!.pid)

    const s = await wb.status(wb.getPin(id)!)
    expect(s).toMatchObject({ state: 'done', cost: 0.12, turns: 3, unread: true, tool: null })
    expect(wb.getPin(id)!.session).toBe(SESSION)

    const t = await wb.transcript(id)
    expect(t!.items.map(i => i.kind)).toEqual(['you', 'tool', 'text', 'result'])
    expect(t!.items[2]).toEqual({ kind: 'text', text: 'did: fix the tests' })
    expect(t!.resume).toContain(`claude --resume ${SESSION}`)

    const [call] = seen()
    expect(call.cwd).toBe(dir)
    expect(call.input).toBe('fix the tests')
    expect(call.argv).toContain('bypassPermissions')
    expect(call.argv).not.toContain('--resume')
    // This API's own PORT stays out of a run, or a dev server it starts takes it.
    expect(call.port).toBeNull()

    wb.seen(id)
    expect((await wb.status(wb.getPin(id)!)).unread).toBe(false)

    await wb.send(id, 'again')
    await until(async () => seen().length === 2 && !wb.getPin(id)!.pid)
    expect(seen()[1].argv.slice(-2)).toEqual(['--resume', SESSION])
  })

  test('a message sent while working queues, and runs when the first ends', async () => {
    const { bin, seen } = fakeClaude({ sleep: 300 })
    const wb = createWorkbench({ dir: join(tmp, 'wb-queue'), bin })
    const r = wb.pin(repo('delta'))
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id

    await wb.send(id, 'one')
    await until(async () => (await wb.status(wb.getPin(id)!)).tool === 'Bash bun test')
    expect(await wb.send(id, 'two')).toEqual({ queued: 1 })
    expect((await wb.status(wb.getPin(id)!)).queued).toBe(1)

    await until(async () => seen().length === 2 && !wb.getPin(id)!.pid && (await wb.status(wb.getPin(id)!)).state === 'done')
    expect(seen().map(c => c.input)).toEqual(['one', 'two'])
  })

  test('stop ends the run as an error the screen can say', async () => {
    const { bin } = fakeClaude({ sleep: 5000 })
    const wb = createWorkbench({ dir: join(tmp, 'wb-stop'), bin })
    const r = wb.pin(repo('epsilon'))
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id

    await wb.send(id, 'long one')
    await until(async () => (await wb.status(wb.getPin(id)!)).state === 'working' && !!wb.getPin(id)!.pid)
    expect(wb.stop(id)).toBe(true)
    await until(async () => !wb.getPin(id)!.pid)
    const s = await wb.status(wb.getPin(id)!)
    expect(s.state).toBe('error')
    expect((await wb.transcript(id))!.items.at(-1)).toEqual({ kind: 'error', text: 'Stopped.' })
  })

  test('a missing binary is an error in the transcript, not a silent idle', async () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-missing'), bin: join(tmp, 'no-such-claude') })
    const r = wb.pin(repo('zeta'))
    if (!('pin' in r)) throw new Error(r.refused)
    await wb.send(r.pin.id, 'hello')
    const said = async () => (await wb.transcript(r.pin.id))!.items.some(i => i.kind === 'error' && i.text.includes('not installed'))
    await until(said)
    expect((await wb.status(wb.getPin(r.pin.id)!)).state).toBe('error')
  })

  test('a new chat clears the session and the transcript, and a new API process reads the same log', async () => {
    const { bin } = fakeClaude()
    const dir = join(tmp, 'wb-fresh')
    const wb = createWorkbench({ dir, bin })
    const r = wb.pin(repo('eta'))
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    await wb.send(id, 'first')
    await until(async () => !wb.getPin(id)!.pid && (await wb.status(wb.getPin(id)!)).state === 'done')

    const restarted = createWorkbench({ dir, bin })
    expect((await restarted.transcript(id))!.items).toHaveLength(4)

    expect(wb.fresh(id)).toMatchObject({ session: null })
    expect((await wb.transcript(id))!.items).toEqual([])
    expect((await createWorkbench({ dir, bin }).transcript(id))!.items).toEqual([])
  })

})
