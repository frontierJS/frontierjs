// api/test/workbench.test.ts — pins, runs and their logs, against a FAKE claude.
//
// The real CLI costs money and needs a login; what `core/workbench.ts` owns is
// the pin file, the detached run writing its own log, and the fold of that log
// into a transcript and a status. The fake records its argv and stdin and
// answers in stream-json, so every one of those is exercised as a process.

import { describe, test, expect, afterAll } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkbench, pinId } from '../src/core/workbench.ts'
import { parseUnifiedDiff, readDiff } from '../src/core/workbench-diff.ts'

const SESSION = '5acea7bb-3850-44cf-81dc-97688510acda'
const tmp = mkdtempSync(join(tmpdir(), 'basecamp-workbench-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function repo(name: string, { done = null as string | null } = {}) {
  const dir = join(tmp, 'repos', name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  // A stand-in for the checkout's own `fli done`: the workbench runs whatever
  // packages/cli/core/done.js the checkout carries, in a process of its own.
  if (done) {
    mkdirSync(join(dir, 'packages', 'cli', 'core'), { recursive: true })
    writeFileSync(join(dir, 'packages', 'cli', 'core', 'done.js'), done)
  }
  return dir
}

const UNFINISHED_DONE = `export function runDone(root) {
  return { root, changed: 2, unfinished: 1,
    items:  [{ check: 'snapshots', subject: 'a.snapshot.md', ok: false, message: 'a.snapshot.md is stale' }],
    drives: [{ changed: 'a service', tier: 'path', on: ['x.ts'], run: ['cd api && bun run verify'] }] }
}
`

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

describe('running cost', () => {

  test('a card totals every run, today included, and a new chat keeps the total', async () => {
    const { bin } = fakeClaude()
    const wb = createWorkbench({ dir: join(tmp, 'wb-cost'), bin })
    const r = wb.pin(repo('cost'))
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    const idle = async () => !wb.getPin(id)!.pid && (await wb.status(wb.getPin(id)!)).state === 'done'

    await wb.send(id, 'one')
    await until(idle)
    await wb.send(id, 'two')
    await until(async () => (await wb.transcript(id))!.items.filter(i => i.kind === 'result').length === 2 && await idle())

    const s = await wb.status(wb.getPin(id)!)
    expect(s.spent.total).toBeCloseTo(0.24)
    expect(s.spent.today).toBeCloseTo(0.24)

    wb.fresh(id)
    expect((await wb.status(wb.getPin(id)!)).spent.total).toBeCloseTo(0.24)
  })

})

describe('checks', () => {

  test('a run ending runs the checkout\'s own fli done, and its report reaches the card', async () => {
    const { bin } = fakeClaude()
    const wb = createWorkbench({ dir: join(tmp, 'wb-checks'), bin })
    const r = wb.pin(repo('checked', { done: UNFINISHED_DONE }))
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id

    await wb.send(id, 'change things')
    await until(async () => ['fail', 'pass', 'error'].includes((await wb.status(wb.getPin(id)!)).checks?.state ?? ''), 10000)

    const s = await wb.status(wb.getPin(id)!)
    expect(s.checks).toMatchObject({ state: 'fail', changed: 2, unfinished: 1, drives: 1 })
    const t = await wb.transcript(id)
    expect(t!.checks!.report!.items[0].message).toBe('a.snapshot.md is stale')
    expect(t!.checks!.report!.drives[0].run).toEqual(['cd api && bun run verify'])
  })

  test('the next message makes the last checks stale, so the card does not show them', async () => {
    const { bin } = fakeClaude({ sleep: 400 })
    const wb = createWorkbench({ dir: join(tmp, 'wb-stale'), bin })
    const r = wb.pin(repo('stale', { done: UNFINISHED_DONE }))
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id

    expect(wb.check(id)).toMatchObject({ started: expect.any(String) })
    await until(async () => (await wb.status(wb.getPin(id)!)).checks?.state === 'fail', 10000)
    await Bun.sleep(5)
    await wb.send(id, 'more')
    expect((await wb.status(wb.getPin(id)!)).checks).toBeNull()
    expect(wb.check(id)).toEqual({ refused: expect.stringContaining('still working') })
  })

  test('a checkout with no fli done is refused a check by name, and a run there starts none', async () => {
    const { bin } = fakeClaude()
    const wb = createWorkbench({ dir: join(tmp, 'wb-nodone'), bin })
    const r = wb.pin(repo('plain'))
    if (!('pin' in r)) throw new Error(r.refused)
    expect(wb.check(r.pin.id)).toEqual({ refused: expect.stringContaining('carries no fli done') })
    await wb.send(r.pin.id, 'hi')
    await until(async () => !wb.getPin(r.pin.id)!.pid && (await wb.status(wb.getPin(r.pin.id)!)).state === 'done')
    expect((await wb.status(wb.getPin(r.pin.id)!)).checks).toBeNull()
  })

})

describe('review', () => {

  test('a pin that asks for review gets a fresh READ-ONLY session after each finished run', async () => {
    const { bin, seen } = fakeClaude()
    const wb = createWorkbench({ dir: join(tmp, 'wb-review'), bin })
    const r = wb.pin(repo('reviewed'))
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    wb.configure(id, { review: true })

    await wb.send(id, 'add the thing')
    await until(async () => (await wb.status(wb.getPin(id)!)).review?.state === 'done' && !wb.getPin(id)!.reviewPid)

    const [, reviewer] = seen()
    // Read-only by argv, which no text in the prompt reaches.
    expect(reviewer.argv).not.toContain('bypassPermissions')
    expect(reviewer.argv).toContain('--tools')
    expect(reviewer.argv).not.toContain('--resume')
    expect(reviewer.input).toContain('read-only')
    expect(reviewer.input).toContain('add the thing')

    const t = await wb.transcript(id)
    expect(t!.review!.items.map(i => i.kind)).toEqual(['tool', 'text', 'result'])
    expect((await wb.status(wb.getPin(id)!)).spent.total).toBeCloseTo(0.24)
  })

  test('a manual review waits for the run, and a pin that did not ask gets none', async () => {
    const { bin, seen } = fakeClaude({ sleep: 300 })
    const wb = createWorkbench({ dir: join(tmp, 'wb-review-manual'), bin })
    const r = wb.pin(repo('unreviewed'))
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id

    await wb.send(id, 'go')
    await until(async () => !!wb.getPin(id)!.pid)
    expect(await wb.review(id)).toEqual({ refused: expect.stringContaining('still working') })
    await until(async () => !wb.getPin(id)!.pid && (await wb.status(wb.getPin(id)!)).state === 'done')
    expect(seen()).toHaveLength(1)
    expect((await wb.status(wb.getPin(id)!)).review).toBeNull()

    expect(await wb.review(id)).toMatchObject({ started: expect.any(String) })
    await until(async () => (await wb.status(wb.getPin(id)!)).review?.state === 'done')
  })

})

describe('diff', () => {

  test('a removed line reading "-- x" stays a removed line, and line numbers follow each side', () => {
    const files = parseUnifiedDiff([
      'diff --git a/a.sql b/a.sql',
      'index 1..2 100644',
      '--- a/a.sql',
      '+++ b/a.sql',
      '@@ -1,3 +1,3 @@',
      ' keep',
      '--- x',
      '+select 1',
      ' tail',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      '\\ No newline at end of file',
    ].join('\n'))
    expect(files.map(f => [f.path, f.status, f.adds, f.dels])).toEqual([['a.sql', 'modified', 1, 1], ['new.txt', 'added', 1, 0]])
    expect(files[0].hunks[0].lines).toEqual([
      { kind: 'ctx', text: 'keep',     old: 1,    new: 1 },
      { kind: 'del', text: '-- x',     old: 2,    new: null },
      { kind: 'add', text: 'select 1', old: null, new: 2 },
      { kind: 'ctx', text: 'tail',     old: 3,    new: 3 },
    ])
  })

  test('a real checkout: tracked edits and untracked files, each as the tree holds it', () => {
    const dir = join(tmp, 'repos', 'git-real')
    mkdirSync(dir, { recursive: true })
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'ignore' })
    git('init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(dir, 'b.txt'), 'new\nfile\n')
    writeFileSync(join(dir, 'c.bin'), Buffer.from([0, 1, 2]))

    const d = readDiff(dir)
    expect(d.total).toBe(3)
    expect(d.cut).toBe(false)
    const byPath = Object.fromEntries(d.files.map(f => [f.path, f]))
    expect(byPath['a.txt']).toMatchObject({ status: 'modified', adds: 1, dels: 1 })
    expect(byPath['b.txt']).toMatchObject({ status: 'untracked', adds: 2, dels: 0 })
    expect(byPath['b.txt'].hunks[0].lines.map(l => l.new)).toEqual([1, 2])
    expect(byPath['c.bin']).toMatchObject({ status: 'binary', hunks: [] })
  })

})
