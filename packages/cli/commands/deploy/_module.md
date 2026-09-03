---
namespace: deploy
description: Deploy FrontierJS apps to a server via SSH + Docker + nginx
---

<script>
const { loadFrontierConfig, dockerfileScripts } = await import(new URL('file://' + global.fliRoot + '/core/utils.js'))
const { vendorWorkspacePackages, linkedDeps, GENERATED_DIR } = await import(new URL('file://' + global.fliRoot + '/core/vendor.js'))
const { createMachine } = await import(new URL('file://' + global.fliRoot + '/core/machine.js'))
const { dockerLogArgs } = await import(new URL('file://' + global.fliRoot + '/core/docker-logging.js'))

// ─── machineFor ───────────────────────────────────────────────────────────────
// The one way a step reaches the box. Every command a deploy runs goes through
// `machine.run(script)`, which pipes the script to `sh -s` there — see
// `core/machine.js` for what that replaced and why it is not negotiable.
//
// `deploy.transport` is the escape hatch and is read here rather than in the
// module, so the whole pipeline agrees about one machine per host.
const machineFor = (context, host, path = null, transport = null) => createMachine({
  host, path,
  exec:      context.exec,
  transport: transport ?? context.config?.deployConf?.transport ?? null,
})

// ─── vendorApp ────────────────────────────────────────────────────────────────
// Write the build context the Dockerfile installs from: deploy/generated/, with
// a manifest and — for an app depending on the framework by `link:` or
// `workspace:` — a packed copy of every one of those packages beside it.
//
// Runs on EVERY build, not only a linked one. With nothing linked it copies the
// manifest and the lockfile, which is what lets one Dockerfile serve both source
// modes; making it conditional here would move the condition into a template
// nobody regenerates when the source mode changes.
//
// It throws on anything it cannot finish. A half-vendored context installs the
// rest from npm and produces an image running two trees at once, which does not
// have to fail to be wrong.
//
// It does NOT prune devDependencies, and the reason is worth stating because
// pruning them looks free: the image builds nothing — it copies `api/` and
// `db/` and runs `db:migrate` then `start` — and **`bun install --production`
// resolves devDependencies anyway**, only skipping their install, so one dev
// tool that 404s fails an image that would never have run it. The `transform`
// hook can drop them; a manifest that no longer matches the lockfile beside it
// then fails `--frozen-lockfile` outright, which is the worse trade. An
// unresolvable devDependency is a publish problem and belongs upstream.
const vendorApp = (root, log) => {
  const result = vendorWorkspacePackages({ appRoot: root, log: (m) => log.info(m) })
  if (result.vendored.length)
    log.success(`Vendored ${result.vendored.length} workspace dependenc(ies) from ${result.packagesDir}`)
  return result
}

// ─── resolveTarget ────────────────────────────────────────────────────────────
// Resolves the deploy target from flags and git branch.
// Priority: --production > --stage > branch name > dev
//
// Usage in any deploy command:
//   const target = resolveTarget(flag, context.git)
const resolveTarget = (flag, git) => {
  if (flag.production) return 'production'
  const branch = git?.branch?.() ?? ''
  if (flag.stage || ['stage', 'staging'].includes(branch)) return 'stage'
  return 'dev'
}

// ─── resolveDeployConf ────────────────────────────────────────────────────────
// Extracts the resolved server/user/path for a given target from the deploy
// block, applying per-target overrides over the top-level values.
//
// Returns null if the required fields are missing — callers should check and
// set context.config.abort = true before returning.
//
// `abort` is a REFUSAL and fails the command: the runtime exits non-zero on it
// even when nothing threw, which is what stops a refusal reading as success
// (`FJS-589`). A deliberate early exit that SUCCEEDED — `--plan` prints a plan
// and stops — sets `context.config.stop` instead. Both skip every later step;
// they differ only in the outcome, and `abort` is the fail-closed default.
//
// Usage:
//   const conf = resolveDeployConf(deployConf, target)
//   if (!conf) { log.error('...'); context.config.abort = true; return }
const resolveDeployConf = (deployConf, target) => {
  if (!deployConf?.server) return null
  const targetConf = deployConf[target] ?? {}
  const server = targetConf.server ?? deployConf.server
  const user   = targetConf.user   ?? deployConf.user ?? 'deploy'
  const path   = targetConf.path   ?? deployConf.path
  if (!server || !path) return null
  return { server, user, path }
}

// ─── resolveSide ──────────────────────────────────────────────────────────────
// The same resolution, per SIDE — 'api' or 'web' — so the two halves of an app
// can live on different machines. A split is the ordinary shape once the API is
// its own origin (api.myapp.com), and the transport already assumes nothing
// about co-location: the browser client takes an absolute url and /ws is
// registered beneath the router, so it never carries apiPrefix either.
//
// Most specific wins, and a side that says nothing inherits the shared value —
// so an unsplit config keeps behaving exactly as it did:
//
//   deploy[target][side]  →  deploy[side]  →  deploy[target]  →  deploy
//
// `deploy.web` already carries domain/keep_releases/ssl and `deploy.api` carries
// port/health/dockerfile, so server/user/path join blocks that exist rather than
// introducing a shape.
//
// Returns null when the side cannot be resolved; callers abort by name.
const resolveSide = (deployConf, target, side) => {
  if (!deployConf) return null
  const t     = deployConf[target] ?? {}
  const ts    = t[side] ?? {}
  const s     = deployConf[side] ?? {}
  const server = ts.server ?? s.server ?? t.server ?? deployConf.server
  const user   = ts.user   ?? s.user   ?? t.user   ?? deployConf.user ?? 'deploy'
  const path   = ts.path   ?? s.path   ?? t.path   ?? deployConf.path
  if (!server || !path) return null
  return { server, user, path, host: `${user}@${server}` }
}

