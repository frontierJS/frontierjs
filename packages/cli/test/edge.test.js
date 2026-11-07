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
  edgeNames, apiOrigin, edgeRoutes, plainRoutes, applyEdge, routeId, accessLogPath, INGRESS_SERVER, PLAIN_SERVER, CLOUDFLARE_RANGES,
  parseConfigRead, parseConfigWrite, heldBy, doorRefusal, writeConfigScript, routeDials, EdgeError, inlineScriptHashes, inlineStyleHashes, OAUTH_WELL_KNOWN,
} from '../core/edge.js'
import { guardId } from '../core/pause.js'
import { checkDiscovery } from '../core/discovery-probe.js'
import { STREAM_CLOSE_DELAY } from '../core/swap.js'

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
    expect(api.match).toEqual([{ path: ['/api', '/api/*', '/ws', '/ws/*', OAUTH_WELL_KNOWN] }])
    expect(api.handle[0].upstreams).toEqual([{ dial: '127.0.0.1:3000' }])
    expect(inner(r).find(x => x.handle[0].handler === 'vars').handle[0].root).toBe('/apps/shop/current')
    expect(handlers(r)).toContain('file_server')
  })

  // A connector probes the issuer's ORIGIN, which is outside apiPrefix; the
  // page's file server would answer with the SPA shell and the sign-in
  // would read as unsupported. Caddy's trailing `*` is a prefix match that
  // crosses slashes, so one glob covers both documents and the path-suffixed form.
  test('proxies the OAuth discovery documents to the container', () => {
    const [api] = proxied(r)
    const [glob] = api.match[0].path.filter(p => p.includes('.well-known'))
    const covers = (path) => path.startsWith(glob.slice(0, -1))
    expect(glob).toBe('/.well-known/oauth-*')
    expect(covers('/.well-known/oauth-authorization-server')).toBe(true)
    expect(covers('/.well-known/oauth-protected-resource/api/mcp')).toBe(true)
    expect(covers('/.well-known/security.txt')).toBe(false)
    expect(api.handle[0].upstreams).toEqual([{ dial: '127.0.0.1:3000' }])
  })

  // A rewrite before the proxy would hand an app registered under apiPrefix
  // '/api' a path it has no route for (FJS-1100).
  test('rewrites nothing on the way to the app', () => {
    const before = inner(r).slice(0, inner(r).indexOf(proxied(r)[0]))
    expect(before.every(x => x.match)).toBe(true)
    expect(proxied(r)[0].handle.map(h => h.handler)).toEqual(['reverse_proxy'])
  })

  // Unset, another app's deploy writes Caddy's config and closes this app's
  // WebSockets (FJS-4016); the value is Outpost's, so the two writers agree.
  test('keeps its WebSockets open across a config write', () => {
    expect(proxied(r)[0].handle[0].stream_close_delay).toBe(STREAM_CLOSE_DELAY)
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
    expect(JSON.stringify(api)).not.toContain('.well-known')
    expect(JSON.stringify(web)).not.toContain('.well-known')
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

  // Every live record is proxied, so the socket peer is a Cloudflare edge; a
  // server that trusted nobody keyed every visitor on that one address.
  test('trusts Cloudflare about the client it fronts, and hands the API one hop', () => {
    const split = routesFor({ web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } })
    const out   = applyEdge(withOutpost, { appId: 'shop', routes: split, plain: plainRoutes({ appId: 'shop', web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } }) })
    for (const name of [INGRESS_SERVER, PLAIN_SERVER]) {
      const srv = out.apps.http.servers[name]
      expect(srv.trusted_proxies).toEqual({ source: 'static', ranges: CLOUDFLARE_RANGES })
      expect(srv.client_ip_headers).toEqual(['CF-Connecting-IP'])
    }
    expect(JSON.stringify(split)).toContain('"X-Forwarded-For":["{http.vars.client_ip}"]')
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
    expect(build).toContain('webBuildEnv({ commit, apiOrigin: origin })')
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

  test('a hashed bundle file is immutable for a year and the page is checked every load', () => {
    const [r] = routesFor({ web: { domain: 'shop.example' } })
    const cacheOf = (path) => inner(r).find(x => x.match?.[0]?.path?.[0] === path && x.handle[0].handler === 'headers')
      ?.handle[0].response.set['Cache-Control']
    expect(cacheOf('/assets/*')).toEqual(['public, max-age=31536000, immutable'])
    expect(cacheOf('/index.html')).toEqual(['no-cache'])
  })

  test('a missing bundle file is an uncached 404, never the page (FJS-4014)', () => {
    const [r] = routesFor({ web: { domain: 'shop.example' } })
    const routes = inner(r)
    const missing = routes.findIndex(x => x.handle[0].handler === 'static_response' && x.match?.[0]?.path?.[0] === '/assets/*')
    const fallback = routes.findIndex(x => x.match?.[0]?.file?.try_files?.includes('/index.html'))
    expect(missing).toBeGreaterThan(-1)
    expect(missing).toBeLessThan(fallback)
    expect(routes[missing].match[0].not).toEqual([{ file: { try_files: ['{http.request.uri.path}'] } }])
    expect(routes[missing].handle[0]).toMatchObject({ status_code: 404, headers: { 'Cache-Control': ['no-cache'] } })
    expect(routes[missing].terminal).toBe(true)
  })

  test('pins the origin to https for a year, and no subdomain with it', () => {
    const [r] = routesFor({ web: { domain: 'shop.example' } })
    expect(headersOf(r)['Strict-Transport-Security']).toEqual(['max-age=31536000'])
  })

  test('allows its own scripts and the inline ones it was built with, by hash', () => {
    const names = edgeNames({ web: { domain: 'shop.example' } })
    const [r] = edgeRoutes({ appId: 'shop', serverPath: '/apps/shop', apiPort: 3000, ...names, scripts: inlineScriptHashes(html) })
    const csp = headersOf(r)['Content-Security-Policy'][0]
    expect(csp).toContain(`script-src 'self' 'wasm-unsafe-eval' ${sha(theme)} ${sha(sw)}`)
    expect(csp).toContain("object-src 'none'")
    expect(csp).not.toContain('unsafe-inline')
  })

  // FJS-D1192's default, so a page refused under junction is refused here too.
  test('falls back to its own origin for everything it does not name', () => {
    const [r] = routesFor({ web: { domain: 'shop.example' } })
    const csp = headersOf(r)['Content-Security-Policy'][0]
    expect(csp).toStartWith("default-src 'self'; ")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("img-src 'self' data:;")
    expect(csp).not.toContain('connect-src')
    expect(csp).not.toContain('style-src')
  })

  test('names a split API origin for the calls and stored files the page fetches', () => {
    const [r] = routesFor({ web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } })
    const csp = headersOf(r)['Content-Security-Policy'][0]
    expect(csp).toContain("connect-src 'self' https://api.shop.example")
    expect(csp).toContain("img-src 'self' data: https://api.shop.example")
  })

  // A prerendered page is the one place a style= reaches the browser as markup
  // (FJS-D1464); the browser hashes the value after decoding its entities.
  test('allows each style= a served page carries, by hash, and no other', () => {
    const page = '<div style="height: 120vh" aria-hidden="true"></div>' +
      `<p style='font-family: &quot;Inter&quot;'>x</p><div style="height: 120vh"></div>` +
      '<script>el.innerHTML = \'<b style="color: red">\'</script>'
    expect(inlineStyleHashes(page)).toEqual([sha('height: 120vh'), sha('font-family: "Inter"')])
    expect(inlineStyleHashes(html)).toEqual([])
    const names = edgeNames({ web: { domain: 'shop.example' } })
    const [r] = edgeRoutes({ appId: 'shop', serverPath: '/apps/shop', apiPort: 3000, ...names, styles: inlineStyleHashes(page) })
    expect(headersOf(r)['Content-Security-Policy'][0]).toContain(`style-src-attr 'unsafe-hashes' ${sha('height: 120vh')} ${sha('font-family: "Inter"')}`)
  })

  // The headers are the SPA's: a response the API sends is helmet's to dress.
  test('sit after the proxy, so the API\'s own responses keep their headers', () => {
    const [r] = routesFor({ web: { domain: 'shop.example' } })
    expect(inner(r).indexOf(served(r))).toBeGreaterThan(inner(r).indexOf(proxied(r)[0]))
    expect(proxied(r)[0].handle.map(h => h.handler)).toEqual(['reverse_proxy'])
    const [, api] = routesFor({ web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } })
    expect(JSON.stringify(api)).not.toContain('Content-Security-Policy')
  })

  test('both steps that write the routes hash every page being served', () => {
    expect(src('_steps-docker/07b-edge.md')).toMatch(/-name '\*\.html'/)
    expect(src('_steps-setup/05-caddy.md')).toMatch(/-name '\*\.html'/)
  })
})

