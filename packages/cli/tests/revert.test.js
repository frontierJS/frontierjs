// ─── revert.test.js — can serving state be put back, and what stops it ──────
//
// Phase 1f, the last of phase 1. The guarantee the design was arranged around is
// *before the pivot, revert restores code, config and schema* — and the whole of
// what makes that a guarantee rather than a hope is the refusals. A rollback that
// puts the previous image back and says nothing is what every other tool ships,
// and it is wrong in exactly the four situations somebody reaches for it.
//
// So this file is mostly about what does NOT happen.

import { describe, test, expect } from 'bun:test'
import {
  REFUSALS, chooseTarget, transitionsSince, imageFromSteps,
  revertRefusals, blocking, formatRevertPlan,
} from '../core/revert.js'

// Newest first, as `readHistory` answers.
const H = (...rows) => rows
const t = (id, releaseId, status, extra = {}) =>
  ({ id, releaseId, status, fromReleaseId: null, crossesPivot: 0, ...extra })

const RELEASE = (id, extra = {}) =>
  ({ id, generation: 1, retentionUntil: null, createdAt: '2026-08-01T00:00:00.000Z', ...extra })

const IMAGE = { image: 'sha256:abc', tag: 'shop:1', scope: 'host', parsed: true }

// ─── the previous TRANSITION, not just the previous release ─────────────────

describe('what the revert restores', () => {
  // Build-on-target puts no digest in the Release id, so two deploys of
  // different source mint the same id. Picking by id answers the newest
  // transition, which is the one serving — measured: a revert restored the bytes
  // it was reverting from and reported success.
  test('two deploys of one Release id resolve to the earlier transition', () => {
    const c = chooseTarget(H(
      t('t3', 'rA', 'succeeded', { fromReleaseId: 'rA' }),
      t('t2', 'rA', 'succeeded', { fromReleaseId: 'rZ' }),
    ))
    expect(c.serving.id).toBe('t3')
    expect(c.previous.id).toBe('t2')
    expect(c.targetId).toBe('rA')
  })

  test('--to picks a transition that is not the serving one', () => {
    const c = chooseTarget(H(
      t('t3', 'rC', 'succeeded'),
      t('t2', 'rB', 'succeeded'),
      t('t1', 'rB', 'succeeded'),
    ), { to: 'rB' })
    expect(c.previous.id).toBe('t2')
  })

  test('a failed attempt between two deploys is not the previous transition', () => {
    const c = chooseTarget(H(
      t('t3', 'rB', 'succeeded'),
      t('t2', 'rB', 'failed'),
      t('t1', 'rA', 'succeeded'),
    ))
    expect(c.previous.id).toBe('t1')
  })

  test('a first deploy has no previous transition', () => {
    expect(chooseTarget(H(t('t1', 'rA', 'succeeded'))).previous).toBe(null)
  })
})