// ─── litestreamStatus ─────────────────────────────────────────────────────────
// `pgrep -x litestream` answers *is a process by that name alive*, which is not
// *is a supported version replicating anything*. Three commands asked the first
// and reported the second (`FJS-243`).
//
// litestream 0.3.x cannot parse the STRICT tables litestone emits. Pointed at a
// litestone database it starts, prints `replicating to:`, and then loops forever
// on `malformed database schema … near "STRICT": syntax error` **without ever
// exiting** — so the process table says healthy, every check here agreed, and
// the replica stayed empty. Demonstrated, not theorised: v0.3.4 does exactly
// this today.
//
// LITESTREAM_MIN is a hand copy of litestone's own floor in
// `src/tools/replicate.js` — change one, change both. This side cannot import
// it: litestream reaches the server as a binary and litestone reaches it as a
// dependency of the app, neither of which the CLI can resolve from here.
//
// `run` takes a shell script and returns its stdout as a string — pass
// `machine.capture`, so this stays a question about litestream rather than about
// how a command reaches the box.
const LITESTREAM_MIN = { major: 0, minor: 5 }

const litestreamStatus = (run) => {
  const pid = (run(`pgrep -x litestream 2>/dev/null || echo ''`) ?? '').trim()
  if (!pid) return { running: false }

  const raw = (run(`litestream version 2>/dev/null || echo ''`) ?? '').trim()
  const m   = raw.match(/v?(\d+)\.(\d+)\.(\d+)/)

  // A version we cannot read is UNKNOWN, not fine. Saying so is the whole point:
  // the failure this replaces was a check that assumed.
  if (!m) return { running: true, pid, version: null, supported: null }

  const major = Number(m[1])
  const minor = Number(m[2])
  const supported =
    major > LITESTREAM_MIN.major ||
    (major === LITESTREAM_MIN.major && minor >= LITESTREAM_MIN.minor)

  return { running: true, pid, version: m[0], supported }
}

const LITESTREAM_MIN_LABEL = `v${LITESTREAM_MIN.major}.${LITESTREAM_MIN.minor}`

// ─── distinctHosts ────────────────────────────────────────────────────────────
// The machines a run touches, deduplicated by host AND path — the SSH check, the
// deploy lock, the git pull and the cleanup are per machine, not per side, and
// the common case is one machine wearing both hats. Deduplicating on the pair
// matters: two apps sharing a host but not a path are two locks, and one app
// split across two hosts is two pulls.
const distinctHosts = (sides) => {
  const seen = new Map()
  for (const side of sides) {
    if (!side) continue
    const key = `${side.host}:${side.path}`
    if (!seen.has(key)) seen.set(key, { host: side.host, path: side.path })
  }
  return [...seen.values()]
}

// ─── deployPlan ───────────────────────────────────────────────────────────────
// Phase 1d. The journal rows a transition WOULD write, built from a minted
// Release and from the REAL step list — `_steps-docker/`, read with the runner's
// own filter and sort, so a plan cannot describe a pipeline that has moved.
//
// One helper rather than two call sites, because `fli deploy --plan` and
// `fli deploy:plan` must print the same document: a plan is a thing people read
// to decide, and two implementations of it is the failure mode the whole Release
// design is arranged against.
//
// It mints rather than being handed a Release, so `--plan` needs no separate
// `release:mint` run and cannot disagree with one.
const deployPlan = async (context, flag, { target, deployConf, doApi, doWeb, digest = null }) => {
  const core = (name) => import(new URL('file://' + global.fliRoot + '/core/' + name))
  const { readdirSync, readFileSync } = await import('fs')

  const { bindingSet, schemaSurfaceHash, mintRelease, BindingError } = await core('release.js')
  const { stepFilesIn, stepNameOf, planSteps, planTransition, formatPlan } = await core('plan.js')
  const { extractFrontmatter } = await core('compiler.js')

  let bindings
  try { bindings = bindingSet(deployConf, target) }
  catch (e) {
    if (!(e instanceof BindingError)) throw e
    return { error: e.message }
  }

  const schema = schemaSurfaceHash(context.paths.db)

  // The pivot is litestone's answer, asked rather than re-derived — the same
  // walk `fli release:check` prints. No baseline answers unknown, which counts
  // as a contract.
  let pivot = 'unknown', findings = []
  if (!schema.missing) {
    const out = context.exec({
      command: `cd ${context.paths.root} && bunx litestone release --schema ${context.paths.db}/schema.lite --json`,
      stdio:   'pipe', allowFailure: true,
    })
    try {
      const verdict = JSON.parse(String(out ?? '').trim())
      pivot    = verdict.verdict  ?? 'unknown'
      findings = verdict.findings ?? []
    } catch {}
  }

  const release = mintRelease({
    app:           deployConf.app_id ?? deployConf.appId,
    environment:   target,
    // The bytes, where they exist. `--plan` runs no build and has none, so the
    // id it prints is provisional and says so; the deploy passes what step 04
    // produced, which is what makes the Release name an artefact at all (2.3f).
    digest:        digest ?? flag.digest ?? null,
    bindingsHash:  bindings.hash,
    schemaHash:    schema.hash,
    pivot,
    pivotFindings: findings,
    createdBy:     context.git.user?.() ?? null,
  })

  // The steps, off disk. `skip:` is evaluated against the same shape the runner
  // hands a predicate, so a step shown as skipped is one that will be skipped.
  const dir   = new URL('file://' + global.fliRoot + '/commands/deploy/_steps-docker').pathname
  const files = stepFilesIn(readdirSync(dir))
  const metas = files.map(f => {
    const fm = extractFrontmatter(readFileSync(`${dir}/${f}`, 'utf8')) ?? {}
    return { name: stepNameOf(f), title: fm.title, skip: fm.skip, runOnAbort: fm.runOnAbort }
  })

  // The context a skip predicate is evaluated against has to be the SHAPE the
  // runner passes — `(config.flag, config)` — so `context.flag.dry` and
  // `context.config.doApi` both resolve. Without `flag` here, `04c-journal`'s
  // predicate threw and the plan could not grade the journal step itself.
  const steps = planSteps(metas, {
    flag,
    context: { flag, config: { doApi, doWeb, deployConf, target } },
  })

  const plan = planTransition({ release, steps, actor: release.createdBy })
  return { ...plan, release, bindings, findings, schema, text: formatPlan({ ...plan, release, bindings, findings }) }
}

