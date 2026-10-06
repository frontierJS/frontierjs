---
title: utils:dev
description: Start the dev server on this app's own ports — refuses a taken one, warns on an empty database
alias: dev
examples:
  - fli dev
  - fli dev --dry
  - fli dev --no-check
flags:
  check:
    type: boolean
    description: Skip both preflights — the ports and the database
    defaultValue: true
---

Runs the project's own `dev` script with the right runner, on this app's own
ports, after two preflights.

**An app the ports table does not name gets a slot of its own.** Every app
`fli new` writes is project 0, so two of them derive the same 8000/8100. `fli
dev` gives each app directory a slot in `~/.fli/sessions.lock` and hands its
ports to the servers it starts as `FLI_PORT_FE`, `FLI_PORT_BE` and the rest,
which the scaffolded configs read: the second app runs on 8001/8101. The slot is
remembered, so an app comes back on the port a browser tab, an OAuth redirect
and a `WEB_URL` already name. An app whose configs ignore the variables stays
at 0, since moving the probe would not move the server (`core/ports.js` § Dev
slots). `fli ps` lists the slots.

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
const root = $.paths.root

const { warnIfDatabaseEmpty, detectRunner } =
  await import(resolve(global.fliRoot, 'core/db-preflight.js'))
const { claimSession, busyPorts } =
  await import(resolve(global.fliRoot, 'core/ports.js'))

let manifest = {}
try {
  manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
} catch { /* an app with no manifest still has surfaces */ }

// Before the check, because the slot decides which ports are checked.
let session
try {
  session = await claimSession(root, { name: manifest.name, scripts: manifest.scripts, dry: flag.dry })
} catch (err) {
  log.error(err.message)
  process.exit(1)
}

if (session.rows.length) {
  const where = session.rows.map(r => `${r.label} ${r.port}`).join(' · ')
  log.info(session.slot ? `slot ${session.slot} — ${where}` : where)
}

if (flag.check) {
  // Ports first. A refusal here is the whole point, and it must happen before
  // anything that takes time — including reading a database the ghost still
  // has open.
  const busy = await busyPorts(session.rows)

  if (busy.length && !flag.dry) {
    log.error('')
    log.error('  Port already in use:')
    log.error('')
    for (const b of busy) log.error(`    ${b.port}  ${b.label}${b.script ? `  (bun run ${b.script})` : ''}`)
    log.error('')
    log.error('  Most likely a dev server from an earlier run. A stale API also holds')
    log.error('  the old database open, so `db:reset` will appear to do nothing while')
    log.error('  it is still running. `fli ps` names the process.')
    log.error('')
    process.exit(1)
  }

  try {
    warnIfDatabaseEmpty($)
  } catch (err) {
    // A preflight that throws must not stop a dev server. It is a courtesy.
    log.detail(`database preflight skipped: ${err.message}`)
  }
}

const runner = detectRunner(root)

log.info(`${runner} — running: ${runner} run dev`)
// `env:` and never an assignment to process.env, which a child under bun does not see.
$.exec({ command: `cd ${root} && ${runner} run dev`, dry: flag.dry, env: { ...process.env, ...session.vars } })
```
