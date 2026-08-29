// revert.js — can serving state be put back, and what stops it.
//
// Phase 1f of IDEAS/release-transitions.md, and the last of phase 1. The guarantee
// the whole design was arranged around is one sentence:
//
//   before the pivot, revert restores code, config and schema.
//
// Everything here is the *before the pivot* half — the refusals. They are the
// feature. A rollback that puts the previous image back and says nothing is what
// every other tool ships, and it is wrong in exactly the cases somebody reaches
// for it: after a contract migration, after a secret rotation, past the retention
// somebody was promised, and against a release whose bytes nothing recorded.
//
// ─── revert is not rollback, and both are kept ───────────────────────────────
//
//   `fli deploy:rollback`  put the previous IMAGE back. No journal, no history,
//                          no questions. Works on a target that has never
//                          deployed through a journal at all.
//   `fli deploy:revert`    restore the PAIR (Release, Generation), and refuse by
//                          name when it cannot.
//
// The second is what this file is. It never silently becomes the first: a
// refusal names the flag that would override it, and the flags are separate so
// that overriding one does not quietly override the rest.
//
// ─── why bindings are a refusal and not a fix ────────────────────────────────
//
// Serving state is the PAIR. `fli` writes no `.env` on a target — the operator
// owns that file — so when the binding generation has moved, a revert genuinely
// cannot restore the pair; it can only put old code onto today's config. That is
// the documented Fly failure this separation exists to refuse, so it is refused,
// and `--onto-current-bindings` is the operator saying they have read which keys
// moved and want it anyway.

const isoNow = (now) => (now ? new Date(now) : new Date())

/** The refusals, in the order a person should read them. Each names its own way out. */
export const REFUSALS = {
  'no-journal':    'nothing has been recorded for this target',
  'nothing-prior': 'there is no earlier release to go back to',
  'pivot':         'a deploy since then cannot be undone',
  'retention':     'the release stopped being a revert target',
  'bindings':      'the configuration has moved since',
  'no-image':      'nothing recorded which bytes that release ran',
  'in-flight':     'a transition is still open',
  'same-bytes':    'it would restore the bytes already running',
}

// ─── which release ───────────────────────────────────────────────────────────

/**
 * What is serving, and what to go back to.
 *
 * `serving` is the last transition that SUCCEEDED, which is not the last
 * transition — a failed deploy leaves the previous release up, and reverting
 * from an attempt that never took hold would move a release nobody is running.
 *
 * The default target is the release the serving transition came FROM, because
 * that is the pair that was serving immediately before. Walking the history for
 * "the previous different releaseId" is the same answer in the ordinary case and
 * a different one after a revert, where it would offer the release we just left.
 */
export function chooseTarget(history = [], { to = null } = {}) {
  const succeeded = history.filter(h => h.status === 'succeeded')
  const serving   = succeeded[0] ?? null
  const inFlight  = history.find(h => h.status === 'running' || h.status === 'planned') ?? null

  if (!history.length) return { serving: null, previous: null, targetId: null, inFlight, reason: 'no-journal' }
  if (!serving)        return { serving: null, previous: null, targetId: null, inFlight, reason: 'no-journal' }

  // The TRANSITION to restore, not just its release. Under build-on-target the
  // Release id carries no digest, so two deploys of different source mint the
  // same id — and a lookup by release id then answers whichever transition is
  // newest, which is the one currently serving. Measured: a revert restored the
  // bytes it was reverting FROM and reported success (`IDEAS/deploy-plane.md`
  // §2.3f). The image lives on the transition, so the transition is what to
  // pick; the release id is derived from it and is unchanged.
  const previous = to
    ? succeeded.slice(1).find(h => h.releaseId === to) ?? null
    : succeeded[1] ?? null

  const targetId = to ?? previous?.releaseId ?? serving.fromReleaseId ?? null
  if (!targetId) return { serving, previous, targetId: null, inFlight, reason: 'nothing-prior' }
  return { serving, previous, targetId, inFlight, reason: null }
}

/**
 * The transitions strictly between the target and now.
 *
 * Newest-first history, so this is everything above the target's own serving
 * transition. It is what the pivot question is asked of: any ONE of them having
 * crossed means the database can no longer serve the release being restored.
 */
export function transitionsSince(history = [], targetId) {
  const out = []
  for (const h of history) {
    if (h.releaseId === targetId && h.status === 'succeeded') break
    out.push(h)
  }
  return out
}

// ─── the image ───────────────────────────────────────────────────────────────

/**
 * Which bytes that transition put into service, read off whichever step recorded
 * them.
 *
 * The digest is a term of the Release now (`04c-journal`), but it is an image ID
 * under build-on-target — true on one host — so the way back to a startable
 * image is still a step OUTPUT. Any step may record one and the
 * LAST wins, because a transition that both builds and swaps puts the swap's
 * image into service. Matching the step by name was the first shape and it was
 * wrong in the case that matters: a revert has no `04-build-api`, so a revert
 * transition recorded no image and could not itself be reverted to.
 *
 * JSON. A row an older `fli` wrote is a sentence, and comes back unparsed rather
 * than guessed at — running the wrong bytes is the worst outcome available.
 */
export function imageFromSteps(steps = []) {
  let found = null
  let raw   = null
  for (const s of steps) {
    if (!s?.output) continue
    try {
      const j = JSON.parse(s.output)
      if (j?.image) { found = { image: j.image, tag: j.tag ?? null, scope: j.scope ?? null, raw: s.output, parsed: true } }
    } catch { raw ??= s.output }
  }
  if (found) return found
  return { image: null, raw, parsed: false }
}

