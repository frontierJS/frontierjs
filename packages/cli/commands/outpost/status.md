---
title: outpost:status
description: One screen of what a fleet box runs, read over ssh from its own Outpost
examples:
  - fli outpost:status box1
  - fli outpost:status root@203.0.113.7
  - fli outpost:status box1 --json
args:
  -
    name: server
    description: "The box: an alias from ~/.ssh/config, or user@host"
flags:
  json:
    type: boolean
    description: Print the Outpost's reading as it came off the box
    defaultValue: false
---

<script>
const APP_ROUTE = /^fjs-(.+?)(?:-redirects|-path-\d+)?$/

const pct   = (n) => n == null ? '–' : `${Math.round(n)}%`
const bytes = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round((n ?? 0) / 1e3)} kB`
const ago   = (at) => {
  const s = Math.round((Date.now() - Date.parse(at)) / 1000)
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}
const dot   = (good, chalk) => good === true ? chalk.green('●') : good === false ? chalk.red('●') : chalk.yellow('●')

/** Every App the box knows of, by id: a container, a route or a replica. A
 *  static app has a route and no container, so containers alone miss it. */
function appsOf(s) {
  const apps = new Map()
  const app  = (id) => apps.get(id) ?? apps.set(id, { id, containers: [], hosts: [], replica: null }).get(id)
  for (const c of Array.isArray(s.containers) ? s.containers : []) if (c.app_id) app(c.app_id).containers.push(c)
  for (const r of s.routes?.routes ?? []) {
    const id = APP_ROUTE.exec(r.id ?? '')?.[1]
    if (id) app(id).hosts.push(...r.hosts, ...r.paths.map(p => `${p.host}${p.prefix}`))
  }
  for (const r of s.replication?.apps ?? []) app(r.app_id).replica = r
  return [...apps.values()]
}

function unitLines(units, chalk) {
  if (!Array.isArray(units)) return [chalk`{yellow ●}  {dim systemctl did not answer${units?.error ? `: ${units.error}` : ''}}`]
  return units.map(u => u.load === 'not-found'
    ? chalk`{dim ○  ${u.unit.replace(/\.service$/, '').padEnd(20)} not installed}`
    : chalk`${dot(u.active === 'active', chalk)}  ${u.unit.replace(/\.service$/, '').padEnd(20)} ${u.active} {dim (${u.sub})${u.since ? ` since ${u.since}` : ''}}`)
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
  return [
    chalk`${dot(good, chalk)}  {bold ${name}} {dim ·} ${state}${live?.status ? chalk` {dim ${live.status}}` : ''}${name === a.id ? '' : chalk`  {dim ${a.id}}`}`,
    chalk`   {dim →} ${a.hosts.length ? a.hosts.join(', ') : chalk.dim('no route')} {dim ·} ${rep}`,
  ]
}

function diskLine(d, chalk) {
  if (!d || d.error) return chalk.dim('docker system df unread')
  return chalk`images ${d.images.total} {dim ·} ${bytes(d.images.size_bytes)} {dim (${bytes(d.images.reclaimable_bytes)} reclaimable)} {dim ·} build cache ${bytes(d.build_cache.size_bytes)} {dim ·} ${d.containers.stopped} stopped containers`
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
its container, hostnames and replica, the Docker disk, and where the files
are. The Basecamp it reports to is named, and need not be reachable.

An Outpost from before `status` answers what an old box still can: the pinned
version, whether each unit is active, and `/health`. `--json` prints the
reading as it came, for a script.

```js
const { plural } = await import(new URL('file://' + global.fliRoot + '/core/text.js'))

const dest = String(arg.server ?? '').trim()
if (!dest) { log.error('Pass the box: fli outpost:status <ssh alias or user@host>'); process.exitCode = 1; return }

const machine = createMachine({ host: dest, path: null, exec: $.exec, transport: null })
if (!machine.reach()) { log.error(`Cannot reach ${dest} over ssh`); process.exitCode = 1; return }

const read = readOutpost(machine)
if (flag.json) { echo(JSON.stringify(read, null, 2)); return }
if (read.error) { log.error(`${dest}: ${read.error}`); process.exitCode = 1; return }

if (read.old) {
  const { pinned, units, health } = read.old
  echo('')
  echo`  {bold ${dest}} {dim ·} Outpost ${pinned ?? 'unknown'} {dim · no status entry on this version}`
  if (read.said) echo`  {dim ${read.said}}`
  echo('')
  echo.lines(units.map(u => chalk`${dot(u.active === 'active', chalk)}  ${u.unit.replace(/\.service$/, '').padEnd(20)} ${u.active}`), { indent: 2 })
  echo('')
  echo(health
    ? chalk`  {bold Health}   ${health.ok ? 'ok' : 'not ok'} {dim ·} server ${health.server_id ?? '–'} {dim ·} version ${health.version ?? '–'}`
    : chalk`  {bold Health}   {red the command port did not answer /health}`)
  echo`\n  {dim An Outpost with}  outpost status  {dim answers the full screen.}\n`
  return
}

const s    = read.status
const r    = s.posture?.readings
const apps = appsOf(s)

echo('')
echo`  {bold ${dest}} {dim ·} Outpost ${s.outpost.version} {dim · server} ${s.outpost.server_id ?? '–'} {dim →} ${s.outpost.basecamp_url ?? 'no Basecamp'}`
if (s.outpost.error) echo`  {yellow ${s.outpost.error}}`
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
