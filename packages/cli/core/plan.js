// plan.js — the journal rows a transition WOULD write, and nothing else.
//
// Phase 1d of IDEAS/release-transitions.md. It is three things at once and the
// third is the one worth stating:
//
//   · the cheapest possible proof that the step decomposition is right
//   · how 1e and 1f get debugged, before either exists
//   · **escape hatch 2, arriving before the machinery it lets you escape** —
//     a person can read what the deploy intends without running any of it, and
//     that ability exists from the first day rather than being retrofitted onto
//     a system people already have to trust
//
// It builds the SAME objects 1e will insert: `db/deploy.lite`'s `Transition`
// and `TransitionStep` rows, with the plan carried on the transition itself, so
// the plan and the record are one object rather than two that can disagree.
// That is the model's own instruction, not an interpretation of it.
//
// ─── the steps are read, never listed ────────────────────────────────────────
//
// The step names come from `_steps-docker/` — the same directory, the same
// filter and the same sort the runner applies — because a plan carrying its own
// copy of the pipeline is wrong the first time someone adds a step, and wrong
// silently: the deploy does one thing and the plan says another, with the plan
// being the document people read to decide.
//
// The `skip:` predicates are evaluated the way the runner evaluates them, so a
// step the plan shows as skipped is a step that will be skipped. Where a
// predicate throws, the plan says it will RUN — the runner's own fail-open
// direction, because a typo should not silently remove a step from either.

import { occurrenceKey } from '@frontierjs/toolbelt/history'

/**
 * The plan's own format. In the transition's `plan` blob, because a resumed
 * transition replays rows an earlier version wrote — the same reason
 * `Journal.formatVersion` exists.
 */
export const PLAN_FORMAT = 1

const short = (hex) => (hex ? String(hex).slice(0, 12) : null)

// ─── the steps ───────────────────────────────────────────────────────────────

/**
 * The runner's own file rule: numbered `.md`, lexicographic.
 *
 * `02b` sorts after `02` and before `03` because the sort is on the whole
 * filename and not on the numeric prefix — which is what lets a step be
 * inserted between two others without renumbering the rest.
 */
export const stepFilesIn = (names) =>
  (names ?? []).filter(f => f.endsWith('.md') && /^\d/.test(f)).sort()

/** `04-build-api.md` → `04-build-api`. The runner's step name, and the journal's. */
export const stepNameOf = (file) => file.replace(/\.md$/, '')

/**
 * Evaluate a step's `skip:` predicate the way the runner does.
 *
 * Answers `{ skipped, reason }`. A predicate that throws is NOT skipped —
 * the runner falls through to running the step for the same reason, so a plan
 * that reported it skipped would describe a deploy that does not happen.
 */
export function skipDecision(skip, { flag, context }) {
  if (!skip) return { skipped: false, reason: null }
  try {
    const skipped = Boolean(new Function('flag', 'context', `return ${skip}`)(flag, context))
    return { skipped, reason: skipped ? skip : null }
  } catch (err) {
    return { skipped: false, reason: null, threw: err?.message ?? String(err) }
  }
}

/**
 * The planned steps, in run order.
 *
 * A skipped step is KEPT in the list and marked, rather than dropped. Two
 * reasons, and the second is the one a dropped row cannot serve: an operator
 * reading a plan needs *the backup did not run* to be visible, and 1e needs the
 * ordinals to be stable so a resume can find the step it left off at even when
 * a `skip:` has since changed answer.
 */
export function planSteps(steps, { flag = {}, context = {} } = {}) {
  return steps.map((s, i) => {
    const d = skipDecision(s.skip, { flag, context })
    return {
      ordinal:  i + 1,
      name:     s.name,
      title:    s.title ?? s.name,
      run:      !d.skipped,
      status:   d.skipped ? 'skipped' : 'pending',
      skippedBy: d.reason,
      predicateThrew: d.threw ?? null,
      runOnAbort: Boolean(s.runOnAbort),
    }
  })
}

