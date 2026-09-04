// tutor.test.js — the state behind a lesson: where it lives, and what a
// previous run already finished.
//
// The assertions that have to stay are the ones a resume gets wrong silently.
//
//   **a refused step records `failed`** — the runner hands `afterStep` the
//   status `succeeded` for a step that set `context.config.abort` and returned,
//   because nothing threw. Take its word and every failed probe is remembered
//   as done, so the resume skips the step that broke and the lesson continues
//   past it.
//   **a replayed step gives its note back** — a skipped step runs none of its
//   own code, so a fact it discovered (the app directory, a port, a token) has
//   to come back out of the journal or every step after it reads `undefined`.
//   **`--step N` overrides a succeeded row** — otherwise the flag a person
//   reaches for to redo one step silently does nothing.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir }                      from 'node:os'
import { join }                        from 'node:path'

import {
  TUTOR_FORMAT, journalPath, tutorWorkspace, readJournal, writeJournal,
  newJournal, journalVerdict, resumeDecision, hydrate, makeRecorder, note,
  pointAtLocalServer, sweepWorkspace,
} from '../core/tutor.js'

let base
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'fjs-tutor-test-')) })
afterEach(()  => rmSync(base, { recursive: true, force: true }))

// A context shaped the way the step runner builds one.
const ctx = (over = {}) => ({ config: {}, flag: {}, ...over })

describe('the workspace', () => {
  test('a named one is created and kept', () => {
    const ws = tutorWorkspace({ name: join(base, 'my-app'), cwd: base })
    expect(ws.kind).toBe('named')
    expect(existsSync(ws.dir)).toBe(true)
    expect(sweepWorkspace(ws)).toBe(false)
    expect(existsSync(ws.dir)).toBe(true)
  })

  test('a temp one is swept, unless it was asked for', () => {
    const a = tutorWorkspace({ tmp: true })
    expect(a.kind).toBe('temp')
    expect(sweepWorkspace(a)).toBe(true)
    expect(existsSync(a.dir)).toBe(false)

    const b = tutorWorkspace({ tmp: true })
    expect(sweepWorkspace(b, { keep: true })).toBe(false)
    expect(existsSync(b.dir)).toBe(true)
    rmSync(b.dir, { recursive: true, force: true })
  })

  test('a named workspace with no name is refused by name', () => {
    expect(() => tutorWorkspace({})).toThrow(/--workspace/)
  })
})

describe('reading and writing', () => {
  test('a round trip', () => {
    writeJournal(base, newJournal({ workspace: base, app: 'my-app' }))
    const doc = readJournal(base)
    expect(doc.format).toBe(TUTOR_FORMAT)
    expect(doc.app).toBe('my-app')
    expect(existsSync(journalPath(base))).toBe(true)
  })

  test('an absent or unreadable journal is not an error — it is a first run', () => {
    expect(readJournal(base)).toBe(null)
    writeFileSync(journalPath(base), '{ not json')
    expect(readJournal(base)).toBe(null)
  })

  test('the write leaves no partial file behind', () => {
    writeJournal(base, newJournal({ workspace: base, app: 'x' }))
    const stray = readFileSync(journalPath(base), 'utf8')
    expect(() => JSON.parse(stray)).not.toThrow()
  })
})

describe('the refusals', () => {
  test('a journal from another directory is refused, naming both', () => {
    const doc = newJournal({ workspace: '/somewhere/else', app: 'x' })
    const v   = journalVerdict(doc, { workspace: base })
    expect(v.ok).toBe(false)
    expect(v.kind).toBe('workspace')
    expect(v.message).toContain('/somewhere/else')
    expect(v.message).toContain(base)
    expect(v.message).toContain('--restart')
  })

  test('a journal from an older format is refused', () => {
    const doc = { ...newJournal({ workspace: base, app: 'x' }), format: 0 }
    expect(journalVerdict(doc, { workspace: base }).kind).toBe('format')
  })

  test('no journal at all is a first run, not a refusal', () => {
    expect(journalVerdict(null, { workspace: base }).ok).toBe(true)
  })
})