// ─── the verdict ─────────────────────────────────────────────────────────────

/**
 * Every reason this revert must not proceed, with the flag that overrides each.
 *
 * All of them, not the first — an operator deciding whether to force needs the
 * whole picture, and a checker that stops at the first refusal makes them
 * discover the rest one flag at a time.
 *
 * @param serving      the transition currently serving
 * @param target       the Release row being restored
 * @param since        transitions between the target and now
 * @param generation   the binding generation in force now
 * @param image        the result of `imageFromSteps` for the target
 * @param force        { pivot, retention, bindings } — each explicitly given
 */
export function revertRefusals({
  serving, target, since = [], generation = null, image = null, servingImage = null,
  inFlight = null, now = null, force = {},
} = {}) {
  const out = []
  const add = (kind, message, override) => out.push({ kind, message, override, forced: Boolean(force[kind]) })

  if (inFlight)
    add('in-flight',
      `transition ${inFlight.id} is still ${inFlight.status} — a deploy is running, or one died without settling`,
      null)

  if (!target) {
    add('nothing-prior', 'nothing earlier is recorded for this target — there is no pair to restore', null)
    return out
  }

  // The pivot. Recorded on the transition rather than reclassified, because what
  // matters is the answer the operator was shown and agreed to at the time.
  const crossed = since.filter(h => h.crossesPivot)
  if (crossed.length)
    add('pivot',
      `${crossed.length} deploy(s) since ${target.id} crossed the pivot — release ${target.id} cannot serve this database. ` +
      `Recovery past a pivot is forward, not back: ${crossed.map(h => h.releaseId).join(', ')}`,
      '--past-pivot')

  // Retention, read off the Release it bounds. Every surveyed system put this in
  // a setting away from the object, so the promise expired in silence and was
  // discovered by the person reverting.
  if (target.retentionUntil && new Date(target.retentionUntil) < isoNow(now))
    add('retention',
      `release ${target.id} stopped being a revert target on ${target.retentionUntil} — its artefacts may already be gone`,
      '--past-retention')

  // The pair. `fli` writes no env file on a target, so this cannot be fixed here
  // and is not offered as one.
  if (generation != null && target.generation != null && target.generation !== generation)
    add('bindings',
      `release ${target.id} was bound at generation ${target.generation} and generation ${generation} is in force — ` +
      `reverting restores the code and NOT the configuration it ran with`,
      '--onto-current-bindings')

  // Restoring what is already running is never what somebody means, so there is
  // no override. Two deploys CAN legitimately build identical bytes — a rebuild
  // with no source change — and reverting between them is a no-op either way.
  // `deploy:rollback` has refused this since it could see an image id; revert
  // could not, because it compares releases and two deploys share one id.
  if (image?.image && servingImage?.image && image.image === servingImage.image)
    add('same-bytes',
      `release ${target.id} was served by the same image that is running now ` +
      `(${String(image.image).slice(0, 19)}…) — this revert would change nothing`,
      null)

  if (!image?.image)
    add('no-image',
      image?.raw
        ? `the transition that served ${target.id} recorded its build as text this fli cannot read: ${String(image.raw).slice(0, 120)}`
        : `nothing recorded which bytes ${target.id} ran — it was deployed before the journal, or the daemon could not be asked`,
      null)

  return out
}

/** Refusals nothing overrode. `in-flight` and `no-image` carry no override by design. */
export const blocking = (refusals = []) => refusals.filter(r => !r.override || !r.forced)

// ─── rendering ───────────────────────────────────────────────────────────────

const pad = (s, n) => String(s ?? '').padEnd(n)

export function formatRevertPlan({ app, environment, serving, target, since = [], image, servingImage = null, refusals = [] } = {}) {
  const out = []
  const row = (k, v) => out.push(`  ${pad(k, 14)}${v}`)

  out.push(`  Revert plan — ${app} · ${environment}`)
  out.push('')
  row('serving', serving?.releaseId ?? '— nothing recorded')
  if (servingImage?.image) row('running', servingImage.image)
  row('revert to', target?.id ?? '— nothing to revert to')
  if (target) {
    row('bytes', image?.image ? `${image.image}${image.scope ? `  (${image.scope})` : ''}` : '— unknown')
    // Two rows can name one release and different bytes, which is the whole of
    // what build-on-target costs. Only said where it is TRUE — the same line
    // above an identical pair of digests would contradict itself.
    if (serving && target.id === serving.releaseId &&
        image?.image && servingImage?.image && image.image !== servingImage.image)
      row('', 'same Release id as what is serving — the bytes differ, the id cannot')
    row('bindings', `generation ${target.generation}`)
    row('deployed', target.createdAt ?? '—')
  }
  if (since.length) row('since then', `${since.length} transition(s)`)

  if (!refusals.length) {
    out.push('')
    out.push('  Nothing refuses this revert.')
    return out.join('\n')
  }

  out.push('')
  out.push(`  ${refusals.length} refusal(s):`)
  for (const r of refusals) {
    out.push(`    ${r.forced ? '⚠' : '✗'} ${r.kind}`)
    out.push(`      ${r.message}`)
    if (r.override) out.push(`      ${r.forced ? `overridden by ${r.override}` : `override with ${r.override}`}`)
    else            out.push('      no override — this one is not a judgement call')
  }
  return out.join('\n')
}
