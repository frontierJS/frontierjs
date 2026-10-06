---
title: 05-caddy
description: Write this app's routes into the machine's Caddy
---

```js
if ($.config.abort) return

const { host, serverPath, appId, edge, apiPort } = $.config

// The pause guard and the page it serves come from `core/pause.js`, which is
// also what `deploy:pause` writes against and what `deploy:status` asks Caddy
// about. The routes come from `core/edge.js`, which also names the origin the
// web build inlines — one reader of the domains, or the route and the bundle
// disagree about where the API is.
const { DEFAULT_PAGE, pagePath, fliDir, guardProbeScript } =
  await import(new URL('file://' + global.fliRoot + '/core/pause.js'))
const { edgeRoutes, routeId, applyEdge, readConfigScript, parseConfigRead, writeConfigScript, parseConfigWrite, EdgeError } =
  await import(new URL('file://' + global.fliRoot + '/core/edge.js'))

let routes
try { routes = edgeRoutes({ appId, serverPath, apiPort, web: edge.web, api: edge.api }) }
catch (e) {
  if (!(e instanceof EdgeError)) throw e
  log.error(e.message)
  $.config.abort = true
  return
}

// ─── Show what will be routed ─────────────────────────────────────────────────
echo('')
for (const r of routes) {
  const what = r['@id'] === routeId(appId, 'api') ? `every path → :${apiPort}`
    : edge.api.domain ? `${serverPath}/current`
    : `${serverPath}/current · /api/ and /ws → :${apiPort}`
  echo(`  https://${r.match[0].host[0]}  ${what}`)
}
echo('')

const answer = await tty.line(`Write these routes into Caddy on ${host}? (y/N) `)
if (answer.trim().toLowerCase() !== 'y') {
  log.info('Skipped — nothing routes to this app until the routes are written. Run fli deploy:setup again.')
  return
}

const machine = machineFor($, host, serverPath)

// The page the guard serves. Written before the routes, because a guard in force
// with nothing behind it answers an empty 503 that says nothing to the person
// reading it. An app that wants its own overwrites this path.
machine.run(`mkdir -p ${fliDir(serverPath)}`)
machine.run(`cat > ${pagePath(serverPath)} << 'FLIPAGEEOF'
${DEFAULT_PAGE}FLIPAGEEOF`)

// ─── Read, merge, write back with If-Match ────────────────────────────────────
// Outpost writes to the same Caddy, so a write between the read and this one is
// a 412 and a second read, never a route of its lost.
let written = null
for (let attempt = 1; attempt <= 3 && !written; attempt++) {
  let read
  try { read = parseConfigRead(machine.capture(readConfigScript())) }
  catch (e) {
    if (!(e instanceof EdgeError)) throw e
    log.error(e.message)
    log.info('01-check-deps installs Caddy as the caddy-api unit; a Caddy started from a Caddyfile has no config this can add to.')
    $.config.abort = true
    return
  }

  let next
  try { next = applyEdge(read.config, { appId, routes }) }
  catch (e) {
    if (!(e instanceof EdgeError)) throw e
    log.error(e.message)
    $.config.abort = true
    return
  }

  const result = parseConfigWrite(machine.capture(writeConfigScript(next, read.etag)))
  if (result.ok) written = true
  else if (!result.stale) {
    log.error(result.error)
    $.config.abort = true
    return
  }
}
if (!written) {
  log.error('Caddy\'s config kept changing under the write — three reads, three 412s. Run fli deploy:setup again.')
  $.config.abort = true
  return
}

// Asked back by id rather than assumed: the same question deploy:pause asks.
if (machine.capture(guardProbeScript(appId)).trim() !== '200') {
  log.error('Caddy accepted the config and does not hold the pause guard — deploy:pause would refuse')
  $.config.abort = true
  return
}
log.success('Routes written; Caddy fetches each certificate on the first request it serves')
$.config.edgeWritten = true
```
