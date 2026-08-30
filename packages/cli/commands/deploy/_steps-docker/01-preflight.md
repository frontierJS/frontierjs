---
title: 01-preflight
description: Validate config, check SSH, acquire deploy lock
---

```js
if (context.config.abort) return

const { server, serverPath, target, hosts } = context.config
const host = context.config.api?.host ?? context.config.web.host

// ─── Validate required config ─────────────────────────────────────────────────
const deployConf = context.config.deployConf
const appId      = deployConf.app_id ?? deployConf.path.split('/').pop()
const apiPort    = deployConf.api?.port ?? 3000
const healthPath = deployConf.api?.health ?? '/health'

context.config.host       = host
context.config.appId      = appId
context.config.apiPort    = apiPort
context.config.healthPath = healthPath
context.config.commit     = context.git.branch() || 'unknown'

// ─── Check the machines are reachable ─────────────────────────────────────────
// Every machine, not just the API's: a split deploy that can reach one host and
// not the other should fail here rather than half-way through, with the web
// released against an API that never moved.
//
// `reach()` is a no-op on a local machine, which is correct rather than lenient
// — there is nothing to log in to.
const machines = new Map(hosts.map(h => [h.host, machineFor(context, h.host, h.path)]))

for (const h of hosts) {
  const m = machines.get(h.host)
  log.info(`Checking ${m.kind === 'local' ? 'the local machine' : `SSH → ${h.host}`}`)
  if (!m.reach()) {
    log.error(`Cannot reach ${h.host} — check your SSH key and server address`)
    context.config.abort = true
    return
  }
}

// ─── Acquire deploy lock ──────────────────────────────────────────────────────
// Prevents two deploys running simultaneously against the same server.
// One lock per machine+path pair. A split app is two locks; an app whose halves
// share a host is one, which is why distinctHosts() dedupes on the pair.
log.info('Acquiring deploy lock...')
const lock = await acquireLock(context, { hosts, target, takeover: context.flag.resume })
if (!lock.ok) {
  for (const [level, line] of await lockRefusal(lock)) log[level](line)
  context.config.abort = true
  return
}
if (context.config.lockTookOver)
  log.warn(`  --resume took the lock over — it held: ${context.config.lockTookOver}`)

context.config.lockAcquired = true

// ─── Litestream detection ─────────────────────────────────────────────────────
// Litestream runs as a separate process outside Docker — do not stop it.
// We just need to know it's there so we can log it and remind the operator
// that continuous replication is active throughout the deploy.
const apiMachine = machines.get(host) ?? machineFor(context, host)
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

context.config.litestreamRunning = ls.running === true && ls.supported !== false

log.success(`Preflight passed → ${appId} (${target})`)
```
