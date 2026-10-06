// ─── edge.test.js — core/edge.js: the Caddy routes and the API's origin ───────
//
// Assertions over the JSON Caddy will be handed and over the merge into its
// config. They cannot say Caddy loads it or what an upstream receives through
// it — `pauseEdgeCycle` in scripts/scaffold-build.mjs pushes this module's
// output into a real Caddy for that. What they can say is which shape was
// written, that another route's hostname is refused, and that the three steps
// reading a domain all read it here.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import {
  edgeNames, apiOrigin, edgeRoutes, applyEdge, routeId, accessLogPath, INGRESS_SERVER,
  parseConfigRead, parseConfigWrite, writeConfigScript, EdgeError,
} from '../core/edge.js'
import { guardId } from '../core/pause.js'

const src = (rel) => readFileSync(new URL(`../commands/deploy/${rel}`, import.meta.url).pathname, 'utf8')

const routesFor = (deploy) => {
  const names = edgeNames(deploy)
  return edgeRoutes({ appId: 'shop', serverPath: '/apps/shop', apiPort: 3000, web: names.web, api: names.api })
}
const inner   = (r) => r.handle[0].routes
const handlers = (r) => inner(r).flatMap(x => x.handle.map(h => h.handler))
const proxied = (r) => inner(r).filter(x => x.handle.some(h => h.handler === 'reverse_proxy'))

describe('the names', () => {
  test('one origin is api.domain unset, and names no API origin', () => {
    expect(apiOrigin(edgeNames({ web: { domain: 'shop.example' } }))).toBe(null)
  })

  test('two origins name the API over https', () => {
    expect(apiOrigin(edgeNames({ web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } })))
      .toBe('https://api.shop.example')
  })

  // Interpolated into a shell line and a Caddy route. Paired with the
  // legitimate hostname one character away.
  test('a domain that is not a hostname is refused by key — beside one that is', () => {
    expect(() => edgeNames({ api: { domain: 'api.shop.example; rm -rf /' } })).toThrow(/deploy\.api\.domain/)
    expect(() => edgeNames({ web: { domain: 'shop.example/x' } })).toThrow(EdgeError)
    expect(() => edgeNames({ api: { domain: 'api-2.shop.example' } })).not.toThrow()
  })

  test('the API on the web domain is refused, since that is what unset means', () => {
    expect(() => edgeNames({ web: { domain: 'shop.example' }, api: { domain: 'shop.example' } })).toThrow(/unset/)
  })

  // Ignoring it would leave somebody waiting on a certificate path nothing reads.
  test('an ssl key is refused by name, since Caddy fetches the certificate', () => {
    expect(() => edgeNames({ web: { domain: 'shop.example', ssl: { cert: '/c', key: '/k' } } })).toThrow(/deploy\.web\.ssl/)
  })
})

describe('one origin', () => {
  const [r, ...rest] = routesFor({ web: { domain: 'shop.example' } })

  test('is one route, matched on the domain', () => {
    expect(rest).toEqual([])
    expect(r['@id']).toBe(routeId('shop'))
    expect(r.match).toEqual([{ host: ['shop.example'] }])
    expect(r.terminal).toBe(true)
  })

  test('proxies /api/ and /ws to the container, and serves the SPA from current/', () => {
    const [api] = proxied(r)
    expect(api.match).toEqual([{ path: ['/api/*', '/ws', '/ws/*'] }])
    expect(api.handle[0].upstreams).toEqual([{ dial: '127.0.0.1:3000' }])
    expect(inner(r).find(x => x.handle[0].handler === 'vars').handle[0].root).toBe('/apps/shop/current')
    expect(handlers(r)).toContain('file_server')
  })

  // A rewrite before the proxy would hand an app registered under apiPrefix
  // '/api' a path it has no route for (FJS-1100).
  test('rewrites nothing on the way to the app', () => {
    const before = inner(r).slice(0, inner(r).indexOf(proxied(r)[0]))
    expect(before.every(x => x.match)).toBe(true)
    expect(proxied(r)[0].handle.map(h => h.handler)).toEqual(['reverse_proxy'])
  })
})

describe('two origins', () => {
  const [web, api] = routesFor({ web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } })

  test('the web route serves the SPA and proxies nothing', () => {
    expect(web.match).toEqual([{ host: ['app.shop.example'] }])
    expect(proxied(web)).toEqual([])
  })

  test('the API route proxies every path and serves no files', () => {
    expect(api['@id']).toBe(routeId('shop', 'api'))
    expect(api.match).toEqual([{ host: ['api.shop.example'] }])
    const [p] = proxied(api)
    expect(p.match).toBeUndefined()
    expect(handlers(api)).not.toContain('vars')
  })

  // A paused app whose API origin still answered would go on taking writes
  // from every open tab.
  test('every route carries the pause guard, first', () => {
    expect(inner(web)[0]['@id']).toBe(guardId('shop'))
    expect(inner(api)[0]['@id']).toBe(guardId('shop', 'api'))
  })
})

test('a route matching every host is refused — it would take over the machine', () => {
  expect(() => routesFor({})).toThrow(/deploy\.web\.domain/)
  expect(() => routesFor({ web: false, api: { domain: 'api.shop.example' } })).not.toThrow()
})

// ─── applyEdge — the merge into Caddy's whole config ─────────────────────────

