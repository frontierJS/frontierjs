// ─── the deploy lock ─────────────────────────────────────────────────────────
// Is another run working in this directory right now?
//
// A different question from the journal's — *what state did the last run leave
// this app in* — and the reason to keep them apart is that a lock which cannot
// expire reads as a second answer to the second question: it refuses the run the
// journal is offering to resume. `FJS-D156` is the ruling and `deploy/_module.md`
// is the wiring.
//
// **Never record a pid here.** The format this replaced wrote `$$`, the pid of
// the `sh -s` that ran the lock script — a shell that exits the instant the file
// is written — and no better one is available: `fli` runs on the operator's
// machine and reaches the target one command at a time, so there is no process
// on the target to point at and nothing can probe one.
//
// What is recorded instead is the run, who started it, when, and which step it
// is inside. The step is the half the journal cannot supply: a build is minutes
// long and runs BEFORE the journal opens (`04c-journal`), which is the window
// where the question is asked most.
//
// One format, one parser, one writer, three readers — `deploy`, `deploy:status`
// and `deploy:doctor`. A fourth that parsed the file itself would be a fourth
// answer; `deploy:status` was one, and split `<pid>:<iso>:<target>` on `:`.

export const LOCK_BASENAME = '.deploy.lock'
export const lockPath = (dir) => `${dir}/${LOCK_BASENAME}`

// A value goes into a shell script and comes back out of a text file, so it may
// carry neither a newline (it would become a second field) nor a quote (the
// script is built by interpolation). Everything here is derived from config an
// operator wrote, which is not hostile and is not validated either.
export const safeValue = (v) =>
  String(v ?? '').replace(/[^A-Za-z0-9._@:+/-]+/g, '-').slice(0, 120)

const FIELDS = ['run', 'actor', 'target', 'started', 'step', 'stepAt']

export function renderLock(fields = {}) {
  return FIELDS
    .filter(k => fields[k] != null && fields[k] !== '')
    .map(k => `${k}=${safeValue(fields[k])}`)
    .join('\n')
}

/**
 * Read a lock file's body.
 *
 * Tolerates the format this replaced — `<pid>:<iso>:<target>` — because an fli
 * that predates this one may have written the file that is being read, and a
 * lock nobody can parse is a directory nobody can deploy to. A legacy row says
 * so rather than pretending it has a run id.
 */
export function parseLock(text) {
  const body = String(text ?? '').trim()
  if (!body) return null

  if (!body.includes('=')) {
    // `<pid>:<iso>:<target>`, and the ISO timestamp has two colons of its own —
    // so the fields are taken from the ENDS. `deploy:status` split this on `:`
    // and read the hour as the timestamp and `00` as the target for its whole
    // life, which is the old format's own reader failing to read it.
    const parts = body.split(':')
    if (!parts[0]) return null
    return {
      legacy: true, run: null, actor: null,
      target:  parts.length > 2 ? parts[parts.length - 1] : null,
      started: parts.length > 2 ? parts.slice(1, -1).join(':') : null,
      step: null, stepAt: null, raw: body,
    }
  }

  const out = { legacy: false, raw: body }
  for (const k of FIELDS) out[k] = null
  for (const line of body.split('\n')) {
    const at = line.indexOf('=')
    if (at < 1) continue
    const k = line.slice(0, at).trim()
    if (FIELDS.includes(k)) out[k] = line.slice(at + 1).trim() || null
  }
  return out
}

// ─── the scripts ─────────────────────────────────────────────────────────────
// Written here rather than in the step, so the acquire and the two commands that
// can drop a lock cannot drift on the file name or the format.

// Each line is one `printf` operand. `safeValue` has already removed the quote,
// so single-quoting is exact rather than hopeful.
const quoted  = (fields) => renderLock(fields).split('\n').map(l => `'${l}'`).join(' ')
const replace = (file, args) =>
  `printf '%s\\n' ${args} > ${file}.$$ && mv -f ${file}.$$ ${file}`

/**
 * Take the lock, or print what holds it.
 *
 * `set -C` is the compare-and-set: with noclobber a redirect onto an existing
 * file fails, so two runs arriving together cannot both pass a `[ -f ]` test and
 * both write. `takeover` is the deliberate override and prints what it displaced,
 * because a run that silently replaced another's lock is the failure this file
 * exists to make visible.
 */
export function acquireScript(file, fields, { takeover = false } = {}) {
  const args = quoted(fields)

  if (takeover) return `if [ -f ${file} ]; then
  echo "TOOK: $(tr '\\n' ';' < ${file})"
fi
${replace(file, args)}
echo "ok"`

  // `set -C` must guard the redirect onto the LOCK itself — a temp file plus a
  // `mv` would make noclobber protect a name nobody is racing for.
  return `if [ -f ${file} ]; then
  echo "HELD"
  cat ${file}
  exit 1
fi
set -C
printf '%s\\n' ${args} > ${file} || { echo "HELD"; cat ${file}; exit 1; }
echo "ok"`
}

/**
 * Say which step the run is in.
 *
 * Refuses to write over another run's lock rather than clobbering it: a takeover
 * is a decision somebody made, and a refresh finding a different run id means
 * that decision was made against this run while it was working.
 */
export function refreshScript(file, fields) {
  return `if [ -f ${file} ] && ! grep -qx 'run=${safeValue(fields.run)}' ${file}; then
  echo "stolen"
  exit 0
fi
${replace(file, quoted(fields))}
echo "ok"`
}

export const releaseScript = (file) => `rm -f ${file}`

// ─── reading one ─────────────────────────────────────────────────────────────

const ageOf = (iso, now) => {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return null
  return Math.max(0, now - t)
}

export function humanAge(ms) {
  if (ms == null) return 'unknown'
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  return `${Math.round(m / 60)}h`
}

/**
 * What the lock says, in the words an operator needs.
 *
 * It reports and never judges, because the one fact that would settle it — is
 * that `fli` process still alive — is on a machine this one cannot see. What is
 * left is a duration, and a step name beside it is what lets a person weigh one:
 * four minutes reads differently in `04-build-api` than in `06-swap`. It is not
 * an inference anything here may make — the time recorded is when a step
 * STARTED, so a fresh one fits a run three seconds into a long build exactly as
 * well as one killed three seconds into it.
 */
export function describeLock(lock, { now = Date.now() } = {}) {
  if (!lock) return { held: false, lines: [] }

  if (lock.legacy) {
    return {
      held: true, legacy: true, ageMs: ageOf(lock.started, now), stepAgeMs: null,
      lines: [
        `held by an older fli — it recorded ${lock.raw}`,
        'The number in it is the pid of a shell that has already exited, so it cannot be probed.',
      ],
    }
  }

  const ageMs     = ageOf(lock.started, now)
  const stepAgeMs = ageOf(lock.stepAt, now)
  const lines = []

  lines.push(`held by ${lock.actor ?? 'someone'}${lock.target ? ` deploying ${lock.target}` : ''}` +
             `${ageMs == null ? '' : `, started ${humanAge(ageMs)} ago`}`)
  if (lock.step)
    lines.push(`in step ${lock.step}${stepAgeMs == null ? '' : ` — ${humanAge(stepAgeMs)} in it`}`)
  else
    lines.push('no step recorded yet — it had not started one')

  return { held: true, legacy: false, ageMs, stepAgeMs, lines }
}
