// pause.js — taking an app down on purpose, and being able to tell that apart
// from it being down.
//
// Phase 3b of IDEAS/release-transitions.md. Until this, the only way to stop
// serving was to stop the container, which the journal reads as a crash: it goes
// on answering that Release R is serving while nothing answers at all, and every
// reader downstream sees a stopped box and a dead one as one fact.
//
// ─── where a pause happens, and why not in the app ───────────────────────────
//
// The container stays UP. `_steps-docker/06-swap` runs the migrations in the
// entrypoint, so a stopped container cannot deploy — and deploying while paused
// is the single case a pause exists to allow. An app that refused from inside
// would have to be told, which is a binding, which is a restart, which is a
// deploy.
//
// So it is the edge. nginx serves the SPA from `current/` and proxies `/api/`,
// which makes it the one place that can answer for both surfaces at once. The
// deploy's own health poll goes to `http://localhost:<apiPort>` directly
// (`_module.md`, `healthOrRestore`) and never through nginx, so a paused app
// still deploys, still migrates and still passes health — health reading 200
// while the edge reads 503 is the correct pair of answers and not a
// contradiction.
//
// ─── the file is the mechanism, the journal is the truth ─────────────────────
//
// nginx stats a file per request, so a pause is one write and an unpause is one
// `rm`: no reload, no sudo, and no half-applied guard. What that buys is also
// what it costs — a file a person can touch by hand is the original complaint
// one level along, so the two are compared rather than trusted. `driftVerdict`
// is that comparison and `fli deploy:status` prints it, under the rule
// `preconditionVerdict` already holds: nothing reconciles, drift names itself.
//
// Everything here is a pure function over strings. Nothing in this file runs a
// command or touches a machine.

/**
 * The marker the generated vhost carries.
 *
 * Detection is an exact grep for this line rather than a guess at the shape of
 * the guard, because the alternative to finding it is `sed` against a live nginx
 * config from inside a deploy.
 */
export const GUARD_MARKER = '# fli:pause-guard'

/**
 * The vhost `_steps-setup/05-nginx` writes.
 *
 * Named here rather than in the step, because `deploy:pause` greps it and
 * `deploy:status` reports on it — three places deriving one path is three
 * answers to where the guard lives.
 */
export const vhostPath = (appId) => `/etc/nginx/sites-available/${appId}`

/** fli's own state on a target. The journal is already here. */
export const fliDir = (serverPath) => `${serverPath}/.fli`

/** The file nginx stats. Its presence is the whole of whether the edge refuses. */
export const pausedFile = (serverPath) => `${fliDir(serverPath)}/paused`

/** The page a visitor gets. Written at setup, replaceable by the app. */
export const pagePath = (serverPath) => `${fliDir(serverPath)}/maintenance.html`

/**
 * The guard, for the `server` block `_steps-setup/05-nginx` writes.
 *
 * A NAMED location, which is the part that is not obvious: an `error_page`
 * pointing at a URI re-enters the rewrite phase, hits the same `if` and nginx
 * refuses the config with a redirection cycle. A named location is unreachable
 * by URI and `break` stops the rewrite there.
 *
 * The status stays 503 because `error_page` without `=` preserves it, and
 * `Retry-After` rides with it — a 503 without one is what takes a paused app out
 * of a search index, and no application should have to know that.
 *
 * It goes FIRST in the server block, ahead of the http→https redirect. Both are
 * rewrite-phase returns and the first one wins, so a guard placed after it
 * answers 301 to every plain-http caller of a paused app — the app looks up,
 * over a scheme somebody is really using. Paused wins over the redirect.
 */
export const nginxGuard = (serverPath, { retryAfter = 120 } = {}) => `  ${GUARD_MARKER}
  # fli deploy:pause writes the file and fli deploy:unpause removes it.
  # Tested per request, so neither needs a reload and neither needs sudo.
  if (-f ${pausedFile(serverPath)}) {
    return 503;
  }
  error_page 503 @fli_paused;
  location @fli_paused {
    root ${fliDir(serverPath)};
    rewrite ^ /maintenance.html break;
    add_header Retry-After ${retryAfter} always;
    add_header Cache-Control "no-store" always;
  }`

