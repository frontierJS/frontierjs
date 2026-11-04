---
title: basecamp:reinstall
description: Back Basecamp up, retire it and install it again on its box — fresh, or restored from the backup just taken — with every question asked before anything changes
effects: takes a backup of Basecamp onto this machine and checks it; then retires Basecamp from its box, its database and env file with it, and installs it again — restored from that backup with --restore
confirm: human
examples:
  - fli basecamp:reinstall --plan
  - fli basecamp:reinstall yuma --fresh
  - fli basecamp:reinstall scratch --restore --yes
args:
  -
    name: server
    description: The box Basecamp runs on (default deploy.server in packages/basecamp/frontier.config.js)
flags:
  fresh:
    type: boolean
    description: Install an empty Basecamp; the backup is kept as insurance (asked at a terminal)
  restore:
    type: boolean
    description: Put the backup just taken onto the new install (asked at a terminal; what --yes takes)
  plan:
    type: boolean
    description: Read the box, ask, print the run and stop — nothing is backed up or changed
  yes:
    type: boolean
    description: Take every default without asking; still refuses everything the backup and its check refuse
  new-key:
    type: boolean
    description: Fresh mode only — install under a new ENCRYPTION_KEY, so the old Basecamp's encrypted values and older backups do not open on the new one
  domain:
    type: string
    description: The new install's hostname (default the one the old Basecamp answers at)
    defaultValue: ''
  admin:
    type: string
    description: Fresh mode's first admin (asked at a terminal; ME from your global fli env otherwise)
    defaultValue: ''
  outpost:
    type: boolean
    description: Enroll the new install's box in its own fleet, so apps can run beside it (asked at a terminal)
    defaultValue: true
  url:
    type: string
    description: The old Basecamp's API origin, where the backup is taken (default is BASECAMP_URL, then https:// and Basecamp's hostname)
---

`fli basecamp:backup`, `fli deploy:retire --production`, `fli basecamp:install`
and, in restore mode, `fli basecamp:restore`, as one run on one box. Every
question is asked first — the mode, the install's own, where the key's copy
goes — then the run is printed and confirmed once, by typing the box's name,
and goes unattended from there. `--plan` stops after printing it.

**Before asking anything** it reads what is there: this checkout's HEAD and
what is uncommitted under `packages/basecamp/` (a deploy ships HEAD, so an
uncommitted change is not installed), the commit Basecamp's container runs,
the hostname it answers at, every machine in its fleet with its last
heartbeat, the Apps and containers on its own box, and the box's Outpost
against the `OUTPOST_VERSION` HEAD installs. The fleet is read over ssh with
`fli deploy:repl`, so no API key is needed for it; a Basecamp that does not
answer there is named and the run goes on.

**Both modes back up first** (`FJS-D1849`). **Restore** round-trips through
the archive, checked on this machine against this checkout before the box is
touched, so every restore-mode reinstall is also a restore drill; a raw copy,
taken when the API cannot back up, is refused there, since `/setup` cannot
take one. **Fresh** keeps the archive as insurance and carries the old key
onto the new install (`FJS-D1853`); with no copy of that key off the box it
refuses, unless `--new-key` says the encrypted values go.

<script>
const { spawnSync }    = await import('node:child_process')
const { ageOf }        = await import(new URL('file://' + global.fliRoot + '/core/cloud.js'))
const { apiContainer } = await import(new URL('file://' + global.fliRoot + '/core/ports.js'))

// One expression: `-e` answers undefined for an arrow function with a block body (FJS-3999).
const FLEET = `Promise.all([` +
  `sys.hubConfig.findFirst({ where: { id: 'hub' }, select: { appId: true } }), ` +
  `sys.server.findMany({ select: { id: true, name: true, ipAddress: true, outpostVersion: true, lastHeartbeatAt: true } }), ` +
  `sys.app.findMany({ select: { id: true, name: true, slug: true } }), ` +
  `sys.appServer.findMany({ select: { appId: true, serverId: true, replicaIndex: true } })` +
  `]).then(([hub, servers, apps, placements]) => ({ hubAppId: hub?.appId ?? null, servers, apps, placements }))`

