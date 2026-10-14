// api/test/workbench.test.ts — pins, runs and their logs, against a FAKE claude.
//
// The real CLI costs money and needs a login; what `core/workbench.ts` owns is
// the pin file, the detached run writing its own log, and the fold of that log
// into a transcript and a status. The fake records its argv and stdin and
// answers in stream-json, so every one of those is exercised as a process.

import { describe, test, expect, afterAll } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkbench, pinId, shownPlan } from '../src/core/workbench.ts'
import { treeOf } from '../src/core/workbench-branch.ts'
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
    expect(wb.getPin(id)!.chats[0].session).toBe(SESSION)

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

  test('a pin whose folder was renamed refuses every run by its path and still unpins', async () => {
    const wb  = createWorkbench({ dir: join(tmp, 'wb-gone'), bin: fakeClaude().bin })
    const dir = repo('gone', { done: UNFINISHED_DONE })
    const r   = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    rmSync(dir, { recursive: true, force: true })

    const gone = { refused: expect.stringContaining(`'${dir}' is no longer there`) }
    expect(await wb.send(r.pin.id, 'hello')).toEqual(gone)
    expect(wb.check(r.pin.id)).toEqual(gone)
    expect(await wb.review(r.pin.id)).toEqual(gone)
    expect(await wb.fork(r.pin.id)).toEqual(gone)
    expect(wb.unpin(r.pin.id)).toBeNull()
    expect(wb.getPin(r.pin.id)).toBeNull()
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

  test('a new chat is shown beside the old one, which keeps its transcript, and a new API process reads both', async () => {
    const { bin, seen } = fakeClaude()
    const dir = join(tmp, 'wb-fresh')
    const wb = createWorkbench({ dir, bin })
    const r = wb.pin(repo('eta'))
    if (!('pin' in r)) throw new Error(r.refused)
    const id    = r.pin.id
    const first = r.pin.chat
    await wb.send(id, 'first')
    await until(async () => !wb.getPin(id)!.pid && (await wb.status(wb.getPin(id)!)).state === 'done')

    const restarted = createWorkbench({ dir, bin })
    expect((await restarted.transcript(id))!.items).toHaveLength(4)

    const p = (await wb.fresh(id))!
    expect(p.chats).toHaveLength(2)
    expect(p.chat).not.toBe(first)
    expect(p.chats[1]).toMatchObject({ session: null, forkOf: null })
    // A second New chat on the empty one opens no third.
    expect((await wb.fresh(id))!.chats).toHaveLength(2)

    expect((await wb.transcript(id))!.items).toEqual([])
    expect((await wb.transcript(id, first))!.items).toHaveLength(4)
    expect(await wb.transcript(id, 'nope')).toBeNull()
    expect((await createWorkbench({ dir, bin }).transcript(id))!.items).toEqual([])

    const s = await wb.status(wb.getPin(id)!)
    expect(s.chat).toBe(p.chat)
    expect(s.chats.map(c => [c.title, c.state])).toEqual([['first', 'done'], [null, 'idle']])

    // The new chat starts a session; the old one, shown again, resumes its own.
    await wb.send(id, 'second')
    await until(async () => seen().length === 2 && !wb.getPin(id)!.pid)
    expect(seen()[1].argv).not.toContain('--resume')
    expect(wb.select(id, first)).toMatchObject({ chat: first })
    expect(wb.select(id, 'nope')).toEqual({ refused: expect.stringContaining("no chat 'nope'") })
    await wb.send(id, 'third')
    await until(async () => seen().length === 3 && !wb.getPin(id)!.pid)
    expect(seen()[2].argv.slice(-2)).toEqual(['--resume', SESSION])
  })

  test('one run at a time in a checkout: another chat is refused, the running one queues', async () => {
    const { bin, seen } = fakeClaude({ sleep: 400 })
    const wb = createWorkbench({ dir: join(tmp, 'wb-one-run'), bin })
    const r = wb.pin(repo('theta'))
    if (!('pin' in r)) throw new Error(r.refused)
    const id    = r.pin.id
    const first = r.pin.chat

    await wb.send(id, 'long one')
    await until(async () => (await wb.status(wb.getPin(id)!)).state === 'working' && !!wb.getPin(id)!.pid)
    const other = (await wb.fresh(id))!.chat
    expect(await wb.send(id, 'meanwhile')).toEqual({ refused: expect.stringContaining('one run at a time') })
    expect(await wb.send(id, 'after', first)).toEqual({ queued: 1 })
    expect(await wb.close(id, first)).toEqual({ refused: expect.stringContaining('working') })

    const s = await wb.status(wb.getPin(id)!)
    expect(s).toMatchObject({ state: 'working', chat: other, running: first })
    expect(s.chats.map(c => c.state)).toEqual(['working', 'idle'])

    // The fake writes what it saw only once it has started.
    await until(async () => !wb.getPin(id)!.pid && (await wb.status(wb.getPin(id)!)).state === 'done' && seen().length === 2)
    expect((await wb.transcript(id, first))!.items.filter(i => i.kind === 'you').map(i => i.kind === 'you' && i.text)).toEqual(['long one', 'after'])
    expect(await wb.send(id, 'now')).toEqual({ queued: 0 })
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

    await wb.fresh(id)
    expect((await wb.status(wb.getPin(id)!)).spent.total).toBeCloseTo(0.24)
    // Closing the chat that spent it keeps it in the total.
    const p = wb.getPin(id)!
    expect(await wb.close(id, p.chats[0].id)).toMatchObject({ chats: [{ id: p.chat }] })
    expect((await wb.status(wb.getPin(id)!)).spent.total).toBeCloseTo(0.24)
    expect(await wb.close(id, p.chat)).toEqual({ refused: expect.stringContaining('one chat') })
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

describe('the plan', () => {

  test('a pin has no plan until Build plan names one, and a bad path or no goal is refused by name', async () => {
    const { bin } = fakeClaude()
    const wb = createWorkbench({ dir: join(tmp, 'wb-plan-refuse'), bin })
    const r = wb.pin(repo('plan-refuse'))
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    expect(wb.getPin(id)!.plan).toBeNull()
    expect(await wb.readPlan(id)).toBeNull()
    expect(await wb.buildPlan(id, { goal: '', path: 'PLAN.md' })).toEqual({ refused: expect.stringContaining('what the plan is for') })
    expect(await wb.buildPlan(id, { goal: 'x' })).toEqual({ refused: expect.stringContaining('name the plan') })
    expect(await wb.buildPlan(id, { goal: 'x', path: '../PLAN.md' })).toEqual({ refused: expect.stringContaining('not a path inside') })
    expect(await wb.buildPlan(id, { goal: 'x', path: '/etc/PLAN.md' })).toEqual({ refused: expect.stringContaining('not a path inside') })
    expect(await wb.buildPlan(id, { goal: 'x', path: 'PLAN.txt' })).toEqual({ refused: expect.stringContaining('not a markdown file') })
    expect(wb.getPin(id)!.plan).toBeNull()
    expect(existsSync(bin + '.seen')).toBe(false)
  })

  test('Build plan: a new chat that may edit the plan file and nothing else, and the plan reads off the file', async () => {
    const { bin, seen } = fakeClaude()
    const wb = createWorkbench({ dir: join(tmp, 'wb-plan-build'), bin })
    const dir = repo('plan-build')
    const r = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    await wb.send(id, 'earlier work')
    await until(async () => !wb.getPin(id)!.pid && (await wb.status(wb.getPin(id)!)).state === 'done')

    const built = await wb.buildPlan(id, { goal: 'ship the widget', path: 'IDEAS/widget.md' })
    if (!('chat' in built)) throw new Error(built.refused)
    expect(built.chat).not.toBe(r.pin.chat)
    expect(wb.getPin(id)).toMatchObject({ chat: built.chat, plan: 'IDEAS/widget.md', plans: [{ path: 'IDEAS/widget.md', steps: {} }] })
    await until(async () => seen().length === 2 && !wb.getPin(id)!.pid)

    const run = seen()[1]
    expect(run.cwd).toBe(dir)
    expect(run.argv).not.toContain('--resume')
    expect(run.argv[run.argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(run.argv.filter((a: string) => a.startsWith('Edit('))).toEqual([`Edit(/${dir}/IDEAS/widget.md)`, `Edit(/${dir}/IDEAS/widget.md/**)`])
    expect(run.input).toContain('ship the widget')
    expect(run.input).toContain('`IDEAS/widget.md`')

    // The session has not written it: the plan is the path, parsed as nothing.
    expect(await wb.readPlan(id)).toEqual({ path: 'IDEAS/widget.md', steps: {}, sections: [], parsed: null })

    mkdirSync(join(dir, 'IDEAS'), { recursive: true })
    writeFileSync(join(dir, 'IDEAS', 'widget.md'), [
      '# Widget', '', '## Plan', '',
      '### Phase 0 — Groundwork', '', 'Goal: a widget.', 'Done when: it renders.', '',
      '- [x] 0.1 Draw it', '  - drawn', '- [ ] 0.2 Ship it', '',
    ].join('\n'))
    const plan = (await wb.readPlan(id))!
    expect(plan.parsed!.title).toBe('Widget')
    expect(plan.parsed!.next).toMatchObject({ id: '0.2', title: 'Ship it' })
    expect(plan.parsed!.steps.map((s: { id: string, box: string }) => [s.id, s.box])).toEqual([['0.1', 'done'], ['0.2', 'open']])
  })

  const PLAN = [
    '# Widget', '', '## Plan', '',
    '### Phase 0 — Groundwork', '', 'Goal: a widget.', 'Done when: it renders.', '',
    '- [x] 0.1 Draw it', '  - drawn', '- [ ] 0.2 Ship it', '',
  ]

  test('Go refuses with no plan, an unwritten one, a finished one, and while a run is live', async () => {
    const { bin, seen } = fakeClaude({ sleep: 300 })
    const wb = createWorkbench({ dir: join(tmp, 'wb-go-refuse'), bin })
    const dir = repo('go-refuse')
    const r = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    expect(await wb.go(id)).toEqual({ refused: expect.stringContaining('has no plan') })

    await wb.buildPlan(id, { goal: 'x', path: 'PLAN.md' })
    expect(await wb.go(id)).toEqual({ refused: expect.stringContaining('working') })
    await until(async () => !wb.getPin(id)!.pid)
    expect(await wb.go(id)).toEqual({ refused: expect.stringContaining('nothing is written at PLAN.md') })

    writeFileSync(join(dir, 'PLAN.md'), PLAN.join('\n').replace('- [ ] 0.2', '- [x] 0.2'))
    expect(await wb.go(id)).toEqual({ refused: expect.stringContaining('every step of PLAN.md is done') })
    expect(seen()).toHaveLength(1)
    expect(shownPlan(wb.getPin(id)!)!.steps).toEqual({})
  })

  test('Go: the first open box\'s step prompt in the shown chat, recorded with the registers\' high-water marks', async () => {
    const { bin, seen } = fakeClaude()
    const wb = createWorkbench({ dir: join(tmp, 'wb-go'), bin })
    const dir = repo('go')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'go', registers: { prefix: 'GO' } }))
    writeFileSync(join(dir, 'ISSUES.md'), [
      '# Issues', '', '## S3 — medium', '',
      '| Id | Area | Title | Status | Verified | Detail |', '| --- | --- | --- | --- | --- | --- |',
      '| <a id="go-041"></a>GO-041 | api | **A thing** | open | 2026-10-01 | — |', '',
    ].join('\n'))
    writeFileSync(join(dir, 'DECISIONS.md'), '# Decisions\n\n## GO-D7 — A ruling\n')
    const r = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    const built = await wb.buildPlan(id, { goal: 'ship the widget', path: 'PLAN.md' })
    if (!('chat' in built)) throw new Error(built.refused)
    await until(async () => existsSync(bin + '.seen') && !wb.getPin(id)!.pid)
    writeFileSync(join(dir, 'PLAN.md'), [...PLAN.slice(0, -1), '- [ ] 0.3 Tell people', ''].join('\n'))

    const before = Date.now()
    expect(await wb.go(id)).toEqual({ step: '0.2', chat: built.chat })
    await until(async () => seen().length === 2 && !wb.getPin(id)!.pid)

    const run = seen()[1]
    expect(run.argv[run.argv.indexOf('--resume') + 1]).toBe(SESSION)
    expect(run.argv.some((a: string) => a.startsWith('Edit('))).toBe(false)
    expect(run.input).toContain('Carry out step 0.2 of the plan at `PLAN.md`: Ship it')
    expect(run.input).toContain('Phase 0 — Groundwork, done when: it renders.')
    expect(run.input).toContain('Commit nothing.')

    const step = shownPlan(wb.getPin(id)!)!.steps['0.2']
    expect(step).toEqual({ chat: built.chat, startedAt: expect.any(String), registerHigh: { issue: 41, decision: 7 } })
    expect(Date.parse(step.startedAt)).toBeGreaterThanOrEqual(before - 1000)
    expect((await wb.readPlan(id))!.steps).toEqual({ '0.2': { ...step, cost: 0.12, turns: 3, filed: [] } })

    // A row numbered above a step's marks is the step's, up to the next step's marks.
    const file = (row: string) => writeFileSync(join(dir, 'ISSUES.md'),
      readFileSync(join(dir, 'ISSUES.md'), 'utf8').replace('| --- | --- | --- | --- | --- | --- |', `| --- | --- | --- | --- | --- | --- |\n${row}`))
    file('| <a id="go-042"></a>GO-042 | api | **Found in 0.2** | open | 2026-10-13 | — |')
    expect((await wb.readPlan(id))!.steps['0.2'].filed).toEqual([
      { id: 'GO-042', kind: 'issue', title: 'Found in 0.2', severity: 'S3', status: 'open', file: 'ISSUES.md', line: 7 },
    ])
    expect(await wb.tick(id, '0.2')).toEqual({ step: '0.2' })
    expect(await wb.go(id)).toMatchObject({ step: '0.3' })
    await until(async () => !wb.getPin(id)!.pid)
    file('| <a id="go-043"></a>GO-043 | api | **Found in 0.3** | open | 2026-10-13 | — |')
    const steps = (await wb.readPlan(id))!.steps
    expect(steps['0.2'].filed.map(r => r.id)).toEqual(['GO-042'])
    expect(steps['0.3'].filed.map(r => r.id)).toEqual(['GO-043'])
  })

  test('File: an issue and a question through fli\'s fileIssue, each the step\'s that is running', async () => {
    const { bin } = fakeClaude({ sleep: 300 })
    const wb = createWorkbench({ dir: join(tmp, 'wb-file'), bin })
    const dir = repo('file')
    const r = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    const row = { severity: 'S3', area: 'web', title: 'The tab', detail: 'It wraps.' }
    expect(await wb.file(id, row)).toEqual({ refused: expect.stringContaining('registers.prefix') })

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'file', registers: { prefix: 'FI' } }))
    writeFileSync(join(dir, 'ISSUES.md'), [
      '# Issues', '', '## Needs a decision', '',
      '| Id | Area | Question | Detail |', '| --- | --- | --- | --- |', '',
      '## S3 — medium', '',
      '| Id | Area | Title | Status | Verified | Detail |', '| --- | --- | --- | --- | --- | --- |',
      '| <a id="fi-001"></a>FI-001 | api | **Before** | open | 2026-10-01 | — |', '',
    ].join('\n'))
    await wb.buildPlan(id, { goal: 'x', path: 'PLAN.md' })
    await until(async () => !wb.getPin(id)!.pid)
    writeFileSync(join(dir, 'PLAN.md'), PLAN.join('\n'))
    expect(await wb.go(id)).toMatchObject({ step: '0.2' })

    // Filed while the step runs: by number, the step's.
    expect(await wb.file(id, row)).toEqual({ id: 'FI-002', file: 'ISSUES.md', line: 12 })
    expect(await wb.file(id, { ...row, severity: 'decision', title: 'Which tab?' })).toEqual({ id: 'FI-D1', file: 'ISSUES.md', line: 7 })
    expect(await wb.file(id, { ...row, severity: 'S9' })).toEqual({ refused: expect.stringContaining('S1, S2, S3, S4, decision') })
    expect(await wb.file(id, { ...row, area: ' ' })).toEqual({ refused: expect.stringContaining('area is required') })
    expect(readFileSync(join(dir, 'ISSUES.md'), 'utf8')).toContain('| <a id="fi-002"></a>FI-002 | web | **The tab** | open |')
    await until(async () => !wb.getPin(id)!.pid)
    expect((await wb.readPlan(id))!.steps['0.2'].filed.map(f => [f.id, f.kind])).toEqual([['FI-D1', 'question'], ['FI-002', 'issue']])
  })

  test('a step costs the runs in its chat from its Go to the next Go there, and nothing once the chat is closed', async () => {
    const { bin } = fakeClaude()
    const wb = createWorkbench({ dir: join(tmp, 'wb-step-cost'), bin })
    const dir = repo('step-cost')
    const r = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    const idle = () => until(async () => !wb.getPin(id)!.pid)
    // The Build plan run is in the same chat and before the Go: not the step's.
    await wb.buildPlan(id, { goal: 'x', path: 'PLAN.md' })
    await idle()
    writeFileSync(join(dir, 'PLAN.md'), [...PLAN.slice(0, -1), '- [ ] 0.3 Tell people', ''].join('\n'))

    expect(await wb.go(id)).toMatchObject({ step: '0.2' })
    expect((await wb.readPlan(id))!.steps['0.2']).toMatchObject({ cost: null, turns: null })
    await idle()
    // The owner's answer in that chat is the step's too.
    await wb.send(id, 'and the docs')
    await idle()
    expect((await wb.readPlan(id))!.steps['0.2']).toMatchObject({ cost: 0.24, turns: 6 })

    expect(await wb.tick(id, '0.2')).toEqual({ step: '0.2' })
    expect(await wb.go(id)).toMatchObject({ step: '0.3' })
    await idle()
    const steps = (await wb.readPlan(id))!.steps
    expect(steps['0.2']).toMatchObject({ cost: 0.24, turns: 6 })
    expect(steps['0.3']).toMatchObject({ cost: 0.12, turns: 3 })

    const chat = wb.getPin(id)!.chat
    await wb.fresh(id)
    expect(await wb.close(id, chat)).toMatchObject({ chats: [expect.anything()] })
    expect((await wb.readPlan(id))!.steps['0.2']).toMatchObject({ cost: null, turns: null })
  })

  test('Next: the next box in a new chat, handed the plan\'s path and the last reply, and refused while a question is open until a letter rules it', async () => {
    const { bin, seen } = fakeClaude({ sleep: 200 })
    const wb = createWorkbench({ dir: join(tmp, 'wb-next'), bin })
    const dir = repo('next')
    const r = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    const idle = () => until(async () => !wb.getPin(id)!.pid)
    expect(await wb.next(id)).toEqual({ refused: expect.stringContaining('has no plan') })
    const built = await wb.buildPlan(id, { goal: 'x', path: 'PLAN.md' })
    if (!('chat' in built)) throw new Error(built.refused)
    await idle()
    writeFileSync(join(dir, 'PLAN.md'), [
      ...PLAN.slice(0, -1), '- [ ] 0.3 Tell people', '',
      '## Open questions (owner)', '',
      '- **Q1 — Which colour is the widget?**', '  - **A** — red.', '  - **B** — blue.', '  - **Recommend A** — it shows.',
      '- ~~**Q2 — Does it ship?**~~ **Answered 2026-10-13: A — yes.**', '',
    ].join('\n'))

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'next', registers: { prefix: 'NX' } }))
    writeFileSync(join(dir, 'DECISIONS.md'), '# Decisions\n\n## Widgets\n\n## Open (discussed, not yet ruled)\n')
    const Q1 = 'PLAN:q1-which-colour-is-the-widget'

    expect(await wb.go(id)).toMatchObject({ step: '0.2' })
    expect(await wb.next(id)).toEqual({ refused: expect.stringContaining('Next starts the next step once it is done') })
    expect(await wb.decide(id, { question: Q1, pick: 'A', section: 'Widgets' })).toEqual({ refused: expect.stringContaining('answer once it stops') })
    await idle()
    writeFileSync(join(dir, 'PLAN.md'), readFileSync(join(dir, 'PLAN.md'), 'utf8').replace('- [ ] 0.2', '- [x] 0.2'))

    // The step ended on a question: the status carries it, and seeing the
    // chat does not take it away — only a ruling does.
    const asked = { plan: 'PLAN.md', id: Q1, question: 'Q1 — Which colour is the widget?' }
    expect((await wb.status(wb.getPin(id)!)).questions).toEqual([asked])
    wb.seen(id)
    expect(await wb.status(wb.getPin(id)!)).toMatchObject({ unread: false, questions: [asked] })

    const chats = wb.getPin(id)!.chats.length
    expect(await wb.next(id)).toEqual({ refused: 'PLAN.md has an open question — rule it before Next: Q1 — Which colour is the widget?' })
    expect(wb.getPin(id)!.chats.length).toBe(chats)
    expect(shownPlan(wb.getPin(id)!)!.steps['0.3']).toBeUndefined()

    // A letter is fli's decide over PLAN.md, which no register source reads.
    const read = (await wb.readPlan(id))!
    expect(read.sections).toEqual(['Widgets'])
    expect(read.parsed!.blocking.map((q: { id: string }) => q.id)).toEqual([Q1])
    expect(await wb.decide(id, { question: Q1, pick: 'B', section: 'Widgets' })).toEqual({ refused: expect.stringContaining('not the recommendation') })
    expect(await wb.decide(id, { question: Q1, pick: 'A', section: 'Nope' })).toEqual({ refused: expect.stringContaining('no section named') })
    expect(await wb.decide(id, { question: Q1, pick: 'A', section: 'Widgets' })).toEqual({ ruling: 'NX-D1', pick: 'A', files: ['DECISIONS.md', 'PLAN.md'] })
    expect(readFileSync(join(dir, 'PLAN.md'), 'utf8')).toContain('- ~~**Q1 — Which colour is the widget?**~~ **Answered ')
    expect(readFileSync(join(dir, 'DECISIONS.md'), 'utf8')).toContain('`NX-D1` — Q1 — Which colour is the widget — Red.')
    expect(await wb.decide(id, { question: Q1, pick: 'A', section: 'Widgets' })).toEqual({ refused: `${Q1} is already ruled` })
    expect((await wb.status(wb.getPin(id)!)).questions).toEqual([])
    // By number the ruling is 0.2's: it answers the question that step stopped on.
    expect((await wb.readPlan(id))!.steps['0.2'].filed).toEqual([expect.objectContaining({ id: 'NX-D1', kind: 'ruling' })])

    const next = await wb.next(id)
    if (!('chat' in next)) throw new Error(next.refused)
    expect(next.step).toBe('0.3')
    expect(next.chat).not.toBe(built.chat)
    expect(wb.getPin(id)!.chat).toBe(next.chat)
    await idle()

    const run = seen()[2]
    expect(run.argv).not.toContain('--resume')
    expect(run.input).toStartWith('This is a fresh session continuing the plan at `PLAN.md`.')
    // The stand-in's reply to the Go is `did: ` and the prompt it was sent.
    expect(run.input).toContain("The last session's reply:\n\ndid: Carry out step 0.2 of the plan at `PLAN.md`")
    expect(run.input).not.toContain('Which colour is the widget?')
    expect(run.input).not.toContain('Does it ship?')
    expect(run.input).toContain('Carry out step 0.3 of the plan at `PLAN.md`: Tell people')
    expect(shownPlan(wb.getPin(id)!)!.steps['0.3']).toEqual({ chat: next.chat, startedAt: expect.any(String), registerHigh: { issue: 0, decision: 1 } })
    expect((await wb.readPlan(id))!.steps['0.3']).toMatchObject({ cost: 0.12, turns: 3 })
  })

  test('Tick: a box the Go\'d run left open, ticked by hand once the run ends, and no other box', async () => {
    const { bin } = fakeClaude({ sleep: 300 })
    const wb = createWorkbench({ dir: join(tmp, 'wb-tick'), bin })
    const dir = repo('tick')
    const r = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    await wb.buildPlan(id, { goal: 'x', path: 'PLAN.md' })
    await until(async () => !wb.getPin(id)!.pid)
    writeFileSync(join(dir, 'PLAN.md'), PLAN.join('\n'))
    expect(await wb.tick(id, '0.2')).toEqual({ refused: expect.stringContaining('Go did not start step \'0.2\'') })

    expect(await wb.go(id)).toMatchObject({ step: '0.2' })
    expect(await wb.tick(id, '0.2')).toEqual({ refused: expect.stringContaining('may still tick 0.2 itself') })
    await until(async () => !wb.getPin(id)!.pid)

    // The stand-in ticks nothing: the box did not move.
    expect((await wb.readPlan(id))!.parsed!.next).toMatchObject({ id: '0.2', box: 'open' })
    expect(await wb.tick(id, '0.1')).toEqual({ refused: expect.stringContaining('Go did not start step \'0.1\'') })
    expect(await wb.tick(id, '0.2')).toEqual({ step: '0.2' })
    expect(readFileSync(join(dir, 'PLAN.md'), 'utf8')).toBe(PLAN.join('\n').replace('- [ ] 0.2', '- [x] 0.2'))
    expect((await wb.readPlan(id))!.parsed!.next).toBeNull()
    expect(await wb.tick(id, '0.2')).toEqual({ refused: expect.stringContaining('0.2 is not an open box in PLAN.md') })
  })

  test('several plans: one shown, Go and tick act on it, and a step\'s rows and runs stop at the next step of any plan', async () => {
    const { bin } = fakeClaude({ sleep: 300 })
    const wb = createWorkbench({ dir: join(tmp, 'wb-plans'), bin })
    const dir = repo('plans')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plans', registers: { prefix: 'SP' } }))
    writeFileSync(join(dir, 'ISSUES.md'), [
      '# Issues', '', '## S3 — medium', '',
      '| Id | Area | Title | Status | Verified | Detail |', '| --- | --- | --- | --- | --- | --- |',
      '| <a id="sp-041"></a>SP-041 | api | **A thing** | open | 2026-10-01 | — |', '',
    ].join('\n'))
    writeFileSync(join(dir, 'PLAN.md'), PLAN.join('\n'))
    mkdirSync(join(dir, 'IDEAS'))
    writeFileSync(join(dir, 'IDEAS', 'b.md'), PLAN.join('\n'))
    const r = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    const idle = () => until(async () => !wb.getPin(id)!.pid)
    const file = (row: string) => writeFileSync(join(dir, 'ISSUES.md'),
      readFileSync(join(dir, 'ISSUES.md'), 'utf8').replace('| --- | --- | --- | --- | --- | --- |', `| --- | --- | --- | --- | --- | --- |\n${row}`))

    expect(wb.openPlan(id, 'nope.md')).toEqual({ refused: expect.stringContaining('nothing is written at nope.md') })
    expect(wb.openPlan(id, '../PLAN.md')).toEqual({ refused: expect.stringContaining('not a path inside') })
    expect(wb.openPlan(id, './PLAN.md')).toMatchObject({ plan: 'PLAN.md', plans: [{ path: 'PLAN.md', steps: {} }] })
    expect(wb.openPlan(id, 'PLAN.md')).toMatchObject({ plans: [expect.anything()] })

    expect(await wb.go(id)).toMatchObject({ step: '0.2' })
    expect(wb.closePlan(id, 'PLAN.md')).toEqual({ refused: expect.stringContaining('close PLAN.md once it stops') })
    await idle()
    file('| <a id="sp-042"></a>SP-042 | api | **Found in PLAN 0.2** | open | 2026-10-13 | — |')

    // Shown while nothing runs; Go starts the shown plan's box, recorded on it.
    expect(wb.openPlan(id, 'IDEAS/b.md')).toMatchObject({ plan: 'IDEAS/b.md', plans: [{ path: 'PLAN.md' }, { path: 'IDEAS/b.md', steps: {} }] })
    expect((await wb.readPlan(id))!.path).toBe('IDEAS/b.md')
    expect(await wb.go(id)).toMatchObject({ step: '0.2' })
    await idle()
    file('| <a id="sp-043"></a>SP-043 | api | **Found in b 0.2** | open | 2026-10-13 | — |')
    expect(Object.keys(wb.getPin(id)!.plans[0].steps)).toEqual(['0.2'])
    expect((await wb.readPlan(id))!.steps['0.2']).toMatchObject({ cost: 0.12, filed: [{ id: 'SP-043' }] })

    // The first plan's step ends where the second plan's began, in rows and in runs.
    wb.openPlan(id, 'PLAN.md')
    expect((await wb.readPlan(id))!.steps['0.2']).toMatchObject({ cost: 0.12, turns: 3, filed: [{ id: 'SP-042' }] })
    expect(await wb.tick(id, '0.2')).toEqual({ step: '0.2' })
    expect(readFileSync(join(dir, 'PLAN.md'), 'utf8')).toContain('- [x] 0.2')
    expect(readFileSync(join(dir, 'IDEAS', 'b.md'), 'utf8')).toContain('- [ ] 0.2')

    // A question on a plan not shown is still one the owner is waited on for.
    expect((await wb.status(wb.getPin(id)!)).questions).toEqual([])
    writeFileSync(join(dir, 'IDEAS', 'b.md'), [...PLAN, '', '## Open questions (owner)', '', '- **Q1 — Red or blue?**', '  - **A** — red.', ''].join('\n'))
    expect((await wb.status(wb.getPin(id)!)).questions).toEqual([{ plan: 'IDEAS/b.md', id: 'b:q1-red-or-blue', question: 'Q1 — Red or blue?' }])

    expect(wb.closePlan(id, 'nope.md')).toEqual({ refused: expect.stringContaining("no plan at 'nope.md'") })
    expect(wb.closePlan(id, 'PLAN.md')).toMatchObject({ plan: 'IDEAS/b.md', plans: [{ path: 'IDEAS/b.md' }] })
    expect(existsSync(join(dir, 'PLAN.md'))).toBe(true)
    expect(wb.closePlan(id, 'IDEAS/b.md')).toMatchObject({ plan: null, plans: [] })
    expect((await wb.status(wb.getPin(id)!)).questions).toEqual([])
    expect(await wb.readPlan(id)).toBeNull()
    expect(await wb.go(id)).toEqual({ refused: expect.stringContaining('has no plan') })
  })

  test('Build plan waits for a run in the checkout, like any message to another chat', async () => {
    const { bin } = fakeClaude({ sleep: 400 })
    const wb = createWorkbench({ dir: join(tmp, 'wb-plan-busy'), bin })
    const r = wb.pin(repo('plan-busy'))
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id
    await wb.send(id, 'long work')
    expect(await wb.buildPlan(id, { goal: 'x', path: 'PLAN.md' })).toEqual({ refused: expect.stringContaining('one run at a time') })
    expect(wb.getPin(id)!.plan).toBeNull()
    expect(wb.getPin(id)!.chats).toHaveLength(1)
    await until(async () => !wb.getPin(id)!.pid)
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

  test('commit: the chosen files as the diff showed them, on HEAD; what others staged and what was not chosen stay uncommitted', () => {
    const wb  = createWorkbench({ dir: join(tmp, 'wb-commit') })
    const dir = join(tmp, 'repos', 'git-commit')
    mkdirSync(dir, { recursive: true })
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    writeFileSync(join(dir, 'gone.txt'), 'delete me\n')
    writeFileSync(join(dir, 'staged.txt'), 'theirs\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    unlinkSync(join(dir, 'gone.txt'))
    writeFileSync(join(dir, 'b.txt'), 'new\n')
    writeFileSync(join(dir, 'other.txt'), 'not chosen\n')
    writeFileSync(join(dir, 'staged.txt'), 'theirs, staged\n')
    git('add', 'staged.txt')
    const r = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    const id = r.pin.id

    const read  = () => Object.fromEntries(wb.diff(id)!.files.map(f => [f.path, { path: f.path, blob: f.blob }]))
    const shown = read()
    expect(shown['a.txt'].blob).toBe(git('hash-object', 'a.txt').trim())
    expect(shown['gone.txt'].blob).toBe(null)
    const chosen = [shown['a.txt'], shown['gone.txt'], shown['b.txt']]

    expect(wb.commit(id, { message: ' ', files: chosen })).toEqual({ refused: 'a commit needs a message' })
    expect(wb.commit(id, { message: 'm', files: [] })).toEqual({ refused: 'no files chosen' })
    expect(wb.commit(id, { message: 'm', files: [{ path: 'nope.txt', blob: null }] })).toMatchObject({ files: ['nope.txt'] })
    expect(wb.commit(id, { message: 'm', files: ['a.txt'] })).toEqual({ refused: expect.stringContaining('{ path, blob }') })

    // Written after the diff was read: refused by name, nothing committed.
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    const head = git('rev-parse', 'HEAD').trim()
    expect(wb.commit(id, { message: 'm', files: chosen })).toEqual({ refused: expect.stringContaining('a.txt changed since'), files: ['a.txt'] })
    expect(git('rev-parse', 'HEAD').trim()).toBe(head)

    // The checkout's own hook refuses: the untracked file is untracked again.
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho no commits today >&2\nexit 1\n')
    chmodSync(join(dir, '.git', 'hooks', 'pre-commit'), 0o755)
    const again = read()
    const fresh = [again['a.txt'], again['gone.txt'], again['b.txt']]
    expect(wb.commit(id, { message: 'm', files: fresh })).toEqual({ refused: expect.stringContaining('no commits today') })
    expect(git('status', '--porcelain', '--', 'b.txt')).toBe('?? b.txt\n')
    unlinkSync(join(dir, '.git', 'hooks', 'pre-commit'))

    const done = wb.commit(id, { message: 'Add b, drop gone\n\nThe body.', files: fresh })
    expect(done).toEqual({ commit: git('rev-parse', 'HEAD').trim(), files: ['a.txt', 'gone.txt', 'b.txt'] })
    expect(git('log', '-1', '--format=%B').trim()).toBe('Add b, drop gone\n\nThe body.')
    expect(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['a.txt', 'b.txt', 'gone.txt'])
    expect(git('show', 'HEAD:a.txt')).toBe('one\ntwo\nthree\n')
    expect(git('diff', '--cached', '--name-only').trim()).toBe('staged.txt')
    expect(git('status', '--porcelain', '--', 'other.txt')).toBe('?? other.txt\n')
    expect(wb.diff(id)!.files.map(f => f.path).sort()).toEqual(['other.txt', 'staged.txt'])
  })

})

describe('branches', () => {

  // A real repository, never clean: one tracked edit and one untracked file
  // sit uncommitted, as they do in this repo every day.
  function gitRepo(name: string) {
    const dir = join(tmp, 'repos', name)
    mkdirSync(dir, { recursive: true })
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(dir, 'gone.txt'), 'delete me\n')
    writeFileSync(join(dir, '.gitignore'), '.env\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(dir, 'wip.txt'), 'half done\n')
    writeFileSync(join(dir, '.env'), 'SECRET=1\n')
    return { dir, git }
  }

  async function forked(wb: ReturnType<typeof createWorkbench>, parentId: string, slug?: string) {
    const r = await wb.fork(parentId, { slug })
    if (!('pin' in r)) throw new Error(r.refused)
    return r.pin
  }

  test('fork: the dirty tree as the operator sees it, in a worktree outside the repo, pinned beside it', async () => {
    const wbDir = join(tmp, 'wb-fork')
    const wb = createWorkbench({ dir: wbDir })
    const { dir, git } = gitRepo('fork')
    const parent = wb.pin(dir)
    if (!('pin' in parent)) throw new Error(parent.refused)
    const indexBefore = readFileSync(join(dir, '.git', 'index'))
    const headBefore  = git('rev-parse', 'HEAD').trim()

    const b = await forked(wb, parent.pin.id)
    expect(b).toMatchObject({ from: parent.pin.id, branch: 'wb/branch-1', name: 'fork · branch-1', chats: [{ forkOf: null }] })
    expect(b.path.startsWith(join(wbDir, 'trees', parent.pin.id))).toBe(true)
    expect(readFileSync(join(b.path, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n')
    expect(readFileSync(join(b.path, 'wip.txt'), 'utf8')).toBe('half done\n')
    // An ignored file is not in the snapshot; the default copy list carries it.
    expect(readFileSync(join(b.path, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(b.setup).toEqual({ copied: ['.env'], install: 'none' })
    expect(b.carried).toEqual({ total: 2, files: ['a.txt', 'wip.txt'] })
    expect(git('rev-parse', `${b.base}^`).trim()).toBe(headBefore)

    // The parent's index, HEAD and branch are only read.
    expect(readFileSync(join(dir, '.git', 'index')).equals(indexBefore)).toBe(true)
    expect(git('rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(git('status', '--porcelain')).toContain('?? wip.txt')
    expect(wb.readPins().map(p => p.from)).toEqual([null, parent.pin.id])

    expect((await forked(wb, parent.pin.id)).branch).toBe('wb/branch-2')
    expect(await wb.fork(parent.pin.id, { slug: 'branch-1' })).toEqual({ refused: expect.stringContaining('already exists') })
    expect(await wb.fork(parent.pin.id, { slug: '../x' })).toEqual({ refused: expect.stringContaining('not a branch name') })
    expect(await wb.fork(b.id)).toEqual({ refused: expect.stringContaining('itself a branch') })
  })

  test('a preview fork: settings on the checkout, the marker in the branch\'s git dir, its web port claimed', async () => {
    const lock = join(tmp, 'preview-sessions.lock')
    const wb = createWorkbench({ dir: join(tmp, 'wb-preview'), portsLock: lock })
    const { dir, git } = gitRepo('preview')
    mkdirSync(join(dir, 'app', 'web'), { recursive: true })
    mkdirSync(join(dir, 'app', 'db'), { recursive: true })
    writeFileSync(join(dir, 'app', 'db', 'schema.lite'), 'model Lead { id Int @id }\n')
    writeFileSync(join(dir, 'app', 'package.json'), '{ "name": "preview-app" }\n')
    writeFileSync(join(dir, 'app', 'web', 'index.html'), '<p>hi</p>\n')
    git('add', 'app')
    git('commit', '-qm', 'app')
    const parent = wb.pin(dir)
    if (!('pin' in parent)) throw new Error(parent.refused)
    const id = parent.pin.id

    expect(await wb.fork(id, { preview: true })).toEqual({ refused: expect.stringContaining('no preview settings') })
    const settings = { projectId: 'p1', app: 'app', domain: '*.Preview.Example.test', apiUrl: 'https://api.example.test/v1', serverId: 's1' }
    expect(wb.configure(id, { preview: { ...settings, app: '.' } })).toEqual({ refused: expect.stringContaining('has no web/') })
    expect(wb.configure(id, { preview: { ...settings, app: '../x' } })).toEqual({ refused: expect.stringContaining('not a directory inside') })
    expect(wb.configure(id, { preview: { ...settings, domain: 'nodot' } })).toEqual({ refused: expect.stringContaining('not a domain') })
    expect(wb.configure(id, { preview: { ...settings, apiUrl: 'ftp://x' } })).toEqual({ refused: expect.stringContaining('API origin') })
    expect(wb.configure(id, { preview: settings })).toMatchObject({
      preview: { projectId: 'p1', app: 'app', domain: 'preview.example.test', apiUrl: 'https://api.example.test', serverId: 's1' },
    })

    expect(await wb.fork(id, { slug: 'not_a_label', preview: true })).toEqual({ refused: expect.stringContaining('hostname label') })
    const r = await wb.fork(id, { slug: 'try', preview: true })
    if (!('pin' in r)) throw new Error(r.refused)
    const b = r.pin
    const marker = execFileSync('git', ['-C', b.path, 'rev-parse', '--path-format=absolute', '--git-path', 'fjs-preview'], { encoding: 'utf8' }).trim()
    expect(existsSync(marker)).toBe(true)
    expect(marker.startsWith(b.path)).toBe(false)
    // The carried files are the snapshot's; the marker added nothing to the tree.
    expect(execFileSync('git', ['-C', b.path, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')

    const { portFor, readLock } = await import('@frontierjs/cli/core/ports.js')
    expect(b.opened).toEqual({ port: await portFor(join(b.path, 'app'), 'fe', { env: 'dev', lockFile: lock }) })
    expect(Object.keys(readLock(lock))).toContain(join(b.path, 'app'))
    expect(b.preview).toBeNull()
    expect(wb.configure(b.id, { preview: settings })).toEqual({ refused: expect.stringContaining('is a branch') })

    // An ordinary fork of the same checkout is no preview.
    const plain = await forked(wb, id, 'plain')
    expect(plain.opened).toBeNull()
    expect(existsSync(execFileSync('git', ['-C', plain.path, 'rev-parse', '--path-format=absolute', '--git-path', 'fjs-preview'], { encoding: 'utf8' }).trim())).toBe(false)

    await wb.archive(b.id, { discard: true })
    expect(Object.keys(readLock(lock))).not.toContain(join(b.path, 'app'))
  })

  test('a clean parent is cut at HEAD, and the diff reads against the base', async () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-clean') })
    const { dir, git } = gitRepo('clean')
    git('add', '-A')
    git('commit', '-qm', 'all')
    const parent = wb.pin(dir)
    if (!('pin' in parent)) throw new Error(parent.refused)
    const b = await forked(wb, parent.pin.id, 'tidy')
    expect(b.base).toBe(git('rev-parse', 'HEAD').trim())
    expect(b.carried).toEqual({ total: 0, files: [] })

    writeFileSync(join(b.path, 'new.txt'), 'x\n')
    writeFileSync(join(b.path, 'a.txt'), 'one\n')
    const d = wb.diff(b.id)!
    expect(d.base).toBe(b.base)
    expect(d.files.map(f => [f.path, f.status])).toEqual([['a.txt', 'modified'], ['new.txt', 'added']])
  })

  test('the first message in a branch forks the parent\'s chat; the next resumes the fork', async () => {
    const { bin, seen } = fakeClaude()
    const wb = createWorkbench({ dir: join(tmp, 'wb-fork-chat'), bin })
    const parent = wb.pin(gitRepo('fork-chat').dir)
    if (!('pin' in parent)) throw new Error(parent.refused)
    wb.configure(parent.pin.id, { budget: 3 })
    await wb.send(parent.pin.id, 'first')
    await until(async () => !wb.getPin(parent.pin.id)!.pid && !!wb.getPin(parent.pin.id)!.chats[0].session)

    const b = await forked(wb, parent.pin.id)
    expect(b).toMatchObject({ chats: [{ forkOf: SESSION, session: null }], budget: 3 })
    await wb.send(b.id, 'in the branch')
    await until(async () => !wb.getPin(b.id)!.pid && !!wb.getPin(b.id)!.chats[0].session)
    await wb.send(b.id, 'again')
    await until(async () => seen().length === 3 && !wb.getPin(b.id)!.pid)

    const [, first, second] = seen()
    expect(first.cwd).toBe(b.path)
    expect(first.argv.slice(-3)).toEqual(['--resume', SESSION, '--fork-session'])
    expect(second.argv.slice(-2)).toEqual(['--resume', SESSION])
    expect(second.argv).not.toContain('--fork-session')

    // A new chat in a branch forks nothing.
    const p = (await wb.fresh(b.id))!
    expect(p.chats.find(c => c.id === p.chat)).toMatchObject({ session: null, forkOf: null })
  })

  test('land: the branch\'s work, committed or not, into the parent\'s tree uncommitted; a second land carries only what came after', async () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-land') })
    const { dir, git } = gitRepo('land')
    const parent = wb.pin(dir)
    if (!('pin' in parent)) throw new Error(parent.refused)
    const b = await forked(wb, parent.pin.id)
    const bgit = (...a: string[]) => execFileSync('git', ['-C', b.path, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' })
    const headBefore = git('rev-parse', 'HEAD').trim()

    expect(wb.land(b.id)).toEqual({ refused: expect.stringContaining('nothing to land') })
    expect(wb.commit(b.id, { message: 'm', files: [] })).toEqual({ refused: expect.stringContaining('is a branch — land it') })

    writeFileSync(join(b.path, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    bgit('commit', '-qam', 'four')
    writeFileSync(join(b.path, 'added.txt'), 'from the branch\n')
    unlinkSync(join(b.path, 'gone.txt'))

    const landed = wb.land(b.id)
    expect(landed).toEqual({ landed: ['a.txt', 'added.txt', 'gone.txt'] })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\nfour\n')
    expect(readFileSync(join(dir, 'added.txt'), 'utf8')).toBe('from the branch\n')
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false)
    expect(readFileSync(join(dir, 'wip.txt'), 'utf8')).toBe('half done\n')
    expect(git('rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(git('diff', '--cached', '--name-only')).toBe('')

    // The base moved to what landed: the diff is empty and so is a second land.
    expect(wb.diff(b.id)!.total).toBe(0)
    expect(wb.land(b.id)).toEqual({ refused: expect.stringContaining('nothing to land') })
    writeFileSync(join(b.path, 'later.txt'), 'later\n')
    expect(wb.land(b.id)).toEqual({ landed: ['later.txt'] })
  })

  test('a snapshot reads a same-size rewrite made in the tick the index was written (FJS-2773)', () => {
    const dir = join(tmp, 'repos', 'racy')
    mkdirSync(dir, { recursive: true })
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    // ctime cannot be set and a rewrite always moves it; without this git
    // would catch the rewrite on ctime and the race would not be reachable.
    git('config', 'core.trustctime', 'false')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    // Git rehashes an entry as new as the index file and trusts the rest, so
    // the copy a snapshot reads must keep the index's mtime.
    const tick = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'a.txt'), tick, tick)
    git('update-index', '--really-refresh')
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    utimesSync(join(dir, 'a.txt'), tick, tick)
    utimesSync(join(dir, '.git', 'index'), tick, tick)
    const blob = git('hash-object', 'a.txt').trim()
    expect(git('ls-tree', treeOf(dir)).split('\n').find(l => l.endsWith('\ta.txt'))).toContain(blob)
  })

  test('land refuses, naming the file, when the parent moved under it — and writes nothing', async () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-conflict') })
    const { dir } = gitRepo('conflict')
    const parent = wb.pin(dir)
    if (!('pin' in parent)) throw new Error(parent.refused)
    const b = await forked(wb, parent.pin.id)
    writeFileSync(join(b.path, 'a.txt'), 'one\nBRANCH\nthree\n')
    writeFileSync(join(b.path, 'other.txt'), 'clean add\n')
    writeFileSync(join(dir, 'a.txt'), 'one\nPARENT\nthree\n')

    const r = wb.land(b.id)
    expect(r).toMatchObject({ refused: expect.stringContaining('a.txt'), files: ['a.txt'] })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\nPARENT\nthree\n')
    expect(existsSync(join(dir, 'other.txt'))).toBe(false)
    expect(wb.getPin(b.id)!.base).toBe(b.base)
  })

  test('setup: the copy list, then an install that saves nothing; a failed install is in the log and the branch stays', async () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-setup') })
    const { dir } = gitRepo('setup')
    writeFileSync(join(dir, '.gitignore'), '.env\nnode_modules/\n*.db\n')
    mkdirSync(join(dir, 'db'))
    writeFileSync(join(dir, 'db', 'dev.db'), 'rows')
    mkdirSync(join(dir, 'vendor', 'dep'), { recursive: true })
    writeFileSync(join(dir, 'vendor', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'setup', private: true, dependencies: { dep: 'file:./vendor/dep' } }))
    execFileSync(process.execPath, ['install'], { cwd: dir, stdio: 'pipe' })
    mkdirSync(join(dir, 'node_modules', '.cache'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.cache', '.env'), 'not ours\n')
    const lock = readFileSync(join(dir, 'bun.lock'), 'utf8')
    const parent = wb.pin(dir)
    if (!('pin' in parent)) throw new Error(parent.refused)

    expect(wb.configure(parent.pin.id, { copy: '../up' })).toEqual({ refused: expect.stringContaining('not a glob inside') })
    expect(wb.configure(parent.pin.id, { copy: '/etc/*' })).toEqual({ refused: expect.stringContaining('not a glob inside') })
    expect(wb.configure(parent.pin.id, { copy: '**/.env\n\n**/*.db\n' })).toMatchObject({ copy: ['**/.env', '**/*.db'] })

    const b = await forked(wb, parent.pin.id)
    // An ignored directory is one entry, so a .env inside node_modules is never reached.
    expect(b.setup).toEqual({ copied: ['.env', 'db/dev.db'], install: 'ran' })
    expect(readFileSync(join(b.path, 'db', 'dev.db'), 'utf8')).toBe('rows')
    expect(existsSync(join(b.path, 'node_modules', '.cache'))).toBe(false)
    expect(existsSync(join(b.path, 'node_modules', 'dep', 'package.json'))).toBe(true)
    expect(readFileSync(join(b.path, 'bun.lock'), 'utf8')).toBe(lock)
    expect(wb.diff(b.id)!.files).toEqual([])

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'setup', private: true, dependencies: { nope: 'file:./missing' } }))
    const c = await forked(wb, parent.pin.id)
    expect(c.setup).toEqual({ copied: ['.env', 'db/dev.db'], install: 'failed' })
    const t = await wb.transcript(c.id)
    expect(t!.items[0]).toMatchObject({ kind: 'error', text: expect.stringContaining('bun install failed in the branch') })
  })

  test('archive gives the branch\'s port block back, and only its own', async () => {
    const portsLock = join(tmp, 'sessions-archive.lock')
    const wb = createWorkbench({ dir: join(tmp, 'wb-archive-ports'), portsLock })
    const { dir } = gitRepo('archive-ports')
    const parent = wb.pin(dir)
    if (!('pin' in parent)) throw new Error(parent.refused)
    const b = await forked(wb, parent.pin.id)
    const app = join(b.path, 'packages', 'app')
    writeFileSync(portsLock, JSON.stringify({ [app]: { root: app, branch: 1 }, [dir]: { root: dir, slot: 0 } }))
    expect(await wb.archive(b.id)).toEqual({ archived: 'wb/branch-1' })
    expect(Object.keys(JSON.parse(readFileSync(portsLock, 'utf8')))).toEqual([dir])
  })

  test('archive asks before losing work, then removes the tree and keeps the branch; a parent with branches cannot be unpinned', async () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-archive') })
    const { dir, git } = gitRepo('archive')
    const parent = wb.pin(dir)
    if (!('pin' in parent)) throw new Error(parent.refused)
    const b = await forked(wb, parent.pin.id)

    expect(wb.unpin(parent.pin.id)).toEqual({ refused: expect.stringContaining('1 branch first') })
    expect(wb.unpin(b.id)).toEqual({ refused: expect.stringContaining('archive it') })
    expect(await wb.archive(parent.pin.id)).toEqual({ refused: expect.stringContaining('not a branch') })

    writeFileSync(join(b.path, 'unlanded.txt'), 'x\n')
    expect(await wb.archive(b.id)).toEqual({ refused: expect.stringContaining('1 file not landed'), pending: 1 })
    expect(existsSync(b.path)).toBe(true)

    expect(await wb.archive(b.id, { discard: true })).toEqual({ archived: 'wb/branch-1' })
    expect(existsSync(b.path)).toBe(false)
    expect(wb.getPin(b.id)).toBeNull()
    expect(git('branch', '--list', 'wb/*').trim()).toBe('wb/branch-1')
    expect(git('worktree', 'list')).not.toContain(b.path)

    // A landed branch archives without asking.
    const c = await forked(wb, parent.pin.id)
    expect(c.branch).toBe('wb/branch-2')
    writeFileSync(join(c.path, 'kept.txt'), 'y\n')
    expect(wb.land(c.id)).toEqual({ landed: ['kept.txt'] })
    expect(await wb.archive(c.id)).toEqual({ archived: 'wb/branch-2' })
    expect(wb.unpin(parent.pin.id)).toBeNull()
  })

})

describe('the Run tab', () => {

  // A checkout that is also an app, carrying its own fli: a stand-in that
  // prints what it was asked and where, then keeps serving like `fli dev`.
  function runnableRepo(name: string, { fli = true } = {}) {
    const dir = repo(name)
    mkdirSync(join(dir, 'db'), { recursive: true })
    writeFileSync(join(dir, 'db', 'schema.lite'), 'model Note {\n  id Int @id\n}\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, scripts: {
      hello: 'echo hello from $npm_lifecycle_event',
      serve: 'echo serving && sleep 30',
      env:   'echo "fe=${FLI_PORT_FE:-} port=${PORT:-}"',
    } }))
    if (fli) {
      mkdirSync(join(dir, 'node_modules', '@frontierjs', 'cli', 'bin'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', '@frontierjs', 'cli', 'bin', 'fli.js'),
        `console.log('fli ' + process.argv.slice(2).join(' ') + ' in ' + process.cwd()); setInterval(() => {}, 1000)\n`)
    }
    return dir
  }

  async function pinned(wb: ReturnType<typeof createWorkbench>, dir: string) {
    const r = wb.pin(dir)
    if (!('pin' in r)) throw new Error(r.refused)
    return r.pin.id
  }

  const runOf = async (wb: ReturnType<typeof createWorkbench>, id: string, row: string) =>
    (await wb.status(wb.getPin(id)!)).runs.find(r => r.id === row)

  test('the inventory is fli dev for the app, then each script once — never a command', async () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-run-list') })
    const id = await pinned(wb, runnableRepo('run-list'))
    const rows = (await wb.runnables(id))!.rows
    expect(rows.map(r => r.id)).toEqual(['app:.', 'task:env', 'task:hello', 'task:serve'])
    expect(rows[0]).toMatchObject({ kind: 'app', name: 'run-list', start: 'fli dev' })
    expect(rows.every(r => !('argv' in r))).toBe(true)
    expect(await wb.run(id, 'rm -rf /')).toEqual({ refused: expect.stringContaining('nothing to run') })
  })

  test('a script runs detached into its own log, which outlives it', async () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-run-script') })
    const id = await pinned(wb, runnableRepo('run-script'))
    expect(await wb.run(id, 'task:hello')).toEqual({ started: expect.any(String) })
    await until(async () => (await runOf(wb, id, 'task:hello'))?.running === false)
    expect(await runOf(wb, id, 'task:hello')).toMatchObject({ name: 'hello', exit: 0, stopped: false, ports: [] })
    const out = wb.output(id, 'task:hello')!
    expect(out.lines).toContain('hello from hello')
    expect(out.lines.at(-1)).toBe('— exited with 0 —')
  })

  test("a server is refused a second start, stopped as a group, then forgotten", async () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-run-stop') })
    const id = await pinned(wb, runnableRepo('run-stop'))
    await wb.run(id, 'task:serve')
    await until(async () => wb.output(id, 'task:serve')!.lines.includes('serving'))
    const { pid } = wb.getPin(id)!.runs['task:serve']
    expect(await wb.run(id, 'task:serve')).toEqual({ refused: expect.stringContaining('already running') })

    expect(wb.halt(id, 'task:serve')).toEqual({ stopped: true })
    await until(async () => (await runOf(wb, id, 'task:serve'))?.running === false)
    // bun run is a launcher: the sleep under it is what would keep serving.
    await until(async () => spawnSync('pgrep', ['-g', String(pid)], { encoding: 'utf8' }).stdout.trim() === '')
    expect(await runOf(wb, id, 'task:serve')).toMatchObject({ stopped: true })

    expect(wb.halt(id, 'task:serve')).toEqual({ stopped: false })
    expect(wb.getPin(id)!.runs).toEqual({})
    expect(wb.output(id, 'task:serve')).toBeNull()
    expect(wb.halt(id, 'task:serve')).toEqual({ refused: expect.stringContaining('nothing called') })
  })

  test("a run gets neither this API's PORT nor the ports fli dev handed it", async () => {
    process.env.FLI_PORT_FE = '8020'
    process.env.PORT = '8120'
    try {
      const wb = createWorkbench({ dir: join(tmp, 'wb-run-env'), env: { PORT: '8120' } })
      const id = await pinned(wb, runnableRepo('run-env'))
      await wb.run(id, 'task:env')
      await until(async () => (await runOf(wb, id, 'task:env'))?.running === false)
      expect(wb.output(id, 'task:env')!.lines).toContain('fe= port=')
    } finally { delete process.env.FLI_PORT_FE; delete process.env.PORT }
  })

  test("fli dev is the checkout's own fli, and a checkout without one is told to install", async () => {
    const wb = createWorkbench({ dir: join(tmp, 'wb-run-fli') })
    const dir = runnableRepo('run-fli')
    const id = await pinned(wb, dir)
    await wb.run(id, 'app:.')
    await until(async () => wb.output(id, 'app:.')!.lines.some(l => l.startsWith('fli dev')))
    expect(wb.output(id, 'app:.')!.lines).toContain(`fli dev in ${dir}`)

    // Unpinning takes the server with it: its folder is no longer anyone's.
    const { pid } = wb.getPin(id)!.runs['app:.']
    expect(wb.unpin(id)).toBeNull()
    await until(async () => { try { process.kill(pid!, 0); return false } catch { return true } })

    const bare = await pinned(wb, runnableRepo('run-nofli', { fli: false }))
    expect(await wb.run(bare, 'app:.')).toEqual({ refused: expect.stringContaining('bun install') })
  })

})
