---
title: api:routes
description: List every HTTP route the running API actually serves
alias: routes
examples:
  - fli api:routes
  - fli api:routes --raw
  - fli api:routes --method POST
  - fli api:routes --json
  - fli api:routes --url http://localhost:8110
flags:
  url:
    char: u
    type: string
    description: API base URL (default $API_URL, else localhost on the project's backend port)
    defaultValue: ''
  method:
    char: m
    type: string
    description: Only this HTTP method
    defaultValue: ''
  raw:
    char: r
    type: boolean
    description: Only routes a plugin or the app registered — hide the auto-mounted service ones
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Output as JSON
    defaultValue: false
---

Asks a **running** API what it serves. The surface is emergent — services
auto-mount, plugins register their own — so it cannot be read off the source
without running it, and `hasRoute()` answers a matching question rather than an
existence one. The answer comes from the app's own router via `GET /manifest`,
which means it reports where a route *landed*, `apiPrefix` included, rather than
where something meant to put it.

`manifestPlugin()` must be configured (it is in the scaffold, and skipped in
production by default). Start the API first — `fli api:dev`.

```js
const base = (flag.url || process.env.API_URL ||
  `http://localhost:${process.env.FLI_PORT_BE ?? 8100}`).replace(/\/$/, '')

// The prefix is unknown until the manifest answers, and the manifest itself
// moves with it — so try the bare path, then ask the app where it lives via
// the one thing that never moves, the port.
let manifest = null
for (const path of ['/manifest', '/api/manifest']) {
  try {
    const res = await fetch(`${base}${path}`)
    if (!res.ok) continue
    manifest = await res.json()
    break
  } catch {
    log.error(`Cannot reach the API at ${base} — is it running? (fli api:dev)`)
    return
  }
}

if (!manifest) {
  log.error(`No manifest at ${base}/manifest or ${base}/api/manifest`)
  log.info('manifestPlugin() must be configured — app.configure(manifestPlugin({ db })).')
  log.info('It is devOnly by default, so a production build answers 404 here on purpose.')
  log.info(`An apiPrefix other than '/api' needs it spelled out: --url ${base}/<prefix>`)
  return
}

if (!Array.isArray(manifest.routes)) {
  log.error('This API reports no routes — @frontierjs/junction is older than the routes manifest')
  return
}

let routes = manifest.routes
if (flag.raw)    routes = routes.filter(r => r.kind === 'raw')
if (flag.method) routes = routes.filter(r => r.method === flag.method.toUpperCase())

if (flag.json) {
  echo(JSON.stringify(routes, null, 2))
  return
}

if (routes.length === 0) {
  log.info('No routes match')
  return
}

const width = Math.max(...routes.map(r => r.method.length))
for (const r of routes) {
  const kind = r.kind === 'service' ? '  (service)' : ''
  echo(`  ${r.method.padEnd(width)}  ${r.path}${kind}`)
}

const raw = routes.filter(r => r.kind === 'raw').length
echo('')
log.info(`${routes.length} route(s) — ${raw} registered by the app or a plugin, ` +
         `${routes.length - raw} auto-mounted from services`)
```
