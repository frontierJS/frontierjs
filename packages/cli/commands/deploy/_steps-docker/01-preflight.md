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

// ─── Check SSH connectivity ───────────────────────────────────────────────────
// Every machine, not just the API's: a split deploy that can reach one host and
// not the other should fail here rather than half-way through, with the web
// released against an API that never moved.
for (const h of hosts) {
  log.info(`Checking SSH → ${h.host}`)
  try {
    context.exec({ command: `ssh -o ConnectTimeout=5 -o BatchMode=yes ${h.host} "echo ok" > /dev/null` })
  } catch {
    log.error(`Cannot reach ${h.host} — check your SSH key and server address`)
    context.config.abort = true
    return
  }
}

// ─── Acquire deploy lock ──────────────────────────────────────────────────────
// Prevents two deploys running simultaneously against the same server.
// Lock file: {serverPath}/.deploy.lock
// One lock per machine+path pair. A split app is two locks; an app whose halves
// share a host is one, which is why distinctHosts() dedupes on the pair.
const locked = []
log.info('Acquiring deploy lock...')
for (const h of hosts) {
  const lockFile = `${h.path}/.deploy.lock`
  const lockCmd  = `
    if [ -f ${lockFile} ]; then
      echo "LOCKED: $(cat ${lockFile})"
      exit 1
    fi
    echo "$$:$(date -u +%Y-%m-%dT%H:%M:%SZ):${target}" > ${lockFile}
    echo "ok"
  `.trim().replace(/\n\s*/g, '; ')

  try {
    context.exec({ command: `ssh ${h.host} "${lockCmd}"` })
    locked.push(h)
  } catch {
    log.error(`Deploy already in progress on ${h.host} — if this is stale, remove ${lockFile}`)
    // Release the ones already taken, or a failed second lock strands the first.
    for (const done of locked) {
      try { context.exec({ command: `ssh ${done.host} "rm -f ${done.path}/.deploy.lock"` }) } catch {}
    }
    context.config.abort = true
    return
  }
}

context.config.lockAcquired = true

// ─── Litestream detection ─────────────────────────────────────────────────────
// Litestream runs as a separate process outside Docker — do not stop it.
// We just need to know it's there so we can log it and remind the operator
// that continuous replication is active throughout the deploy.
const ls = litestreamStatus((cmd) => {
  try { return context.exec({ command: `ssh ${host} "${cmd}"`, stdio: 'pipe' })?.toString('utf8') ?? '' }
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
