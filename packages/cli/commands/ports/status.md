---
title: ports:status
description: What is holding every port this workspace can name, plus the broker's own sessions
alias: ps
examples:
  - fli ps
  - fli ports:status
  - fli ports:status --clean
  - fli ports:status --sessions
flags:
  clean:
    type: boolean
    description: Forget the slots of apps that are not running
    defaultValue: false
  json:
    type: boolean
    description: Output as JSON
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
reserved 8500–8509 tooling block and each assigned project across every
category and env — probed against the OS, then decoded back into *env ·
category · project* and named with the process holding it. This is the half the
lock file cannot see: `fli db:studio` binds 8502 as a literal and claims no
session, as does any app somebody started by hand, so a status built on the
broker alone answered *no active sessions* while a port was busy and sent people
looking in the wrong place.

**Which slot `fli dev` gave each app.** `~/.fli/sessions.lock` — one entry per
app directory, its ports, and whether its `fli dev` is running. An idle entry is
not stale: it is how the app gets the same ports next time. `--clean` forgets
the idle ones, and `--sessions` shows only this half.

`fli kill <port>` is what to do about a port you want back; it names the process
before it signals it, and reads the same `pidsOnPort` this does.

```js
const { getSessionStatus, releaseSession, busyKnownPorts } = await import(resolve(global.fliRoot, 'core/ports.js'))

const sessions = getSessionStatus()
const busy     = flag.sessions ? [] : await busyKnownPorts()

if (flag.json) {
  echo(JSON.stringify({ busy, sessions }, null, 2))
  return
}

// ── What is holding a port right now ────────────────────────────────────────
if (!flag.sessions) {
  echo('')
  if (!busy.length) {
    echo('  No port this workspace can name is in use.\n')
  } else {
    echo(`  ${busy.length} port${busy.length === 1 ? '' : 's'} in use\n`)
    for (const b of busy) {
      const what = b.reserved
        ? (b.project ?? 'reserved tooling slot')
        : `${b.project} · ${b.category} · ${b.env}`
      echo(`  ●  ${String(b.port).padEnd(6)} ${what}`)
      // The pid is what makes the line actionable — without it the answer is
      // "something has it", which is what the caller already knew.
      if (b.command) echo(`     ${'pid ' + b.pids.join(', ')}  ${b.command}`)
      else           echo(`     (no lsof here — the port answers, the process cannot be named)`)
    }
    echo('')
  }
}

if (!sessions.length) {
  log.info('No app has a slot in ~/.fli/sessions.lock — `fli dev` gives one')
  return
}

const alive  = sessions.filter(s => s.alive)
const idle   = sessions.filter(s => !s.alive)

echo('')
echo(`  dev slots — ${alive.length} running  ·  ${idle.length} idle\n`)

for (const s of sessions) {
  const status  = s.alive ? '↑' : '·'
  const state   = s.alive ? `pid ${s.pid}` : 'idle'
  echo(`  ${status}  ${s.name}  ·  ${state}  ·  ${s.env}  ·  project ${s.projectId} slot ${s.slot ?? 0}`)
  echo(`       ${s.root}`)

  for (const [cat, ps] of Object.entries(s.ports || {})) {
    const portList = Array.isArray(ps) ? ps : [ps]
    for (const p of portList) {
      echo(`       ${String(p).padEnd(6)}  ${cat}`)
    }
  }

  const uptime = s.startedAt
    ? `last started ${new Date(s.startedAt).toLocaleString()}`
    : ''
  if (uptime) echo(`       ${uptime}`)
  echo('')
}

if (flag.clean && idle.length) {
  for (const s of idle) {
    releaseSession(s.root)
    log.success(`Forgot the slot of ${s.name}`)
  }
}
```
