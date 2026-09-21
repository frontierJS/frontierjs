// ─── pause-journal.test.js — a pause, through the helper the command calls ────
//
// `openPauseJournal` lives in `deploy/_module.md`, which is a markdown script
// block and not a module, so nothing imports it — and a ReferenceError inside
// it is invisible to every test that compiles the file. That is not a
// hypothetical: a destructure that did not land left `filePresent` undefined,
// the suite stayed green, and the first thing to see it was the four-minute
// deploy cycle in CI.
//
// So this evaluates the script block the way `deploy-helpers.test.js` does and
// calls the helper for real. Nothing is stubbed: the machine is `localhost`,
// which is a transport rather than a simulation, the runner is the one that
// ships, and the journal is a SQLite file in a temp directory. What it cannot
// reach is nginx, which is `pauseEdgeCycle`'s half.
//
// Every refusal is PAIRED with the same call one term away, and every refusal
// is followed by a read of the journal asserting it wrote nothing.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { execSync } from 'child_process'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { chooseTarget } from '../core/revert.js'

const ROOT = resolve(import.meta.dir, '..')
global.fliRoot ??= ROOT

const realExec = ({ command, ...opts }) => execSync(command, { stdio: 'inherit', ...opts })

const helpers = await (async () => {
  const src = readFileSync(resolve(ROOT, 'commands/deploy/_module.md'), 'utf8')
  const block = src.match(/<script>([\s\S]+?)<\/script>/)[1]
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  return new AsyncFunction(`${block}\nreturn { openPauseJournal, connectJournal }`)()
})()

const APP = 'shop'
const ENV = 'production'
const HOST = 'localhost'

let dir, context, deployConf
beforeEach(() => {
  dir        = mkdtempSync(`${tmpdir()}/fjs-pausej-`)
  deployConf = { app_id: APP, journal: { path: `${dir}/deploy.db` } }
  context    = { exec: realExec, config: { deployConf }, git: { user: () => 'tester' }, paths: {} }
})
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

const journal = () => helpers.connectJournal(context, { host: HOST, serverPath: dir, deployConf })

const noLog = { info() {}, warn() {}, error() {}, success() {} }

const pause = (kind, extra = {}) => helpers.openPauseJournal(context, {}, {
  kind, host: HOST, serverPath: dir, deployConf, target: ENV, stepsDir: '_steps-pause', log: noLog,
  vhostHasGuard: true, filePresent: false, ...extra,
})

/** A journal with one succeeded deploy in it — what a target that has shipped once holds. */
const deployed = async () => {
  const j = await journal()
  await j.open({ app: APP, host: HOST })
  await j.begin({
    release: { id: 'r1', app: APP, environment: ENV, bindingsHash: 'bh', generation: 1, schemaHash: 'sh', pivot: 'expand' },
    transition: { id: 't-deploy', kind: 'deploy', app: APP, environment: ENV, releaseId: 'r1',
                  fromReleaseId: null, generation: 1, plan: {}, actor: 'tester' },
    steps: [],
  })
  await j.settle({ id: 't-deploy', status: 'succeeded' })
  return j
}

/** Run a pause's steps to the end the way the runner would, and settle. */
const complete = async (opened) => {
  for (const step of ['01-preflight', '02-pause', '02a-queues-resume', '02b-unpause', '03-verify', '03b-queues-pause', '04-cleanup']) {
    const d = await opened.recorder.beforeStep(step)
    if (d.run) await opened.recorder.afterStep(step, 0, { status: 'succeeded' })
  }
  await opened.recorder.settle('succeeded')
}

const kinds = async (j) => (await j.history({ app: APP, environment: ENV, limit: 50 })).map(h => h.kind)

// ─── accepting ───────────────────────────────────────────────────────────────

