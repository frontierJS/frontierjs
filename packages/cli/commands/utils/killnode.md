---
title: utils:killnode
description: Kill all running Node/Bun processes, or whatever holds a given port
alias: kill
examples:
  - fli kill
  - fli kill 8010
  - fli kill 8010 --force
  - fli kill deno
  - fli killnode
  - fli kill --dry
args:
  -
    name: target
    description: port number (kills its listeners) or process name (killall) — omit for node + bun
flags:
  force:
    char: f
    type: boolean
    description: send SIGKILL instead of SIGTERM
    defaultValue: false
---

<script>
import { execSync } from 'child_process'
import { resolve } from 'path'

// killall/kill exit non-zero when nothing matched — that is information, not a
// failure, so capture it rather than letting execSync throw the command down.
// A real failure (permission denied) still has something to say: surface it.
const sh = (command, dry, log) => {
  if (dry) { log.dry(command); return true }
  try { execSync(command, { stdio: ['ignore', 'inherit', 'pipe'] }); return true }
  catch (err) {
    const stderr = String(err.stderr ?? '').trim()
    if (stderr && !/no process found|no such process/i.test(stderr)) log.warn(stderr)
    return false
  }
}

// `pidsOnPort` and `describe` moved to core/ports.js when `fli ps` became the
// second caller — two implementations of *what is holding this port* is how the
// command that kills it and the command that lists it come to disagree.
const { pidsOnPort, describeProcess: describe } =
  await import(resolve(global.fliRoot, 'core/ports.js'))
</script>

With no argument this kills every `node` and `bun` process. Give it a port and
it kills whatever is listening on that port instead — the usual reason a dev
server refuses to start. Any other argument is treated as a process name and
passed to `killall`.

```js
const target = String(arg.target ?? '').trim()
const signal = flag.force ? '-9' : '-15'

// ── No arg: the original behavior — every node and bun ──────────────────────
if (!target) {
  for (const name of ['node', 'bun']) {
    if (!sh(`killall ${signal} ${name}`, flag.dry, log)) log.info(`no ${name} processes running`)
  }

// ── A number: a port ─────────────────────────────────────────────────────────
} else if (/^\d+$/.test(target)) {
  const port = Number(target)
  if (port < 1 || port > 65535) {
    log.error(`${port} is not a valid port`)
  } else {
    const pids = pidsOnPort(port)
    if (!pids.length) {
      log.info(`nothing listening on port ${port}`)
    } else {
      for (const pid of pids) log.info(`port ${port} → pid ${pid}  ${describe(pid)}`)
      if (sh(`kill ${signal} ${pids.join(' ')}`, flag.dry, log) && !flag.dry) {
        log.success(`killed ${pids.length} process${pids.length === 1 ? '' : 'es'} on port ${port}`)
      }
    }
  }

// ── Anything else: a process name ────────────────────────────────────────────
} else {
  if (!sh(`killall ${signal} ${target}`, flag.dry, log)) log.info(`no ${target} processes running`)
}
```