// ─── the deploy lock ──────────────────────────────────────────────────────────
// One lock per machine+path pair, and ONE definition of it, because a deploy and
// a revert have to be able to see each other's: two writers on one journal is
// two answers to what is serving, which is the state the whole Release design
// exists to make impossible. Two copies of this script that had drifted on the
// file name or the format would each hold a lock the other could not read.
//
// The format, the scripts and the reading of one are `core/lock.js`, where the
// tests are; this is the wiring. The lock answers *is another run working in this
// directory*; the journal answers *what state did the last run leave*. Two
// questions, not two answers to one — `FJS-D156`, which is also why nothing here
// settles a transition when a lock is dropped.
//
// The failure mode being bought off is a stranded lock: a second machine
// refusing after the first accepted must release the first, or the next deploy
// is blocked by a run that never happened.
const lockCore = () => import(new URL('file://' + global.fliRoot + '/core/lock.js'))

const releaseLocks = async (context, hosts = []) => {
  const { lockPath, releaseScript } = await lockCore()
  for (const h of hosts) {
    try { machineFor(context, h.host, h.path).run(releaseScript(lockPath(h.path))) } catch {}
  }
}

const acquireLock = async (context, { hosts, target, takeover = false }) => {
  const { lockPath, acquireScript, parseLock } = await lockCore()
  const { randomUUID } = await import('crypto')

  const run = context.config.lockRun ??= {
    run:     randomUUID().slice(0, 8),
    actor:   context.config.deployConf?.actor ?? process.env.USER ?? 'unknown',
    target,
    started: new Date().toISOString(),
  }

  const locked = []
  for (const h of hosts) {
    const lockFile = lockPath(h.path)
    const machine  = machineFor(context, h.host, h.path)
    try {
      const out = machine.capture(acquireScript(lockFile, run, { takeover }))
      const took = /^TOOK: (.*)$/m.exec(out)
      if (took) context.config.lockTookOver = took[1].replace(/;+$/, '').replace(/;/g, ' · ')
      locked.push(h)
    } catch (err) {
      // The refusal carries the lock's own body on STDOUT — reading the file a
      // second time is a second answer, and the run that holds it may have moved
      // on between them. `attribute` folds stderr into the message and leaves
      // stdout where it is, which is where the script wrote this.
      const body = /HELD\n([\s\S]*)/.exec(String(err?.stdout ?? ''))
      await releaseLocks(context, locked)
      return { ok: false, host: h.host, lockFile, held: parseLock(body?.[1] ?? '') }
    }
  }
  context.config.lockHosts  = hosts
  // The step runner's one reader. Installed here rather than by the step, so a
  // run that never took a lock never refreshes one.
  context.config.beforeStep = (step) => refreshLock(context, step)
  return { ok: true }
}

// ─── refreshLock ──────────────────────────────────────────────────────────────
// Say which step the run is inside.
//
// The step runner calls this before every step, which is the only place it can
// be called from: the build is the longest thing a deploy does and it runs
// BEFORE the journal opens (`04c-journal`), so for the window where *is this
// alive* is asked most, the journal has nothing to say. `fli` cannot heartbeat
// on a timer either — `execSync` blocks the loop for the whole of a step — so a
// step boundary is the finest grain there is.
//
// It is a fact for a person to weigh, never one anything here decides on: the
// time recorded is when a step STARTED, so a fresh one is as consistent with a
// run three seconds into a five-minute build as with one killed three seconds
// into it. What it buys is that a duration means something beside a step name —
// four minutes in `04-build-api` reads differently from four minutes in
// `06-swap`.
const refreshLock = async (context, step) => {
  const run   = context.config.lockRun
  const hosts = context.config.lockHosts
  if (!run || !hosts?.length) return

  const { lockPath, refreshScript } = await lockCore()
  const fields = { ...run, step, stepAt: new Date().toISOString() }

  for (const h of hosts) {
    try {
      const out = machineFor(context, h.host, h.path).capture(refreshScript(lockPath(h.path), fields))
      if (/stolen/.test(out) && !context.config.lockStolen) {
        context.config.lockStolen = true
        context.log?.warn?.(`  The deploy lock on ${h.host} is now held by another run — this one no longer owns it.`)
      }
    } catch {}
  }
}

