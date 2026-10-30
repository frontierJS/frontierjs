---
title: 08c-site
description: Build site/ against the production database and publish it, once its Worker has a deployment
optional: true
skip: "!($.config.doApi || $.config.siteOnly) || $.config.target !== 'production'"
---

After health, so the database the site reads is the one the new API migrated.
`optional`: a failure here leaves the API swap standing and the last site
serving. Wrangler signs in as whoever runs this (`FJS-D1687`), and a Worker
with no deployment is skipped, because the first deploy claims `siteUrl`'s
domain and is `fli site:deploy` by hand (`FJS-D1688`).

```js
const { existsSync, mkdtempSync, readdirSync, rmSync } = await import('fs')
const { join }      = await import('path')
const { tmpdir }    = await import('os')
const { spawnSync } = await import('child_process')

const site = $.paths.site
if (!site || !existsSync(join(site, 'config/vite.config.js'))) {
  if ($.config.siteOnly) {
    log.error('--site: this app has no site/ surface fli made')
    $.config.abort = true
  }
  return
}

// ─── Only a site already live ─────────────────────────────────────────────────
// Read-only, so it runs under --dry too: a dry run then shows which branch a real one takes.
const probe = spawnSync(`${$.bin('sierra', site)} site --deployed`, { cwd: site, encoding: 'utf8', shell: true })
const said  = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.replace(/\s*✗\s*/g, '').trim()
if (probe.status === 3) {
  log.info(`Site not published — ${said}. The first deploy claims the domain: fli site:deploy`)
  return
}
if (probe.status !== 0) {
  log.warn(`Site not published — ${said || `sierra exited ${probe.status}`}`)
  return
}

// The API ships `git archive HEAD`; the site builds from the working tree.
const dirty = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: site, encoding: 'utf8' }).stdout.trim()
if (dirty) log.warn('site/ has uncommitted edits, and the site build includes them')

// ─── A copy of the production database ────────────────────────────────────────
// `litestone backup` inside the serving container, as 05-backup takes its
// snapshot: a file copied from under a live WAL can be torn.
const { appId, deployConf } = $.config
const { host, path: serverPath } = $.config.api
const machine   = machineFor($, host, serverPath)
const container = apiContainer(appId, deployConf)
const stamp     = `site-build-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const destHost  = `${apiFiles(deployConf, serverPath).dbDir}/backups/${stamp}`
const local     = mkdtempSync(join(tmpdir(), 'fli-site-db-'))

try {
  log.info(`Copying the production database for the site build`)
  machine.run(`docker exec ${container} sh -c 'cd /app && bunx litestone backup ${CONTAINER_DB_DIR}/backups/${stamp} --schema db/schema.lite'`)
  machine.fetch(destHost, local)

  // `litestone backup` names each database's copy for the database; DATABASE_URL is `main`.
  const copied = join(local, stamp)
  const files  = $.flag.dry ? ['main.db'] : readdirSync(copied).filter(f => f.endsWith('.db'))
  const db     = files.includes('main.db') ? 'main.db' : files.length === 1 ? files[0] : null
  if (!db) throw new Error(`no main.db among the copied databases (${files.join(', ') || 'none'})`)

  // A shell variable wins over site:build's --env-file, so the build reads the copy.
  $.exec({ command: `${$.fli} site:build`, cwd: $.paths.root, env: { ...process.env, DATABASE_URL: join(copied, db) }, dry: $.flag.dry })
  $.exec({ command: `${$.fli} site:deploy`, cwd: $.paths.root, dry: $.flag.dry })
  log.success('Site published')
} catch (err) {
  log.error(`Site not published — the API is deployed and the last site is still serving`)
  throw err
} finally {
  rmSync(local, { recursive: true, force: true })
  // From inside, as 05-backup's note says: the copy belongs to the image's user.
  try { machine.run(`docker exec ${container} rm -rf ${CONTAINER_DB_DIR}/backups/${stamp}`) }
  catch { log.warn(`Could not remove the database copy on ${host}: ${destHost}`) }
}
```