describe('routeDials (FJS-D1890)', () => {
  const proxy = (dial) => ({ handler: 'reverse_proxy', upstreams: [{ dial }] })
  const config = (...routes) => ({ apps: { http: { servers: { [INGRESS_SERVER]: { routes } } } } })

  test('reads each side\'s dial, the web route\'s nested API proxy included', () => {
    const web = { '@id': 'fli-shop', handle: [{ handler: 'subroute', routes: [{ handle: [proxy('127.0.0.1:3000')] }, { handle: [{ handler: 'file_server' }] }] }] }
    const api = { '@id': 'fli-shop-api', handle: [proxy('127.0.0.1:3001')] }
    expect(routeDials(config(web, api), 'shop')).toEqual([
      { id: 'fli-shop', dial: '127.0.0.1:3000', port: 3000 },
      { id: 'fli-shop-api', dial: '127.0.0.1:3001', port: 3001 },
    ])
  })

  test('another app\'s route, Outpost\'s and a non-loopback dial are not this app\'s', () => {
    const other = { '@id': 'fli-other', handle: [proxy('127.0.0.1:1')] }
    const outpost = { '@id': 'fjs-shop', handle: [proxy('127.0.0.1:2')] }
    const remote = { '@id': 'fli-shop', handle: [proxy('10.0.0.5:3')] }
    expect(routeDials(config(other, outpost, remote), 'shop')).toEqual([])
  })

  test('no Caddy config, or no ingress server, is no dials', () => {
    expect(routeDials({}, 'shop')).toEqual([])
    expect(routeDials(undefined, 'shop')).toEqual([])
  })
})

