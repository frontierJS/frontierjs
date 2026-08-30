// ─── journal.test.js — the deploy journal, written and read back ────────────
//
// Phase 1e. Two halves, deliberately:
//
//   the DECISIONS are pure and tested as functions — which attempt is this,
//   does a rerun redo this step, did the world move under the plan;
//
//   the STATEMENTS are run against a real SQLite file through the real
//   `core/journal-runner.mjs`, because SQL that is only asserted as a string is
//   asserted against the author's memory of SQLite. The sequence the suite walks
//   is the one the feature exists for: deploy, die inside a step, rerun.
//
// The table names are checked against the committed DDL rather than trusted.
// This module hand-writes SQL against a schema litestone emits, so a table that
// gets renamed is a runtime failure on a machine nobody is watching.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { spawnSync } from 'child_process'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import {
  JOURNAL_FORMAT, TABLE, journalClient, JournalError,
  openJournal, journalVerdict, readState, readAttempts, attemptDecision,
  recordRelease, recordBindings, openTransition, claimStep, finishStep,
  settleTransition, resumeDecision, preconditionVerdict, formatDrift,
  readHistory, readSteps, readLiveTransition,
} from '../core/journal.js'

const ROOT   = resolve(import.meta.dir, '..')
const RUNNER = `${ROOT}/core/journal-runner.mjs`
const DDL    = readFileSync(`${ROOT}/db/ddl.snapshot.sql`, 'utf8')

// ─── the schema this module binds to ─────────────────────────────────────────

