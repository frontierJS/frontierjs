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
const { routeId } = await import(new URL('file://' + global.fliRoot + '/core/edge.js'))

// A first setup has no page yet and 07b-edge hashes the one each deploy builds;
// a setup run again keeps the hashes of the page already serving.
const machine = machineFor($, host, serverPath)
const html    = machine.capture(`cat ${serverPath}/current/index.html 2>/dev/null || true`)

const { routes, paths, error } = await edgeRoutesFor({ root: $.paths.root, appId, serverPath, apiPort, edge, html })
if (error) {
  log.error(error)
  $.config.abort = true
  return
}
if (!paths) log.warn('No app.snapshot.md — only /api/ and /ws are routed to the API. Run `junction app` to route what the API mounts.')

// ─── Show what will be routed ─────────────────────────────────────────────────
echo('')
for (const r of routes) {
  const what = r['@id'] === routeId(appId, 'api') ? `every path → :${apiPort}`
    : edge.api.domain ? `${serverPath}/current`
    : `${serverPath}/current · ${paths?.prefix === null ? `${paths.roots.length} API paths (pages by Accept)` : `${paths?.prefix ?? '/api'}/`} and /ws → :${apiPort}`
  echo(`  https://${r.match[0].host[0]}  ${what}`)
}
echo('')

const answer = await tty.line(`Write these routes into Caddy on ${host}? (y/N) `)
if (answer.trim().toLowerCase() !== 'y') {
  log.info('Skipped — nothing routes to this app until the routes are written. Run fli deploy:setup again.')
  return
}

// The page the guard serves. Written before the routes, because a guard in force
// with nothing behind it answers an empty 503 that says nothing to the person
// reading it. An app that wants its own overwrites this path.
machine.run(`mkdir -p ${fliDir(serverPath)}`)
machine.run(`cat > ${pagePath(serverPath)} << 'FLIPAGEEOF'
${DEFAULT_PAGE}FLIPAGEEOF`)

const written = await writeEdge(machine, { appId, routes })
if (written.error) {
  log.error(written.error)
  log.info('01-check-deps installs Caddy as the caddy-api unit; a Caddy started from a Caddyfile has no config this can add to.')
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
