---
title: 01-preflight
description: Reach each machine, take the deploy lock, say what will go, and have a person type the app's id
---

```js
const { join } = await import('node:path')
const { homedir } = await import('node:os')
const { existsSync, readdirSync, statSync } = await import('node:fs')
const { localBackups, backupsOf } = await import(new URL('file://' + global.fliRoot + '/core/basecamp.js'))
const { ageOf } = await import(new URL('file://' + global.fliRoot + '/core/cloud.js'))

const { appId, target, sides, dbDir, envFile, deployConf } = $.config
const container = apiContainer(appId, deployConf)
const keep      = $.flag['keep-data']

for (const s of sides) {
  if (!machineFor($, s.host, s.path).reach()) {
    log.error(`Cannot reach ${s.host} — check your SSH key and server address`)
    $.config.abort = true
    return
  }
}

// The SAME lock a deploy takes: a deploy landing halfway through a retire
// would start a container into a root this run is deleting.
const lock = await acquireLock($, { hosts: sides, target })
if (!lock.ok) {
  for (const [level, line] of await lockRefusal(lock, { verb: 'retire' })) log[level](line)
  $.config.abort = true
  return
}
$.config.lockAcquired = true

const apiMachine = machineFor($, $.config.api.host, $.config.api.path)
const running    = apiMachine.capture(`docker ps -a --format '{{.Names}}' 2>/dev/null | grep -x -e ${container} -e ${container}_replaced || true`).trim()
const images     = apiMachine.capture(`docker images -q ${appId} 2>/dev/null | sort -u | wc -l`).trim()
const outpost    = $.flag.outpost && deployConf.outpost === true &&
  apiMachine.capture('[ -x /usr/local/sbin/outpost-uninstall ] && echo yes || echo no').trim() === 'yes'
$.config.outpostPresent = outpost

// The uninstall takes the box's firewall with it while the apps the Outpost
// placed keep running, so a port one publishes on every interface without
// Outpost's fjs.exposed-port label is dropped from outside now and answers
// once this run ends.
const opened = !outpost ? [] : apiMachine
  .capture(`docker ps --format '{{.Names}}|{{.Label "fjs.exposed-port"}}|{{.Ports}}' 2>/dev/null || true`)
  .split('\n').filter(Boolean).map(l => l.split('|'))
  .filter(([name, declared]) => !declared && name !== container && name !== `${container}_replaced`)
  .map(([name, , ports = '']) => [name, [...new Set([...ports.matchAll(/(?:0\.0\.0\.0|\[::\]|::):(\d+)->/g)].map(m => m[1]))]])
  .filter(([, ports]) => ports.length)

// The deploy's own pre-deploy snapshots live under the db directory by
// default, so the copies an operator might count on go with it.
const snapDir   = deployConf.db?.backups ?? `${dbDir}/backups`
const snapsGo   = snapDir.startsWith(`${dbDir}/`) ? !keep : snapDir.startsWith(`${$.config.api.path}/`)
const snapshots = !snapsGo ? 0 : Number(apiMachine.capture(`ls -1d ${snapDir}/pre-deploy-* 2>/dev/null | wc -l`).trim()) || 0

const loud = (s) => chalk.bold(target === 'production' ? chalk.red(s) : chalk.yellow(s))
echo('')
if (keep) {
  echo(loud(`  ⚠  This shuts ${appId} down on ${target}.`) + chalk.dim(' Its database and env file stay (--keep-data).'))
} else {
  echo(loud(`  ⚠  This shuts ${appId} down on ${target} and deletes its database. There is no undo.`))
  echo(loud(`     Make sure you know what you're doing.`))
}

echo('')
const goes = (what, value) => echo(`    ${chalk.dim(what.padEnd(12))}${value}`)
echo(chalk`  {bold ${appId}} {dim on ${target} — what goes:}`)
goes('routes', `fli-${appId} in Caddy on ${[...new Set(sides.map(s => s.host))].join(', ')}`)
if (outpost) {
  goes('outpost', `outpost-uninstall on ${$.config.api.host} ${chalk.dim('(Docker and Caddy stay)')}`)
  goes('firewall', `${$.config.api.host}'s, with the Outpost — ${chalk.yellow('inbound on any listening port is no longer dropped')}`)
  for (const [name, ports] of opened) goes('', chalk.yellow(`${name} then answers from outside on ${ports.join(', ')}`))
}
goes('containers', running ? running.split('\n').join(', ') : chalk.dim('none running'))
goes('images', `${images} of ${appId}`)
for (const s of sides) goes('files', `${s.host}:${s.path}${keep ? chalk.dim(' (db and env file kept)') : ''}`)
if (!keep) {
  goes('database', dbDir)
  goes('env file', envFile)
}
if (snapshots) goes('snapshots', chalk.yellow(`${snapshots} pre-deploy, in ${snapDir} — not a backup once this runs`))
echo('')
if (!keep) sayLastBackup()

// A replica somebody started against this database outlives the files it
// reads, and stopping it is theirs to decide.
const replica = apiMachine.capture(`pgrep -af litestream 2>/dev/null | grep -F ${$.config.api.path} || true`).trim()
if (replica) log.warn(`Litestream is replicating from ${$.config.api.path} — it is left running: ${replica.split('\n')[0]}`)

// `confirm: human` has already refused a run with no person behind it; a
// person at a terminal types the id, because the wrong app shares a prompt.
if (!$.flag.approved) {
  const typed = (await tty.line(loud(`Type ${appId} to retire it from ${target}: `))).trim()
  if (typed !== appId) {
    log.info('Nothing removed')
    $.config.abort = true
    return
  }
}

/** The newest copy of this app's data on THIS machine — the one that survives
 *  the retire. Basecamp files its own by box; an App's lands in db/backups/,
 *  beside any local backup, so that line names a place rather than vouching. */
function sayLastBackup() {
  const basecamp = appId === 'basecamp'
  const take     = basecamp ? 'fli basecamp:backup' : 'fli db:download'
  const newest   = basecamp ? newestBasecampCopy() : newestAppCopy()
  const tilde    = (path) => path.replace(homedir(), '~')
  if (!newest) {
    echo(chalk`  {red.bold No backup of ${appId} found on this machine.} {dim Take one first:} ${take}`)
  } else {
    const age   = ageOf(newest.at)
    const fresh = Date.now() - Date.parse(newest.at) < 60 * 60_000
    const when  = `${new Date(newest.at).toLocaleString()} (${age} ago)`
    echo(`  ${chalk.dim('last backup'.padEnd(14))}${fresh ? chalk.green(when) : chalk.yellow(when)}  ${chalk.dim(tilde(newest.dir))}`)
    if (!fresh) echo(chalk`  {yellow It is ${age} old — did you take one just now?} {dim Take one first:} ${take}`)
  }
  echo('')
}

function newestBasecampCopy() {
  const b = localBackups(backupsOf($.config.api.host)).filter(b => b.kind !== 'unreadable' && b.takenAt).at(-1)
  return b && { at: b.takenAt, dir: b.dir }
}

function newestAppCopy() {
  const dir = $.paths?.db && join($.paths.db, 'backups')
  if (!dir || !existsSync(dir)) return null
  const entries = readdirSync(dir).map(name => ({ dir: join(dir, name), at: statSync(join(dir, name)).mtime.toISOString() }))
  return entries.sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null
}
```