describe('a pause through the journal', () => {
  test('opens a pause transition over the Release already serving, and mints none', async () => {
    const j = await deployed()
    const opened = await pause('pause')

    expect(opened.error).toBeUndefined()
    expect(opened.refused).toBeUndefined()
    expect(opened.transition).toMatchObject({ kind: 'pause', releaseId: 'r1', fromReleaseId: 'r1', crossesPivot: false })

    await complete(opened)
    const state = await j.state({ app: APP, environment: ENV })
    expect(state).toMatchObject({ serving: 'r1', paused: true, kind: 'pause', actor: 'tester' })
  })

  test('the step rows it writes are the directory the runner reads', async () => {
    await deployed()
    const opened = await pause('pause')
    const j = await journal()
    const names = (await j.stepsOf(opened.transition.id)).map(s => s.name)
    expect(names).toEqual(['01-preflight', '02-pause', '02a-queues-resume', '02b-unpause', '03-verify', '03b-queues-pause', '04-cleanup'])
  })

  test('an unpause after it puts the app back to serving, and the same Release', async () => {
    const j = await deployed()
    await complete(await pause('pause'))
    await complete(await pause('unpause', { filePresent: true }))

    expect(await j.state({ app: APP, environment: ENV })).toMatchObject({ serving: 'r1', paused: false, kind: 'unpause' })
    expect(await kinds(j)).toEqual(['unpause', 'pause', 'deploy'])
  })

  // The history a revert reads. Two pause rows sit on top of the deploy; the
  // Release the revert offers must not become the one already serving.
  test('a revert reading that history is not moved by it', async () => {
    const j = await deployed()
    await j.begin({
      release: { id: 'r2', app: APP, environment: ENV, bindingsHash: 'bh', generation: 1, schemaHash: 'sh', pivot: 'expand' },
      transition: { id: 't-deploy-2', kind: 'deploy', app: APP, environment: ENV, releaseId: 'r2',
                    fromReleaseId: 'r1', generation: 1, plan: {}, actor: 'tester' },
      steps: [],
    })
    await j.settle({ id: 't-deploy-2', status: 'succeeded' })
    await complete(await pause('pause'))
    await complete(await pause('unpause', { filePresent: true }))

    const history = await j.history({ app: APP, environment: ENV, limit: 50 })
    expect(chooseTarget(history)).toMatchObject({ targetId: 'r1' })
    expect(chooseTarget(history).serving.releaseId).toBe('r2')
  })
})

// ─── refusing, and writing nothing for it ────────────────────────────────────

describe('what a pause refuses, against a real journal', () => {
  test('a vhost with no guard', async () => {
    const j = await deployed()
    const opened = await pause('pause', { vhostHasGuard: false })
    expect(opened.refused?.map(r => r.code)).toEqual(['no-guard'])
    expect(await kinds(j)).toEqual(['deploy'])
  })

  test('a journal nothing has been deployed through', async () => {
    const j = await journal()
    await j.open({ app: APP, host: HOST })
    const opened = await pause('pause')
    expect(opened.refused?.map(r => r.code)).toEqual(['no-journal'])
    expect(await kinds(j)).toEqual([])
  })

  test('a pause over a pause', async () => {
    const j = await deployed()
    await complete(await pause('pause'))
    const again = await pause('pause', { filePresent: true })
    expect(again.refused?.map(r => r.code)).toEqual(['already'])
    expect(await kinds(j)).toEqual(['pause', 'deploy'])
  })

  // The pair for the row above, and the case `already` exists NOT to refuse: the
  // journal says paused and somebody removed the file.
  test('but a pause over a pause whose file is gone goes ahead — that is the fix', async () => {
    await deployed()
    await complete(await pause('pause'))
    const again = await pause('pause', { filePresent: false })
    expect(again.refused).toBeUndefined()
    expect(again.transition.kind).toBe('pause')
  })

  // And the other direction: the journal says serving and the edge is refusing.
  test('an unpause over a target paused by hand goes ahead', async () => {
    await deployed()
    const opened = await pause('unpause', { filePresent: true })
    expect(opened.refused).toBeUndefined()
    expect(opened.transition.kind).toBe('unpause')
  })

  test('while an unpause over a target nobody paused is refused', async () => {
    const j = await deployed()
    const opened = await pause('unpause', { filePresent: false })
    expect(opened.refused?.map(r => r.code)).toEqual(['already'])
    expect(await kinds(j)).toEqual(['deploy'])
  })

  test('a deploy still open', async () => {
    const j = await deployed()
    await j.begin({
      release: { id: 'r3', app: APP, environment: ENV, bindingsHash: 'bh', generation: 1, schemaHash: 'sh', pivot: 'expand' },
      transition: { id: 't-open', kind: 'deploy', app: APP, environment: ENV, releaseId: 'r3',
                    fromReleaseId: 'r1', generation: 1, plan: {}, actor: 'tester' },
      steps: [],
    })
    const opened = await pause('pause')
    expect(opened.refused?.map(r => r.code)).toEqual(['in-flight'])
    expect(opened.refused[0].fix).toContain('t-open')
  })
})