// ─── lockRefusal ──────────────────────────────────────────────────────────────
// What an operator reads when the lock refuses them.
//
// It reports and never judges, because the fact that would settle it — is that
// other `fli` still running — is on a machine this one cannot see. So it prints
// what is known and names both ways out, and the two are not the same choice:
// `--resume` continues what the journal is holding, which is safe because a
// succeeded step replays into a no-op and a step is claimed compare-and-set;
// `deploy:unlock` drops the lock and deploys fresh.
const lockRefusal = async (lock, { verb = 'deploy' } = {}) => {
  const { describeLock } = await lockCore()
  const d = describeLock(lock.held)
  // A revert takes the same lock and cannot resume — `j.attempt` gives it an
  // attempt number and it opens a new transition either way — so pointing its
  // operator at `--resume` would be advice for a command they are not running.
  // What they can do is drop the lock, which is why `unlock` settles nothing.
  const resume = verb === 'deploy'
    ? '    fli deploy --resume    continue it — the journal knows how far it got'
    : '    fli deploy --resume    continue it, if what died was a deploy'
  return [
    ['error', `A deploy is already in progress on ${lock.host}`],
    ...d.lines.map(line => ['error', `  ${line}`]),
    ['info', ''],
    ['info', '  If that run is dead:'],
    ['info', resume],
    ['info', `    fli deploy:unlock      drop the lock and ${verb === 'deploy' ? 'start over' : 'revert'} (${lock.lockFile})`],
  ]
}

// ─── swapContainer ────────────────────────────────────────────────────────────
// Put a named container onto a given image, keeping the one it replaced under
// `_replaced` so there is a handle to go back to.
//
// Two callers — `_steps-docker/06-swap` deploying forward and
// `_steps-revert/03-swap` going back — and it is one function because the going-
// back path is the one nobody exercises until the day it matters. A copy of this
// that had drifted would be discovered mid-incident.
//
// **Stopping `_replaced` before starting the new one is required by SQLite**, not
// a tidy-up: only one writer at a time, and the new container's entrypoint opens
// the database to migrate. That costs a 3–10s gap and it is the correct trade.
// Litestream is unaffected — it checkpoints the WAL when `_replaced` stops.
const swapContainer = (context, { host, container, image, apiPort, dbPath, envFile, build, log }) => {
  const machine  = machineFor(context, host)
  const replaced = `${container}_replaced`

  log.info('Renaming current container to _replaced...')
  machine.run(`if docker inspect ${container} > /dev/null 2>&1; then
  docker rename ${container} ${replaced}
fi`)

  log.info('Stopping _replaced container...')
  // `-t`, not `--time`: docker deprecated the long form in favour of `--timeout`
  // and prints a warning on every deploy, while the short form means the same
  // thing in both and is not deprecated in either.
  machine.run(`if docker inspect ${replaced} > /dev/null 2>&1; then
  docker stop -t 10 ${replaced}
fi`)

  log.info(`Starting ${image}...`)
  const runCmd = [
    'docker run -d',
    `--name ${container}`,
    '--restart unless-stopped',
    `-p 127.0.0.1:${apiPort}:3000`,
    `--volume ${dbPath}:/db`,
    `--env-file ${envFile}`,
    // AFTER --env-file so it wins: the mapping above targets 3000 inside the
    // container, and the app binds whatever PORT says. A PORT in .env.production
    // otherwise leaves the container listening where nothing forwards, which the
    // health step then reports as a sick application.
    `--env PORT=3000`,
    `--env NODE_ENV=production`,
    // Docker's default json-file driver caps nothing, so a chatty container
    // fills the disk and the database stops writing before anybody reads a log.
    // `deploy.logs` is the escape for a daemon already pointed somewhere.
    ...dockerLogArgs(deployConf),
    // What this process states on every response, so a browser holding the
    // previous build can tell (`FJS-D160`). The same value the web build was
    // stamped with — one deploy is one build on both sides of the wire.
    ...(build ? [`--env FJS_BUILD=${build}`] : []),
    image,
  ].join(' ')

  machine.run(runCmd)
  return { container, replaced }
}

// ─── showContainerTail ────────────────────────────────────────────────────────
// Print the last lines a container wrote, when a health check has just failed.
//
// Separate from healthOrRestore because the REVERT path shares that function and
// wants this too: a revert whose health check fails is a target with no working
// release on it, which is the worst moment to be told only that a URL did not
// answer.
//
// Never throws. This runs on a path that is already failing, and a deploy that
// fell over because the log tail could not be read would be a worse bug than
// the one it was trying to explain.
const showContainerTail = (machine, container, log, lines = 40) => {
  let out = ''
  try {
    out = machine.capture(`docker logs --tail ${lines} ${container} 2>&1 || true`)
  } catch {
    return
  }
  const body = String(out ?? '').trimEnd()
  if (!body) {
    log.info(`  ${container} wrote nothing — it may have failed before the app started`)
    return
  }
  log.info('')
  log.info(`  last ${lines} lines from ${container} — the app's own words:`)
  for (const line of body.split('\n')) log.info(`  │ ${line}`)
  log.info('')
}

