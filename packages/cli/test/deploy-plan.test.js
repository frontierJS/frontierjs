// ─── deploy-plan.test.js — the journal rows a transition would write ───────────────
//
// Phase 1d. `--plan` executes nothing, so what there is to get wrong is the
// SHAPE: an id that collides with a different intent, a step list that has
// drifted from the pipeline, a pivot graded the permissive way. Each of those
// is silent at plan time and expensive at 1e.
//
// The rows are built here and inserted there, from one function, because the
// model itself says so — `Transition.plan` carries the plan, so the document a
// person read and the record a deploy wrote cannot be two things that disagree.

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import {
  PLAN_FORMAT, stepFilesIn, stepNameOf, skipDecision, planSteps,
  transitionId, planTransition, formatPlan, crossesPivot,
} from '../core/deploy-plan.js'
import { extractFrontmatter } from '../core/compiler.js'

const RELEASE = {
  id: 'a1b2c3d4e5f6', app: 'shop', environment: 'production',
  digest: null, imageRef: null,
  configurationHash: 'b'.repeat(64), schemaHash: 'c'.repeat(64),
}

const STEPS = [
  { name: '01-preflight' },
  { name: '02-ship' },
  { name: '04-build-api', skip: '!$.config.doApi' },
]

const plannedWith = (config) => planSteps(STEPS, { flag: {}, $: { config } })

// ─── the step list ───────────────────────────────────────────────────────────

describe('the steps are read, not listed', () => {
  test('the runner\'s own filter: numbered .md only', () => {
    expect(stepFilesIn(['01-a.md', '_module.md', 'README.txt', 'notes.md', '02-b.md']))
      .toEqual(['01-a.md', '02-b.md'])
  })

  // Lexicographic on the whole filename, which is what lets a step be inserted
  // between two others without renumbering the rest — `02b-build-check` is a
  // real instance and its position is load-bearing.
  test('a lettered step sorts between its neighbors', () => {
    expect(stepFilesIn(['03-c.md', '02b-x.md', '02-b.md', '01-a.md']))
      .toEqual(['01-a.md', '02-b.md', '02b-x.md', '03-c.md'])
  })

  test('nothing at all is an empty list rather than a throw', () => {
    expect(stepFilesIn(undefined)).toEqual([])
  })

  test('the file names the step', () => {
    expect(stepNameOf('04-build-api.md')).toBe('04-build-api')
  })

  // The anti-drift assertion, and the reason this module reads a directory at
  // all: a plan that carried its own copy of the pipeline would be wrong the
  // first time somebody added a step, and wrong silently.
  test('the real pipeline is readable by these rules, in order', () => {
    const dir   = resolve(import.meta.dir, '../commands/deploy/_steps-docker')
    const files = stepFilesIn(readdirSync(dir))
    expect(files.length).toBeGreaterThan(5)
    expect(files[0]).toBe('01-preflight.md')
    expect(files.at(-1)).toBe('09-cleanup.md')
    // Every one carries a title, or the plan renders a nameless row.
    for (const f of files) {
      const fm = extractFrontmatter(readFileSync(`${dir}/${f}`, 'utf8'))
      expect(fm?.title, `${f} has no title`).toBeTruthy()
    }
  })

  // The runner warns when two steps share a prefix, so a shipped pair that does
  // fires it on every run and teaches everyone to read past it (FJS-4207).
  test('no shipped step folder has two steps on one prefix', () => {
    const commands = resolve(import.meta.dir, '../commands')
    const shared   = []
    for (const ns of readdirSync(commands, { withFileTypes: true })) {
      if (!ns.isDirectory()) continue
      for (const dir of readdirSync(`${commands}/${ns.name}`, { withFileTypes: true })) {
        if (!dir.isDirectory() || !dir.name.startsWith('_steps')) continue
        const seen = new Map()
        for (const f of stepFilesIn(readdirSync(`${commands}/${ns.name}/${dir.name}`))) {
          const prefix = f.match(/^(\d+[a-z]*)/)[1]
          if (seen.has(prefix)) shared.push(`${ns.name}/${dir.name}: ${seen.get(prefix)} and ${f}`)
          else seen.set(prefix, f)
        }
      }
    }
    expect(shared).toEqual([])
  })
})