describe('restoring the bytes already running', () => {
  const SAME = { image: 'sha256:abc', parsed: true }

  test('is refused, and the refusal carries no override', () => {
    const r = revertRefusals({
      serving: t('t2', 'rA', 'succeeded'), target: RELEASE('rA'),
      generation: 1, image: SAME, servingImage: SAME,
    })
    const same = r.find(x => x.kind === 'same-bytes')
    expect(same).toBeTruthy()
    expect(same.override).toBe(null)
    expect(blocking(r).map(x => x.kind)).toContain('same-bytes')
  })

  test('different bytes under one Release id is not refused', () => {
    const r = revertRefusals({
      serving: t('t2', 'rA', 'succeeded'), target: RELEASE('rA'),
      generation: 1, image: SAME, servingImage: { image: 'sha256:def', parsed: true },
    })
    expect(r.map(x => x.kind)).not.toContain('same-bytes')
  })

  // An unknown serving image must not be read as *the same*, or every revert on
  // a target whose build note is unreadable would be refused.
  test('an unknown serving image decides nothing', () => {
    const r = revertRefusals({
      serving: t('t2', 'rA', 'succeeded'), target: RELEASE('rA'),
      generation: 1, image: SAME, servingImage: null,
    })
    expect(r.map(x => x.kind)).not.toContain('same-bytes')
  })

  test('and does not say it when the bytes are identical too', () => {
    const text = formatRevertPlan({
      app: 'shop', environment: 'dev',
      serving: t('t2', 'rA', 'succeeded'), target: RELEASE('rA'),
      image: { image: 'sha256:abc' }, servingImage: { image: 'sha256:abc' }, refusals: [],
    })
    expect(text).not.toContain('the bytes differ')
  })

  test('the plan says when one Release id names both sides', () => {
    const text = formatRevertPlan({
      app: 'shop', environment: 'dev',
      serving: t('t2', 'rA', 'succeeded'), target: RELEASE('rA'),
      image: { image: 'sha256:def' }, servingImage: { image: 'sha256:abc' }, refusals: [],
    })
    expect(text).toContain('the bytes differ, the id cannot')
    expect(text).toContain('sha256:abc')
    expect(text).toContain('sha256:def')
  })
})

// ─── choosing ────────────────────────────────────────────────────────────────

describe('what is serving, and what to go back to', () => {
  test('an empty journal has no answer, and says which', () => {
    expect(chooseTarget([])).toMatchObject({ reason: 'no-journal' })
  })

  // A failed deploy leaves the previous release up. Reverting FROM an attempt
  // that never took hold would move a release nobody is running.
  test('serving is the last SUCCEEDED transition, not the last one', () => {
    const c = chooseTarget(H(
      t('t3', 'r3', 'failed'),
      t('t2', 'r2', 'succeeded', { fromReleaseId: 'r1' }),
    ))
    expect(c.serving.id).toBe('t2')
    expect(c.targetId).toBe('r1')
  })

  // The pair that was serving immediately before — which after a revert is a
  // different answer from "the previous different releaseId" in the history.
  test('the default target is where the serving transition came FROM', () => {
    expect(chooseTarget(H(t('t2', 'r2', 'succeeded', { fromReleaseId: 'r1' }))).targetId).toBe('r1')
  })

  test('a first deploy has nothing to go back to', () => {
    expect(chooseTarget(H(t('t1', 'r1', 'succeeded')))).toMatchObject({ reason: 'nothing-prior' })
  })

  test('--to names a release outright', () => {
    expect(chooseTarget(H(t('t2', 'r2', 'succeeded', { fromReleaseId: 'r1' })), { to: 'r0' }).targetId).toBe('r0')
  })

  test('a transition still open is reported, not ignored', () => {
    const c = chooseTarget(H(t('t3', 'r3', 'running'), t('t2', 'r2', 'succeeded', { fromReleaseId: 'r1' })))
    expect(c.inFlight.id).toBe('t3')
  })
})

describe('what happened since', () => {
  test('everything above the target, and the target itself excluded', () => {
    const since = transitionsSince(H(
      t('t3', 'r3', 'succeeded'), t('t2', 'r2', 'failed'), t('t1', 'r1', 'succeeded'),
    ), 'r1')
    expect(since.map(h => h.id)).toEqual(['t3', 't2'])
  })

  // A failed attempt at the target's own release is not the target, so the walk
  // must not stop at it.
  test('a FAILED transition of the target release does not end the walk', () => {
    const since = transitionsSince(H(
      t('t3', 'r3', 'succeeded'), t('t2', 'r1', 'failed'), t('t1', 'r1', 'succeeded'),
    ), 'r1')
    expect(since.map(h => h.id)).toEqual(['t3', 't2'])
  })

  test('a target that is not in the history yields the whole list rather than throwing', () => {
    expect(transitionsSince(H(t('t1', 'r1', 'succeeded')), 'nope')).toHaveLength(1)
  })
})

