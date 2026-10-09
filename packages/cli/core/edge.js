/**
 * core/edge.js — what the EDGE of a deployed app is: the Caddy routes in front
 * of it, and the origin its browser build names for the API.
 *
 * One owner, three readers: `_steps-setup/05-caddy` writes the routes,
 * `_steps-docker/03-build-web` inlines the API origin into the web build, and
 * `_steps-setup/07-report` prints both. A domain read three ways is a route for
 * one name and a bundle calling another, which is a CORS error on the first
 * page load and nothing earlier (`FJS-1089`).
 *
 * ── One edge per machine ──────────────────────────────────────────────────
 *
 * Caddy runs as a host service managed through its admin API, the shape a fleet
 * machine already has (`FJS-D564`), and these routes join the SAME `ingress`
 * server Outpost writes to. Two front doors on one box both want :443, so the
 * box Basecamp is installed on could never also be a fleet machine. Each side
 * refuses a hostname the other already routes.
 *
 * ── Two shapes ─────────────────────────────────────────────────────────────
 *
 * **One origin** — `deploy.web.domain` alone. One route serves the SPA and
 * proxies `/api/` and `/ws` to the container, so the page and the API share an
 * origin and `junction.url` defaulting to `location.origin` is correct.
 *
 * **Two origins** — `deploy.api.domain` as well (`api.example.com` beside
 * `app.example.com`). The web route serves the SPA and proxies nothing; the API
 * route proxies every path. The web build is run with `VITE_API_URL` set to the
 * API's origin, which is the name every surface's sierra config reads.
 *
 * ── The path reaches the app unchanged ────────────────────────────────────
 *
 * `reverse_proxy` rewrites nothing, so `/api/orders` arrives as `/api/orders`
 * at an app whose routes are registered under `apiPrefix: '/api'` (`FJS-1100`).
 *
 * ── Certificates are Caddy's ──────────────────────────────────────────────
 *
 * A route naming a host is what makes Caddy fetch a certificate for it, and the
 * http→https redirect comes with it. There is no `ssl` key to configure, so one
 * left in a deploy block is refused rather than ignored.
 *
 * Pure functions over strings and JSON. Nothing here runs a command.
 */

import { caddyGuard, guardId } from './pause.js'

export class EdgeError extends Error {}

/** Outpost's server name (`outpost/src/ingress.js`). Shared on purpose — see above. */
export const INGRESS_SERVER = 'ingress'

/** Where the routes are written, from ON the target. Caddy binds it to loopback. */
export const CADDY_ADMIN = 'http://127.0.0.1:2019'

/**
 * How many proxies these routes put in front of the API: Caddy, and nothing
 * else. The deploy hands the count to the container as `FJS_TRUST_PROXY`
 * (`FJS-D617`), so a route that added a second hop without raising this would
 * key every caller on Caddy's address again.
 */
export const EDGE_HOPS = 1

// A hostname, and nothing a shell or a config could read as syntax: the value
// is interpolated into both.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i

/**
 * The two sides' names, graded.
 *
 * @returns {{ web: Side, api: Side }} where Side is `{ domain }`
 * @throws {EdgeError} naming the key
 */
export function edgeNames(deployConf) {
  const side = (name) => {
    const conf   = deployConf?.[name] ?? {}
    const domain = conf.domain ?? null
    if (domain !== null && !HOSTNAME.test(String(domain)))
      throw new EdgeError(`deploy.${name}.domain is ${JSON.stringify(domain)}, which is not a hostname. It is written into a Caddy route and a shell line, so it is refused rather than quoted.`)
    if (conf.ssl !== undefined)
      throw new EdgeError(`deploy.${name}.ssl is set. Caddy fetches the certificate for every domain it routes, so there is nothing to point it at. Remove the key.`)
    return { domain: domain === null ? null : String(domain).toLowerCase() }
  }
  const web = side('web')
  const api = side('api')

  if (api.domain && api.domain === web.domain)
    throw new EdgeError(`deploy.api.domain is the web domain. One origin is what leaving it unset means — the web route already proxies /api/ and /ws.`)

  return { web, api }
}