// ─── skip ────────────────────────────────────────────────────────────────────

describe('evaluating a skip predicate the way the runner does', () => {
  test('no predicate runs the step', () => {
    expect(skipDecision(null, { flag: {}, $: {} })).toMatchObject({ skipped: false })
  })

  test('a true predicate skips it, and the reason is the predicate itself', () => {
    const d = skipDecision('!$.config.doApi', { flag: {}, $: { config: { doApi: false } } })
    expect(d.skipped).toBe(true)
    expect(d.reason).toBe('!$.config.doApi')
  })

  test('a false predicate runs it and records no reason', () => {
    expect(skipDecision('!$.config.doApi', { flag: {}, $: { config: { doApi: true } } }))
      .toEqual({ skipped: false, reason: null })
  })

  // The runner falls through to RUNNING on a throw, so a plan that reported the
  // step skipped would describe a deploy that does not happen. Fail-open in the
  // same direction, and say so.
  test('a predicate that throws leaves the step running, and is reported', () => {
    const d = skipDecision('nope.nothing.here', { flag: {}, $: {} })
    expect(d.skipped).toBe(false)
    expect(d.threw).toBeTruthy()
  })

  test('a flag is in scope, as it is for the runner', () => {
    expect(skipDecision('flag.web', { flag: { web: true }, $: {} }).skipped).toBe(true)
  })

  // The runner evaluates a predicate as `(config.flag, config)`, so a step may
  // reach the flag EITHER way and both have to resolve. `04c-journal` reads
  // `$.flag.dry`, and against a context carrying only `config` it threw —
  // so the plan could not grade the journal step itself.
  test('the flag is reachable through the context too, the way the runner passes it', () => {
    const ctx = { flag: { dry: true }, config: { deployConf: {} } }
    const d = skipDecision('$.flag.dry', { flag: ctx.flag, $: ctx })
    expect(d.skipped).toBe(true)
    expect(d.threw).toBeUndefined()
  })

  test("the real 04c-journal predicate grades rather than throwing", () => {
    const pred = '$.flag.dry || $.config.deployConf.journal === false'
    const ctx  = (flagDry, journal) =>
      ({ flag: { dry: flagDry }, config: { deployConf: { journal } } })

    const dry = ctx(true, undefined)
    expect(skipDecision(pred, { flag: dry.flag, $: dry })).toMatchObject({ skipped: true })

    const off = ctx(false, false)
    expect(skipDecision(pred, { flag: off.flag, $: off })).toMatchObject({ skipped: true })

    const on = ctx(false, undefined)
    const d  = skipDecision(pred, { flag: on.flag, $: on })
    expect(d.skipped).toBe(false)
    expect(d.threw).toBeUndefined()
  })
})

describe('planning the steps', () => {
  test('ordinals are 1-based and follow the file order', () => {
    expect(plannedWith({ doApi: true }).map(s => s.ordinal)).toEqual([1, 2, 3])
  })

  // Two reasons and the second is the one a dropped row cannot serve: an
  // operator needs *the backup did not run* to be visible, and a resume has to
  // find the step it stopped at even after a `skip:` changed its answer.
  test('a skipped step keeps its ordinal instead of being dropped', () => {
    const s = plannedWith({ doApi: false })
    expect(s).toHaveLength(3)
    expect(s[2]).toMatchObject({ ordinal: 3, name: '04-build-api', status: 'skipped', run: false })
  })

  test('a step that will run is pending, not skipped', () => {
    expect(plannedWith({ doApi: true })[2]).toMatchObject({ status: 'pending', run: true })
  })
})

// ─── the transition id ───────────────────────────────────────────────────────

