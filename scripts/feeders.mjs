// ============================================================
// Feeders — what a red CI run and a stalled stranger build file
//
// The pure half of `feed-loop.mjs`: which failing units a CI run holds,
// the one title each is filed under, and what a run may do about each —
// file it, amend the open row that already names it, hold it past the
// cap, or set it aside as an environment failure. Nothing here reads a
// file or runs a command, so `packages/cli/test/feeders.test.js` holds it
// the way `stressors.test.js` holds `stressors.mjs`.
//
// A title is FIXED per failing unit — the CI phase and the step's key,
// or the stranger build's step — because the title is the dedupe key:
// the same red two nights running must find its own row, and a title
// that carried the exit code or a count would file a second one.
// ============================================================

/**
 * The steps a stranger's build goes through, in order; the first that exits
 * non-zero is the stall. `new` installs as it scaffolds, the way the README
 * tells a tester to: scaffolded with `--no-install`, an app has no first
 * migration and its own check refuses it before anything of the framework ran.
 */
export const STRANGER_STEPS = ['new', 'check', 'build']

/**
 * The title a CI step is filed under: the phase and the step's key, or its
 * label when it has none. A label counts things — `5 register finding(s)`,
 * `1 rule(s) above check-baseline.json`, `exited 1` — and a count in the title
 * files the same red again the night the number changes, so a label-built
 * title keeps the words and drops the numbers.
 */
export const ciTitle = (phase, step) => `CI red: ${phase} · ${step.key ?? uncounted(step.label)}`

const uncounted = label => String(label ?? '')
  .replace(/\b\d+ ((?:\w+ )*\w+)\(s\)/g, '$1s')
  .replace(/ exited \d+\b/g, '')
  .replace(/ in \d+(?:\.\d+)?\s?(?:s|ms|min)\b/g, '')
  .replace(/\s{2,}/g, ' ').trim()

/** The title a stranger build's stall is filed under. */
export const strangerTitle = step => `A stranger's build from npm stalls at ${step}`

/**
 * The area a CI failure belongs to: the package its key or label names,
 * `example` for the kitchen sink, `repo` for anything else.
 */
export function areaOf(text) {
  const s = String(text ?? '')
  const pkg = /(?:^|[\s:(`])packages\/([a-z0-9-]+)/.exec(s)
  if (pkg) return pkg[1]
  if (/(?:^|[\s:(`])example(?:\/|\b)/.test(s)) return 'example'
  return 'repo'
}

/**
 * Every failing step of a folded CI run (`core/ci-log.js` `foldRun`), each
 * with the title and area it files under. A `warn` is a known failure CI
 * already names, and is not red.
 */
export function failuresOf(run) {
  const out = []
  for (const phase of run?.phases ?? []) {
    for (const step of phase.steps ?? []) {
      if (step.status !== 'fail') continue
      out.push({ phase: phase.name, key: step.key ?? null, label: step.label, detail: step.detail ?? null, output: step.output ?? null, title: ciTitle(phase.name, step), area: areaOf(step.key ?? step.label) })
    }
  }
  return out
}

/** The failure a stranger build's first non-zero step is filed as. */
export function strangerFailure({ step, cmd, code, output, version, app }) {
  return { step, cmd, code, output: output ?? null, version, app, title: strangerTitle(step), area: 'cli' }
}

/** One line of a failure's output, ANSI and runs of whitespace squashed, cut at `max` with an ellipsis. */
export function squash(text, max = 700) {
  const s = String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** The Detail cell a failure is filed with: who filed it, off what, and the failure's own words. */
export function detailOf(feeder, f, { run, commit, cites } = {}) {
  const cited = cites ? ` · came back after \`${cites}\`` : ''
  if (feeder === 'ci') {
    const where = run ? ` off run ${run}${commit ? ` at ${commit}` : ''}` : ''
    const said  = [f.label, f.detail].filter(Boolean).join(' — ')
    const out   = f.output ? ` · output: ${squash(f.output)}` : ''
    return `Filed by the ci feeder${where} (\`scripts/ci.mjs\` on a worktree at HEAD): ${squash(said, 400)}${out}${cited} · [ci.mjs](scripts/ci.mjs)`
  }
  const out = f.output ? ` · output: ${squash(f.output)}` : ''
  return `Filed by the stranger feeder: \`${f.cmd}\` exited ${f.code} in \`${f.app}\`, a fresh \`fli new --full --source npm\` from @frontierjs/cli@${f.version} with nothing of this checkout on the path${out}${cited} · [feed-loop.mjs](scripts/feed-loop.mjs)`
}

/** Whether a feed line of `today` already amended row `id`: a persistent red grows its row once a day, not once a run. */
export function amendedToday(log, id, today = new Date()) {
  const day = today.toDateString()
  return log.some(e => e.at && new Date(e.at).toDateString() === day && Array.isArray(e.amended) && e.amended.includes(id))
}

/**
 * What a run does about each failure, in order:
 *
 *   env     its title reads as an environment failure (`smells`) — logged, never filed
 *   amend   an open row has its title; `skip` when a feed line already amended it today
 *   file    no open row — a closed one with the title is cited; counted against `left`
 *   held    past the cap; the next run files it
 *
 * `titled(title)` answers the rows with that title, open first.
 */
export function plan({ failures, titled, log = [], cap, filedToday = 0, smells = () => false, today = new Date() }) {
  const out  = { file: [], amend: [], skip: [], env: [], held: [] }
  let left   = Number.isInteger(cap) ? cap - filedToday : 0
  const seen = new Set()
  for (const f of failures) {
    if (seen.has(f.title)) continue
    seen.add(f.title)
    if (smells(f.title)) { out.env.push(f); continue }
    const rows = titled(f.title)
    const open = rows.find(r => !r.closed)
    if (open) { (amendedToday(log, open.id, today) ? out.skip : out.amend).push({ ...f, id: open.id }); continue }
    if (left <= 0) { out.held.push(f); continue }
    left--
    out.file.push({ ...f, cites: rows[0]?.id ?? null })
  }
  return out
}
