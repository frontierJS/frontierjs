---
title: outpost:status
description: One screen of what a fleet box runs, read over ssh from its own Outpost; with no box, a line per box in the fleet
examples:
  - fli outpost:status box1
  - fli outpost:status root@203.0.113.7
  - fli outpost:status box1 --json
  - fli outpost:status
args:
  -
    name: server
    description: "The box: an alias from ~/.ssh/config, or user@host. Omitted, every box in BASECAMP_URL's fleet"
flags:
  json:
    type: boolean
    description: Print the Outpost's reading as it came off the box
    defaultValue: false
---

<script>
const APP_ROUTE = /^fjs-(.+?)(?:-redirects|-path-\d+)?$/
const OUTPOST   = '@frontierjs/outpost'

const pct   = (n) => n == null ? '–' : `${Math.round(n)}%`
const bytes = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round((n ?? 0) / 1e3)} kB`
const ago   = (at) => {
  const s = Math.round((Date.now() - Date.parse(at)) / 1000)
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}
const dot   = (good, chalk) => good === true ? chalk.green('●') : good === false ? chalk.red('●') : chalk.yellow('●')
const short = (unit) => unit.replace(/\.service$/, '')

/** The key's Basecamp, or null: without one the screen is the box's alone. */
const hub = () => process.env.BASECAMP_API_KEY && process.env.BASECAMP_URL
  ? { origin: process.env.BASECAMP_URL.replace(/\/+$/, ''), key: process.env.BASECAMP_API_KEY }
  : null

/** `0.1.9 (npm has 0.1.11)`, the hint only when npm answered and is ahead. */
function versionOf(version, latest, chalk) {
  if (!version) return 'unknown'
  const parts  = (v) => String(v).split(/[.-]/).map(Number)
  const behind = latest && parts(latest).some((n, i, l) => n !== parts(version)[i] && l.slice(0, i).every((m, j) => m === parts(version)[j]) && n > parts(version)[i])
  return behind ? chalk`${version} {yellow (npm has ${latest})}` : version
}

/** The Server row's side: when Basecamp last heard this box. A box that reads
 *  well here and that Basecamp has not heard from is a box no release reaches. */
async function heardOf(serverId, boxHub, basecamp) {
  const h = hub()
  if (!h || !serverId) return null
  if (boxHub && boxHub.replace(/\/+$/, '') !== h.origin) return { other: boxHub }
  try { return { row: await basecamp(h.origin, h.key, `/servers/${encodeURIComponent(serverId)}`) } }
  catch (err) { return { error: err.message } }
}

function heardLine(heard, chalk) {
  if (heard.other) return chalk`{dim BASECAMP_URL is not this box's Basecamp (${heard.other})}`
  if (heard.error) return chalk`{yellow ${heard.error}}`
  const { status, lastHeartbeatAt } = heard.row
  const stale = !lastHeartbeatAt || Date.now() - Date.parse(lastHeartbeatAt) > 120_000
  return chalk`${dot(status === 'online' && !stale, chalk)} ${status} {dim ·} ${lastHeartbeatAt ? `heard ${ago(lastHeartbeatAt)}` : 'never heard'}`
}

/** Every App the box knows of, by id: a container, a route, a replica or an
 *  archive. A static app has a route and no container. */
function appsOf(s) {
  const apps = new Map()
  const app  = (id) => apps.get(id) ?? apps.set(id, { id, containers: [], hosts: [], replica: null, traffic: null, backup: null }).get(id)
  for (const c of Array.isArray(s.containers) ? s.containers : []) if (c.app_id) app(c.app_id).containers.push(c)
  for (const r of s.routes?.routes ?? []) {
    const id = APP_ROUTE.exec(r.id ?? '')?.[1]
    if (id) app(id).hosts.push(...r.hosts, ...r.paths.map(p => `${p.host}${p.prefix}`))
  }
  for (const r of s.replication?.apps ?? []) app(r.app_id).replica = r
  for (const t of Array.isArray(s.traffic) ? s.traffic : []) app(t.app_id).traffic = t
  for (const b of Array.isArray(s.backups) ? s.backups : []) app(b.app_id).backup = b
  return [...apps.values()]
}