/** The API's public origin under two origins; null under one, where the page's own origin is right. */
export function apiOrigin(names) {
  return names.api.domain ? `https://${names.api.domain}` : null
}

/** A route's `@id`, which is also its access logger's name. `fli-`, so it never meets Outpost's `fjs-<app>`. */
export const routeId = (appId, side = 'web') => side === 'api' ? `fli-${appId}-api` : `fli-${appId}`

/** Where a route's access log is written. Caddy rolls it itself, so nothing else has to. */
export const accessLogPath = (id) => `/var/log/caddy/${id}.access.log`

/**
 * The routes `deploy:setup` writes: one, or two.
 *
 * The pause guard is the FIRST handler in every route — a paused app whose API
 * origin still answered would let every open tab go on writing through the
 * migration the pause exists for.
 *
 * @throws {EdgeError} when no side names a domain: Caddy routes by hostname, and
 *   a route matching every host would take over whatever else the machine serves.
 */
export function edgeRoutes({ appId, serverPath, apiPort, web, api }) {
  const split = Boolean(api?.domain)
  if (!web?.domain && !split)
    throw new EdgeError('deploy.web.domain is not set. Caddy routes by hostname and fetches a certificate for it, so the edge needs one.')

  const routes = []
  if (web?.domain) routes.push(route({
    id: routeId(appId), host: web.domain,
    inner: [caddyGuard(serverPath, guardId(appId)), ...(split ? [] : [apiRoute(apiPort, ['/api/*', '/ws', '/ws/*'])]), ...spa(serverPath)],
  }))
  if (split) routes.push(route({
    id: routeId(appId, 'api'), host: api.domain,
    inner: [caddyGuard(serverPath, guardId(appId, 'api')), apiRoute(apiPort)],
  }))
  return routes
}

const route = ({ id, host, inner }) => ({
  '@id':    id,
  match:    [{ host: [host] }],
  handle:   [{ handler: 'subroute', routes: inner }],
  terminal: true,
})