describe('resumeDecision', () => {
  test('the three verdicts', () => {
    expect(resumeDecision(undefined).action).toBe('run')
    expect(resumeDecision({ status: 'succeeded' }).action).toBe('skip')
    expect(resumeDecision({ status: 'skipped' }).action).toBe('skip')
    expect(resumeDecision({ status: 'running' }).action).toBe('rerun')
    expect(resumeDecision({ status: 'failed' }).action).toBe('run')
  })

  test('a step that died mid-run is RE-run, never skipped', () => {
    const d = resumeDecision({ status: 'running' })
    expect(d.action).toBe('rerun')
    expect(d.note).toContain('died inside this step')
  })

  test('a succeeded step carries its recorded output back', () => {
    const d = resumeDecision({ status: 'succeeded', output: '{"appDir":"/tmp/a"}' })
    expect(d.output).toBe('{"appDir":"/tmp/a"}')
  })
})

describe('an ephemeral step', () => {
  // A running process is the one thing the journal cannot hold. Replay the step
  // that started it and every step after it talks to a dead port — which is a
  // connection refused several steps from the cause.

  test('is never skipped, however it finished last time', () => {
    const first = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx(), ephemeral: ['04-run'] })
    first.beforeStep('04-run')
    first.afterStep('04-run', 4, { status: 'succeeded', output: '{"appDir":"/tmp/a"}' })

    const context = ctx()
    const second  = makeRecorder({ workspace: base, lesson: 'tutor:app', context, ephemeral: ['04-run'] })

    expect(second.beforeStep('04-run').run).toBe(true)
  })

  test('and the step beside it, not named, still replays', () => {
    const first = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx(), ephemeral: ['04-run'] })
    for (const n of ['04-run', '05-register']) {
      first.beforeStep(n)
      first.afterStep(n, 1, { status: 'succeeded', output: '{}' })
    }

    const second = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx(), ephemeral: ['04-run'] })
    expect(second.beforeStep('04-run').run).toBe(true)
    expect(second.beforeStep('05-register').run).toBe(false)
  })

  test('is still RECORDED — it is not skipped, only never replayed', () => {
    const r = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx(), ephemeral: ['04-run'] })
    r.beforeStep('04-run')
    r.afterStep('04-run', 4, { status: 'succeeded' })

    expect(readJournal(base).lessons['tutor:app'].steps['04-run'].status).toBe('succeeded')
  })
})

describe('writing a journal into a workspace that is gone', () => {
  // The teardown step sweeps a temporary workspace and the runner then records
  // that step, in that order. Throwing there made a lesson that had just
  // printed `done` exit 1 about a temp file in a directory nobody has.

  test('answers null rather than throwing', () => {
    const gone = join(base, 'never-made')
    expect(writeJournal(gone, newJournal({ workspace: gone, app: 'x' }))).toBe(null)
  })

  test('and a recorder over one settles without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-tutor-gone-'))
    const r   = makeRecorder({ workspace: dir, lesson: 'tutor:app', context: ctx() })
    r.beforeStep('10-finish')
    rmSync(dir, { recursive: true, force: true })

    expect(() => r.afterStep('10-finish', 10, { status: 'succeeded' })).not.toThrow()
    expect(() => r.settle('succeeded')).not.toThrow()
  })
})

