// ============================================================
// Stressors — the listed apps as the stress loop sees them
//
// The pure half of `stress-loop.mjs`: which app's step runs next,
// why an app is passed over, and what a finished session is graded
// as. Nothing here touches git, the filesystem or a session, so
// `packages/cli/test/stressors.test.js` holds it the way
// `lanes.test.js` holds `lanes.mjs`; the loop feeds it what it read.
//
// An app is a card: `{ app, dir, plan, step, waited, error }` —
// `step` its plan's first open box (`parsePlan(...).next`),
// `waited` the ISO instant that box has waited since, `error` why
// there is no step to run. Waited is the LATER of the box line's
// last change and the loop's last attempt at it: an edit anywhere
// else in the plan does not reset an app's turn, and an app the
// loop tried this morning goes behind one it has not.
// ============================================================

const EPOCH = '1970-01-01T00:00:00.000Z'

/**
 * When a step has waited since: the box line's last commit (`lineAt`), the
 * plan file's mtime when that line is uncommitted, and the loop's last attempt
 * at the step (`attemptAt`) when later than either.
 */
export function waitedSince({ lineAt, mtime, attemptAt }) {
  const base = lineAt ?? mtime ?? EPOCH
  return attemptAt && attemptAt > base ? attemptAt : base
}

/** The box line's commit time off `git blame --porcelain -L n,n`, or null for a line not committed yet. */
export function blamedAt(porcelain) {
  const head = String(porcelain).split('\n')[0] ?? ''
  if (/^0{40}/.test(head)) return null
  const m = /^committer-time (\d+)$/m.exec(porcelain)
  return m ? new Date(Number(m[1]) * 1000).toISOString() : null
}

/**
 * The cards with a step, longest-waited first; a tie keeps the list's order,
 * which is the owner's. A card with an `error` is left out.
 */
export function orderCards(cards) {
  return cards
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.step && !c.error)
    .sort((a, b) => a.c.waited.localeCompare(b.c.waited) || a.i - b.i)
    .map(({ c }) => c)
}

/**
 * Why `card` is passed over this run, or null. A step the log says was ticked
 * on its branch waits on the owner's merge: the app's own plan still shows the
 * box open, and running the step twice would build it twice.
 */
export function passedOver(card, log) {
  if (card.error) return card.error
  if (!card.step) return 'no open box'
  const last = log.filter(e => e.app === card.app && e.step === card.step.id && e.outcome && e.outcome !== 'started').at(-1)
  if (last?.outcome === 'ticked') return `${card.step.id} is ticked on ${last.branch ?? `stress/${card.step.id}`}, waiting on the owner's merge`
  return null
}

/** The `stress-next: <app> <step> <status> — note` line of a report, last one wins; null when there is none. */
export function claimed(report) {
  let out = null
  for (const m of String(report).matchAll(/^stress-next: (\S+) (\S+) (ticked|blocked|busy|failed)\b[ \t—–-]*(.*)$/gm)) out = { app: m[1], step: m[2], status: m[3], note: m[4].trim() }
  return out
}

/**
 * What the session did, read off the plan in its worktree and the registers,
 * the claim only for what neither can show:
 *
 *   ticked    the step's box went from open to done
 *   blocked   not ticked, and a row or question was filed — the step waits on it
 *   busy      not ticked, nothing filed, and the session said another holds the app
 *   failed    anything else; the ladder's next rung retries it
 */
export function grade({ before, after, filed, claim }) {
  if (before === 'open' && after === 'done') return 'ticked'
  if (filed.length) return 'blocked'
  if (claim?.status === 'busy') return 'busy'
  if (claim?.status === 'blocked') return 'blocked'
  return 'failed'
}

/** The branch a step's work lands on, one per step, so the owner merges a box at a time. */
export const branchOf = step => `stress/${step}`