describe('the id of one attempt to move serving state', () => {
  const base = {
    kind: 'deploy', app: 'shop', environment: 'production',
    fromReleaseId: 'r1', releaseId: 'r2', generation: 1, attempt: 1,
  }

  test.each([
    ['kind',          { kind: 'revert' }],
    ['app',           { app: 'other' }],
    ['environment',   { environment: 'stage' }],
    ['from',          { fromReleaseId: 'r0' }],
    ['to',            { releaseId: 'r3' }],
    ['generation',    { generation: 2 }],
    ['attempt',       { attempt: 2 }],
  ])('%s moves the id', (_label, patch) => {
    expect(transitionId({ ...base, ...patch })).not.toBe(transitionId(base))
  })

  // The resume case: a crashed deploy reruns, computes the same id, and finds
  // the row it left behind.
  test('the same intent computes the same id', () => {
    expect(transitionId(base)).toBe(transitionId({ ...base }))
  })

  // The direction matters: R1→R2 and R2→R1 are two different operations and one
  // must not resume the other.
  test('a move and its reverse are different transitions', () => {
    expect(transitionId(base))
      .not.toBe(transitionId({ ...base, fromReleaseId: 'r2', releaseId: 'r1' }))
  })

  test('a first deploy names no predecessor rather than omitting the term', () => {
    expect(transitionId({ ...base, fromReleaseId: null })).toContain(':none:')
  })

  // occurrenceKey's own injectivity — the reason four call sites were replaced
  // by one (FJS-342). A joined string would make these two the same key.
  test('a colon inside a term cannot forge a different id', () => {
    expect(transitionId({ ...base, app: 'shop:production' }))
      .not.toBe(transitionId({ ...base, app: 'shop', environment: 'production:production' }))
  })
})

// ─── the rows ────────────────────────────────────────────────────────────────

describe('the journal rows', () => {
  const build = (release = RELEASE, config = { doApi: true }) =>
    planTransition({ release, steps: plannedWith(config) })

  test('the transition is planned and names its Release', () => {
    const { transition } = build()
    expect(transition).toMatchObject({
      kind: 'deploy', app: 'shop', environment: 'production',
      releaseId: RELEASE.id, fromReleaseId: null, status: 'planned', generation: 1,
    })
  })

  test('one step row per planned step, keyed by the step name', () => {
    const { transition, steps } = build()
    expect(steps).toHaveLength(3)
    expect(steps[0].id).toBe(`deploy:${transition.id.replace(/:/g, '%3A')}:01-preflight`)
    expect(steps.every(s => s.transitionId === transition.id)).toBe(true)
  })

  test('a skipped step is still a row, at its own ordinal', () => {
    const { steps } = build(RELEASE, { doApi: false })
    expect(steps.map(s => s.ordinal)).toEqual([1, 2, 3])
    expect(steps[2].status).toBe('skipped')
  })

  // What each step checks before it runs, and it is the model's own three-part
  // shape: the Release serving, the configuration generation, the schema as applied.
  test('every step carries the same precondition', () => {
    const { steps } = build()
    for (const s of steps)
      expect(s.precondition).toEqual({ serving: null, generation: 1, schemaHash: RELEASE.schemaHash })
  })

  test('a resumed transition finds the same step ids', () => {
    expect(build().steps.map(s => s.id)).toEqual(build().steps.map(s => s.id))
  })

  // Recorded rather than re-derived: what matters afterwards is the answer the
  // operator was shown, not the one a classifier gives once the schema moved on.
  // The verdict is the transition's, asked of the target against what serves.
  test.each([
    ['unchanged',                'unchanged', 'r1', false],
    ['expand',                   'expand',    'r1', false],
    ['contract',                 'contract',  'r1', true],
    ['unknown',                  'unknown',   'r1', true],   // unknown counts as a contract
    ['no verdict, something live', null,      'r1', true],   // a classifier that did not run proved nothing
    ['a first deploy',           null,        null, false],  // nothing earlier to revert to
    ['a first deploy, contract', 'contract',  null, false],
  ])('%s → isCrossingPivot', (_l, pivot, fromReleaseId, expected) => {
    expect(crossesPivot({ pivot, fromReleaseId })).toBe(expected)
    const { transition } = planTransition({ release: RELEASE, fromReleaseId, pivot, pivotReason: 'why', steps: [] })
    expect(transition.isCrossingPivot).toBe(expected)
    expect(transition).toMatchObject({ pivot, pivotReason: 'why' })
  })

  // A pause moves no schema; its caller states the answer instead.
  test('a stated isCrossingPivot wins over the derivation', () => {
    expect(planTransition({ release: RELEASE, fromReleaseId: 'r1', isCrossingPivot: false }).transition.isCrossingPivot).toBe(false)
  })

  // The plan blob has to stand alone: 1e stores it and 1f reads it back, by
  // which time the step rows have been mutated by the run.
  test('the plan blob carries its format and mirrors the step rows', () => {
    const { transition, steps } = build(RELEASE, { doApi: false })
    expect(transition.plan.formatVersion).toBe(PLAN_FORMAT)
    expect(transition.plan.steps.map(s => s.ordinal)).toEqual(steps.map(s => s.ordinal))
    expect(transition.plan.steps.map(s => s.name)).toEqual(steps.map(s => s.name))
    expect(transition.plan.steps[2].skippedBy).toBe('!$.config.doApi')
  })

  test('a plan without a Release is refused rather than half-built', () => {
    expect(() => planTransition({ steps: [] })).toThrow(/minted Release/)
  })
})