const apiRoute = (apiPort, paths = null) => ({
  ...(paths ? { match: [{ path: paths }] } : {}),
  // X-Forwarded-For carries the address Caddy observed and nothing a caller
  // sent, since no proxy in front of it is trusted. EDGE_HOPS is what tells
  // the app this one hop is there.
  handle:   [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${apiPort}` }] }],
  terminal: true,
})

// The SPA: a file that exists, else index.html. Root is read per request, so
// the `current` symlink swap is the whole of a web release — nothing reloads.
const spa = (serverPath) => [
  { handle: [{ handler: 'vars', root: `${serverPath}/current` }] },
  { match:  [{ file: { try_files: ['{http.request.uri.path}', '/index.html'] } }],
    handle: [{ handler: 'rewrite', uri: '{http.matchers.file.relative}' }] },
  { handle: [{ handler: 'encode', encodings: { gzip: {} }, prefer: ['gzip'] }, { handler: 'file_server' }] },
]

/**
 * Caddy's whole config with this app's routes and access logs in it.
 *
 * Read-modify-write over the full config, sent back with `If-Match`: a write
 * Outpost made in between is a 412 and a retry, not a route lost. Replaces
 * this app's routes wherever they are, removes one a previous shape left (a
 * split app that is now one origin), and refuses a hostname any other route
 * names — Caddy answers the first match, so a second claim either takes the
 * name over or is never reached, depending on order.
 *
 * Access logging is turned on for the ingress server with unmapped hosts
 * skipped, so an Outpost app logs exactly as much as before; each route gets a
 * file of its own, excluded from the default logger so it is not written twice.
 */
export function applyEdge(config, { appId, routes }) {
  const out    = structuredClone(config ?? {})
  const ours   = new Set([routeId(appId), routeId(appId, 'api')])
  const http   = (out.apps ??= {}).http ??= {}
  const server = (http.servers ??= {})[INGRESS_SERVER] ??= { listen: [`:${http.https_port ?? 443}`], routes: [] }

  const hosts = routes.flatMap(hostsOf)
  for (const other of server.routes ?? []) {
    if (ours.has(other['@id'])) continue
    const taken = hostsOf(other).filter(h => hosts.includes(h))
    if (taken.length)
      throw new EdgeError(`${taken.join(', ')} is already routed to ${other['@id'] ?? 'a route nobody named'} on this machine`)
  }
  server.routes = [...(server.routes ?? []).filter(r => !ours.has(r['@id'])), ...routes]

  const logs  = server.logs ??= {}
  logs.skip_unmapped_hosts ??= true
  const names = logs.logger_names ??= {}
  for (const [host, logger] of Object.entries(names))
    if ([logger].flat().some(l => ours.has(l))) delete names[host]
  const logging = (out.logging ??= {}).logs ??= {}
  for (const id of ours) delete logging[id]
  const dflt = logging.default ??= {}
  dflt.exclude = (dflt.exclude ?? []).filter(e => ![...ours].some(id => e === `http.log.access.${id}`))

  for (const r of routes) {
    const id = r['@id']
    for (const host of hostsOf(r)) names[host] = [id]
    logging[id] = {
      writer:  { output: 'file', filename: accessLogPath(id) },
      encoder: { format: 'json' },
      include: [`http.log.access.${id}`],
    }
    dflt.exclude.push(`http.log.access.${id}`)
  }
  return out
}

const hostsOf = (r) => (r.match ?? []).flatMap(m => m.host ?? []).map(h => String(h).toLowerCase())

// ─── the admin API, as scripts for the target's own shell ─────────────────────

/** Prints the response headers, a blank line, then the body. */
export const readConfigScript = () => `curl -s -D - ${CADDY_ADMIN}/config/`

/** The `{ etag, config }` a read answered. Throws when nothing Caddy-shaped came back. */
export function parseConfigRead(output) {
  const text  = String(output ?? '').replace(/\r/g, '')
  const split = text.indexOf('\n\n')
  if (!/^HTTP\/\S+ 200/.test(text) || split < 0)
    throw new EdgeError(`Caddy's admin API did not answer at ${CADDY_ADMIN} — is caddy-api running? ${text.split('\n')[0] ?? ''}`.trim())
  const etag = text.slice(0, split).match(/^etag:\s*(.+)$/mi)?.[1]?.trim() ?? null
  const body = text.slice(split + 2).trim()
  return { etag, config: body && body !== 'null' ? JSON.parse(body) : {} }
}

/**
 * The write. A QUOTED heredoc, and the quotes are the whole of it: a route is
 * full of `{http.request.uri.path}`, and a shell that expanded anything in it
 * would write a config that loads and serves the wrong thing.
 */
export function writeConfigScript(config, etag) {
  const ifMatch = etag ? ` -H 'If-Match: ${etag.replace(/'/g, '')}'` : ''
  return `curl -s -w '\\n%{http_code}' -X POST -H 'content-type: application/json'${ifMatch} --data-binary @- ${CADDY_ADMIN}/config/ << 'CADDYEOF'
${JSON.stringify(config)}
CADDYEOF`
}

/**
 * What a write answered: `ok`, `stale` (the config changed since it was read —
 * read again), or a refusal carrying Caddy's own words.
 */
export function parseConfigWrite(output) {
  const lines  = String(output ?? '').trim().split('\n')
  const status = Number(lines.pop())
  const said   = lines.join('\n').trim()
  if (status === 200) return { ok: true }
  if (status === 412) return { ok: false, stale: true }
  let error = said
  try { error = JSON.parse(said).error ?? said } catch {}
  return { ok: false, stale: false, error: `Caddy refused the config (${status || 'no answer'}): ${error}` }
}