// FJS-4026: a release copied every asset its predecessor held, merged ones
// included, so release N carried release 1's files and pruning freed none.
// Runs the step's own merge and prune scripts against a directory, three deploys.
describe('the web release merge (FJS-4026)', () => {
  const { execFileSync } = require('child_process')
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync, rmSync } = require('fs')
  const { tmpdir } = require('os')
  const { join } = require('path')

  const step    = src('_steps-docker/03-build-web.md')
  const merge   = step.match(/machine\.run\(`(\[ -d "\$\{releaseDir\}[^`]*)`\)/)[1]
  const prune   = step.match(/machine\.run\(`(ls -1dt [^`]*xargs rm -rf --)`\)/)[1]
  const render  = (script, vars) => new Function(...Object.keys(vars), `return \`${script}\``)(...Object.values(vars))

  test('a kept release holds the files of the releases kept with it, and no older one', () => {
    const serverPath = mkdtempSync(join(tmpdir(), 'fjs-4026-'))
    const assetDir = 'assets'
    const keepReleases = 2
    try {
      let tick = 1_000_000
      const deploy = (commit) => {
        const releaseDir = `${serverPath}/releases/${commit}`
        mkdirSync(`${releaseDir}/${assetDir}`, { recursive: true })
        writeFileSync(`${releaseDir}/index.html`, commit)
        writeFileSync(`${releaseDir}/${assetDir}/${commit}.js`, commit)
        utimesSync(releaseDir, tick, tick++)
        const vars = { serverPath, releaseDir, assetDir, keepReleases }
        execFileSync('bash', ['-c', render(merge, vars)])
        execFileSync('bash', ['-c', render(prune, vars)])
      }
      deploy('aaaaaaa'); deploy('bbbbbbb'); deploy('ccccccc')
      expect(readdirSync(`${serverPath}/releases`).sort()).toEqual(['bbbbbbb', 'ccccccc'])
      const held = readdirSync(`${serverPath}/releases/ccccccc/${assetDir}`).sort()
      expect(held).toEqual(['bbbbbbb.js', 'ccccccc.js'])
      expect(existsSync(`${serverPath}/releases/ccccccc/${assetDir}/aaaaaaa.js`)).toBe(false)
    } finally { rmSync(serverPath, { recursive: true, force: true }) }
  })
})