/** The fleet as the old Basecamp holds it, with the box it runs on picked out
 *  the way `hostServer` picks it: the hub App's first placement. */
const fleetOf = ({ hubAppId, servers, apps, placements }) => {
  const hostId = placements.filter(p => p.appId === hubAppId).sort((a, b) => a.replicaIndex - b.replicaIndex)[0]?.serverId ?? null
  const here = new Set(placements.filter(p => p.serverId === hostId && p.appId !== hubAppId).map(p => p.appId))
  return {
    servers: servers.map(s => ({ ...s, host: s.id === hostId })),
    host:    servers.find(s => s.id === hostId) ?? null,
    apps:    apps.filter(a => a.id !== hubAppId),
    onBox:   apps.filter(a => here.has(a.id)),
  }
}

// Root reads all three: the image's tags, the env file and docker's list.
const boxScript = ({ container, envFile }) => `set -u
img=$(docker inspect -f '{{.Image}}' ${container} 2>/dev/null || true)
[ -z "$img" ] || echo "tags=$(docker image inspect -f '{{join .RepoTags " "}}' "$img" 2>/dev/null || true)"
echo "url=$(grep -E '^FRONTIER_APP_URL=' ${envFile} 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
docker ps --format 'ctr={{.Names}}|{{.Label "fjs.app"}}|{{.Label "fjs.app.slug"}}' 2>/dev/null || true
`

/** What runs on the box: the commit Basecamp's image was tagged with by
 *  `02-ship`, the hostname its env file names, and every other container. */