/**
 * The default page.
 *
 * No build step, no asset, no request that can itself fail — it is served while
 * the app is down, so anything it had to fetch would be the second thing broken.
 */
export const DEFAULT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Back shortly</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 system-ui, sans-serif; background:Canvas; color:CanvasText }
  main { max-width:28rem; padding:2rem; text-align:center }
  h1 { font-size:1.375rem; margin:0 0 .5rem }
  p { margin:0; opacity:.75 }
</style>
</head>
<body>
<main>
  <h1>Back shortly</h1>
  <p>This service is down for maintenance. Nothing is wrong with your connection.</p>
</main>
</body>
</html>
`

// ─── the two answers, compared ───────────────────────────────────────────────

/**
 * What the journal says against what the edge does.
 *
 * Four states and the two that matter are the ones where they disagree. Neither
 * is repaired here: the journal row records an intent a person had and the file
 * records what is in force, and picking one is a guess about which of them is
 * out of date.
 */
export function driftVerdict({ journalPaused = false, filePresent = false } = {}) {
  if (!journalPaused && !filePresent)
    return { state: 'serving', drift: false, summary: 'serving' }
  if (journalPaused && filePresent)
    return { state: 'paused', drift: false, summary: 'paused' }
  if (journalPaused && !filePresent)
    return {
      state: 'paused', drift: true, summary: 'paused in the journal, answering at the edge',
      detail: 'the pause is NOT in force — the guard file is gone, so the app is serving',
      fix: 'fli deploy:pause to put it back, or fli deploy:unpause to record that it is serving',
    }
  return {
    state: 'serving', drift: true, summary: 'paused by hand',
    detail: 'the edge is refusing and nothing recorded why, who, or what it is waiting for',
    fix: 'fli deploy:unpause to lift it, or fli deploy:pause to record the pause that is already in force',
  }
}

// ─── refusals ────────────────────────────────────────────────────────────────

/** Each names its own way out, in the order a person should read them. */
export const REFUSALS = {
  'no-guard':    'this target\'s vhost was written before pause existed and carries no guard',
  'no-journal':  'nothing has been recorded for this target, so a pause would not be either',
  'in-flight':   'a transition is still open',
  'already':     'it is already in that state — running it twice is almost always two people',
}

/**
 * Can this pause or unpause go ahead?
 *
 * `already` is a refusal rather than a no-op on purpose: running it twice is
 * almost always two people, and the second one should be told what the first did
 * rather than shown a success for work nobody performed.
 *
 * **It is graded on BOTH answers and not on the journal alone**, which is the
 * difference between a rule and a trap. A journal that says paused over a target
 * whose file somebody deleted must accept another pause — that is the fix for
 * the drift. A journal that says serving over a target somebody paused by hand
 * must accept an unpause — that is the only way the hand-made pause ever gets
 * recorded. So *already* means the two agree AND they agree with what was asked.
 */
export function pauseRefusals({
  want, vhostHasGuard, journalOpen = true, inFlight = null,
  journalPaused = null, filePresent = null,
} = {}) {
  const out = []
  const add = (code, extra) => out.push({ code, reason: REFUSALS[code], ...extra })

  if (want === 'pause' && !vhostHasGuard)
    add('no-guard', { fix: 'fli deploy:setup rewrites the vhost and asks before it does; nothing here edits a live nginx config behind you' })
  if (!journalOpen)
    add('no-journal', { fix: 'deploy once through the journal first' })
  if (inFlight)
    add('in-flight', { fix: `fli deploy:status shows it — ${inFlight}` })

  if (journalPaused !== null && filePresent !== null) {
    const v = driftVerdict({ journalPaused, filePresent })
    if (!v.drift && v.state === (want === 'pause' ? 'paused' : 'serving'))
      add('already', {
        reason: `it is already ${v.state}`,
        fix: want === 'pause' ? 'fli deploy:unpause lifts it' : 'nothing to lift',
      })
  }

  return out
}

// ─── the queues (FJS-D262) ───────────────────────────────────────────────────
//
// The container stays up, so a pause at the edge leaves every job, cron and
// outbox delivery running — and the case a pause is most reached for, a
// migration nothing may write through, is exactly the case that matters. The
// queues are Caravan's, and this file never writes Caravan's tables: it builds
// the script that runs Caravan's OWN bin inside the serving container, so the
// code writing the pause row is the code the app reads it with, and it grades
// the bin's answer. Which database, which queues and whether anybody is claiming
// are all the bin's to find out; nothing here restates them.

/** What a deploy's queue pause is held by. A resume stating it lifts nothing an operator paused. */
export const QUEUE_HOLDER = 'fli:deploy'

/** Where the bin is inside an app image. Run by path: `bunx caravan` fetches whatever npm calls that. */
export const CARAVAN_BIN = 'node_modules/@frontierjs/caravan/bin/caravan.ts'

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * The script that runs one verb over every queue in `container`.
 *
 * Always exits 0 and prints one JSON line last: the bin's answer, or a
 * `{"fli": …}` line where there was nothing to ask. A non-zero exit from the
 * bin is a refusal with a reason in its JSON, and `capture` throwing on it
 * would throw that reason away.
 */
export function queueScript({ container, verb, actor, reason = null }) {
  const args = [
    'queue', verb,
    ...(verb === 'state' ? [] : ['--actor', sq(actor || 'fli'), '--holder', sq(QUEUE_HOLDER)]),
    ...(reason && (verb === 'pause' || verb === 'drain') ? ['--reason', sq(reason)] : []),
  ].join(' ')
  return `if [ "$(docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null)" != "true" ]; then
  echo '{"fli":"no-container"}'