// ─── the OAuth discovery probe (FJS-D1946) ───────────────────────────────────
// RFC 8414 puts the document at the origin's root, where a front door that did
// not write `OAUTH_WELL_KNOWN` hands the SPA shell to a connector.

describe('the discovery probe after the edge is written', () => {
  const WITH_OAUTH = { routes: [{ method: 'GET', path: '/.well-known/oauth-authorization-server', kind: 'raw' }] }
  const AUTH_ONLY  = { routes: [{ method: 'POST', path: '/api/auth/login', kind: 'raw' }] }
  const ONE        = edgeNames({ web: { domain: 'shop.example' } })
  const TWO        = edgeNames({ web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } })
  const stub       = (fn) => { const calls = []; const f = async (url, init) => { calls.push(url); return fn(url, init) }; f.calls = calls; return f }
  const json       = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  test('a 200 JSON body naming this origin as issuer is silent', async () => {
    const fetch = stub(() => json({ issuer: 'https://shop.example' }))
    const out = await checkDiscovery({ snapshot: WITH_OAUTH, names: ONE, fetch })
    expect(out).toEqual({ probed: true, url: 'https://shop.example/.well-known/oauth-authorization-server', warning: null })
    expect(fetch.calls).toEqual(['https://shop.example/.well-known/oauth-authorization-server'])
  })

  test('a 404 warns, naming the URL and the status, and what to add', async () => {
    const out = await checkDiscovery({ snapshot: WITH_OAUTH, names: ONE, fetch: stub(() => new Response('nope', { status: 404 })) })
    expect(out.warning).toContain('https://shop.example/.well-known/oauth-authorization-server')
    expect(out.warning).toContain('answered 404')
    expect(out.warning).toContain('/.well-known/oauth-*')
  })

  test('the SPA shell (200, not JSON) warns', async () => {
    const out = await checkDiscovery({ snapshot: WITH_OAUTH, names: ONE, fetch: stub(() => new Response('<!doctype html>', { status: 200 })) })
    expect(out.warning).toContain('not JSON')
  })

  test('JSON naming another issuer warns', async () => {
    const out = await checkDiscovery({ snapshot: WITH_OAUTH, names: ONE, fetch: stub(() => json({ issuer: 'http://localhost:3000' })) })
    expect(out.warning).toContain('http://localhost:3000')
  })

  test('a refused connection warns and does not throw', async () => {
    const out = await checkDiscovery({ snapshot: WITH_OAUTH, names: ONE, fetch: stub(() => { throw new TypeError('Unable to connect') }) })
    expect(out.warning).toContain('did not answer')
    expect(out.warning).toContain('Unable to connect')
  })

  test('a real refused port is a warning too', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('') })
    const port = server.port
    server.stop(true)
    const out = await checkDiscovery({ snapshot: WITH_OAUTH, names: ONE, timeoutMs: 2000,
      fetch: (url, init) => fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init) })
    expect(out.probed).toBe(true)
    expect(out.warning).toContain('did not answer')
  })

  test('a silent server times out into a warning', async () => {
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    const out = await checkDiscovery({ snapshot: WITH_OAUTH, names: ONE, fetch: hang, timeoutMs: 30 })
    expect(out.warning).toContain('no reply in')
  })

  test('an App with auth routes but no OAuth server makes no request', async () => {
    const fetch = stub(() => json({}))
    expect(await checkDiscovery({ snapshot: AUTH_ONLY, names: ONE, fetch })).toEqual({ probed: false })
    expect(await checkDiscovery({ snapshot: null, names: ONE, fetch })).toEqual({ probed: false })
    expect(fetch.calls).toEqual([])
  })

  test('no domain at all makes no request', async () => {
    const fetch = stub(() => json({}))
    expect(await checkDiscovery({ snapshot: WITH_OAUTH, names: edgeNames({}), fetch })).toEqual({ probed: false })
    expect(fetch.calls).toEqual([])
  })

  test('two origins probe the API domain, and its issuer is the API origin', async () => {
    const fetch = stub(() => json({ issuer: 'https://api.shop.example' }))
    const out = await checkDiscovery({ snapshot: WITH_OAUTH, names: TWO, fetch })
    expect(out.warning).toBe(null)
    expect(fetch.calls).toEqual(['https://api.shop.example/.well-known/oauth-authorization-server'])
  })

  test('the route step runs it after the write, as a warning', () => {
    const step = src('_steps-docker/07b-edge.md')
    expect(step).toContain('checkDiscovery(')
    expect(step.indexOf('checkDiscovery(')).toBeGreaterThan(step.indexOf('writeEdge('))
    expect(step).toContain('log.warn(`OAuth discovery:')
  })
})