// ─── healthOrRestore ──────────────────────────────────────────────────────────
// Poll the health endpoint and, if it never answers, put `_replaced` back.
//
// Shared by `_steps-docker/07-health` and `_steps-revert/04-health` for the same
// reason `swapContainer` is: the restore branch is the one nobody exercises until
// the day it matters, and a revert whose own safety net had drifted from the
// deploy's would be discovered at the worst moment.
//
// Answers `{ healthy, restored }` and throws nothing — the caller decides what a
// failure means, because for a deploy it is a rollback and for a revert it is a
// revert that could not land.
const healthOrRestore = (context, { host, container, replaced, apiPort, healthPath, log, attempts = 10, intervalS = 2 }) => {
  const machine = machineFor(context, host)
  log.info(`Waiting for ${healthPath} (up to ${attempts * intervalS}s)...`)

  // Every `$` and every nested quote below is the TARGET's — the script is piped
  // to its shell rather than interpolated into a command line, which is what
  // stops `$(curl …)` running here and polling the operator's own machine.
  const healthCmd = `for i in $(seq 1 ${attempts}); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${apiPort}${healthPath} 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "ok"
    exit 0
  fi
  sleep ${intervalS}
done
echo "fail"
exit 1`

  try {
    machine.run(healthCmd)
    log.success('Health check passed')
    return { healthy: true, restored: false }
  } catch {}

  // Name the URL. The most common cause is not a sick app but a health path that
  // omits the app's apiPrefix — healthPlugin() registers through app.get(), which
  // moves with the prefix, so an app serving /api/health polls 404 here and a
  // working release gets taken down. Without the URL in the message that reads as
  // the app's fault.
  log.error(`Health check failed after ${attempts * intervalS}s`)
  log.error(`  polled: http://localhost:${apiPort}${healthPath}`)
  log.info(`  if the API is healthy, check deploy.api.health includes your apiPrefix`)

  // ── The container's own last words ──────────────────────────────────────────
  //
  // An app that REFUSED to start says why, clearly, in its own output — a
  // missing attachment binding, a bad encryption key, a port already taken —
  // and until this the operator saw none of it. All they got was "health check
  // failed", a rollback, and a message about apiPrefix that is wrong whenever
  // the app never came up at all. The refusal was sitting in `docker logs`,
  // where nobody looks at 3am because nothing said to.
  //
  // Tailed rather than dumped: an app that started and is merely unwell has
  // written thousands of lines, and burying the one that matters is the same
  // failure one layer along. A stopped container still answers, which is the
  // case that matters most — it is the one that exited.
  showContainerTail(machine, container, log)

  const restoreCmd = `docker stop ${container} || true
docker rm   ${container} || true
if docker inspect ${replaced} > /dev/null 2>&1; then
  docker rename ${replaced} ${container}
  docker start  ${container}
  echo "restored"
else
  echo "no previous container to restore"
fi`

  try {
    machine.run(restoreCmd)
    log.warn('Restored the previous container')
    return { healthy: false, restored: true }
  } catch (err) {
    log.error('Restore also failed: ' + err.message)
    return { healthy: false, restored: false }
  }
}

// ─── connectJournal ───────────────────────────────────────────────────────────
// Copy the runner to the target and hand back a client pointed at its journal.
// Two callers — the deploy that writes one and `deploy:journal` that reads it —
// because a reader that resolved the path or shipped the runner a second way is
// a reader that can be pointed at a different file than the writer.
//
// `bun` is what the far side needs and `deploy:setup` installs it. `bun:sqlite`
// is built in, so there is nothing to resolve on a checkout that has no
// node_modules — which a deploy target does not, since the build is in Docker.
const connectJournal = async (context, { host, serverPath, deployConf }) => {
  const { journalClient } = await import(new URL('file://' + global.fliRoot + '/core/journal.js'))
  const { readFileSync }  = await import('fs')

  const runnerLocal  = new URL('file://' + global.fliRoot + '/core/journal-runner.mjs').pathname
  const runnerRemote = `${serverPath}/.fli/journal-runner.mjs`
  const dbRemote     = deployConf?.journal?.path ?? `${serverPath}/.fli/deploy.db`

  const machine = machineFor(context, host, serverPath)
  machine.run(`mkdir -p ${serverPath}/.fli`)
  machine.send(runnerLocal, runnerRemote)

  // The runner reads one JSON object on stdin, so it cannot go through
  // `machine.run` — that channel is already carrying the script. `machine.pipe`
  // is the verb for it, which is what keeps the local backend working here.
  const ddl = readFileSync(new URL('file://' + global.fliRoot + '/db/ddl.snapshot.sql').pathname, 'utf8')

  return journalClient({
    db: dbRemote, ddl,
    exec: (stdin) => machine.pipe(`bun ${runnerRemote}`, stdin),
  })
}

// ─── noteForJournal ───────────────────────────────────────────────────────────
// One line a step leaves for the journal, keyed by the step's own name.
//
// Keyed rather than a single slot, because since `04c-journal` the build runs
// BEFORE the journal opens: there is no `afterStep` to read an unkeyed value and
// the note is simply lost — which is exactly what a revert reads to find a
// startable image. The bag is drained by whichever reader gets there: the
// journal's open, for the steps that already ran, and `afterStep` for the rest.
const noteForJournal = (context, step, value) => {
  context.config.journalNotes ??= {}
  context.config.journalNotes[step] = typeof value === 'string' ? value : JSON.stringify(value)
}

const takeNote = (context, step) => {
  const bag = context.config.journalNotes
  if (!bag || !(step in bag)) return null
  const v = bag[step]
  delete bag[step]
  return v
}