describe('the tables are the ones the schema emits', () => {
  // `db/ddl.snapshot.sql` is generated from `db/deploy.lite` and the `snapshots`
  // CI phase fails a stale one — so this crossing is what makes the fragment the
  // single source of a schema that is hand-queried here.
  test.each(Object.entries(TABLE))('%s → "%s" exists in the DDL', (_key, table) => {
    expect(DDL).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`)
  })

  test('every column these statements name is in the DDL', () => {
    const stmts = [
      ...openJournal({ app: 'a', host: 'h' }),
      ...readState({ app: 'a', environment: 'e' }),
      ...readAttempts({ kind: 'deploy', app: 'a', environment: 'e', releaseId: 'r', generation: 1 }),
      ...recordRelease({ id: 'r', app: 'a', environment: 'e', bindingsHash: 'b' }),
      ...recordBindings({ app: 'a', environment: 'e', generation: 1, hash: 'h' }),
      ...openTransition({ transition: { id: 't', kind: 'deploy', app: 'a', environment: 'e', releaseId: 'r', generation: 1, plan: {} }, steps: [] }),
      ...claimStep({ id: 's' }), ...finishStep({ id: 's', status: 'succeeded' }),
      ...settleTransition({ id: 't', status: 'succeeded' }),
      ...readHistory({ app: 'a', environment: 'e' }), ...readSteps({ transitionId: 't' }),
    ]
    // Every double-quoted identifier that is not a table name has to be a column
    // the DDL declares. `rowid` is SQLite's own and is in no CREATE TABLE.
    const tables = new Set(Object.values(TABLE))
    const named  = new Set()
    for (const s of stmts) for (const m of s.sql.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) named.add(m[1])
    const unknown = [...named].filter(n => !tables.has(n) && n !== 'rowid' && !DDL.includes(`"${n}" `))
    expect(unknown).toEqual([])
  })

  // Invariant 8. An app id, a step name and an actor all reach these from
  // configuration a person wrote.
  test('no statement interpolates a value — every one is bound', () => {
    const stmts = [
      ...openJournal({ app: "'; DROP TABLE release; --", host: 'h' }),
      ...recordRelease({ id: "'x", app: "'y", environment: 'e', bindingsHash: 'b' }),
      ...claimStep({ id: "' OR 1=1 --" }),
    ]
    for (const s of stmts) {
      expect(s.sql).not.toContain('DROP TABLE release')
      expect(s.sql).not.toContain('OR 1=1')
    }
  })
})

// ─── the decisions ───────────────────────────────────────────────────────────

describe('whose journal is this', () => {
  const at = { app: 'shop', host: 'deploy@prod' }

  test('an empty file is a new journal, not a mismatch', () => {
    expect(journalVerdict(null, at)).toMatchObject({ ok: true, kind: 'new' })
  })

  test('a matching row opens', () => {
    expect(journalVerdict({ app: 'shop', host: 'deploy@prod', formatVersion: 1 }, at).ok).toBe(true)
  })

  // Three refusals rather than one boolean, because the ways out differ.
  test('another app is refused, and says the path names one', () => {
    const v = journalVerdict({ app: 'other', host: 'deploy@prod', formatVersion: 1 }, at)
    expect(v).toMatchObject({ ok: false, kind: 'app' })
    expect(v.reason).toContain('other')
  })

  test('another host is refused — a copied disk carries a history that is not this one', () => {
    const v = journalVerdict({ app: 'shop', host: 'deploy@stage', formatVersion: 1 }, at)
    expect(v).toMatchObject({ ok: false, kind: 'host' })
  })

  test('a newer format is refused rather than parsed', () => {
    const v = journalVerdict({ app: 'shop', host: 'deploy@prod', formatVersion: JOURNAL_FORMAT + 1 }, at)
    expect(v).toMatchObject({ ok: false, kind: 'format' })
    expect(v.reason).toContain('upgrade fli')
  })

  test('an OLDER format is readable — that is what the version is for', () => {
    expect(journalVerdict({ app: 'shop', host: 'deploy@prod', formatVersion: 0 }, at).ok).toBe(true)
  })
})

describe('resume, or a new attempt', () => {
  test('nothing recorded is attempt 1', () => {
    expect(attemptDecision([])).toEqual({ attempt: 1, resume: null })
  })

  // The interrupted deploy: rerunning must find that row, not open a second.
  test.each(['planned', 'running'])('a %s transition is resumed at its own number', (status) => {
    const d = attemptDecision([{ id: 't1', status: 'succeeded' }, { id: 't2', status }])
    expect(d).toMatchObject({ attempt: 2 })
    expect(d.resume.id).toBe('t2')
  })

  // deploy R2 → revert to R1 → deploy R2 again is three operations, and the
  // third is not a replay of the first. This is the term `--plan` could not
  // answer (core/plan.js).
  test('a finished transition means the next run is a NEW attempt', () => {
    expect(attemptDecision([{ status: 'succeeded' }])).toMatchObject({ attempt: 2, resume: null })
    expect(attemptDecision([{ status: 'succeeded' }, { status: 'failed' }]))
      .toMatchObject({ attempt: 3, resume: null })
  })
})

describe('what a rerun does with a step', () => {
  test('a step with no row runs', () => {
    expect(resumeDecision(null).action).toBe('run')
  })

  // The property the whole occurrence-key scheme exists for.
  test('a succeeded step replays into a no-op', () => {
    const d = resumeDecision({ status: 'succeeded' })
    expect(d.action).toBe('skip')
    expect(d.note).toContain('no-op')
  })

  test('a step its predicate skipped stays skipped', () => {
    expect(resumeDecision({ status: 'skipped' }).action).toBe('skip')
  })

  // A half-finished step is not a finished one, and this pipeline holds at least
  // one (`06-swap` renames a container) a person needs told about.
  test('a step a previous run died inside runs again, and says so', () => {
    const d = resumeDecision({ status: 'running' })
    expect(d.action).toBe('rerun')
    expect(d.note).toContain('died inside')
  })

  test('a failed step runs again', () => {
    expect(resumeDecision({ status: 'failed' }).action).toBe('run')
  })

  // A replayed step's effect on the run never happens, so what it RECORDED has
  // to come back with the decision. `04-build-api` records which bytes it built
  // and `06-swap` starts them — without this a resumed deploy ran
  // `docker run … undefined`, the resume failing in the one case it exists for:
  // a crash between the build and the swap.
  test('a replayed step hands back what it recorded', () => {
    const note = JSON.stringify({ image: 'sha256:abc', tag: 'shop:1', scope: 'host' })
    expect(resumeDecision({ status: 'succeeded', output: note }).output).toBe(note)
  })

  test('a step that is about to run hands back nothing to restore', () => {
    expect(resumeDecision({ status: 'running', output: 'half' }).output).toBeNull()
    expect(resumeDecision({ status: 'failed',  output: 'half' }).output).toBeNull()
    expect(resumeDecision({ status: 'skipped', output: 'x'    }).output).toBeNull()
    expect(resumeDecision(null).output).toBeNull()
  })
})

describe('did the world move under the plan', () => {
  const planned = { serving: 'r1', generation: 2, schemaHash: 'abc' }

  test('agreement is agreement', () => {
    expect(preconditionVerdict(planned, { ...planned }).ok).toBe(true)
  })

  // A first deploy plans against nothing and finds nothing.
  test('null against null on an empty journal is not drift', () => {
    expect(preconditionVerdict({ serving: null }, { serving: null }).ok).toBe(true)
  })

  test.each([
    ['serving',    { serving: 'r9' }],
    ['generation', { generation: 3 }],
    ['schemaHash', { schemaHash: 'zzz' }],
  ])('%s moving is drift, and it names itself', (key, patch) => {
    const v = preconditionVerdict(planned, { ...planned, ...patch })
    expect(v.ok).toBe(false)
    expect(v.drift[0].key).toBe(key)
    expect(v.drift[0].what).toBeTruthy()
  })

  test('a term the plan did not state is not graded', () => {
    expect(preconditionVerdict({ serving: 'r1' }, { serving: 'r1', generation: 7 }).ok).toBe(true)
  })

  // The two answers came from two intents, so picking one is a guess about which
  // person was right. The refusal says that outright rather than leaving the
  // reader to wonder whether something merged behind them.
  test('the refusal states that nothing reconciles, and says what to do', () => {
    const text = formatDrift(preconditionVerdict(planned, { ...planned, serving: 'r9' }).drift)
    expect(text).toContain('Nothing here reconciles')
    expect(text).toContain('Re-run the deploy')
    expect(text).toContain('r1')
    expect(text).toContain('r9')
  })
})

// ─── against a real database ─────────────────────────────────────────────────

describe('the journal, through the runner that ships to the target', () => {
  let dir, db, j

  const RELEASE = {
    id: 'r2aaaaaaaaaa', app: 'shop', environment: 'production',
    digest: null, bindingsHash: 'b'.repeat(64), generation: 1,
    schemaHash: 'c'.repeat(64), pivot: 'expand', createdBy: 'jordan',
  }
  const NAMES = ['01-preflight', '02-pull', '04-build-api', '06-swap']
  const steps = (tid) => NAMES.map((name, i) => ({
    id: `deploy:${tid}:${name}`, transitionId: tid, name, ordinal: i + 1,
    status: 'pending', precondition: { serving: null, generation: 1, schemaHash: RELEASE.schemaHash },
  }))
  const TRANSITION = {
    id: 't1', kind: 'deploy', app: 'shop', environment: 'production',
    releaseId: RELEASE.id, fromReleaseId: null, generation: 1,
    crossesPivot: false, plan: { formatVersion: 1, attempt: 1, steps: [] }, actor: 'jordan',
  }

  beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/fjs-journal-`)
    db  = `${dir}/deploy.db`
    j   = journalClient({
      db, ddl: DDL,
      exec: (stdin) => spawnSync('bun', [RUNNER], { input: stdin, encoding: 'utf8' }).stdout,
    })
  })
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  const begin = (tid = 't1') =>
    j.begin({ release: RELEASE, transition: { ...TRANSITION, id: tid }, steps: steps(tid) })

  // ─── what --resume adopts ──────────────────────────────────────────────────
  //
  // `attempt()` keys on `releaseId`, which is right for an ordinary deploy and
  // wrong for a resume: the Release id carries the image digest, a local image
  // ID is not a content address, and a rebuild that is not a full cache hit
  // mints a new Release from identical bytes. So the lookup missed the row it
  // was standing on and every resume opened a second transition (`FJS-595`).
  //
  // Every case here has its negative control in the same describe — a query that
  // finds a live transition under every condition would pass while adopting
  // somebody else's run.
  describe('the transition --resume adopts', () => {
    const otherRelease = { ...RELEASE, id: 'r9zzzzzzzzzz' }

    test('finds the open transition even though the Release has moved', async () => {
      await j.open({ app: 'shop', host: 'deploy@prod' })
      await begin('t-live')
      // The rebuild minted a different Release from the same source. This is the
      // whole defect: `attempt()` answers nothing here.
      expect(await j.attempt({
        kind: 'deploy', app: 'shop', environment: 'production',
        releaseId: otherRelease.id, fromReleaseId: null, generation: 1,
      })).toMatchObject({ resume: null })

      const held = await j.live({ app: 'shop', environment: 'production' })
      expect(held?.transition.id).toBe('t-live')
      // Adopted WITH its Release, or `06-swap` starts bytes the journal never named.
      expect(held?.release.id).toBe(RELEASE.id)
    })

    test('a settled transition is not adopted — succeeded', async () => {
      await j.open({ app: 'shop', host: 'deploy@prod' })
      await begin('t-done')
      await j.settle({ id: 't-done', status: 'succeeded' })
      expect(await j.live({ app: 'shop', environment: 'production' })).toBeNull()
    })

    test('a settled transition is not adopted — failed', async () => {
      await j.open({ app: 'shop', host: 'deploy@prod' })
      await begin('t-failed')
      await j.settle({ id: 't-failed', status: 'failed' })
      expect(await j.live({ app: 'shop', environment: 'production' })).toBeNull()
    })

    test('another environment is not adopted', async () => {
      await j.open({ app: 'shop', host: 'deploy@prod' })
      await begin('t-live')
      expect(await j.live({ app: 'shop', environment: 'stage' })).toBeNull()
    })

    test('another app is not adopted', async () => {
      await j.open({ app: 'shop', host: 'deploy@prod' })
      await begin('t-live')
      expect(await j.live({ app: 'other', environment: 'production' })).toBeNull()
    })

    // A revert opens a transition of its own and takes the same lock. A deploy
    // picking it up would continue somebody else's intent.
    test('a revert in flight is not adopted by a deploy', async () => {
      await j.open({ app: 'shop', host: 'deploy@prod' })
      await j.begin({
        release: RELEASE,
        transition: { ...TRANSITION, id: 't-revert', kind: 'revert' },
        steps: steps('t-revert'),
      })
      expect(await j.live({ kind: 'deploy', app: 'shop', environment: 'production' })).toBeNull()
      expect((await j.live({ kind: 'revert', app: 'shop', environment: 'production' }))?.transition.id)
        .toBe('t-revert')
    })

    test('the newest open transition wins where two are somehow open', async () => {
      await j.open({ app: 'shop', host: 'deploy@prod' })
      await begin('t-old')
      await begin('t-new')
      expect((await j.live({ app: 'shop', environment: 'production' }))?.transition.id).toBe('t-new')
    })

    test('the query names only the columns it is scoped by', () => {
      const [q] = readLiveTransition({ kind: 'deploy', app: 'shop', environment: 'production' })
      expect(q.sql).not.toMatch(/"releaseId"\s*=/)
      expect(q.params).toEqual(['deploy', 'shop', 'production'])
    })
  })

  test('opening a journal that does not exist creates one and stamps it', async () => {
    const { journal } = await j.open({ app: 'shop', host: 'deploy@prod' })
    expect(journal).toMatchObject({ app: 'shop', host: 'deploy@prod', formatVersion: JOURNAL_FORMAT })
  })

  test('opening it twice keeps the first row', async () => {
    await j.open({ app: 'shop', host: 'deploy@prod' })
    const { journal } = await j.open({ app: 'shop', host: 'deploy@prod' })
    expect(journal.app).toBe('shop')
  })

  test('a journal belonging to another app refuses by name', async () => {
    await j.open({ app: 'shop', host: 'deploy@prod' })
    await expect(j.open({ app: 'other', host: 'deploy@prod' })).rejects.toThrow(JournalError)
  })

  test('an empty journal reports nothing serving', async () => {
    await j.open({ app: 'shop', host: 'deploy@prod' })
    expect(await j.state({ app: 'shop', environment: 'production' }))
      .toEqual({ serving: null, schemaHash: null, generation: null, transition: null })
  })

  test('beginning writes the Release, the transition and one row per step', async () => {
    const r = await begin()
    expect(r.resumed).toBe(false)
    expect(r.steps.map(s => s.name)).toEqual(NAMES)
    expect(r.steps.every(s => s.status === 'pending')).toBe(true)
  })

  // The Release id is the hash of its own terms, so a row already there is the
  // same Release and a second write has nothing to change.
  test('beginning twice is the same transition, not a second one', async () => {
    await begin()
    expect((await begin()).resumed).toBe(true)
    expect(await j.history({ app: 'shop', environment: 'production' })).toHaveLength(1)
  })

  // The sequence this whole phase exists for.
  test('a run that dies inside a step resumes exactly where it stopped', async () => {
    const S = steps('t1')
    await begin()
    for (const s of S.slice(0, 2)) {
      await j.claim({ id: s.id })
      await j.finish({ id: s.id, status: 'succeeded', durationMs: 12 })
    }
    await j.claim({ id: S[2].id })                       // claimed, never finished

    const again = await begin()
    expect(again.resumed).toBe(true)
    const byName = new Map(again.steps.map(r => [r.name, resumeDecision(r).action]))
    expect([...byName.values()]).toEqual(['skip', 'skip', 'rerun', 'run'])
  })

  // The half of a resume that a status alone cannot carry. A replayed step
  // contributes nothing to the run, so what it RECORDED has to come back on the
  // row the resume reads — and `output` was not in that projection, so a resumed
  // deploy started `undefined` instead of the image the build had produced.
  test('a replayed step brings its recorded output back with it', async () => {
    const S = steps('t1')
    await begin()
    const note = JSON.stringify({ image: 'sha256:abc', tag: 'shop:1', scope: 'host' })
    await j.claim({ id: S[0].id })
    await j.finish({ id: S[0].id, status: 'succeeded', durationMs: 3, output: note })

    const again = await begin()
    const row = again.steps.find(r => r.name === S[0].name)
    expect(row.output).toBe(note)
    expect(resumeDecision(row).output).toBe(note)
    expect(JSON.parse(resumeDecision(row).output).image).toBe('sha256:abc')
  })

  // A failed deploy leaves the previous release up, so serving must not move
  // until the transition settles.
  test('nothing is serving until the transition settles', async () => {
    const S = steps('t1')
    await begin()
    for (const s of S) { await j.claim({ id: s.id }); await j.finish({ id: s.id, status: 'succeeded' }) }
    expect((await j.state({ app: 'shop', environment: 'production' })).serving).toBeNull()

    await j.settle({ id: 't1', status: 'succeeded' })
    expect((await j.state({ app: 'shop', environment: 'production' })).serving).toBe(RELEASE.id)
  })

  test('a failed transition leaves the previous release serving', async () => {
    await begin()
    await j.settle({ id: 't1', status: 'failed' })
    expect((await j.state({ app: 'shop', environment: 'production' })).serving).toBeNull()
  })

  test('the binding generation comes back off the recorded set', async () => {
    await j.begin({
      release: RELEASE, transition: TRANSITION, steps: steps('t1'),
      bindings: { app: 'shop', environment: 'production', generation: 4, hash: 'h', values: { A: '1' }, secretRefs: {} },
    })
    expect((await j.state({ app: 'shop', environment: 'production' })).generation).toBe(4)
  })

  test('attempt numbering is read off the rows, not guessed', async () => {
    const intent = {
      kind: 'deploy', app: 'shop', environment: 'production',
      fromReleaseId: null, releaseId: RELEASE.id, generation: 1,
    }
    expect(await j.attempt(intent)).toMatchObject({ attempt: 1, resume: null })
    await begin()
    expect((await j.attempt(intent)).resume?.id).toBe('t1')   // running → resume
    await j.settle({ id: 't1', status: 'succeeded' })
    expect(await j.attempt(intent)).toMatchObject({ attempt: 2, resume: null })
  })

  test('a step records its duration and its one line of output', async () => {
    const S = steps('t1')
    await begin()
    await j.claim({ id: S[0].id })
    await j.finish({ id: S[0].id, status: 'succeeded', durationMs: 480, output: 'shop:abc — these bytes, on this host' })
    const [row] = await j.stepsOf('t1')
    expect(row).toMatchObject({ status: 'succeeded', durationMs: 480 })
    expect(row.output).toContain('on this host')
  })

  // A journal row that grows without bound is a journal nobody can read.
  test('an enormous output is truncated rather than stored whole', async () => {
    const S = steps('t1')
    await begin()
    await j.claim({ id: S[0].id })
    await j.finish({ id: S[0].id, status: 'failed', output: 'x'.repeat(50_000) })
    expect((await j.stepsOf('t1'))[0].output.length).toBeLessThanOrEqual(2000)
  })

  test('history is newest first and carries the pivot', async () => {
    await begin('t1')
    await j.settle({ id: 't1', status: 'succeeded' })
    await j.begin({
      release: { ...RELEASE, id: 'r3bbbbbbbbbb', pivot: 'contract' },
      transition: { ...TRANSITION, id: 't2', releaseId: 'r3bbbbbbbbbb', fromReleaseId: RELEASE.id, crossesPivot: true },
      steps: steps('t2'),
    })
    const rows = await j.history({ app: 'shop', environment: 'production' })
    expect(rows.map(r => r.id)).toEqual(['t2', 't1'])
    expect(rows[0]).toMatchObject({ crossesPivot: 1, pivot: 'contract', fromReleaseId: RELEASE.id })
  })

  test('a runner failure is an error with a sentence, not a silent empty read', async () => {
    const broken = journalClient({
      db, ddl: DDL,
      exec: (stdin) => spawnSync('bun', [RUNNER], { input: stdin, encoding: 'utf8' }).stdout,
    })
    await expect(broken.send([{ name: 'x', sql: 'SELECT * FROM "nope"', params: [] }]))
      .rejects.toThrow(/no such table/i)
  })

  test('a transport that answers nothing is named as a transport failure', async () => {
    const mute = journalClient({ db, ddl: DDL, exec: () => '' })
    await expect(mute.open({ app: 'shop', host: 'h' })).rejects.toThrow(/not JSON/)
  })
})