describe('one door per app on a box (FJS-D1967)', () => {
  const read = (routes) => parseConfigRead(`HTTP/1.1 200 OK\nEtag: x\n\n${JSON.stringify({ apps: { http: { servers: { ingress: { routes } } } } })}`).config

  test('a Basecamp App routing the deploy hostname refuses the release, naming the move to this door', () => {
    const config = read([
      { '@id': 'fli-shop', match: [{ host: ['shop.example.com'] }] },
      { '@id': 'fjs-0b4c', match: [{ host: ['shop.example.com', 'www.example.com'] }] },
    ])
    const theirs = heldBy(config, 'basecamp', ['shop.example.com'])
    expect(theirs).toEqual([{ id: 'fjs-0b4c', hosts: ['shop.example.com'] }])
    const said = doorRefusal('ssh', theirs)
    expect(said).toContain('shop.example.com is served on this box by a Basecamp App (fjs-0b4c)')
    expect(said).toContain('fli deploy:move --to=ssh')
  })

  test('this door\'s own routes and another hostname are no refusal', () => {
    const config = read([{ '@id': 'fli-shop', match: [{ host: ['shop.example.com'] }] },
                         { '@id': 'fjs-0b4c', match: [{ host: ['blog.example.com'] }] }])
    expect(heldBy(config, 'basecamp', ['shop.example.com'])).toEqual([])
  })

  test('the preflight asks before the lock, so a refused release holds nothing on the box', () => {
    const step = readFileSync(new URL('../commands/deploy/_steps-docker/01-preflight.md', import.meta.url), 'utf8')
    expect(step).toContain("heldBy(config, 'basecamp', names)")
    expect(step.indexOf("heldBy(config, 'basecamp'")).toBeLessThan(step.indexOf('acquireLock('))
  })

  // An empty deploy.web.domain was refused by 03-build-web, after the ship and
  // the server install had already run.
  test('a web domain that is not a hostname is refused in the preflight, not at the web build', () => {
    expect(() => edgeNames({ web: { domain: '' } })).toThrow(EdgeError)
    const step = readFileSync(new URL('../commands/deploy/_steps-docker/01-preflight.md', import.meta.url), 'utf8')
    const refusal = step.slice(step.indexOf('edgeNames(deployConf)'), step.indexOf('acquireLock('))
    expect(refusal).toMatch(/if \(\$\.config\.doWeb\) \{\s*log\.error\(e\.message\)\s*\$\.config\.abort = true\s*return/)
  })
})
