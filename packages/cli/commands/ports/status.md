---
title: ports:status
description: What is holding every port this workspace can name, plus the broker's own sessions
alias: ps
examples:
  - fli ps
  - fli ports:status
  - fli ps 8008
  - fli ports:status --clean
  - fli ps --clean thod
  - fli ports:status --sessions
  - fli ps --include-idle
  - fli ps --docker
args:
  -
    name: port
    description: one port — what holds it and which dev slot it belongs to
flags:
  include-idle:
    type: boolean
    description: List the idle dev slots too — by default only the running ones are shown
    defaultValue: false
  clean:
    type: string
    description: Forget the slots of apps that are not running; with a name, only that app's
    defaultValue: ''
  json:
    type: boolean
    description: Output as JSON
    defaultValue: false
  docker:
    type: boolean
    description: Also list the ports Docker containers publish — lsof cannot see them
    defaultValue: false
  sessions:
    type: boolean
    description: Only the broker's lock file — skip probing the schema's ports
    defaultValue: false
---

<script>
import { resolve } from 'path'
</script>

Two questions, because the answer to one of them was misleading on its own.

**What is actually holding a port.** Every port the schema can name — the
reserved 5500–5509 tooling block and each assigned project across every
category and env — probed against the OS, then decoded back into *env ·
category · project* and named with the process holding it. This is the half the
lock file cannot see: `fli db:studio` binds 5502 as a literal and claims no
session, as does any app somebody started by hand, so a status built on the
broker alone answered *no active sessions* while a port was busy and sent people
looking in the wrong place.

**Which slot `fli dev` gave each app.** `~/.fli/sessions.lock` — one entry per
app directory, its ports, and whether its `fli dev` is running. An idle entry is
not stale: it is how the app gets the same ports next time. Idle entries are
counted but not listed — a dozen of them buried the running one — so
`--include-idle` lists them, `--clean` forgets them, and `--sessions` shows only
this half.

**One port.** `fli ps 8008` asks about that number alone. It is probed
directly rather than looked up among the schema's ports, because the schema's
walk stops at service slot 0 and the port somebody types is often a slot
`fli dev` handed out. The dev slots are cut to the one holding the port, idle
or running, since the app that owns a free port is usually the question.

**Docker.** `--docker` adds the ports containers publish. They are held by
docker-proxy, a root process, which an unprivileged `lsof` does not list — so a
container is absent from the first half above even on a port the schema names.
Asked of `docker ps`, the one authority on what it published.

`fli kill <port>` is what to do about a port you want back; it names the process
before it signals it, and reads the same `pidsOnPort` this does.