// ─── the bytes ───────────────────────────────────────────────────────────────

describe('which bytes that release ran', () => {
  // Under build-on-target the digest is not a term of the Release, so the way
  // back to an image is what step 04 wrote down.
  test('the build step output is JSON and is read as JSON', () => {
    const got = imageFromSteps([
      { name: '02-pull', output: null },
      { name: '04-build-api', output: JSON.stringify({ image: 'sha256:abc', tag: 'shop:1', scope: 'host' }) },
    ])
    expect(got).toMatchObject({ image: 'sha256:abc', tag: 'shop:1', scope: 'host', parsed: true })
  })

  // A row an older fli wrote is a sentence. Returned unparsed rather than
  // guessed at — a revert that ran the wrong bytes is the worst outcome here.
  test('a prose output is returned unparsed, never scraped', () => {
    const got = imageFromSteps([{ name: '04-build-api', output: 'shop:abc — these bytes, on this host' }])
    expect(got.parsed).toBe(false)
    expect(got.image).toBeNull()
    expect(got.raw).toContain('shop:abc')
  })

  test('no build step at all answers nothing', () => {
    expect(imageFromSteps([{ name: '02-pull', output: 'x' }])).toMatchObject({ image: null, parsed: false })
  })

  test('an empty step list does not throw', () => {
    expect(imageFromSteps()).toMatchObject({ image: null })
  })

  // A revert has no `04-build-api` — it starts an image rather than building
  // one. Matching the step by NAME meant a revert transition recorded no image
  // and the release it restored could not itself be reverted to: the next revert
  // read `no-image` about a release that was plainly running.
  test('a revert records its image on the swap, and that counts', () => {
    const got = imageFromSteps([
      { name: '02-decide', output: null },
      { name: '03-swap',   output: JSON.stringify({ image: 'sha256:def', scope: 'restored' }) },
    ])
    expect(got).toMatchObject({ image: 'sha256:def', scope: 'restored', parsed: true })
  })

  // A transition that builds and then swaps puts the SWAP's image into service.
  test('the last step to record an image wins', () => {
    const got = imageFromSteps([
      { name: '04-build-api', output: JSON.stringify({ image: 'sha256:built' }) },
      { name: '06-swap',      output: JSON.stringify({ image: 'sha256:started' }) },
    ])
    expect(got.image).toBe('sha256:started')
  })

  test('a JSON note carrying no image is not an image', () => {
    expect(imageFromSteps([{ name: '05-backup', output: JSON.stringify({ ok: true }) }]))
      .toMatchObject({ image: null, parsed: false })
  })
})

// ─── the refusals ────────────────────────────────────────────────────────────

const check = (over = {}) => revertRefusals({
  serving: t('t2', 'r2', 'succeeded', { fromReleaseId: 'r1' }),
  target:  RELEASE('r1'),
  since:   [t('t2', 'r2', 'succeeded')],
  generation: 1,
  image: IMAGE,
  ...over,
})
const kinds = (rs) => rs.map(r => r.kind)

describe('nothing in the way', () => {
  test('an ordinary revert is refused by nothing', () => {
    expect(check()).toEqual([])
  })

  test('the plan says so in as many words', () => {
    expect(formatRevertPlan({ app: 'shop', environment: 'production', target: RELEASE('r1'), image: IMAGE, refusals: [] }))
      .toContain('Nothing refuses this revert')
  })
})