// ─── the report ──────────────────────────────────────────────────────────────

const render = (release, config = { doApi: true }) => {
  const plan = planTransition({ release, steps: plannedWith(config) })
  return formatPlan({ ...plan, release })
}

describe('what a person reads', () => {
  // The digest is a TERM of the Release id, so a plan that built nothing is
  // naming an id the deploy will not mint. Left unsaid, the first person to
  // compare the two finds out by noticing they differ.
  test('an unbuilt plan says its own Release id is provisional', () => {
    const out = render({ ...RELEASE, digest: null })
    expect(out).toContain('provisional')
    expect(out).toContain('term of this id')
  })

  test('a plan naming real bytes claims nothing provisional about its id', () => {
    const out = render({ ...RELEASE, digest: 'sha256:' + 'a'.repeat(64), imageRef: 'digest' })
    expect(out).not.toContain('term of this id')
  })

  // A plan reaches no server, and the verdict is relative to the schema the
  // live container runs, so a laptop guess is what printed `unknown` under
  // every deploy (`FJS-4004`).
  test('the pivot is left to the target rather than guessed', () => {
    const out = render(RELEASE)
    expect(out).toContain('decided on the target at deploy time')
    expect(out).not.toMatch(/Pivot\s+(expand|contract|unknown)/)
  })

  // A tag is not an identity, so an absent digest says so rather than showing
  // one as though it were.
  test('no digest reads as not built, never as a tag', () => {
    expect(render(RELEASE)).toContain('not built')
  })

  test('a digest is shown short, with its readable name beside it', () => {
    const out = render({ ...RELEASE, digest: 'sha256:' + 'd'.repeat(64), imageRef: 'shop@sha256:dd' })
    expect(out).toContain('shop@sha256:dd')
  })

  test('with no journal on the target, serving says so rather than guessing', () => {
    expect(render(RELEASE)).toContain('nothing recorded')
  })

  test('the attempt is labeled provisional, because the journal owns the count', () => {
    expect(render(RELEASE)).toContain('provisional')
  })

  test('a skipped step is shown with the predicate that skipped it', () => {
    const out = render(RELEASE, { doApi: false })
    expect(out).toContain('2 of 3 would run')
    expect(out).toContain('!$.config.doApi')
  })

  test('a predicate that threw is reported as RUNNING, not as skipped', () => {
    const steps = planSteps([{ name: '01-x', skip: 'nope.nothing' }], { flag: {}, $: {} })
    const plan  = planTransition({ release: RELEASE, steps })
    const out   = formatPlan({ ...plan, release: RELEASE })
    expect(out).toContain('it will RUN')
    expect(out).not.toMatch(/01-x\s+skipped/)
  })

  test('it closes by saying nothing was written', () => {
    expect(render(RELEASE)).toContain('Nothing above has been written or run')
  })
})