describe('the recorder', () => {
  test('a first run runs everything and records it', () => {
    const context = ctx()
    const r = makeRecorder({ workspace: base, lesson: 'tutor:app', context })

    expect(r.beforeStep('01-scaffold').run).toBe(true)
    r.afterStep('01-scaffold', 1, { status: 'succeeded', durationMs: 10 })

    const doc = readJournal(base)
    expect(doc.lessons['tutor:app'].steps['01-scaffold'].status).toBe('succeeded')
  })

  test('a second run replays a succeeded step into a no-op', () => {
    const first = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx() })
    first.beforeStep('01-scaffold')
    first.afterStep('01-scaffold', 1, { status: 'succeeded', output: '{"appDir":"/tmp/a"}' })

    const context = ctx()
    const second  = makeRecorder({ workspace: base, lesson: 'tutor:app', context })
    const claim   = second.beforeStep('01-scaffold')

    expect(claim.run).toBe(false)
    expect(claim.note).toContain('replayed into a no-op')
    // …and the fact it discovered is back, which is the whole reason a note exists
    expect(context.config.appDir).toBe('/tmp/a')
  })

  test('a REFUSED step records failed, not the succeeded the runner reports', () => {
    const context = ctx()
    const r = makeRecorder({ workspace: base, lesson: 'tutor:app', context })

    r.beforeStep('04-register')
    context.config.abort = true          // what `must()` does on a failed probe
    r.afterStep('04-register', 4, { status: 'succeeded', durationMs: 5 })

    expect(readJournal(base).lessons['tutor:app'].steps['04-register'].status).toBe('failed')

    // …so the next run runs it again rather than skipping past the break
    const next = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx() })
    expect(next.beforeStep('04-register').run).toBe(true)
  })

  test('a deliberate stop is not a refusal', () => {
    const context = ctx()
    const r = makeRecorder({ workspace: base, lesson: 'tutor:fleet', context })

    r.beforeStep('01-locate')
    context.config.abort = true
    context.config.stop  = true
    r.afterStep('01-locate', 1, { status: 'succeeded' })

    expect(readJournal(base).lessons['tutor:fleet'].steps['01-locate'].status).toBe('succeeded')
  })

  test('a step interrupted mid-run is left running, and re-runs', () => {
    const r = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx() })
    r.beforeStep('03-run')               // and the process dies here

    expect(readJournal(base).lessons['tutor:app'].steps['03-run'].status).toBe('running')

    const next  = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx() })
    const claim = next.beforeStep('03-run')
    expect(claim.run).toBe(true)
    expect(claim.note).toContain('died inside this step')
  })

  test('--step N overrides a succeeded row', () => {
    const first = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx() })
    first.beforeStep('05-model')
    first.afterStep('05-model', 5, { status: 'succeeded' })

    const forced = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx({ flag: { step: 5 } }) })
    expect(forced.beforeStep('05-model').run).toBe(true)
  })

  test('--restart clears the lesson and leaves its neighbors alone', () => {
    const a = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx() })
    a.beforeStep('01'); a.afterStep('01', 1, { status: 'succeeded' })
    const b = makeRecorder({ workspace: base, lesson: 'tutor:access', context: ctx() })
    b.beforeStep('01'); b.afterStep('01', 1, { status: 'succeeded' })

    const again = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx() })
    again.restart()

    const doc = readJournal(base)
    expect(doc.lessons['tutor:app'].steps).toEqual({})
    expect(doc.lessons['tutor:access'].steps['01'].status).toBe('succeeded')
  })

  test('lessons do not read each other', () => {
    const a = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx() })
    a.beforeStep('01-shared-name'); a.afterStep('01-shared-name', 1, { status: 'succeeded' })

    const b = makeRecorder({ workspace: base, lesson: 'tutor:deploy', context: ctx() })
    expect(b.beforeStep('01-shared-name').run).toBe(true)
  })

  test('settle records how the lesson ended', () => {
    const r = makeRecorder({ workspace: base, lesson: 'tutor:app', context: ctx() })
    r.settle('failed')
    expect(readJournal(base).lessons['tutor:app'].status).toBe('failed')
  })
})