function unitLines(units, chalk) {
  if (!Array.isArray(units)) return [chalk`{yellow ●}  {dim systemctl did not answer${units?.error ? `: ${units.error}` : ''}}`]
  return units.map(u => u.load === 'not-found'
    ? chalk`{dim ○  ${short(u.unit).padEnd(20)} not installed}`
    : chalk`${dot(u.active === 'active', chalk)}  ${short(u.unit).padEnd(20)} ${u.active} {dim (${u.sub})${u.since ? ` since ${u.since}` : ''}}`)
}

function machineLine(v, chalk) {
  if (!v || v.error) return chalk`{dim unread${v?.error ? `: ${v.error}` : ''}}`
  return chalk`cpu ${pct(v.cpu)} {dim ·} memory ${pct(v.memory)} {dim ·} disk ${pct(v.disk)} {dim ·} load ${v.load ?? '–'}`
}

function softwareLine(r, chalk) {
  const os = r?.os ? `${r.os.id} ${r.os.version}` : 'os unknown'
  const v  = r?.versions ?? {}
  return chalk`${os} {dim ·} kernel ${r?.kernel?.running ?? '–'} {dim ·} docker ${v.docker ?? '–'} {dim ·} caddy ${v.caddy ?? '–'} {dim ·} bun ${v.bun ?? '–'}`
}

/** The posture facts a person acts on at a shell. Basecamp's posture tab
 *  grades the rest. */
function defenseParts(r, chalk) {
  if (!r) return [chalk.dim('posture unread')]
  const parts = []
  const fw = r.firewall?.input_policy
  parts.push(fw === 'drop' ? 'firewall drop' : fw ? chalk.red(`firewall ${fw}`) : chalk.yellow('firewall unknown'))
  const pw = r.ssh?.password_authentication
  parts.push(pw === 'no' ? 'ssh passwords off' : pw ? chalk.red(`ssh passwords ${pw}`) : chalk.yellow('ssh unknown'))
  parts.push(r.time?.synced ? 'clock synced' : chalk.yellow('clock not synced'))
  if (r.cert?.expires_at) parts.push(`cert until ${r.cert.expires_at.slice(0, 10)}`)
  if (r.updates) parts.push(r.updates.pending ? chalk.yellow(`${r.updates.pending} updates (${r.updates.security} security)`) : 'up to date')
  if (r.auto_updates && !r.auto_updates.enabled) parts.push(chalk.yellow('auto-updates off'))
  if (r.reboot?.required) parts.push(chalk.yellow('reboot required'))
  return parts
}

function appLines(a, chalk) {
  const live  = a.containers.find(c => !c.name?.endsWith('_replaced'))
  const name  = (live ?? a.containers[0])?.name?.replace(/^fjs--/, '') ?? a.id
  const state = live ? live.state : a.containers.length ? 'set aside only' : 'static'
  const good  = live ? live.state === 'running' : a.containers.length ? false : true
  const rep   = a.replica
    ? (a.replica.last_sync_at ? `${a.replica.status}, synced ${ago(a.replica.last_sync_at)}` : `${a.replica.status}, never synced`)
    : 'not replicated'
  const facts = [
    rep,
    a.traffic && `${a.traffic.requests.toLocaleString('en-US')}${a.traffic.truncated ? '+' : ''} req/24h`,
    a.backup ? `backup ${ago(a.backup.at)}` : 'no backup here',
  ].filter(Boolean).join(chalk.dim(' · '))
  return [
    chalk`${dot(good, chalk)}  {bold ${name}} {dim ·} ${state}${live?.status ? chalk` {dim ${live.status}}` : ''}${name === a.id ? '' : chalk`  {dim ${a.id}}`}`,
    chalk`   {dim →} ${a.hosts.length ? a.hosts.join(', ') : chalk.dim('no route')} {dim ·} ${facts}`,
  ]
}