// ─── restoreStepNote ──────────────────────────────────────────────────────────
// Put a replayed step's recorded output back onto the run.
//
// A resume skips steps that already succeeded, so their side effects on
// `context.config` never happen — and one of those side effects is load-bearing:
// `04-build-api` records which bytes it built and `06-swap` starts them. A
// resumed deploy therefore ran `docker run … undefined`.
//
// The note is JSON (`04-build-api`, `_steps-revert/03-swap`). A row an older fli
// wrote is prose and restores nothing rather than being scraped — running the
// wrong bytes is worse than refusing, and `06-swap` falls back to the tag, which
// it already says out loud.
const restoreStepNote = (context, output) => {
  if (!output) return
  let note
  try { note = JSON.parse(output) } catch { return }
  if (!note || typeof note !== 'object') return
  if (note.image) {
    context.config.imageAddress  = note.image
    context.config.imageIdentity ??= note.scope ? { scope: note.scope } : null
  }
}

// ─── openDeployJournal ────────────────────────────────────────────────────────
// Phase 1e. Turns the plan 1d prints into rows on the TARGET, and hands the step
// runner a recorder so the existing `_steps-docker` list becomes journal rows
// with no step file learning to write one.
//
// Everything it needs on the far side is `bun`, which `deploy:setup` installs.
// `core/journal-runner.mjs` is copied over and given JSON on stdin; every rule
// about what a deploy may do lives in `core/journal.js` on THIS machine, where
// the tests are.
//
// It refuses rather than reconciles. A journal belonging to another app or
// another host, and a precondition that moved between planning and running, both
// stop the deploy by name — the two answers were produced by two intents and
// picking one is a guess about which person was right.
const openDeployJournal = async (context, flag, opts) => {
  const core = (name) => import(new URL('file://' + global.fliRoot + '/core/' + name))
  const { JournalError, preconditionVerdict, formatDrift, resumeDecision } = await core('journal.js')
  const { planTransition } = await core('plan.js')
  const { occurrenceKey } = await import('@frontierjs/toolbelt/history')

  const { host, serverPath, log } = opts
  const plan = await deployPlan(context, flag, opts)
  if (plan.error) return { error: plan.error }

  const j = await connectJournal(context, opts)

  try {
    await j.open({ app: plan.release.app, host })

    // What is actually serving, which is what the plan could only guess at.
    const state  = await j.state({ app: plan.release.app, environment: plan.release.environment })

    // ── `--resume` adopts what is open rather than recomputing it ────────────
    // The Release id carries the image digest, and a local image id is not a
    // content address: an unchanged tree rebuilt without a full cache hit mints a
    // different Release, so the attempt lookup — which keys on `releaseId` —
    // missed the row it was standing on and opened a second transition every
    // time. All the resume machinery below (skip a succeeded step, replay the
    // image it recorded) was therefore unreachable in the one case it exists for
    // (`FJS-595`). Only under the flag: an ordinary deploy of genuinely different
    // bytes must still open its own transition.
    const held = flag.resume
      ? await j.live({ kind: 'deploy', app: plan.release.app, environment: plan.release.environment })
      : null

    // The Release is adopted WITH the transition. Resuming the old transition
    // against the bytes this run just built is the two halves disagreeing, and
    // `06-swap` would start an image the journal never named.
    const release = held?.release ?? plan.release
    const intent = {
      kind: 'deploy', app: release.app, environment: release.environment,
      fromReleaseId: held?.transition.fromReleaseId ?? state.serving,
      releaseId: release.id,
      generation: held?.transition.generation ?? state.generation ?? 1,
    }
    const { attempt, resume } = await j.attempt(intent)

    // Rebuilt against the real serving state and attempt number — the two terms
    // `--plan` states as provisional.
    const real = planTransition({
      release, steps: plan.steps.map((s, i) => ({ ...s, ordinal: i + 1 })),
      fromReleaseId: intent.fromReleaseId, generation: intent.generation, attempt,
      actor: release.createdBy,
    })

    const verdict = preconditionVerdict(
      { serving: state.serving, generation: intent.generation },
      { serving: state.serving, generation: state.generation ?? intent.generation })
    if (!verdict.ok) return { error: formatDrift(verdict.drift) }

    const begun = await j.begin({
      release,
      bindings: {
        app: release.app, environment: release.environment,
        generation: intent.generation, hash: release.bindingsHash,
        values: plan.bindings.values, secretRefs: plan.bindings.secretRefs,
        createdBy: release.createdBy,
      },
      transition: real.transition,
      steps: real.steps,
    })

    const byName = new Map(begun.steps.map(r => [r.name, r]))
    const idFor  = (name) => occurrenceKey('deploy', real.transition.id, name)

    // The steps that already ran are marked done here, because the journal opens
    // AFTER the build now (`04c-journal`) and nothing else will ever claim them.
    // Left alone they sit `pending` forever, which reads as a pipeline that
    // stopped rather than one that had not started recording yet — the same
    // thing `_steps-revert/02-decide` does for the two steps ahead of it.
    //
    // Their PLANNED status is used rather than `succeeded`, so a step its own
    // predicate skipped is not recorded as having run.
    const self = real.steps.find(st => /journal/.test(st.name))?.ordinal ?? 0
    for (const st of real.steps) {
      if (st.ordinal >= self) continue
      if (byName.get(st.name)?.status !== 'pending') continue
      // Their notes too — `04-build-api` records which bytes it built, and that
      // is what a revert reads to find a startable image.
      await j.finish({
        id:     idFor(st.name),
        status: st.status === 'skipped' ? 'skipped' : 'succeeded',
        output: takeNote(context, st.name),
      })
    }

    return {
      journal: j,
      transition: real.transition,
      release,
      // A transition adopted by `--resume` IS a resume, whatever the insert did:
      // `begun.resumed` reads the OR IGNORE changes count, which is 0 for a row
      // that was already there and also 0 for nothing at all.
      resumed: begun.resumed || !!held,
      adopted: !!held && held.release.id !== plan.release.id,
      attempt,
      serving: state.serving,
      // The recorder the step runner calls. It knows step NAMES, because that is
      // what the runner has — the ordinal it is handed is the file's position and
      // the id is derived from the name, which is stable when a step is inserted.
      recorder: {
        async beforeStep(name) {
          const d = resumeDecision(byName.get(name))
          if (d.action === 'skip') {
            // A replayed step's own contribution to `context.config` never
            // happens, so what it RECORDED has to be put back. The one such
            // contribution is the image `04-build-api` built, which `06-swap`
            // starts — without this a resumed deploy ran `docker run … undefined`
            // and died, which is the resume failing in the one case it is for.
            restoreStepNote(context, d.output)
            return { run: false, note: d.note }
          }
          await j.claim({ id: idFor(name) })
          return { run: true, note: d.note }
        },
        async afterStep(name, _ordinal, { status, durationMs, output } = {}) {
          // A step may leave one line for the journal, keyed by its own name.
          // Read here rather than passed through the runner, which knows nothing
          // about deploys.
          await j.finish({ id: idFor(name), status, durationMs, output: output ?? takeNote(context, name) })
        },
        // Called by 09-cleanup on both paths. A deploy that aborted must leave a
        // `failed` transition and not a `running` one, or the next run reads it
        // as a crash and tries to resume something nobody started.
        async settle(status) {
          await j.settle({ id: real.transition.id, status })
        },
      },
    }
  } catch (err) {
    if (err instanceof JournalError) return { error: `deploy journal: ${err.message}` }
    throw err
  }
}
</script>