// ─── the transition ──────────────────────────────────────────────────────────

/**
 * The id of one attempt to move serving state.
 *
 * Every term is here for a case that would otherwise collide with another:
 *
 *   kind          a revert to R1 is not the deploy that first shipped it
 *   app, env      one journal per host, and a host can hold several apps
 *   from → to     resuming a crashed R1→R2 must find the same row; R1→R2 and
 *                 R2→R1 must not
 *   generation    a rotated secret is a new intent, not a replay of the old one
 *   attempt       **the journal's count of prior transitions for this pair**
 *
 * The last one is the one a PLAN cannot answer, and it says so rather than
 * pretending. Deploy R2, revert to R1, deploy R2 again: every other term is
 * identical to the first attempt, so without a counter the third operation
 * resumes a transition already marked `succeeded` and leaves R1 serving. A plan
 * run has no journal to count, so it states `attempt 1` and labels the id
 * provisional — which is exactly the kind of thing `--plan` exists to surface
 * before 1e writes a row under it.
 */
export function transitionId({ kind, app, environment, fromReleaseId, releaseId, generation, attempt = 1 }) {
  return occurrenceKey(kind, app, environment,
    fromReleaseId ?? 'none', releaseId, String(generation), String(attempt))
}

/**
 * Build the journal rows. Writes nothing — that is 1e.
 *
 * `crossesPivot` is recorded rather than re-derived later, because what matters
 * afterwards is the answer the operator was shown and agreed to, not the answer
 * a classifier gives once the schema has moved on. **Unknown counts as a
 * contract**, which is the fail-closed direction the whole Release design takes.
 */
export function planTransition({
  kind = 'deploy',
  release,
  fromReleaseId = null,
  generation    = 1,
  attempt       = 1,
  steps         = [],
  actor         = null,
} = {}) {
  if (!release?.id) throw new Error('planTransition needs a minted Release')

  const id = transitionId({
    kind, app: release.app, environment: release.environment,
    fromReleaseId, releaseId: release.id, generation, attempt,
  })

  const precondition = {
    serving:    fromReleaseId,
    generation,
    schemaHash: release.schemaHash ?? null,
  }

  const stepRows = steps.map(s => ({
    id:           occurrenceKey(kind, id, s.name),
    transitionId: id,
    name:         s.name,
    ordinal:      s.ordinal,
    status:       s.status,
    // Every step carries the same three-part check, which is what the model
    // declares: the Release serving, the binding generation, and the schema as
    // at last applied. Drift refuses and names itself; nothing reconciles.
    precondition,
    output:       null,
    startedAt:    null,
    finishedAt:   null,
    durationMs:   null,
  }))

  return {
    transition: {
      id,
      kind,
      app:           release.app,
      environment:   release.environment,
      releaseId:     release.id,
      fromReleaseId,
      generation,
      status:        'planned',
      crossesPivot:  release.pivot !== 'expand',
      plan: {
        formatVersion: PLAN_FORMAT,
        attempt,
        steps: steps.map(s => ({
          ordinal: s.ordinal, name: s.name, run: s.run,
          skippedBy: s.skippedBy, predicateThrew: s.predicateThrew ?? null,
        })),
      },
      actor,
      startedAt:  null,
      finishedAt: null,
    },
    steps: stepRows,
  }
}

// ─── rendering ───────────────────────────────────────────────────────────────

const pad = (s, n) => String(s ?? '').padEnd(n)

/**
 * What a person reads. The Release and the pivot first, because those are the
 * two facts that decide whether to run it at all; the steps after, because they
 * are what it will do.
 */
