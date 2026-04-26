---
title: 05-backup
description: Hot backup of the database before the container swap
optional: true
skip: "context.config.deployConf.db?.backup === false"
---

```js
if (context.config.abort) return

const { host, serverPath, deployConf } = context.config
const dbPath     = deployConf.db?.path    ?? `${serverPath}/db`
const dbFile     = deployConf.db?.file    ?? 'production.db'
const backupDir  = deployConf.db?.backups ?? `${dbPath}/backups`

// ─── Create backup dir ────────────────────────────────────────────────────────
context.exec({ command: `ssh ${host} "mkdir -p ${backupDir}"` })

// ─── Hot backup via sqlite3 .backup ──────────────────────────────────────────
// .backup is SQLite's online backup API — safe to call while the DB is open.
// Litestream continues replicating throughout. This gives us a local snapshot
// as a safety net before migrations run in the new container.
const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupFile = `${backupDir}/pre-deploy-${timestamp}.db`

log.info(`Backing up ${dbFile} → ${backupFile}`)
context.exec({
  command: `ssh ${host} "sqlite3 ${dbPath}/${dbFile} '.backup ${backupFile}'"`,
})

// ─── Prune old backups ────────────────────────────────────────────────────────
// Keep the last 5 pre-deploy backups — they're only needed if a migration
// goes wrong. Litestream handles long-term retention.
const keepBackups = deployConf.db?.keep_backups ?? 5
const pruneCmd = `
  ls -1t ${backupDir}/pre-deploy-*.db 2>/dev/null |
  tail -n +${keepBackups + 1} |
  xargs rm -f --
`.trim().replace(/\n\s*/g, ' ')
context.exec({ command: `ssh ${host} "${pruneCmd}"` })

context.config.backupFile = backupFile
log.success(`Backup complete → ${backupFile}`)
if (context.config.litestreamRunning) {
  log.info('  Litestream is also replicating continuously to your remote replica')
}
```