```js
const { getSessionStatus, releaseSession, busyKnownPorts, portStatus, dockerPorts, slotConflicts, readLock } = await import(resolve(global.fliRoot, 'core/ports.js'))
const { plural } = await import(resolve(global.fliRoot, 'core/text.js'))

const target = String(arg.port ?? '').trim()
const only   = target ? Number(target) : null
if (target && !(/^\d+$/.test(target) && only >= 1 && only <= 65535)) {
  log.error(`${target} is not a port`)
  return
}

const holds    = s => Object.values(s.ports || {}).flat().map(Number).includes(only)
const sessions = getSessionStatus().filter(s => only == null || holds(s))
const one      = only != null && !flag.sessions ? await portStatus(only) : null
const docker   = flag.docker && !flag.sessions ? dockerPorts().filter(d => only == null || d.port === only) : []
const busy     = flag.sessions ? [] : one ? (one.busy ? [one] : []) : await busyKnownPorts()

if (flag.json) {
  echo(JSON.stringify(one ? { port: one, sessions, docker } : { busy, sessions, docker }, null, 2))
  return
}

// ── What is holding a port right now ────────────────────────────────────────
const ENV_TONE = { dev: chalk.yellow, test: chalk.magenta, prod: chalk.red }
const envTag   = env => (ENV_TONE[env] ?? chalk.white)(env)

if (!flag.sessions) {
  echo('')
  if (one && !one.busy) {
    echo(chalk`  {bold.cyan ${only}} {dim is free —} ${one.env} {dim ·} ${one.category} {dim ·} {dim project ${one.projectId} slot ${one.serviceId}}\n`)
  } else if (!busy.length) {
    echo(chalk.dim('  No port this workspace can name is in use.\n'))
  } else {
    echo(chalk`  {bold ${plural(busy.length, 'port')} in use}\n`)
    for (const b of busy) {
      const what = b.reserved
        ? chalk`{magenta ${b.project ?? 'reserved tooling slot'}}`
        : chalk`{bold ${b.project ?? `project ${b.projectId} slot ${b.serviceId}`}} {dim ·} {cyan ${b.category}} {dim ·} ${envTag(b.env)}`
      echo(chalk`  {green ●}  {bold.cyan ${String(b.port).padEnd(6)}} ${what}`)
      // The pid is what makes the line actionable — without it the answer is
      // "something has it", which is what the caller already knew.
      echo(b.command
        ? chalk`     {dim pid ${b.pids.join(', ')}}  {gray ${b.command}}`
        : chalk`     {dim (no lsof here — the port answers, the process cannot be named)}`)
    }
    echo('')
  }
}

if (docker.length) {
  echo(chalk`  {bold docker} {dim —} ${plural(docker.length, 'published port')}\n`)
  for (const d of docker) {
    echo(chalk`  {green ●}  {bold.cyan ${String(d.port).padEnd(6)}} {magenta ${d.name}} {dim → :${d.container}}`)
    echo(chalk`     {gray ${d.image}}`)
  }
  echo('')
}

if (!sessions.length) {
  log.info(only != null
    ? `No dev slot in ~/.fli/sessions.lock holds ${only}`
    : 'No app has a slot in ~/.fli/sessions.lock — `fli dev` gives one')
  return
}

const alive  = sessions.filter(s => s.alive)
const idle   = sessions.filter(s => !s.alive)
const shown  = flag['include-idle'] || only != null ? sessions : alive

echo('')
echo(chalk`  {bold dev slots} {dim —} {green ${alive.length} running}  {dim ·  ${idle.length} idle}\n`)

for (const s of shown) {
  const where = `project ${s.projectId} slot ${s.slot ?? 0}${s.branch ? ` branch ${s.branch}` : ''}`
  const ports = Object.entries(s.ports || {})
    .flatMap(([cat, ps]) => (Array.isArray(ps) ? ps : [ps]).map(p => [String(p).padEnd(6), cat]))
  const started = s.startedAt && `last started ${new Date(s.startedAt).toLocaleString()}`

  const head = [
    chalk`{bold ${s.name}}`,
    s.alive ? chalk`{green pid ${s.pid}}` : 'idle',
    envTag(s.env),
    chalk.dim(where),
  ].join(chalk.dim('  ·  '))

  // An idle slot is the same block dimmed, so the running ones read first.
  const block = [
    `${s.alive ? chalk.green('↑') : '·'}  ${head}`,
    chalk.dim(`     ${s.root}`),
    ...ports.map(([port, cat]) => chalk`     {cyan ${port}}  ${cat}`),
    started && chalk.dim(`     ${started}`),
  ]
  echo.lines(block, { indent: 2, style: s.alive ? null : chalk.dim })
  echo('')
}

// A slot two apps remember is how one gets refused at the other's port. Said
// here so the lock cannot rot in silence; `fli dev` reallocates the newer claim.
const conflicts = only == null ? slotConflicts(readLock()) : []
for (const c of conflicts) {
  log.warn(`${c.apps.length} apps remember ${c.env} slot ${c.slot} -- ${c.apps.map(a => a.name).join(', ')}`)
}
if (conflicts.length) echo(chalk`  {dim The elder claim keeps the slot; the others move on their next} fli dev\n`)

// A bare `--clean` reaches a string flag as the word true.
const clean = flag.clean === true || flag.clean === 'true' ? '*' : String(flag.clean ?? '').trim()
if (!flag['include-idle'] && only == null && idle.length && !clean) {
  echo(chalk`  {dim ${plural(idle.length, 'idle slot')} not listed —} --include-idle {dim to show,} --clean {dim to forget,} --clean <name> {dim for one}\n`)
}

if (clean) {
  const named = s => clean === '*' || s.name === clean || s.name?.split('/').pop() === clean || s.root === clean || s.root.split('/').pop() === clean
  const picked = idle.filter(named)
  if (clean !== '*' && !picked.length) {
    const running = alive.find(named)
    log.error(running ? `${running.name} is running (pid ${running.pid}); stop it before forgetting its slot` : `No idle slot named ${clean}`)
    return
  }
  for (const s of picked) {
    releaseSession(s.root)
    log.success(`Forgot the slot of ${s.name}`)
  }
}
```