export function formatPlan({ transition, steps, release, bindings, findings = [] } = {}) {
  const out = []
  const row = (k, v) => out.push(`  ${pad(k, 14)}${v}`)

  out.push(`  ${transition.kind === 'revert' ? 'Revert' : 'Deploy'} plan — ${release.app} → ${release.environment}`)
  out.push('')
  row('Release', release.id)
  // The digest is a TERM of that id, so a plan that has not built anything is
  // naming a Release the deploy will not mint. Said here rather than left to be
  // discovered when the two ids disagree — a plan is what somebody reads to
  // decide, and *this exact id* is not what it is offering.
  if (!release.digest) row('', 'provisional — the bytes are a term of this id and nothing has built them')
  // A tag is not an identity, so an absent digest says so rather than showing
  // one as though it were.
  row('bytes', release.digest ? `${short(release.digest)}  (${release.imageRef ?? 'digest'})` : '— not built')
  row('bindings', `${short(release.bindingsHash)}  · generation ${transition.generation}` +
    (bindings ? `  · ${bindings.count} binding(s), ${Object.keys(bindings.secretRefs ?? {}).length} secret ref(s)` : ''))
  row('schema', release.schemaHash ? short(release.schemaHash) : '— none')
  row('serving', transition.fromReleaseId ?? '— nothing recorded (no journal on the target yet)')
  out.push('')
  row('transition', transition.id)
  row('status', `${transition.status} · attempt ${transition.plan.attempt} (provisional — the journal owns this count)`)

  // ── the pivot ──────────────────────────────────────────────────────────────
  out.push('')
  if (release.pivot === 'expand') {
    out.push('  Pivot         expand — Release N-1 can still serve, so this deploy can be taken back')
  } else {
    const why = release.pivot === 'unknown'
      ? 'unknown, which counts as a contract — nothing here could prove N-1 keeps working'
      : 'contract — Release N-1 cannot serve this database'
    out.push(`  Pivot         ${why}`)
    out.push('                After this deploy, only forward — a revert past it cannot restore the database.')
    for (const f of findings.filter(x => x.severity === 'contract').slice(0, 12)) {
      out.push(`                  · ${f.subject}: ${f.detail}`)
      // Where litestone offered the three-step split, print it: a refusal that
      // carries its own way out is advice, and one that does not is a wall.
      for (const line of f.plan ?? []) out.push(`                      ${line}`)
    }
    const rest = findings.filter(x => x.severity === 'contract').length - 12
    if (rest > 0) out.push(`                  · …and ${rest} more (fli release:check prints them all)`)
  }

  // ── the steps ──────────────────────────────────────────────────────────────
  //
  // WHY a step is skipped comes off the transition's own `plan` blob rather than
  // off the step rows: a `TransitionStep` records status and no reason, so a
  // renderer reading only those can say *skipped* and never say why. Reading it
  // here is also the assertion that the blob is self-sufficient — 1e stores it
  // and 1f reads it back, with the step rows long since mutated by the run.
  const why = new Map((transition.plan?.steps ?? []).map(s => [s.ordinal, s]))

  out.push('')
  out.push(`  Steps         ${steps.filter(s => s.status !== 'skipped').length} of ${steps.length} would run`)
  out.push('')
  for (const s of steps) {
    const skipped = s.status === 'skipped'
    const planned = why.get(s.ordinal)
    out.push(`    ${pad(skipped ? '·' : String(s.ordinal), 4)}${pad(s.name, 24)}${skipped ? 'skipped' : ''}`)
    if (skipped && planned?.skippedBy) out.push(`        ${pad('', 24)}${planned.skippedBy}`)
    if (planned?.predicateThrew) out.push(`        ${pad('', 24)}skip predicate threw (${planned.predicateThrew}) — it will RUN`)
  }

  out.push('')
  out.push('  Nothing above has been written or run. The journal is written by the')
  out.push('  transition itself, on the target, which is phase 1e.')
  return out.join('\n')
}

/** The plan as data — the rows, exactly as they would be inserted. */
export const planAsJson = ({ transition, steps, release }) =>
  ({ release, transition, steps })
