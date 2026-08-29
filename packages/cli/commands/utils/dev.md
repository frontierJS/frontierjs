---
title: utils:dev
description: Start the dev server — refuses a taken port, warns on an empty database
alias: dev
examples:
  - fli dev
  - fli dev --dry
  - fli dev --no-check
flags:
  no-check:
    type: boolean
    description: Skip both preflights — the ports and the database
    defaultValue: false
---

Runs the project's own `dev` script with the right runner, after two preflights.

**The port check refuses; the database check warns.** They are different kinds
of fact. An empty database is the correct state for a first run, so saying so is
a courtesy — but it is worth saying, because an app with no rows boots clean,
serves every route, answers every request correctly and shows a person a blank
screen, and the first thing anyone does is look for a bug in the app.

A port that is already answering is not correct in any reading, and the two dev
runners fail differently and badly: `bun --watch` prints EADDRINUSE and **keeps
watching**, so the process stays alive and whatever is waiting on it waits
forever, and vite exits on `strictPort` after somebody has already been confused
once. The worst version is a stale server from an earlier run — it still owns
the port AND still holds the old database open, including one that has been
deleted, since an unlinked SQLite file lives on while a handle does. The new
server never starts, every request is answered by the ghost, and `db:reset`
looks like it did nothing.

**Which ports are checked comes from what this app's own `dev` script RUNS**,
resolved through `core/ports.js` — which owns the formula and the project table,
so a list kept per app cannot go stale the day somebody adds a surface.

It used to be the surfaces that EXIST, and the two are only the same set in a
scaffolded app: `fli new` composes every surface into one `dev`, so there the
question does not arise. Every app in this repo answers it differently —
`example` has five surfaces and a `dev` that starts two — so a storefront left
running on 8610 refused `fli dev` by naming a port nothing it was about to start
would have taken (`FJS-568`). `devPorts()` narrows `appPorts()` by walking the
`dev` script's `bun run` targets, transitively. A `dev` that runs no other
script cannot be narrowed and is not: that is a single-surface app whose `dev`
IS the surface command, and every surface it has is one it starts.

**The runner is decided by a lockfile found by walking UP.** A package inside a
workspace has no lockfile of its own — the one lockfile is at the workspace root
— so looking only beside `package.json` reported *npm detected* for every
package in a bun monorepo, and then ran the wrong runner.

<script>
import { readFileSync } from 'fs'
import { resolve } from 'path'
</script>

```js
const root = context.paths.root

const { warnIfDatabaseEmpty, detectRunner } =
  await import(resolve(global.fliRoot, 'core/db-preflight.js'))
const { devPorts, busyPorts } =
  await import(resolve(global.fliRoot, 'core/ports.js'))

if (!flag['no-check']) {
  // Ports first. A refusal here is the whole point, and it must happen before
  // anything that takes time — including reading a database the ghost still
  // has open.
  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  } catch { /* an app with no manifest still has surfaces */ }

  const busy = await busyPorts(devPorts(root, { name: manifest.name, scripts: manifest.scripts }))

  if (busy.length && !flag.dry) {
    log.error('')
    log.error('  Port already in use:')
    log.error('')
    for (const b of busy) log.error(`    ${b.port}  ${b.label}${b.script ? `  (bun run ${b.script})` : ''}`)
    log.error('')
    log.error('  Most likely a dev server from an earlier run. A stale API also holds')
    log.error('  the old database open, so `db:reset` will appear to do nothing while')
    log.error('  it is still running.')
    log.error('')
    process.exit(1)
  }

  try {
    warnIfDatabaseEmpty(context)
  } catch (err) {
    // A preflight that throws must not stop a dev server. It is a courtesy.
    log.debug?.(`database preflight skipped: ${err.message}`)
  }
}

const runner = detectRunner(root)

log.info(`${runner} — running: ${runner} run dev`)
context.exec({ command: `cd ${root} && ${runner} run dev`, dry: flag.dry })
```
