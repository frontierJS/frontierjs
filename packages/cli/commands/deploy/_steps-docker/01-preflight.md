---
title: 01-preflight
description: Validate config, check SSH, acquire deploy lock
---

```js
const { server, serverPath, target, hosts } = $.config
const host = $.config.api?.host ?? $.config.web.host

// ─── Validate required config ─────────────────────────────────────────────────
const deployConf = $.config.deployConf
const appId      = appIdOf(deployConf)
const apiPort    = deployConf.api?.port ?? 3000
const healthPath = deployConf.api?.health ?? '/health'

// Refused before the build rather than at the swap, minutes later.
try { swapSetting(deployConf); checkHealthTimeout(deployConf.healthTimeout) }
catch (e) {
  log.error(e.message)
  $.config.abort = true
  return
}

// A web side with nothing to build failed at 08-release-web, after the API was
// already swapped (FJS-4003). 03-build-web runs `build:web` where the app names
// one, else the build in web/.
if ($.config.doWeb) {
  const { existsSync, readFileSync } = await import('fs')
  const scripts = JSON.parse(readFileSync(`${$.paths.root}/package.json`, 'utf8')).scripts ?? {}
  if (!scripts['build:web'] && !existsSync(`${$.paths.root}/web`)) {
    log.error('This app has no web/ to deploy. Set deploy.web = false in frontier.config.js, or pass --api.')
    $.config.abort = true
    return
  }
}

// widgets/ is built by sierra's own command from its own directory, so the
// directory is what a widgets side needs (the same check as web/ above).
if ($.config.doWidgets) {
  const { existsSync } = await import('fs')
  if (!existsSync(`${$.paths.root}/widgets`)) {
    log.error('deploy.widgets is set and this app has no widgets/ to deploy. Set deploy.widgets = false in frontier.config.js, or remove the key.')
    $.config.abort = true
    return
  }
  // Built and released with no domain, a widget origin answers nobody, and a
  // guessed hostname would write DNS (FJS-D2033).
  if (!deployConf.widgets?.domain) {
    log.error('deploy.widgets names no domain. Set deploy.widgets.domain in frontier.config.js, or set deploy.widgets = false.')
    $.config.abort = true
    return
  }
}

$.config.host       = host
$.config.appId      = appId
$.config.apiPort    = apiPort
$.config.healthPath = healthPath
$.config.commit     = $.git.branch() || 'unknown'

// ─── Basecamp ships a commit that was pushed and passed CI ────────────────────
// Yuma runs Basecamp, and every other app's release goes through it, so a bad
// commit here takes the rest down with it (FJS-4118, FJS-D2040). Asked in the
// deploy and not in a hook: another session can land a commit between a check
// and the deploy. Read under --dry too.
{
  const { isBasecampApp, checkDeployGate } = await import(new URL('file://' + global.fliRoot + '/core/deploy-gate.js'))
  if (isBasecampApp($.paths.root)) {
    const gate = checkDeployGate($.paths.root, { unverified: $.flag.unverified })
    for (const [level, line] of gate.lines) log[level](line)
    if (!gate.ok) {
      $.config.abort = true
      return
    }
  }
}

// ─── Check the machines are reachable ─────────────────────────────────────────
// Every machine, not just the API's: a split deploy that can reach one host and
// not the other should fail here rather than half-way through, with the web
// released against an API that never moved.
//
// `reach()` is a no-op on a local machine, which is correct rather than lenient
// — there is nothing to log in to.
const machines = new Map(hosts.map(h => [h.host, machineFor($, h.host, h.path)]))

for (const h of hosts) {
  const m = machines.get(h.host)
  log.info(`Checking ${m.kind === 'local' ? 'the local machine' : `SSH → ${h.host}`}`)
  if (!m.reach()) {
    log.error(`Cannot reach ${h.host} — check your SSH key and server address`)
    $.config.abort = true
    return
  }
}

// ─── One door per app on a box ────────────────────────────────────────────────
// A Basecamp App serving this app's hostname keeps its own database and
// ENCRYPTION_KEY, so a release here would run beside it serving neither, and
// 07b-edge leaves routes it does not hold alone (`FJS-D1967`). A box with no
// Caddy holds no route of either door. Read under --dry too, which is where an
// operator asks whether the run would be refused.
{
  const { edgeNames, readConfigScript, parseConfigRead, heldBy, doorRefusal, EdgeError } =
    await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
  let names = []
  try {
    const edge = edgeNames(deployConf)
    names = [edge.web.domain, edge.api.domain, edge.widgets.domain].filter(Boolean)
  } catch (e) {
    if (!(e instanceof EdgeError)) throw e
    // 03-build-web refuses the same names after the ship and the install.
    if ($.config.doWeb || $.config.doWidgets) {
      log.error(e.message)
      $.config.abort = true
      return
    }
  }
  for (const m of names.length ? machines.values() : []) {
    let config
    try { config = parseConfigRead(m.capture(readConfigScript(), { dry: false })).config }
    catch (e) { if (e instanceof EdgeError) continue; throw e }
    const theirs = heldBy(config, 'basecamp', names)
    if (theirs.length) {
      log.error(doorRefusal('ssh', theirs))
      $.config.abort = true
      return
    }
  }
}

// ─── The release's migrations against the box's journal ───────────────────────
// A file edited after it was applied builds into an image and then keeps the
// new container from booting, five minutes later. The running container's own
// journal answers it now. Nothing to compare on a first deploy or with no API.
if ($.config.doApi) {
  const { checkJournal } = await import(new URL('file://' + global.fliRoot + '/core/migration-journal.js'))
  const verdict = checkJournal({
    machine:        machines.get(host) ?? machineFor($, host),
    container:      apiContainer(appId, deployConf),
    migrationsRoot: `${$.paths.root}/db/migrations`,
  })
  if (!verdict.ok) {
    for (const line of verdict.message.split('\n')) log.error(line)
    $.config.abort = true
    return
  }
}

// ─── The migrations against the schema ────────────────────────────────────────
// The journal above compares files with the box. This asks whether the files
// build db/schema.lite at all, the rule basecamp:deploy asks, so a `db:push`
// change in no migration is refused here and not by the image's db:migrate
// after the build and the upload (FJS-4102).
if ($.config.doApi) {
  const { migrationHistoryVerdict } = await import(new URL('file://' + global.fliRoot + '/core/release-preflight.js'))
  const history = migrationHistoryVerdict($.paths.root)
  for (const line of history.warnings) log.warn(`Migration history not checked: ${line}`)
  if (history.errors.length) {
    log.error('db/migrations does not build db/schema.lite — the container would refuse to start:')
    for (const line of history.errors) log.error(`  ${line}`)
    log.error("Run 'fli db:migrate' to write the missing migration.")
    $.config.abort = true
    return
  }
}

// ─── Acquire deploy lock ──────────────────────────────────────────────────────
// Prevents two deploys running simultaneously against the same server.
// One lock per machine+path pair. A split app is two locks; an app whose halves
// share a host is one, which is why distinctHosts() dedupes on the pair.
log.info('Acquiring deploy lock...')
let lock = await acquireLock($, { hosts, target, takeover: $.flag.resume })

// A box never set up is offered `deploy:setup` rather than only told about it.
// It runs as its own command so the env file is written there and nowhere in
// this pipeline (FJS-D1186); without a terminal, or under --dry, the refusal
// below stands.
if (!lock.ok && lock.missing && tty.interactive && !$.flag.dry) {
  const answer = (await tty.line(`${lock.missing} does not exist on ${lock.host}. Set the server up now? (y/N)`)).trim()
  if (/^y(es)?$/i.test(answer)) {
    const targetFlag = target === 'dev' ? [] : [`--${target}`]
    const installFlag = $.flag['auto-install'] ? ['--auto-install'] : []
    try {
      $.exec({ command: [$.fli, 'deploy:setup', '--server', JSON.stringify(lock.host), ...targetFlag, ...installFlag].join(' '), stdio: 'inherit' })
    } catch {
      log.error('deploy:setup did not finish — nothing was deployed')
      $.config.abort = true
      return
    }
    lock = await acquireLock($, { hosts, target, takeover: $.flag.resume })
  }
}

if (!lock.ok) {
  for (const [level, line] of await lockRefusal(lock)) log[level](line)
  $.config.abort = true
  return
}
if ($.config.lockTookOver)
  log.warn(`  --resume took the lock over — it held: ${$.config.lockTookOver}`)

$.config.lockAcquired = true

// ─── Litestream detection ─────────────────────────────────────────────────────
// Litestream runs as a separate process outside Docker — do not stop it.
// We just need to know it's there so we can log it and remind the operator
// that continuous replication is active throughout the deploy.
const apiMachine = machines.get(host) ?? machineFor($, host)
const ls = litestreamStatus((script) => {
  try { return apiMachine.capture(script) }
  catch { return '' }
})

if (!ls.running) {
  log.info('Litestream: not running')
} else if (ls.supported === false) {
  // A warning rather than an abort: blocking a deploy on the replication tool
  // would be worse than the state it describes, and an operator mid-incident
  // needs the deploy. But it cannot be quiet — the whole defect was a check
  // that called this healthy.
  log.warn(`Litestream: ${ls.version} is TOO OLD — ${LITESTREAM_MIN_LABEL} or newer is required`)
  log.warn('  It is running and replicating NOTHING: 0.3.x cannot parse the STRICT tables')
  log.warn('  litestone emits, so it loops on a sync error without exiting.')
  log.warn('  Treat this server as having NO replication until it is upgraded.')
} else if (ls.supported === null) {
  log.warn(`Litestream: running (pid ${ls.pid}), version unreadable — cannot confirm it is ${LITESTREAM_MIN_LABEL}+`)
} else {
  log.info(`Litestream: running — ${ls.version}, continuous WAL replication active`)
  log.info('  DB will be replicated throughout the deploy. Do not stop Litestream.')
}

$.config.litestreamRunning = ls.running === true && ls.supported !== false

// Basecamp's own box replicates this database through its Outpost once the
// hub names a replica destination (IDEAS/backups.md 2.4). A second Litestream
// on the same WAL — the operator's `litestone replicate` — fights it for the
// checkpoint, and each replica then misses what the other one took. A warning,
// for the same reason as the version check above.
if (ls.running) {
  const { dbDir } = apiFiles(deployConf, serverPath)
  let both = ''
  try {
    both = String(apiMachine.capture([
      `n=$(pgrep -x litestream | wc -l)`,
      `[ "$n" -ge 2 ] && sudo -n grep -qF -- '${dbDir.replace(/'/g, `'\\''`)}' /etc/outpost/litestream.yml 2>/dev/null && echo both || true`,
    ].join('\n')) ?? '').trim()
  } catch {}
  if (both === 'both') {
    log.warn(`Litestream: TWO processes replicate ${dbDir} — the Outpost's and another`)
    log.warn('  Basecamp replicates its own database once /hub/settings/ names a continuous replica;')
    log.warn('  stop the operator-run one (litestone replicate) or clear that setting.')
  }
}

log.success(`Preflight passed → ${appId} (${target})`)
```