describe('the pivot', () => {
  // Recorded on the transition rather than reclassified: what matters afterwards
  // is the answer the operator was shown and agreed to at the time.
  test('a deploy since then that crossed it refuses, naming the releases', () => {
    const r = check({ since: [t('t2', 'r2', 'succeeded', { crossesPivot: 1 })] })
    expect(kinds(r)).toEqual(['pivot'])
    expect(r[0].message).toContain('r2')
    expect(r[0].message).toContain('forward, not back')
    expect(r[0].override).toBe('--past-pivot')
  })

  test('several crossings are counted, not just the first', () => {
    const r = check({ since: [
      t('t3', 'r3', 'succeeded', { crossesPivot: 1 }),
      t('t2', 'r2', 'succeeded', { crossesPivot: 1 }),
    ] })
    expect(r[0].message).toContain('2 deploy(s)')
  })

  test('--past-pivot marks it forced and stops it blocking', () => {
    const r = check({ since: [t('t2', 'r2', 'succeeded', { crossesPivot: 1 })], force: { pivot: true } })
    expect(r[0].forced).toBe(true)
    expect(blocking(r)).toEqual([])
  })
})

describe('retention', () => {
  // Every surveyed system put retention in a setting away from the object it
  // bounds, so the promise expired in silence and was found by the person
  // reverting. Here it is read off the Release and named with its date.
  test('a release past its retention refuses, and names the date', () => {
    const r = check({ target: RELEASE('r1', { retentionUntil: '2026-01-01T00:00:00.000Z' }), now: '2026-08-26T00:00:00.000Z' })
    expect(kinds(r)).toEqual(['retention'])
    expect(r[0].message).toContain('2026-01-01')
  })

  test('a retention still in the future is not a refusal', () => {
    expect(check({ target: RELEASE('r1', { retentionUntil: '2027-01-01T00:00:00.000Z' }), now: '2026-08-26T00:00:00.000Z' }))
      .toEqual([])
  })

  test('no retention recorded is not a refusal', () => {
    expect(check({ target: RELEASE('r1', { retentionUntil: null }) })).toEqual([])
  })

  test('--past-retention overrides it', () => {
    const r = check({
      target: RELEASE('r1', { retentionUntil: '2026-01-01T00:00:00.000Z' }),
      now: '2026-08-26T00:00:00.000Z', force: { retention: true },
    })
    expect(blocking(r)).toEqual([])
  })
})

describe('the bindings — the pair, not the code', () => {
  // The documented Fly failure this separation exists to refuse: reverting a
  // Release onto today's configuration.
  test('a moved generation refuses and says what it can and cannot restore', () => {
    const r = check({ target: RELEASE('r1', { generation: 2 }), generation: 3 })
    expect(kinds(r)).toEqual(['bindings'])
    expect(r[0].message).toContain('generation 2')
    expect(r[0].message).toContain('generation 3')
    expect(r[0].message).toContain('NOT the configuration')
  })

  test('the same generation is not a refusal', () => {
    expect(check({ target: RELEASE('r1', { generation: 2 }), generation: 2 })).toEqual([])
  })

  // A journal with no binding set recorded cannot answer the question, and a
  // guess either way is wrong: silence, rather than a refusal or a pass.
  test('an unknown current generation is not graded', () => {
    expect(check({ target: RELEASE('r1', { generation: 2 }), generation: null })).toEqual([])
  })

  test('--onto-current-bindings is a different sentence, and it overrides', () => {
    const r = check({ target: RELEASE('r1', { generation: 2 }), generation: 3, force: { bindings: true } })
    expect(r[0].override).toBe('--onto-current-bindings')
    expect(blocking(r)).toEqual([])
  })
})

describe('the two that are not judgement calls', () => {
  // There is no image to start. No flag can conjure one.
  test('no recorded bytes refuses with no override', () => {
    const r = check({ image: { image: null, raw: null, parsed: false } })
    expect(kinds(r)).toEqual(['no-image'])
    expect(r[0].override).toBeNull()
    expect(blocking(r)).toHaveLength(1)
  })

  test('an unreadable build row says what it found rather than guessing', () => {
    const r = check({ image: { image: null, raw: 'shop:abc — some old sentence', parsed: false } })
    expect(r[0].message).toContain('some old sentence')
  })

  test('forcing does not clear a refusal that carries no override', () => {
    const r = check({ image: { image: null }, force: { pivot: true, retention: true, bindings: true } })
    expect(blocking(r)).toHaveLength(1)
  })

  // A deploy is running, or one died without settling. Either way the journal
  // does not yet know what is serving.
  test('a transition still open refuses, with no override', () => {
    const r = check({ inFlight: t('t3', 'r3', 'running') })
    expect(kinds(r)).toContain('in-flight')
    expect(r.find(x => x.kind === 'in-flight').override).toBeNull()
  })

  test('nothing to revert to is its own refusal and short-circuits the rest', () => {
    const r = revertRefusals({ target: null, image: null })
    expect(kinds(r)).toEqual(['nothing-prior'])
  })
})