## Overview

The `deploy:` commands deploy FrontierJS apps to a Linux server using SSH,
Docker, and nginx. Configuration lives in `frontier.config.js` — no CapRover,
no external platform required.

```
fli make:deploy         ← scaffold Dockerfile, deploy config, and health endpoint

fli deploy:local        ← build + run + health check locally (no server needed)

fli deploy              ← deploy to dev (or auto-detected from branch)
fli deploy --production ← deploy to production
fli deploy --stage      ← deploy to staging
fli deploy --api        ← API only  (see § Splitting, below)
fli deploy --web        ← web only

fli deploy:status       ← check what's running on the server
fli deploy:logs         ← stream or show API container logs
fli deploy:run <cmd>    ← run a one-off command inside the running container
fli deploy:rollback     ← roll back to the previous release
fli deploy:setup        ← first-time server setup walkthrough
```

## Getting started

If this is a new project, run `fli make:deploy` first. It scaffolds the
Dockerfile, `.dockerignore`, and `deploy` block in `frontier.config.js`, and
walks you through what still needs to be done:

```
fli make:deploy
fli make:deploy --server myapp.com --domain myapp.com
```

Then test the container locally before touching a server:

```
fli deploy:local
```

Once that passes, set up the server and deploy:

```
fli deploy:setup
fli deploy
```

## Prerequisites

**On your machine:**
- SSH access to the server (`ssh user@server` must work without a password prompt)
- Docker (for `fli deploy:local`)
- A `frontier.config.js` with a `deploy` block in your project root

**On the server:**
- Ubuntu 20.04+ (or any Debian-based Linux)
- Docker, nginx, git, Bun

Run `fli deploy:setup` to check and install what's missing.

### Build once, promote a digest

`deploy.builder` names the machine the image is BUILT on. Absent, it is the api
target — dev, stage and production each build their own bytes, and no two of them
can be shown to be one artefact:

```
deploy: {
  server: 'prod.your-app.com',
  builder: { server: 'build.your-app.com', path: '/apps/shop' },
}
```

Declared, the image is built there once and shipped with
`docker save | docker load`, which preserves the image ID — so the digest the
Release names is the digest that starts. No registry; `IDEAS/deploy-plane.md`
keeps three distribution strategies open and this is the one that needs no
infrastructure.

**The digest is a term of the Release id**, so an unchanged redeploy is the same
Release and a changed one is a different Release. That is what `fli deploy:revert`
reads to tell two deploys apart.

### The machine can be this one

Every command a deploy runs goes through `core/machine.js`, which pipes the
script to `sh -s` — with an `ssh <host>` in front of it, or without. So a
`server` of `localhost` (or `local`, `127.0.0.1`, `::1`) runs the same pipeline
against this machine: same scripts, same Docker daemon, same journal. It is not
a dry run and it is not a simulation; the only thing it does not exercise is ssh.

That is what CI uses to run `fli deploy` at all. `transport: 'ssh'` in the deploy
block overrides the inference, for testing sshd on your own box.

## frontier.config.js

The `deploy` block is the single source of truth for all deploy commands:

