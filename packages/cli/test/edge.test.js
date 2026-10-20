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
import { createHash } from 'crypto'
import {
  edgeNames, apiOrigin, edgeRoutes, plainRoutes, applyEdge, routeId, accessLogPath, INGRESS_SERVER, PLAIN_SERVER,
  parseConfigRead, parseConfigWrite, writeConfigScript, EdgeError, inlineScriptHashes,
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
    expect(api.match).toEqual([{ path: ['/api', '/api/*', '/ws', '/ws/*'] }])
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

// FJS-3210: Caddy's automatic http→https redirect covers every host it routes,
// so a client sending the API plaintext was upgraded and never learned its
// first request had leaked. A :80 route refuses the API's paths first; the
// redirect stays for pages.
describe('plaintext on :80', () => {
  const plainFor = (deploy, paths = null) => {
    const names = edgeNames(deploy)
    return plainRoutes({ appId: 'shop', web: names.web, api: names.api, paths })
  }
  const refusals = (r) => r.handle[0].routes
  const one = plainFor({ web: { domain: 'shop.example' } })

  test('one origin: the API paths and /ws are answered 403, not redirected', () => {
    expect(one.map(r => r['@id'])).toEqual([routeId('shop', 'web', true)])
    const [r] = one
    expect(r.match).toEqual([{ host: ['shop.example'] }])
    expect(r.terminal).toBeUndefined()
    const [refuse] = refusals(r)
    expect(refuse.match).toEqual([{ path: ['/api', '/api/*', '/ws', '/ws/*'] }])
    expect(refuse.handle[0]).toMatchObject({ handler: 'static_response', status_code: 403 })
    expect(refuse.handle[0].body).toMatch(/https/i)
    expect(refuse.terminal).toBe(true)
  })

  // The route is not terminal and the pages are not matched, so a page request
  // falls through to the redirect Caddy adds for the host.
  test('pages are left to the redirect', () => {
    expect(refusals(one[0])).toHaveLength(1)
  })

  test('unprefixed, a navigation is a page and still redirects', () => {
    const [r] = plainFor({ web: { domain: 'shop.example' } }, { prefix: null, roots: ['/projects'] })
    const [refuse] = refusals(r)
    expect(refuse.match[0].path).toEqual(['/projects', '/projects/*', '/ws', '/ws/*'])
    expect(refuse.match[0].not).toEqual([{ header: { Accept: ['*text/html*'] }, not: [{ path: ['/auth/oauth/*'] }] }])
  })

  test('two origins: every path on the API host, and nothing on the web host', () => {
    const rs = plainFor({ web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } })
    expect(rs.map(r => r['@id'])).toEqual([routeId('shop', 'api', true)])
    expect(rs[0].match).toEqual([{ host: ['api.shop.example'] }])
    expect(refusals(rs[0])[0].match).toBeUndefined()
  })

  test('applyEdge writes them to a :80 server beside ingress, and drops them with the app', () => {
    const routes = routesFor({ web: { domain: 'shop.example' } })
    const plain  = plainFor({ web: { domain: 'shop.example' } })
    const out    = applyEdge({}, { appId: 'shop', routes, plain })
    expect(out.apps.http.servers[PLAIN_SERVER].listen).toEqual([':80'])
    expect(out.apps.http.servers[PLAIN_SERVER].routes.map(r => r['@id'])).toEqual([routeId('shop', 'web', true)])
    expect(applyEdge(out, { appId: 'shop', routes, plain })).toEqual(out)
    const gone = applyEdge(out, { appId: 'shop', routes: [] })
    expect(gone.apps.http.servers[PLAIN_SERVER]).toBeUndefined()
  })

  test('the pipeline hands them to the write', () => {
    expect(src('_module.md')).toContain('plainRoutes(')
    expect(src('_steps-setup/05-caddy.md')).toContain('plain')
    expect(src('_steps-docker/07b-edge.md')).toContain('plain')
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
    expect(src('_module.md')).toContain('edgeRoutes(')
    expect(src('_steps-setup/05-caddy.md')).toContain('edgeRoutesFor(')
    expect(src('_steps-docker/07b-edge.md')).toContain('edgeRoutesFor(')
    expect(src('_module.md')).toContain('applyEdge(')
    expect(src('_steps-setup/05-caddy.md')).not.toMatch(/reverse_proxy|"host"/)
  })

  test('the web build inlines the origin this module names, and checks the bundle carries it', () => {
    const build = src('_steps-docker/03-build-web.md')
    expect(build).toContain('apiOrigin(edgeNames(deployConf))')
    expect(build).toContain('FRONTIER_PUBLIC_API_URL=${origin}')
    expect(build).toMatch(/grep -rl .* '\$\{origin\}'/)
  })
})

// Caddy's file_server sends no header of its own, and helmet is a Junction
// router middleware, so the document a person uses reached the browser
// frameable, sniffable and with no script policy (FJS-3190, FJS-D1205).
describe('the document the web route serves', () => {
  const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`
  const theme = 'document.documentElement.classList.add("dark")'
  const sw    = "if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js')"
  const html  = `<html><head><script id="sierra-theme">${theme}</script>` +
    '<script type="module" crossorigin src="/assets/index.js"></script></head>' +
    `<body><script>${sw}</script></body></html>`
  const served    = (r) => inner(r).at(-1)
  const headersOf = (r) => served(r).handle.find(h => h.handler === 'headers')?.response?.set ?? {}

  test('hashes each inline script and nothing with a src', () => {
    expect(inlineScriptHashes(html)).toEqual([sha(theme), sha(sw)])
    expect(inlineScriptHashes('')).toEqual([])
  })

  test('carries nosniff, a referrer policy and both framing refusals', () => {
    const [r] = routesFor({ web: { domain: 'shop.example' } })
    const h = headersOf(r)
    expect(h['X-Content-Type-Options']).toEqual(['nosniff'])
    expect(h['Referrer-Policy']).toEqual(['strict-origin-when-cross-origin'])
    expect(h['X-Frame-Options']).toEqual(['DENY'])
    expect(h['Content-Security-Policy'][0]).toContain("frame-ancestors 'none'")
  })

  test('allows its own scripts and the inline ones it was built with, by hash', () => {
    const names = edgeNames({ web: { domain: 'shop.example' } })
    const [r] = edgeRoutes({ appId: 'shop', serverPath: '/apps/shop', apiPort: 3000, ...names, scripts: inlineScriptHashes(html) })
    const csp = headersOf(r)['Content-Security-Policy'][0]
    expect(csp).toContain(`script-src 'self' 'wasm-unsafe-eval' ${sha(theme)} ${sha(sw)}`)
    expect(csp).toContain("object-src 'none'")
    expect(csp).not.toContain('unsafe-inline')
  })

  // The headers are the SPA's: a response the API sends is helmet's to dress.
  test('sit after the proxy, so the API\'s own responses keep their headers', () => {
    const [r] = routesFor({ web: { domain: 'shop.example' } })
    expect(inner(r).indexOf(served(r))).toBeGreaterThan(inner(r).indexOf(proxied(r)[0]))
    expect(proxied(r)[0].handle.map(h => h.handler)).toEqual(['reverse_proxy'])
    const [, api] = routesFor({ web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } })
    expect(JSON.stringify(api)).not.toContain('Content-Security-Policy')
  })

  test('both steps that write the routes hash the index.html being served', () => {
    expect(src('_steps-docker/07b-edge.md')).toMatch(/index\.html/)
    expect(src('_steps-setup/05-caddy.md')).toMatch(/index\.html/)
  })
})