// ─── all of them, never just the first ───────────────────────────────────────

describe('the whole picture', () => {
  // An operator deciding whether to force needs every reason at once. A checker
  // that stops at the first makes them discover the rest one flag at a time,
  // mid-incident.
  test('every refusal is reported together', () => {
    const r = check({
      since:      [t('t2', 'r2', 'succeeded', { crossesPivot: 1 })],
      target:     RELEASE('r1', { generation: 2, retentionUntil: '2026-01-01T00:00:00.000Z' }),
      generation: 3,
      now:        '2026-08-26T00:00:00.000Z',
      image:      { image: null },
    })
    expect(kinds(r).sort()).toEqual(['bindings', 'no-image', 'pivot', 'retention'])
  })

  test('forcing three of four still blocks on the fourth', () => {
    const r = check({
      since:      [t('t2', 'r2', 'succeeded', { crossesPivot: 1 })],
      target:     RELEASE('r1', { generation: 2, retentionUntil: '2026-01-01T00:00:00.000Z' }),
      generation: 3, now: '2026-08-26T00:00:00.000Z', image: { image: null },
      force:      { pivot: true, retention: true, bindings: true },
    })
    expect(kinds(blocking(r))).toEqual(['no-image'])
  })

  test('every kind the checker can produce is in the catalogue', () => {
    const produced = new Set([
      ...kinds(check({ since: [t('t', 'r', 'succeeded', { crossesPivot: 1 })] })),
      ...kinds(check({ target: RELEASE('r1', { retentionUntil: '2000-01-01T00:00:00.000Z' }) })),
      ...kinds(check({ target: RELEASE('r1', { generation: 9 }), generation: 1 })),
      ...kinds(check({ image: { image: null } })),
      ...kinds(check({ inFlight: t('t', 'r', 'running') })),
      ...kinds(revertRefusals({ target: null })),
    ])
    for (const k of produced) expect(Object.keys(REFUSALS)).toContain(k)
  })
})

describe('what the operator reads', () => {
  const rendered = (over) => formatRevertPlan({
    app: 'shop', environment: 'production',
    serving: t('t2', 'r2', 'succeeded'), target: RELEASE('r1'), image: IMAGE,
    refusals: check(over), since: over?.since ?? [],
  })

  test('it leads with what is serving and what it would restore', () => {
    const out = rendered()
    expect(out).toContain('r2')
    expect(out).toContain('r1')
    expect(out).toContain('sha256:abc')
  })

  test('an unknown image says unknown rather than showing a tag', () => {
    const out = formatRevertPlan({ app: 'a', environment: 'e', target: RELEASE('r1'), image: { image: null }, refusals: [] })
    expect(out).toContain('— unknown')
  })

  test('each refusal names its override, and the ones without say so', () => {
    const out = rendered({ since: [t('t2', 'r2', 'succeeded', { crossesPivot: 1 })], image: { image: null } })
    expect(out).toContain('override with --past-pivot')
    expect(out).toContain('not a judgement call')
  })

  test('a forced refusal reads as overridden rather than as passing', () => {
    const out = rendered({ since: [t('t2', 'r2', 'succeeded', { crossesPivot: 1 })], force: { pivot: true } })
    expect(out).toContain('overridden by --past-pivot')
  })
})