<!-- Illustrative config, not command code — a ```js fence is compiled INTO the
     command body, and an `export default` there is a syntax error. Every other
     fence in this file is a plain one for the same reason. -->

```
export default {
  deploy: {
    server: 'myapp.com',
    user:   'deploy',          // default: 'deploy'
    path:   '/apps/myapp',
    app_id: 'myapp',           // default: last segment of path

    api: {
      port:       3000,        // default: 3000
      health:     '/health',    // must match the app: healthPlugin() serves
                                // `{apiPrefix}/health`, and Junction's default
                                // apiPrefix is '' — so this is '/health' unless
                                // the app sets one. make:deploy reads it for you.
      dockerfile: 'deploy/Dockerfile',   // the path make:deploy writes
      env:        '/apps/myapp/.env.production',

      // Validate server env against .env.example before deploying
      // Aborts with a clear list of missing keys if any are not set
      envCheck:   true,        // default: false
    },

    web: {
      domain:        'myapp.com',
      keep_releases: 3,        // default: 3
      ssl: {
        cert: '/etc/ssl/myapp.pem',
        key:  '/etc/ssl/myapp.key',
      },
    },

    db: {
      path:         '/apps/myapp/db',   // default: {path}/db
      file:         'production.db',    // default: production.db
      keep_backups: 5,                  // default: 5
    },

    // What the container does with its own stdout. Omit it and the log is
    // capped at 10m x 5 — Docker's own default caps nothing at all. Set
    // `logs: false` where the daemon is already pointed at a shipper, or name
    // a driver to hand over the whole decision.
    logs: {
      max_size:  '10m',               // default: 10m
      max_files: 5,                   // default: 5
      // driver:  'journald',         // instead of the two above
      // options: { 'loki-url': '…' },// a named driver's own options
    },

    // Per-target overrides — server/user/path only
    production: { server: 'prod.myapp.com' },
    stage:      { server: 'stg.myapp.com'  },
  },
}
```

### Splitting the API and the web onto different machines

`api` and `web` may each carry their own `server` / `user` / `path`. A side that
says nothing inherits the shared value, so the config above keeps behaving
exactly as it did — the split is opt-in per side.

```
export default {
  deploy: {
    server: 'myapp.com',            // still the default for anything unstated
    path:   '/apps/myapp',

    api: {
      server: 'api.myapp.com',      // ← the API lives on its own box
      path:   '/apps/myapp-api',
      port:   3000,
      health: '/health',
    },

    web: {
      domain: 'myapp.com',          // web stays on the shared server above
    },

    production: {
      api: { server: 'api-prod.myapp.com' },   // per target AND per side
    },
  },
}
```

Resolution, most specific first:

```
deploy[target][side]  →  deploy[side]  →  deploy[target]  →  deploy
```

Splitting is the ordinary shape once the API has its own origin, and nothing in
the transport assumes co-location: the browser client takes an absolute `url`,
and `/ws` is registered beneath the router so it never carries `apiPrefix`. What
a split *does* need is CORS — Junction's default is `origins: []`, deliberately —
and the WebSocket upgrade is an HTTP request, so it needs the same allowance.

Deploy one side at a time:

```
fli deploy              → both halves
fli deploy --api        → API only
fli deploy --web        → web only
fli deploy --api --production
```

The same `--web` / `--api` filters `deploy:rollback` has always had.

**Each machine gets its own lock, keyed by host AND path**, so two apps sharing a
server are two locks and one app split across two servers is two. A run that
cannot take the second lock releases the first rather than stranding it. Both
hosts are SSH-checked before anything moves, and **a split whose hosts are on
different commits is refused** — shipping two versions under one release name is
the failure this is most likely to cause.

## How a deploy works

```
01-preflight   → SSH check, deploy lock, Litestream detection
01b-env-check  → validate server env against .env.example (if envCheck: true)
02-pull        → git pull on server, capture commit SHA
03-build-web   → bun build on server, create versioned release
04-build-api   → docker build on server (no registry needed)
05-backup      → hot backup of the database before any changes
06-swap        → stop old container, start new (migrations run in entrypoint)
07-health      → poll deploy.api.health — rolls back to previous container on failure
08-release-web → atomic symlink swap, nginx reload
09-cleanup     → remove _replaced, prune images, release deploy lock
```

Migrations run inside the new container's entrypoint before it starts serving
traffic. If migrations fail, the container exits non-zero, the health check
fails, and the previous container is automatically restored.

## Deploy targets

```
fli deploy                    → dev (default)
fli deploy --stage            → stage (or if branch is 'stage'/'staging')
fli deploy --production       → production
```

Without a `deploy` block in `frontier.config.js`, `fli deploy` falls back to
the legacy CapRover mode using `DEV_SERVER` / `PROD_SERVER` from `.env`.

## Logs and one-off commands

```
fli deploy:logs                     → last 50 lines from the API container
fli deploy:logs --follow            → stream live (Ctrl+C to stop)
fli deploy:logs --tail 200 --production

fli deploy:run "bun run db:seed"           → run a command in the container
fli deploy:run --production "bun repl"     → interactive (tty forwarded)
```

## Testing locally

Before deploying to a server, validate the Docker image locally:

```
fli deploy:local           → build, run, health check on :3001
fli deploy:local --clean   → stop any existing test container first
```

`deploy:local` uses the same Dockerfile and runs the same entrypoint
(migrations → server start) as a real deploy. If the health check passes
locally, `fli deploy` will pass on the server.

## Rollback

```
fli deploy:rollback            → roll back both web and API
fli deploy:rollback --web      → web only (previous release symlink)
fli deploy:rollback --api      → API only (restore _replaced container)
fli deploy:rollback --production
```

Web rollback points the `current` symlink at the second-most-recent release.
API rollback restores the `_replaced` container if present, otherwise prompts
to select from available image tags.

## Litestream

If Litestream is running on the server, `fli deploy` detects it and notes it in
the preflight step. Do not stop Litestream during a deploy — it runs throughout
and checkpoints the WAL naturally when the old container stops. The deploy
pipeline is designed around this: old container stops cleanly, Litestream
checkpoints, new container starts and runs migrations, Litestream continues.

```
fli deploy:status   → shows Litestream pid and replica URL
```