describe('note and hydrate', () => {
  test('a note reaches the steps after it, in this run and the next', () => {
    const context = ctx()
    const r = makeRecorder({ workspace: base, lesson: 'tutor:app', context })

    r.beforeStep('01-workspace')
    note(context, '01-workspace', { appDir: '/tmp/app', apiPort: 8100 })
    expect(context.config.appDir).toBe('/tmp/app')   // this run
    r.afterStep('01-workspace', 1, { status: 'succeeded' })

    expect(hydrate(readJournal(base), 'tutor:app')).toEqual({ appDir: '/tmp/app', apiPort: 8100 })
  })

  test('hydrate merges every finished step and ignores the unfinished', () => {
    const context = ctx()
    const r = makeRecorder({ workspace: base, lesson: 'tutor:app', context })

    r.beforeStep('01'); note(context, '01', { appDir: '/tmp/app' }); r.afterStep('01', 1, { status: 'succeeded' })
    r.beforeStep('02'); note(context, '02', { token: 'sk' });        r.afterStep('02', 2, { status: 'succeeded' })
    r.beforeStep('03'); note(context, '03', { never: true })
    context.config.abort = true
    r.afterStep('03', 3, { status: 'succeeded' })

    const facts = hydrate(readJournal(base), 'tutor:app')
    expect(facts).toEqual({ appDir: '/tmp/app', token: 'sk' })
    expect(facts.never).toBeUndefined()
  })

  test('hydrate on a lesson that never ran is empty, not a throw', () => {
    expect(hydrate(null, 'tutor:app')).toEqual({})
    expect(hydrate(newJournal({ workspace: base, app: 'x' }), 'tutor:app')).toEqual({})
  })
})

describe('pointAtLocalServer', () => {
  // The block `fli make:deploy` REALLY writes, copied from
  // `commands/make/deploy.md`'s `makeDeployBlock` for appId `my-app`. A
  // hand-simplified fixture is what lets a rewrite pass here and miss on a real
  // app — the web block alone has a commented-out `// },` inside it that a
  // greedy match eats.
  const CONF = `export default {
  deploy: {
    server: 'localhost',
    user: 'deploy',              // SSH user on the server
    path: '/apps/my-app',      // deploy root on the server
    app_id: 'my-app',

    api: {
      port:       3000,
      health:     '/api/health',
      dockerfile: 'deploy/Dockerfile',
      env:        '/apps/my-app/.env.production',

      envCheck: true,
    },

    web: {
      domain: 'ci.invalid',
      keep_releases: 3,
      // ssl: {
      //   cert: '/etc/ssl/certs/my-app.pem',
      //   key:  '/etc/ssl/private/my-app.key',
      // },
    },

    db: {
      path:         '/apps/my-app/db',
      file:         'production.db',
      keep_backups: 5,
    },
  },
}
`

  test('every term is pointed at this machine', () => {
    const { text, ok } = pointAtLocalServer(CONF, { serverDir: '/tmp/srv', port: 7102 })

    expect(ok).toBe(true)
    expect(text).toContain("path: '/tmp/srv',      // deploy root on the server")
    expect(text).toContain("env:        '/tmp/srv/.env.production'")
    expect(text).toContain('port:       7102,')
    expect(text).toContain("path:         '/tmp/srv/db',")
    expect(text).toContain('web: false,')
    expect(text).not.toContain('ci.invalid')
    expect(text).not.toContain('keep_releases')
    // the db block survives — a greedy web match would have eaten it
    expect(text).toContain("file:         'production.db',")
    expect(text).toContain('envCheck: true,')
  })

  test('a config it cannot rewrite answers ok:false rather than passing silently', () => {
    // The failure this exists for: every regex misses, the file is written back
    // unchanged, and the deploy goes to whatever host make:deploy was given.
    const { text, ok } = pointAtLocalServer('export default { deploy: { server: "prod" } }', { serverDir: '/tmp/srv', port: 7102 })
    expect(ok).toBe(false)
    expect(text).not.toContain('/tmp/srv')
  })
})