elif ! docker exec -w /app ${container} test -f ${CARAVAN_BIN}; then
  echo '{"fli":"no-caravan"}'
else
  docker exec -w /app ${container} bun ${CARAVAN_BIN} ${args} 2>&1 || true
fi`
}

const who = (p) => `${p.actor ?? 'nobody'}${p.reason ? ` (${p.reason})` : ''}`

/**
 * What the step says and whether the transition fails, from what the script printed.
 *
 * `fail` is kept for the bin REFUSING — two databases open, a file that is not
 * Caravan's, output nobody can read. Nothing running to pause is not a failure:
 * there is no work being claimed to stop, and a failed transition over an app
 * that is down would ask a person to fix something that is not broken.
 */
export function queueVerdict({ kind, output }) {
  const line = String(output ?? '').trim().split('\n').reverse().find(l => l.trim().startsWith('{'))
  let a
  try { a = line ? JSON.parse(line) : null } catch { a = null }
  if (!a)
    return { level: 'fail', lines: ['the Caravan bin answered nothing a deploy can read', ...String(output ?? '').trim().split('\n').slice(-3)] }

  if (a.fli === 'no-container')
    return { level: 'warn', lines: [kind === 'pause'
      ? 'no container is running, so no queue was paused — a container started while the edge is paused runs its jobs'
      : 'no container is running, so no queue was resumed'] }
  if (a.fli === 'no-caravan')
    return { level: 'note', lines: ['this app has no Caravan — there are no queues to ' + (kind === 'pause' ? 'pause' : 'resume')] }

  if (a.error) {
    if (a.exists === false && a.source === 'open')
      return { level: 'note', lines: ['no process in the container has a Caravan jobs database open — nothing is claiming jobs'] }
    return { level: 'fail', lines: [
      `the Caravan bin refused: ${a.error}`,
      ...(a.candidates ?? []).map(c => `  ${c}`),
    ] }
  }

  const lines = []
  let level = 'ok'
  const warn = (text) => { level = 'warn'; lines.push(text) }

  if (kind === 'pause') {
    if (a.changed)                          lines.push(`every queue paused → ${a.db}`)
    else if (a.pause?.holder === QUEUE_HOLDER) lines.push(`every queue was already paused by a deploy → ${a.db}`)
    else warn(`every queue was already paused by ${who(a.pause)} — the unpause will leave that pause in force`)
    if (a.drained === false)
      warn(`${a.running} job(s) still running when the drain stopped waiting — they finish, and nothing new starts`)
    if (a.liveInstances === 0)
      warn(`no Caravan instance has heartbeated on ${a.db} within a lease — the pause is written and is read at the next start`)
    return { level, lines }
  }

  if (a.changed)       lines.push(`every queue resumed → ${a.db}`)
  else if (!a.pause)   lines.push('no queue pause was held by a deploy — nothing to lift')
  else warn(`every queue is still paused by ${who(a.pause)}, which a deploy did not make — lift it with: caravan queue resume --actor <you>`)
  return { level, lines }
}

/**
 * One line for `deploy:status`, from `queueScript({ verb: 'state' })`'s output,
 * with the disagreement with the edge named rather than reconciled — the same
 * rule `driftVerdict` holds for the journal and the file.
 */
export function queueStateLine({ output, edgePaused }) {
  const line = String(output ?? '').trim().split('\n').reverse().find(l => l.trim().startsWith('{'))
  let a
  try { a = line ? JSON.parse(line) : null } catch { a = null }
  if (!a)                          return { text: 'could not be read', drift: false }
  if (a.fli === 'no-container')    return { text: 'no container running', drift: false }
  if (a.fli === 'no-caravan')      return { text: 'this app has no Caravan', drift: false }
  if (a.error)                     return { text: `could not be read — ${a.error}`, drift: false }

  if (a.paused) {
    const byDeploy = a.paused.holder === QUEUE_HOLDER
    const since    = new Date(a.paused.pausedAt).toISOString()
    return {
      text:  `every queue paused · since ${since} · ${who(a.paused)}${byDeploy ? ' · held by a deploy' : ''}`,
      // A deploy's pause with the edge serving is a pause nobody will lift: the
      // unpause that owns it has already run, or never will.
      drift: byDeploy && !edgePaused,
    }
  }
  const own = Object.entries(a.queues ?? {}).filter(([, q]) => q.paused).map(([n]) => n)
  const text = own.length ? `${own.length} of ${Object.keys(a.queues).length} paused (${own.join(', ')})` : 'claiming'
  return { text, drift: edgePaused }
}

// ─── what a swap throws away (FJS-1095) ──────────────────────────────────────

const under = (path, dir) => path === dir || path.startsWith(dir.replace(/\/$/, '') + '/')

/**
 * Does the jobs database the running app has open survive a container swap?
 *
 * Read off `queueScript({ verb: 'state' })` run against the container being
 * REPLACED, before it is. Only a file under the volume outlives the swap; any
 * other path is the container's own layer, and the new container opens an empty
 * one — every pending job, every stated dispatch id and every pause gone, with
 * nothing said.
 *
 * `fail` only when a PAUSE is in force: a deploy while paused is the case a pause
 * exists for, and the new container would run its migration with every queue
 * claiming. Pending work alone is a warning, because refusing it would deadlock —
 * binding the path is itself a deploy. The way out of the refusal is to unpause,
 * deploy the binding, and pause again.
 */
export function jobsVolumeVerdict({ output, volume }) {
  const line = String(output ?? '').trim().split('\n').reverse().find(l => l.trim().startsWith('{'))
  let a
  try { a = line ? JSON.parse(line) : null } catch { a = null }
  if (!a || a.fli || (a.error && a.exists === false)) return { level: 'ok', lines: [] }
  if (a.error)
    return { level: 'warn', lines: [`could not tell which jobs database this app uses — ${a.error}`] }
  if (under(a.db, volume)) return { level: 'ok', lines: [] }

  const queues  = Object.entries(a.queues ?? {})
  const sum     = (k) => queues.reduce((n, [, q]) => n + (q.stats?.[k] ?? 0), 0)
  const pending = sum('pending')
  const running = sum('running')
  const paused  = [...(a.paused ? ['every queue'] : []), ...queues.filter(([, q]) => q.paused?.queue && q.paused.queue !== '*').map(([n]) => n)]

  const lines = [
    `the jobs database is ${a.db}, which is inside the container and not under ${volume} — this swap starts an empty one`,
    `  lost with it: ${pending} pending, ${running} running, every stated dispatch id and unique lock` +
      (paused.length ? `, and the pause on ${paused.join(', ')}` : ''),
    `  bind it under ${volume}: createCaravan({ db }) beside the main database, which DATABASE_URL already puts there`,
  ]
  if (paused.length)
    return { level: 'fail', lines: [...lines,
      `  refused because the new container would migrate with every queue claiming — unpause, deploy the binding, then pause again`] }
  return { level: 'warn', lines }
}