const readBox = async ({ files, container }) => {
  const out = await asRootOn(files.host, boxScript({ container, envFile: files.envFile }), 'read the box')
  const said = (k) => out.split('\n').filter(l => l.startsWith(`${k}=`)).map(l => l.slice(k.length + 1))
  const sha = (said('tags')[0] ?? '').split(' ').map(t => t.split(':').pop()).find(t => /^[0-9a-f]{7,40}$/.test(t)) ?? null
  const others = said('ctr').map(l => l.split('|')).filter(([name]) => name !== container && name !== `${container}_replaced`)
  return {
    running:    !!said('tags').length,
    sha,
    hostname:   (said('url')[0] ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null,
    containers: others.map(([name, app, slug]) => ({ name, app: app || null, slug: slug || null })),
  }
}

/** 3.1: everything the questions and the plan stand on, read before either. */
const readOld = async ({ server, files, container }) => {
  const root = provisionScript().root
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.trim()
  const { OUTPOST_VERSION } = await import(root + 'api/src/providers/compute/enrollment.ts')
  const lastLine = (err) => err.message.split('\n').filter(Boolean).pop()
  return {
    head:    git('rev-parse', '--short', 'HEAD'),
    dirty:   git('status', '--porcelain', '--', '.').split('\n').filter(Boolean).length,
    outpost: OUTPOST_VERSION,
    box:     await readBox({ files, container }).catch(err => ({ error: lastLine(err) })),
    fleet:   await replLine(FLEET, ['--server', server]).then(fleetOf).catch(err => ({ error: lastLine(err) })),
  }
}

/** A container on the box that is not one of the old Basecamp's Apps, named as such. */
const containerRow = (c, fleet, chalk) => {
  const app = fleet.apps?.find(a => a.id === c.app)
  if (app) return chalk`${app.name} {dim — container} ${c.name}`
  const namesake = c.slug && fleet.apps?.find(a => a.slug === c.slug)
  return namesake
    ? chalk`{yellow ${c.slug}} {dim — container ${c.name} is App ${c.app?.slice(0, 8)}; this Basecamp's ${namesake.name} is ${namesake.id.slice(0, 8)}, so it was released by an earlier one}`
    : chalk`{yellow ${c.slug ?? c.name}} {dim — container ${c.name}, not an App this Basecamp knows}`
}

const machineRow = (s, chalk) =>
  chalk`${s.name}${s.host ? chalk` {dim (this box)}` : ''} {dim ${s.lastHeartbeatAt ? `heard ${ageOf(s.lastHeartbeatAt)} ago` : 'never heard'}}`

const oldRows = ({ head, dirty, outpost, box, fleet }, chalk) => {
  const row = (label, value) => `${chalk.dim(label.padEnd(10))} ${value}`
  const boxOf = fleet.host?.outpostVersion
  return [
    row('code', chalk`${head} {dim at HEAD}${dirty ? chalk` · {yellow ${plural(dirty, 'uncommitted change')} under packages/basecamp, not installed}` : ''}`),
    row('running', box.error ? chalk`{yellow unread} {dim — ${box.error}}`
      : !box.running ? chalk.yellow('no Basecamp container on the box')
      : box.sha ? (box.sha === head ? chalk`${box.sha} {dim — HEAD}` : box.sha) : chalk.yellow('an image with no commit tag')),
    row('hostname', box.hostname ?? chalk.dim('none in the env file')),
    row('outpost', !boxOf ? chalk`{dim none on the box ·} HEAD installs ${outpost}`
      : boxOf === outpost ? chalk`${boxOf} {dim — what HEAD installs}`
      : chalk`{yellow ${boxOf}} {dim on the box ·} HEAD installs ${outpost}`),
    ...fleet.error
      ? [row('fleet', chalk`{yellow unread} {dim — ${fleet.error}}`)]
      : fleet.servers.map((s, i) => row(i ? '' : 'fleet', machineRow(s, chalk))),
    ...(box.containers ?? []).length
      ? box.containers.map((c, i) => row(i ? '' : 'beside it', containerRow(c, fleet, chalk)))
      : [row('beside it', chalk.dim('nothing — Basecamp is the only container'))],
    !fleet.error && row('Apps', fleet.apps.length
      ? chalk`${plural(fleet.apps.length, 'App')} {dim — their ids are printed after the install (FJS-D1854)}`
      : chalk.dim('none besides Basecamp')),
  ]
}

const MODES = { r: 'restore — the backup back onto the new install', f: 'fresh — an empty Basecamp, the backup kept' }

/** 3.2: the mode, from a flag, a keypress, or restore under --yes. */
const pickMode = async ({ flag, asking, tty, chalk }) => {
  if (flag.fresh) return 'fresh'
  if (flag.restore || !asking) return 'restore'
  return await tty.keys(chalk`{cyan ?} {bold Reinstall how?}`, MODES) === 'f' ? 'fresh' : 'restore'
}

const runRows = ({ mode, head, how, newKey, install, chalk }) => {
  const step = (n, name, what) => chalk`{cyan ${n}} {bold ${name.padEnd(8)}} ${what}`
  const restore = mode === 'restore'
  return [
    step(1, 'backup', chalk`an archive through the API, or the files over ssh when it cannot {dim · key copy:} ${KEY_COPIES[how]}`),
    restore && step(2, 'check', chalk`the archive against this checkout {dim — a refusal ends the run with the box untouched}`),
    step(restore ? 3 : 2, 'retire', chalk`fli deploy:retire --production {dim — container, routes, the bare Outpost uninstall,} {red database and env file}`),
    step(restore ? 4 : 3, 'install', chalk`${head} {dim under} ${newKey ? chalk.yellow('a new key') : 'the old key'}`),
    ...installRows(install, chalk, restore).map(([label, value]) => chalk`    {dim ${label.padEnd(9)}} ${value}`),
    restore && step(5, 'restore', chalk`the archive onto the new install {dim — sign in as its admin}`),
    step(restore ? 6 : 4, 'after', chalk`BASECAMP_API_KEY minted again {dim ·} the old App ids printed {dim ·} infra.launch's steps`),
  ]
}

/** One typed confirmation, the box's name; --yes is the approval at a pipe. */
const confirmed = async ({ server, yes, tty, log, chalk }) => {
  if (yes) return true
  if (!tty.interactive) { log.error('Pass --yes to reinstall without a terminal to confirm on'); return false }
  const typed = (await tty.line(chalk`{cyan ?} {bold Type ${server} to back up, retire and reinstall Basecamp there}\n  {cyan ›}`)).trim()
  if (typed === server) return true
  log.error(`"${typed}" is not ${server} — nothing was changed`)
  return false
}

/** 3.3: the backup, and in restore mode the check 2.1 runs, both before the
 *  box is touched. Answers the archive to restore, `true` for fresh, or null. */
const backUpFirst = async ({ server, mode, how, newKey, url, tty, log, echo, chalk }) => {
  const taken = await takeBackup({ server, out: backupsOf(server), url, how, tty, log, echo, chalk })
  if (!taken) { log.error('No backup, so nothing else ran — the box is as it was'); return null }
  if (mode === 'fresh') {
    if (taken.keyKept || newKey) return true
    log.error(`No copy of ${server}'s ENCRYPTION_KEY is off the box, so a fresh install could not carry it — the box is as it was. Pass --new-key if its encrypted values may go`)
    return null
  }
  if (taken.kind !== 'archive') {
    log.error(`The API could not take an archive, and /setup cannot take a raw copy — the box is as it was. --fresh installs an empty Basecamp and keeps ${taken.dir}`)
    return null
  }
  try {
    const picked = pickArchive({ from: taken.dir, server })
    return await checkHere({ picked, keyFile: keyFor(server, picked.manifest), log, echo, chalk }) ? picked : null
  } catch (err) { log.error(`${err.message} — the box is as it was`); return null }
}
</script>

```js
const server = String(arg.server ?? '').trim() || await deployServer()
if (!server) { log.error('Pass the box: fli basecamp:reinstall <server>, or set deploy.server in packages/basecamp/frontier.config.js'); process.exitCode = 1; return }
if (flag.fresh && flag.restore) { log.error('Pass one of --fresh and --restore'); process.exitCode = 1; return }

const files = await deployFiles(server)
const { default: conf } = await import(provisionScript().root + 'frontier.config.js')
const container = apiContainer(conf.deploy.app_id, conf.deploy)
const asking = tty.interactive && !flag.yes

echo(chalk`\n  {bold fli basecamp:reinstall}  {dim Basecamp on} ${files.host}\n`)
const old = await readOld({ server, files, container })
echo.lines([...oldRows(old, chalk), ''], { indent: 2 })

const mode = await pickMode({ flag, asking, tty, chalk })
if (mode === 'restore' && flag['new-key']) { log.error('--new-key is fresh mode only: a restored archive opens under the key it was taken with. Pass --fresh'); process.exitCode = 1; return }
const install = await askInstall({ flag: { ...flag, domain: flag.domain || old.box.hostname || '' }, restore: mode === 'restore', asking, tty, log, echo, chalk })
if (install.refusal) {
  log.error(`${install.refusal}. Nothing was changed`)
  if (install.rejected) await tokenHint({ echo, chalk })
  process.exitCode = 1
  return
}
const how = asking ? await howToKeep(tty, chalk) : 'f'

echo(chalk`\n  {bold The run} {dim — ${mode}, on} ${files.host}`)
echo.lines([...runRows({ mode, head: old.head, how, newKey: flag['new-key'], install, chalk }), ''], { indent: 4 })
if (flag.plan) return
if (!await confirmed({ server, yes: flag.yes, tty, log, chalk })) { process.exitCode = 1; return }

const archive = await backUpFirst({ server, mode, how, newKey: flag['new-key'], url: flag.url, tty, log, echo, chalk })
if (!archive) { process.exitCode = 1; return }

log.warn(`Retire, install and restore are not wired in yet (IDEAS/basecamp-reinstall.md 3.4–3.7) — the box is as it was, and the backup is in ${backupsOf(server)}`)
process.exitCode = 1
```
