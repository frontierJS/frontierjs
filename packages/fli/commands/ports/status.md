---
title: ports:status
description: Show all active FLI port sessions and their status
alias: ps
examples:
  - fli ps
  - fli ports:status
  - fli ports:status --clean
flags:
  clean:
    type: boolean
    description: Remove stale sessions from the lock file
    defaultValue: false
  json:
    type: boolean
    description: Output as JSON
    defaultValue: false
---

<script>
import { resolve } from 'path'
</script>

Shows every project currently registered in `~/.fli/sessions.lock`,
along with their assigned ports and whether the process is still alive.

Use `--clean` to prune stale entries left by crashed processes.

```js
const { getSessionStatus, readLock, releaseSession, decode } = await import(resolve(global.fliRoot, 'core/ports.js'))

const sessions = getSessionStatus()

if (flag.json) {
  echo(JSON.stringify(sessions, null, 2))
  return
}

if (!sessions.length) {
  log.info('No active sessions in ~/.fli/sessions.lock')
  return
}

const alive  = sessions.filter(s => s.alive)
const stale  = sessions.filter(s => !s.alive)

echo('')
echo(`  ${alive.length} active  ·  ${stale.length} stale\n`)

for (const s of sessions) {
  const status  = s.alive ? '↑' : '✗'
  const color   = s.alive ? '' : ' (stale)'
  echo(`  ${status}  ${s.name}  ·  pid ${s.pid}${color}  ·  ${s.env}  ·  project slot ${s.projectId}`)

  for (const [cat, ps] of Object.entries(s.ports || {})) {
    const portList = Array.isArray(ps) ? ps : [ps]
    for (const p of portList) {
      echo(`       ${String(p).padEnd(6)}  ${cat}`)
    }
  }

  const uptime = s.startedAt
    ? `started ${new Date(s.startedAt).toLocaleTimeString()}`
    : ''
  if (uptime) echo(`       ${uptime}`)
  echo('')
}

if (flag.clean && stale.length) {
  for (const s of stale) {
    releaseSession(s.name)
    log.success(`Removed stale session: ${s.name}`)
  }
}
```