function diskLine(d, chalk) {
  if (!d || d.error) return chalk.dim('docker system df unread')
  return chalk`images ${d.images.total} {dim ·} ${bytes(d.images.size_bytes)} {dim (${bytes(d.images.reclaimable_bytes)} reclaimable)} {dim ·} build cache ${bytes(d.build_cache.size_bytes)} {dim ·} ${d.containers.stopped} stopped containers`
}

/** One fleet box in a line: its reading where ssh reached it, the row's side either way. */
function fleetLine(row, target, read, latest, chalk) {
  const name  = String(row.name ?? target).padEnd(14)
  const heard = heardLine({ row }, chalk)
  if (!read) return chalk`{red ●}  {bold ${name}} {red ssh to ${target} did not answer} {dim ·} ${heard}`
  if (read.error) return chalk`{red ●}  {bold ${name}} {red ${read.error}} {dim ·} ${heard}`
  const units   = read.status?.units ?? read.old?.units
  const up      = Array.isArray(units) ? units.filter(u => u.active === 'active').length : null
  const known   = Array.isArray(units) ? units.filter(u => u.load !== 'not-found').length : null
  const version = read.status?.outpost.version ?? read.old?.pinned
  const vitals  = read.status?.vitals
  const apps    = read.status ? appsOf(read.status).length : null
  return chalk`${dot(up != null && up === known, chalk)}  {bold ${name}} ${versionOf(version, latest, chalk)} {dim ·} ${up ?? '–'}/${known ?? '–'} units` +
    (read.status ? chalk` {dim ·} ${apps} apps {dim ·} cpu ${pct(vitals?.cpu)} mem ${pct(vitals?.memory)} disk ${pct(vitals?.disk)}` : chalk` {dim · no status entry}`) +
    chalk` {dim ·} ${heard}`
}
</script>

What is on a box that runs only an Outpost, from the box itself. Every route
on the Outpost but `/health` is signed with its Basecamp's key, which this
machine does not hold, so the reading comes over ssh: the box runs `outpost
status` through its unit's own pinned command, and the readers that answer are
the ones its heartbeat and reports use (`packages/outpost/src/status.js`). It
starts no second Outpost and changes nothing on the box.

The screen is the units the install put there, the machine's load, its
software and the posture facts a person acts on at a shell, then each App with
its container, hostnames, replica, the last day's requests off its Caddy log
and its newest archive on the box, the Docker disk, and where the files are.
The version is npm's `latest` beside the pin when npm is ahead.

**With `BASECAMP_API_KEY` and `BASECAMP_URL`**, the box's Server row adds when
Basecamp last heard it. A box that reads well over ssh and that its Basecamp
has not heard from in two minutes is one no release reaches: a clock skewed
past the 300-second window, a wrong `BASECAMP_URL` in its env, or a firewall
between them.

**With no box named**, the same key lists every Server row in that Basecamp
and reads each over ssh, one line apiece: the alias in `~/.ssh/config` whose
HostName is the row's address, `root@<address>` otherwise. A box ssh does not
reach still prints its row.

An Outpost from before `status` answers what an old box still can: the pinned
version, whether each unit is active, and `/health`. `--json` prints the
reading as it came, for a script.

