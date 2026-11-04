/*
 * typo.js — the name a person most likely meant, when the one they wrote is
 * not one of the names there are.
 *
 * Five packages answered this with five private Levenshtein copies and five
 * cutoffs (half the word, a third, a quarter, a flat two), so the same typo got
 * a suggestion in one refusal and none in the next. One definition here.
 *
 * ─── The rule, and where it comes from ─────────────────────────────────────
 *
 * Distance is optimal string alignment: Levenshtein plus a swap of two adjacent
 * letters costing one edit, as git, rustc, cargo, commander and yargs count it.
 * The swap is the commonest typo there is, and plain Levenshtein charges it two
 * — `emial` is two edits from `email` there, and under a tight cutoff no
 * suggestion at all.
 *
 * A candidate is suggested when it is at most `max(len, 3) / 3` edits away,
 * which is rustc's rule (and clang's) "to avoid obviously incorrect
 * suggestions": one edit up to five letters, two up to eight. A looser cutoff
 * is what makes a three-letter word match half a list. A candidate differing
 * only by case wins outright, and a suggestion must keep more letters than it
 * changes, so `x` is not corrected to `y`.
 *
 * Nothing is suggested when nothing is close. A wrong suggestion sends someone
 * to the wrong place with confidence; no suggestion sends them to the list.
 */

/**
 * The closest candidate to `word`, or `null` when none is close enough to be
 * a typo of it. A tie goes to the candidate given first.
 *
 * @param {string} word
 * @param {Iterable<string>} candidates
 * @returns {string | null}
 */
export function nearest(word, candidates) {
  return nearestAll(word, candidates)[0] ?? null
}

/**
 * Every candidate close enough to be a typo of `word`, closest first, ties in
 * the order given. Empty when none is.
 *
 * @param {string} word
 * @param {Iterable<string>} candidates
 * @returns {string[]}
 */
export function nearestAll(word, candidates) {
  if (typeof word !== 'string' || !word) return []
  const want = word.toLowerCase()
  const limit = Math.floor(Math.max(want.length, 3) / 3)
  const found = []
  const seen = new Set()
  let order = 0
  for (const candidate of candidates ?? []) {
    const name = String(candidate)
    if (seen.has(name)) continue
    seen.add(name)
    const d = distance(want, name.toLowerCase(), limit)
    if (d <= limit && d < want.length) found.push({ name, d, at: order })
    order++
  }
  return found.sort((a, b) => a.d - b.d || a.at - b.at).map((f) => f.name)
}

/**
 * Optimal string alignment distance, giving up past `max`: anything further
 * answers `max + 1`, which is all a cutoff needs to know.
 *
 * @param {string} a @param {string} b @param {number} max
 */
function distance(a, b, max) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let before = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let low = i
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1)
      row[j] = d
      if (d < low) low = d
    }
    if (low > max) return max + 1
    before = prev
    prev = row
  }
  return prev[b.length]
}
