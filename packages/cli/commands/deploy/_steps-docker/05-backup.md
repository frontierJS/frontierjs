---
title: 05-backup
description: Hot backup of every declared database, taken inside the running container
optional: true
skip: "!context.config.doApi || context.config.deployConf.db?.backup === false"
---

```js
if (context.config.abort) return

const { appId, deployConf } = context.config
const { host, path: serverPath } = context.config.api
const dbPath    = deployConf.db?.path    ?? `${serverPath}/db`
const backupDir = deployConf.db?.backups ?? `${dbPath}/backups`
const container = `${appId}-api`

// ─── The app backs itself up ──────────────────────────────────────────────────
// This used to shell out to `sqlite3 … '.backup'` on the host, which was wrong
// twice. It needed a binary the application does not need — and `deploy:setup`
// never installed it, so on a server this tool provisioned the snapshot silently
// never happened. And it named ONE file, while a schema declares as many
// databases as it likes: `main` plus an `audit` logger is the shape both apps in
// this repo use, so the trail nobody may lose was the part not being copied.
//
// `litestone backup` already answers both. It reads the schema, hot-copies every
// SQLite database through $backup (safe under active writes) and cp's the
// JSONL/logger directories beside them. The running container has litestone and
// the schema already, so the backup is taken where the answer lives.
//
// Runs BEFORE 06-swap, so the container it runs in is the OLD one — which is the
// point: this is the state to return to, taken while it is still serving.
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const destHost  = `${backupDir}/pre-deploy-${timestamp}`
// The container mounts dbPath at /db, so writing there lands on the host.
const destInner = `/db/backups/pre-deploy-${timestamp}`

// ─── First deploy has nothing to back up ─────────────────────────────────────
const machine = machineFor(context, host)

let running = false
try {
  machine.run(`docker inspect ${container} > /dev/null 2>&1`)
  running = true
} catch {
  running = false
}

if (!running) {
  log.info(`No ${container} container yet — nothing to back up (first deploy)`)
  return
}

machine.run(`mkdir -p ${backupDir}`)

log.info(`Backing up every declared database → ${destHost}`)
try {
  // --schema also fixes the migrations dir (litestone resolves it as a sibling),
  // and without it the lookup falls back to ./schema.lite in the WORKDIR, which
  // is not where the canonical layout puts it.
  machine.run(`docker exec ${container} sh -c 'cd /app && bunx litestone backup ${destInner} --schema db/schema.lite'`)
} catch (err) {
  // The step is `optional`, so the deploy continues into 06-swap and the new
  // container's entrypoint migrations. Say what was lost — a one-line warning
  // reads as though the snapshot exists.
  log.error(`Backup FAILED — the deploy will continue and run migrations with NO pre-deploy snapshot`)
  log.info(`  the container must carry db/schema.lite for litestone to resolve databases (FJS-232)`)
  const byHand = `docker exec ${container} sh -c 'cd /app && bunx litestone backup --help'`
  log.info(`  check by hand:  ${machine.local ? byHand : `ssh ${host} "${byHand}"`}`)
  throw err
}

// ─── Prune old backups ────────────────────────────────────────────────────────
// Each backup is now a DIRECTORY (one entry per declared database), not a single
// file — so this prunes with -d and rm -rf. Litestream handles long-term
// retention; these exist only for the window where a migration goes wrong.
const keepBackups = deployConf.db?.keep_backups ?? 5
machine.run(`ls -1dt ${backupDir}/pre-deploy-* 2>/dev/null |
  tail -n +${keepBackups + 1} |
  xargs rm -rf --`)

context.config.backupDir = destHost
log.success(`Backup complete → ${destHost}`)
if (context.config.litestreamRunning) {
  log.info('  Litestream is also replicating continuously to your remote replica')
}
```