describe('applyEdge', () => {
  const routes = routesFor({ web: { domain: 'shop.example' } })
  const outpostRoute = { '@id': 'fjs-blog', match: [{ host: ['blog.example'] }], handle: [], terminal: true }
  const withOutpost = { apps: { http: { https_port: 443, servers: { [INGRESS_SERVER]: { listen: [':443'], routes: [outpostRoute] } } } } }

  test('creates the ingress server Outpost would, on an empty Caddy', () => {
    const out = applyEdge({}, { appId: 'shop', routes })
    expect(out.apps.http.servers[INGRESS_SERVER].listen).toEqual([':443'])
    expect(out.apps.http.servers[INGRESS_SERVER].routes.map(r => r['@id'])).toEqual([routeId('shop')])
  })

  test('keeps every route it did not write, and does not mutate what it read', () => {
    const before = structuredClone(withOutpost)
    const out = applyEdge(withOutpost, { appId: 'shop', routes })
    expect(out.apps.http.servers[INGRESS_SERVER].routes.map(r => r['@id'])).toEqual(['fjs-blog', routeId('shop')])
    expect(withOutpost).toEqual(before)
  })

  test('a second run replaces its own routes rather than adding beside them', () => {
    const once  = applyEdge(withOutpost, { appId: 'shop', routes })
    const twice = applyEdge(once, { appId: 'shop', routes })
    expect(twice).toEqual(once)
  })

  // Caddy answers the first match, so a second claim either takes the name
  // over or is never reached, depending on order.
  test('a hostname another route names is refused, naming the route', () => {
    const claim = routesFor({ web: { domain: 'blog.example' } })
    expect(() => applyEdge(withOutpost, { appId: 'shop', routes: claim })).toThrow(/blog\.example is already routed to fjs-blog/)
  })

  test('a split app made one origin loses its API route', () => {
    const split = applyEdge({}, { appId: 'shop', routes: routesFor({ web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } }) })
    const one   = applyEdge(split, { appId: 'shop', routes: routesFor({ web: { domain: 'app.shop.example' } }) })
    expect(one.apps.http.servers[INGRESS_SERVER].routes.map(r => r['@id'])).toEqual([routeId('shop')])
    expect(one.logging.logs[routeId('shop', 'api')]).toBeUndefined()
    expect(one.apps.http.servers[INGRESS_SERVER].logs.logger_names['api.shop.example']).toBeUndefined()
  })

  // Two apps writing into one file is the default a per-app log replaced; a
  // log nothing rolls grows until the disk does (FJS-616).
  test('each route logs to a file of its own, written once', () => {
    const out = applyEdge(withOutpost, { appId: 'shop', routes })
    const srv = out.apps.http.servers[INGRESS_SERVER]
    expect(srv.logs.logger_names['shop.example']).toEqual([routeId('shop')])
    expect(srv.logs.skip_unmapped_hosts).toBe(true)
    expect(out.logging.logs[routeId('shop')].writer).toEqual({ output: 'file', filename: accessLogPath(routeId('shop')) })
    expect(out.logging.logs.default.exclude).toEqual([`http.log.access.${routeId('shop')}`])
    const again = applyEdge(out, { appId: 'shop', routes })
    expect(again.logging.logs.default.exclude).toEqual([`http.log.access.${routeId('shop')}`])
  })
})

// ─── the admin API as scripts ────────────────────────────────────────────────

describe('reading and writing over the admin API', () => {
  test('a read carries the ETag the write sends back', () => {
    const r = parseConfigRead('HTTP/1.1 200 OK\r\nEtag: "/config/ 96d4"\r\nContent-Type: application/json\r\n\r\n{"apps":{}}\n')
    expect(r).toEqual({ etag: '"/config/ 96d4"', config: { apps: {} } })
    expect(writeConfigScript({}, r.etag)).toContain(`-H 'If-Match: "/config/ 96d4"'`)
  })

  test('an empty Caddy reads as an empty config, and no answer is refused by name', () => {
    expect(parseConfigRead('HTTP/1.1 200 OK\nEtag: x\n\nnull').config).toEqual({})
    expect(() => parseConfigRead('')).toThrow(/admin API/)
  })

  // The heredoc delimiter is quoted, so a placeholder survives the shell.
  test('the write sends the JSON untouched', () => {
    const script = writeConfigScript({ x: '{http.request.uri.path} $HOME' }, null)
    expect(script).toContain(`<< 'CADDYEOF'`)
    expect(script).toContain('{"x":"{http.request.uri.path} $HOME"}')
  })

  test('a write answers ok, stale, or Caddy\'s own words', () => {
    expect(parseConfigWrite('\n200')).toEqual({ ok: true })
    expect(parseConfigWrite('{"error":"If-Match header did not match"}\n412')).toEqual({ ok: false, stale: true })
    expect(parseConfigWrite('{"error":"loading new config: bad"}\n400').error).toContain('loading new config: bad')
  })
})

describe('the steps read the domains here, and nowhere else', () => {
  test('setup grades them, and the route step writes this module\'s routes', () => {
    expect(src('setup.md')).toContain('edgeNames(deployConf)')
    expect(src('_steps-setup/05-caddy.md')).toContain('edgeRoutes(')
    expect(src('_steps-setup/05-caddy.md')).toContain('applyEdge(')
    expect(src('_steps-setup/05-caddy.md')).not.toMatch(/reverse_proxy|"host"/)
  })

  test('the web build inlines the origin this module names, and checks the bundle carries it', () => {
    const build = src('_steps-docker/03-build-web.md')
    expect(build).toContain('apiOrigin(edgeNames(deployConf))')
    expect(build).toContain('VITE_API_URL=${origin}')
    expect(build).toMatch(/grep -rl .* '\$\{origin\}'/)
  })
})