```js
const { plural }   = await import(new URL('file://' + global.fliRoot + '/core/text.js'))
const { latestOn } = await import(new URL('file://' + global.fliRoot + '/core/tags-on-npm.js'))
const { aliasOf }  = await import(new URL('file://' + global.fliRoot + '/core/cloud.js'))

const latestAsked = latestOn(OUTPOST)
const dest = String(arg.server ?? '').trim()

const reach = (target) => {
  const machine = createMachine({ host: target, path: null, exec: $.exec, transport: null })
  return machine.reach() ? machine : null
}

// ── The fleet, a line per box ───────────────────────────────────────────────
if (!dest) {
  const h = hub()
  if (!h) { log.error('Pass the box: fli outpost:status <ssh alias or user@host> — or set BASECAMP_API_KEY and BASECAMP_URL for the fleet'); process.exitCode = 1; return }
  const rows = await basecampAll(h.origin, h.key, '/servers').catch(err => { log.error(`The fleet is Basecamp's Server rows — ${err.message}`); return null })
  if (!rows) { process.exitCode = 1; return }
  const boxes = []
  for (const row of rows) {
    const target  = row.ipAddress ? (await aliasOf(row.ipAddress)) ?? `root@${row.ipAddress}` : null
    const machine = target && reach(target)
    boxes.push({ row, target: target ?? 'no address', read: machine ? readOutpost(machine) : null })
  }
  if (flag.json) { echo(JSON.stringify(boxes, null, 2)); return }
  const latest = await latestAsked
  echo('')
  echo`  {bold ${plural(rows.length, 'server')}} {dim in} ${h.origin}`
  echo('')
  echo.lines(boxes.map(b => fleetLine(b.row, b.target, b.read, latest, chalk)), { indent: 2 })
  echo('')
  return
}

// ── One box, the whole screen ───────────────────────────────────────────────
const machine = reach(dest)
if (!machine) { log.error(`Cannot reach ${dest} over ssh`); process.exitCode = 1; return }

const read = readOutpost(machine)
if (flag.json) { echo(JSON.stringify(read, null, 2)); return }
if (read.error) { log.error(`${dest}: ${read.error}`); process.exitCode = 1; return }
const latest = await latestAsked

if (read.old) {
  const { pinned, units, health } = read.old
  const heard = await heardOf(health?.server_id, null, basecamp)
  echo('')
  echo`  {bold ${dest}} {dim ·} Outpost ${versionOf(pinned, latest, chalk)} {dim · no status entry on this version}`
  if (read.said) echo`  {dim ${read.said}}`
  echo('')
  echo.lines(units.map(u => chalk`${dot(u.active === 'active', chalk)}  ${short(u.unit).padEnd(20)} ${u.active}`), { indent: 2 })
  echo('')
  echo(health
    ? chalk`  {bold Health}    ${health.ok ? 'ok' : 'not ok'} {dim ·} server ${health.server_id ?? '–'} {dim ·} version ${health.version ?? '–'}`
    : chalk`  {bold Health}    {red the command port did not answer /health}`)
  if (heard) echo`  {bold Basecamp}  ${heardLine(heard, chalk)}`
  echo`\n  {dim An Outpost with}  outpost status  {dim answers the full screen.}\n`
  return
}

const s     = read.status
const r     = s.posture?.readings
const apps  = appsOf(s)
const heard = await heardOf(s.outpost.server_id, s.outpost.basecamp_url, basecamp)

echo('')
echo`  {bold ${dest}} {dim ·} Outpost ${versionOf(s.outpost.version, latest, chalk)} {dim · server} ${s.outpost.server_id ?? '–'} {dim →} ${s.outpost.basecamp_url ?? 'no Basecamp'}`
if (s.outpost.error) echo`  {yellow ${s.outpost.error}}`
if (heard) echo`  {bold Basecamp}  ${heardLine(heard, chalk)}`
echo('')
echo.lines(unitLines(s.units, chalk), { indent: 2 })
echo('')
echo`  {bold Machine}   ${machineLine(s.vitals, chalk)}`
echo`  {bold Software}  ${softwareLine(r, chalk)}`
echo`  {bold Defenses}  ${defenseParts(r, chalk).join(chalk.dim(' · '))}`
echo`  {bold Disk}      ${diskLine(s.disk, chalk)}`
echo('')
echo`  {bold ${plural(apps.length, 'app')}}${s.routes?.caddy === false ? chalk`  {yellow Caddy's admin API did not answer}` : ''}${s.replication?.error ? chalk`  {yellow ${s.replication.error}}` : ''}`
echo.lines(apps.flatMap(a => appLines(a, chalk)), { indent: 2 })
echo('')
echo`  {bold Files}     ${s.paths.links} {dim →} config ${s.paths.config} {dim ·} data ${s.paths.state} {dim ·} logs ${s.paths.logs}\n`
```
