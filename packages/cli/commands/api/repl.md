---
title: api:repl
description: A REPL over HTTP against the running API — requests, variables, auth, watch
examples:
  - fli api:repl
  - fli api:repl --url http://localhost:8110
  - fli api:repl --url https://api.myapp.com
flags:
  url:
    char: u
    type: string
    description: API base URL (default $FRONTIER_API_URL, else localhost on the port fli dev gives this app's api/)
    defaultValue: ''
---

<script>
import { readFileSync } from 'fs'
import { resolve } from 'path'
</script>

```js
const { appPorts }         = await import(resolve(global.fliRoot, 'core/ports.js'))
const { resolveGenerator } = await import(resolve(global.fliRoot, 'core/snapshots.js'))
const { spawnSync }        = await import('node:child_process')

const root = $.paths.root

let manifest = {}
try { manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) } catch { /* no manifest -- the port falls back below */ }

// The port `fli dev:api` starts the surface on, so the REPL lands where the
// server does rather than on junction's own default of 3000.
const port = appPorts(root, { name: manifest.name, scripts: manifest.scripts })
  .find(r => r.surface === 'api')?.port ?? process.env.FRONTIER_PORT_BE ?? 8100
const url  = (flag.url || process.env.FRONTIER_API_URL || `http://localhost:${port}`).replace(/\/$/, '')

// Resolved the way the app's own imports resolve it, never with `bunx`, which
// on a machine with no install fetches a stranger's `junction`.
const junction = resolveGenerator('junction', $.paths.api)
if (!junction) {
  log.error(`@frontierjs/junction is not installed where ${$.paths.api} can reach it`)
  process.exitCode = 1
  return
}

const run = spawnSync('bun', [junction, 'repl', '--url', url], { cwd: root, stdio: 'inherit' })
if (run.error?.code === 'ENOENT') {
  log.error('bun not found — junction is Bun-only, so its REPL needs bun on PATH')
  process.exitCode = 1
  return
}
process.exitCode = run.status ?? 1
```

## What it is

Junction's REPL, pointed at this app. It speaks HTTP to a **running** API — start
it first with `fli dev:api` — so every call goes through the same transport,
hooks, gate and envelope a browser's does:

```
› get /api/orders?$limit=2
› set o = $_.data[0]
› patch /api/orders/$o.id { "status": "paid" }
› auth <token>
› watch /health 1000
```

`help` inside lists the rest: variables (`$_` is the last body), history, persistent
headers, `base <url>` to move, and tab completion of the service paths `/metrics`
names.

## Which console

| | Talks to | As |
| --- | --- | --- |
| `fli api:repl` | the running server, over HTTP | whatever token you `auth` with — anonymous until then |
| `fli db:repl` | the database file, no server | a standing you boot at — `--as`, `--level` |
| `fli call` | the app booted once in-process | `--as` — one method, once, JSON out |
