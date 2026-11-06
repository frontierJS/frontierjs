/*
 * ingress.js — the machine's front door: Caddy, told about an app's hostnames
 * through its admin API (`FJS-D564`).
 *
 * Caddy runs as a host service the install put there, and this is the only
 * thing that writes its config. There is no config file and no reload: a route
 * is one JSON object with the app's `@id`, PATCHed in place on a redeploy and
 * DELETEd on a stop. Certificates are Caddy's own automatic HTTPS — a route
 * naming a host is what makes Caddy fetch one for it.
 *
 * **What puts the routes back when Caddy restarts on its own is Caddy.** The
 * install runs it as `caddy run --resume`, which reloads the config the admin
 * API last autosaved, so this process holds no route state and has nothing to
 * replay. Proved by `verify-docker.mjs` restarting Caddy under a live route.
 *
 * The ingress SERVER is created on the first route rather than at start, so a
 * machine with no Caddy on it — a dev box, basecamp's own co-resident Outpost —
 * deploys an app with no hostname exactly as before. Its listen port is read
 * off Caddy's own `https_port`, which is the machine's setting and not this
 * process's.
 */

import { X509Certificate, createPrivateKey } from 'node:crypto'
import { heldBy } from './doors.js'
import { ROOTS } from './layout.js'
import { repointRoutes, STREAM_CLOSE_DELAY } from './swap.js'

const SERVER = 'ingress'
/** Reads a guarded write may repeat when another writer got in between: three
 *  were exhausted by `fli deploy` landing routes back to back (`FJS-4030`). */
const WRITE_ATTEMPTS = 10
/** After a 412, random so two writers do not fall into step; the other one's
 *  write and Caddy's load of it fit in the gap. */
const backoff = (attempt) => sleep(Math.random() * 10 * attempt)
/** Sends of one admin call reset by Caddy swapping its admin listener. */
const RESET_SENDS = 3
/** Caddy negotiates from Accept-Encoding and passes an answer through unencoded
 *  when it is already encoded, short, or a type it does not compress. */
const ENCODE = { handler: 'encode', encodings: { zstd: {}, gzip: {} }, prefer: ['zstd', 'gzip'] }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const isReset = (err) => err?.code === 'ECONNRESET' || /ECONNRESET/.test(err?.message ?? '')
/** A DNS name, lowercased. A route names no wildcard host: a wildcard
 *  CERTIFICATE arrives minted by Basecamp (`loadCert`), so DNS-01 and the DNS
 *  vendor's token stay off the machine (`FJS-D1975`, `IDEAS/fleet-ingress.md` D6). */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** The route's `@id`, which is the container's name — one noun for one app. */
export const routeId = (appId) => `fjs-${appId}`

/** Where a route's access log is written; Caddy rolls it. `fli deploy` names
 *  its own routes' the same way under `fli-`, so the two never share a file. */
export const accessLogPath = (id) => `${ROOTS.logs}/${id}.access.log`

/**
 * The ingress server's `logs` and Caddy's `logging` with `hosts` logged to the
 * app's own file, or to none. Caddy writes no access line for a route unless
 * the server names a logger for the host, and a logger no `include` claims
 * lands in the default log as well, so the default excludes it (`FJS-D763`).
 * Unmapped hosts are skipped, so the machine logs only what a route names.
 */
export function accessLogFor(config, id, hosts) {
  const logs  = structuredClone(config?.apps?.http?.servers?.[SERVER]?.logs ?? {})
  logs.skip_unmapped_hosts ??= true
  const names = logs.logger_names ??= {}
  for (const [host, logger] of Object.entries(names))
    if ([logger].flat().includes(id)) delete names[host]
  for (const host of hosts) names[host] = [id]

  const logging = structuredClone(config?.logging ?? {})
  const loggers = logging.logs ??= {}
  delete loggers[id]
  const dflt    = loggers.default
  const exclude = (dflt?.exclude ?? []).filter(e => e !== `http.log.access.${id}`)
  if (hosts.length) {
    loggers[id] = {
      writer:  { output: 'file', filename: accessLogPath(id) },
      encoder: { format: 'json' },
      include: [`http.log.access.${id}`],
    }
    exclude.push(`http.log.access.${id}`)
  }
  if (dflt || exclude.length) (loggers.default ??= {}).exclude = exclude
  return { logs, logging }
}

/** The hostnames a /deploy names, lowercased and de-duplicated, or a refusal
 *  naming the first bad one. Asked BEFORE the old container goes, so a typo
 *  fails the release with the app still up. */
export function hostsOf(list) {
  if (list == null) return []
  if (!Array.isArray(list)) throw new Error(`hosts must be a list of hostnames — got ${JSON.stringify(list)}`)
  const hosts = [...new Set(list.map(h => String(h).trim().toLowerCase()))]
  const bad   = hosts.find(h => !HOSTNAME.test(h))
  if (bad !== undefined) throw new Error(`'${bad}' is not a hostname this machine can route`)
  return hosts
}

/** The redirect route's `@id`: the app's own id with a suffix, so a stop that
 *  takes `fjs-<app>` takes this one with it. */
export const redirectsId = (appId) => `${routeId(appId)}-redirects`

/** The `{host, to}` pairs a /deploy names, hosts lowercased and de-duplicated,
 *  or a refusal naming the first bad one. `to` is an absolute http(s) URL:
 *  Caddy expands `{…}` in a header value, so a target holding a brace would
 *  read the machine's environment into a response, and a relative one is a
 *  redirect to a path on the redirecting host. */
export function redirectsOf(list) {
  if (list == null) return []
  if (!Array.isArray(list)) throw new Error(`redirects must be a list of { host, to } — got ${JSON.stringify(list)}`)
  const seen = new Set()
  return list.map(r => {
    const [host] = hostsOf([r?.host])
    const to     = String(r?.to ?? '').trim()
    let url
    try { url = new URL(to) } catch {}
    if (!url || !/^https?:$/.test(url.protocol) || /[{}]/.test(to))
      throw new Error(`'${to}' is not a URL a redirect from ${host} can point at — it must be http(s) and hold no braces`)
    if (seen.has(host)) throw new Error(`${host} is redirected twice`)
    seen.add(host)
    return { host, to }
  })
}

/** Sent on the hosts a route's `noindex` names: Basecamp lists the App's
 *  ingress name there (`FJS-D1952`), so a search engine indexes the Domain and
 *  never the name every App has (`IDEAS/ingress-name.md` § Security 5). The
 *  caller states it because the zone is the caller's: a guess from the host's
 *  shape marked an app `shop`'s own `shop.example.com`. */
const NOINDEX = { 'X-Robots-Tag': ['noindex'] }

/** One path route's `@id` prefix: an app may hold many, and each is its own
 *  route because Caddy answers the first match in order and the order is by
 *  prefix length, which a route holding two prefixes cannot have. */
export const pathRouteId = (appId) => `${routeId(appId)}-path-`

/** Is `id` one of THIS app's path routes. Matched whole: a prefix test took
 *  `fjs-a-path-0`, app `a-path-0`'s own route, for app `a`'s path route. */
const isPathRouteOf = (appId, id) =>
  typeof id === 'string' && id.startsWith(pathRouteId(appId)) && /^[0-9]+$/.test(id.slice(pathRouteId(appId).length))

/** An app id a route may be written for: a plain name, and not one that spells
 *  another app's `-redirects` or `-path-<n>` route id, which would be that
 *  app's route to Caddy. */
export function checkRouteAppId(appId) {
  if (typeof appId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(appId))
    throw new Error(`app_id '${appId}' is not a plain name`)
  if (appId.startsWith('cert-'))
    throw new Error(`app_id '${appId}' starts the way a certificate id does and would collide with its @id`)
  if (/-redirects$|-path-[0-9]+$/.test(appId))
    throw new Error(`app_id '${appId}' ends the way a route id does and would collide with another app's route`)
}

/** A pushed certificate's `@id`. It shares Caddy's one `/id/` namespace with
 *  the routes, which is why `checkRouteAppId` refuses an app id starting `cert-`. */
export const certId = (id) => `fjs-cert-${id}`

/**
 * A certificate Caddy can be handed, or a refusal in words, BEFORE anything is
 * written: a key that is not the certificate's, or a certificate past its end,
 * would be accepted by `load_pem` only to fail the config load, and Caddy
 * rejecting the whole config stops every route being written after it.
 * Answers the SAN's names and the expiry.
 */
export function readCert({ id, cert, key }, now = Date.now()) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))
    throw new Error(`cert id '${id}' is not a plain name`)
  let x509, priv
  try { x509 = new X509Certificate(String(cert)) } catch { throw new Error('cert is not a PEM certificate') }
  try { priv = createPrivateKey(String(key)) } catch { throw new Error('key is not a PEM private key') }
  if (!x509.checkPrivateKey(priv)) throw new Error('key does not match the certificate')
  const expires = new Date(x509.validTo)
  if (!(expires.getTime() > now)) throw new Error(`the certificate expired ${expires.toISOString()}`)
  const names = (x509.subjectAltName ?? '').split(',').map(n => n.trim())
    .filter(n => n.startsWith('DNS:')).map(n => n.slice(4).toLowerCase())
  return { id, names, expires_at: expires.toISOString() }
}

/** A path prefix: segments of URL-safe characters, no wildcard, no trailing
 *  slash. Caddy's path matcher expands `*` and `{…}`, so a prefix holding
 *  either would match more than the Domain's owner wrote. */
const PREFIX = /^(?:\/[a-z0-9._~-]+)+$/

/** The `{host, prefix}` pairs a /deploy names (`FJS-D1040`): this app answers
 *  `prefix` on `host`, ahead of whichever app answers the rest of that host.
 *  Hosts and prefixes are lowercased because Caddy matches a path without
 *  case; a repeat or a prefix that is `/` itself is refused by name, since the
 *  host is what routes the whole of it. */
export function pathsOf(list) {
  if (list == null) return []
  if (!Array.isArray(list)) throw new Error(`paths must be a list of { host, prefix } — got ${JSON.stringify(list)}`)
  const seen = new Set()
  return list.map(p => {
    const [host] = hostsOf([p?.host])
    const prefix = String(p?.prefix ?? '').trim().toLowerCase().replace(/\/+$/, '')
    if (!PREFIX.test(prefix) || prefix.split('/').some(seg => seg === '.' || seg === '..'))
      throw new Error(`'${p?.prefix}' is not a path prefix ${host} can route — it must start with / and name a segment, with no wildcard or braces (the host itself routes the whole of it)`)
    if (seen.has(host + prefix)) throw new Error(`${host}${prefix} is routed twice`)
    seen.add(host + prefix)
    return { host, prefix }
  })
}

/** Path routes first, the longest prefix leading, every other route behind
 *  them in the order it already had: a host-wide route listed before a path
 *  route on the same host would answer the path itself. */
const ordered = (routes) => {
  const depth = (r) => Math.max(-1, ...(r.match ?? []).flatMap(m => m.path ? [m.path[0].length] : []))
  return routes.map((r, i) => ({ r, i, d: depth(r) })).sort((a, b) => b.d - a.d || a.i - b.i).map(x => x.r)
}

/** A target naming only an origin keeps the request's path and query, so
 *  `www.shop.test/cart` lands on `shop.test/cart`; one naming a page IS that page. */
const locationFor = (to) => {
  const url = new URL(to)
  return url.pathname === '/' && !url.search && !url.hash ? `${url.origin}{http.request.uri}` : to
}

/** Where a route's handlers send a request, flattened through every subroute
 *  and de-duplicated — a fli route nests its API proxy and its file server
 *  three levels down, and a reader wants the destinations, not the tree. */
export function targetsOf(handlers) {
  const out = []
  const walk = (list) => {
    for (const h of list ?? []) {
      if (h.handler === 'reverse_proxy')
        for (const u of h.upstreams ?? []) out.push({ kind: 'proxy', dial: u.dial, host: h.headers?.request?.set?.Host?.[0] ?? null })
      else if (h.handler === 'file_server') out.push({ kind: 'files', root: h.root ?? null })
      else if (h.handler === 'static_response')
        out.push(h.headers?.Location
          ? { kind: 'redirect', status: h.status_code ?? null, location: h.headers.Location[0] }
          : { kind: 'respond', status: h.status_code ?? 200 })
      else if (h.handler === 'subroute')
        for (const r of h.routes ?? []) walk(r.handle)
    }
  }
  walk(handlers)
  const seen = new Set()
  return out.filter(t => { const k = JSON.stringify(t); return seen.has(k) ? false : seen.add(k) })
}

export function createIngress({ admin = 'http://127.0.0.1:2019', fetch: fetchFn = globalThis.fetch, now = Date.now } = {}) {
  admin = admin.replace(/\/$/, '')

  // Two releases on one machine at once would each read the config, and the
  // second write would be decided against a read the first had already changed.
  let tail = Promise.resolve()
  const serially = (fn) => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => {})
    return run
  }

  /** One admin call. Answers the status and Caddy's own words; throws only
   *  when nothing answered, with the address, because *connection refused* on
   *  its own does not say it was Caddy that was missing.
   *
   *  Every config load replaces Caddy's admin listener and shuts the old one
   *  down behind it, so with another writer on the box a call is sometimes
   *  reset (ECONNRESET, `FJS-4025`, `FJS-4030`): a pooled socket the old
   *  server closed, or a fresh connection left in its backlog. No socket is
   *  reused, and a reset call is sent again when a repeat is harmless: a
   *  read, a PATCH or DELETE by id, a PUT, or a write carrying `If-Match`,
   *  which answers 412 if the first one landed. A bare POST appends, so its
   *  reset is thrown with `reset` set and `put` settles it by id. */
  async function caddy(method, path, body, headers = {}) {
    const repeatable = method !== 'POST' || 'if-match' in headers
    for (let sent = 1; ; sent++) {
      let res
      try {
        res = await fetchFn(`${admin}${path}`, {
          method,
          headers:   body === undefined ? headers : { 'content-type': 'application/json', ...headers },
          body:      body === undefined ? undefined : JSON.stringify(body),
          signal:    AbortSignal.timeout(10_000),
          keepalive: false,
        })
      } catch (err) {
        if (isReset(err) && repeatable && sent < RESET_SENDS) { await sleep(20 * sent); continue }
        const unreachable = new Error(`caddy's admin API at ${admin} did not answer: ${err.message}`)
        unreachable.unreachable = true
        unreachable.reset = isReset(err)
        throw unreachable
      }
      const text = await res.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch {}
      return { status: res.status, data, said: data?.error ?? text.trim(), etag: res.headers?.get('etag') ?? null }
    }
  }

  const must = (reply, doing) => {
    if (reply.status >= 300) throw new Error(`caddy refused ${doing} (${reply.status}): ${reply.said}`)
    return reply.data
  }

  /**
   * Read `readPath`, let `change(data)` say what to write (null for nothing),
   * and send it with `If-Match` on the read's etag. `fli deploy` writes this
   * same Caddy from the same box, so a write that landed between the read and
   * this one answers 412 and the step is read and decided again: without the
   * header, the array or config built from the old read overwrites the other
   * writer's routes. `change` returns `{ method, path, body, headers, doing }`.
   * Answers whether a write was made.
   */
  async function guarded(readPath, reading, change) {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      const read  = await caddy('GET', readPath)
      const write = change(must(read, reading))
      if (!write) return false
      const reply = await caddy(write.method, write.path, write.body, {
        ...write.headers, ...(read.etag ? { 'if-match': read.etag } : {}),
      })
      if (reply.status === 412) { await backoff(attempt); continue }
      must(reply, write.doing)
      return true
    }
    throw new Error(`caddy's config kept changing under ${reading} — ${WRITE_ATTEMPTS} reads, ${WRITE_ATTEMPTS} 412s`)
  }

  /** Writes only what differs, so a redeploy that moved nothing asks Caddy
   *  for nothing. Both halves go in one write of the whole config: they are
   *  two paths, and a second guarded write would carry an etag the first had
   *  already spent. `/config/logging` is also a 400 until something sets it. */
  const logAccess = (id, hosts) => guarded('/config/', 'its config', (config) => {
    const server = config?.apps?.http?.servers?.[SERVER]
    const want   = accessLogFor(config, id, hosts)
    const live   = { logs: server?.logs ?? null, logging: config?.logging ?? null }
    if (!server || (!hosts.length && !live.logs)) return null
    if (JSON.stringify(want) === JSON.stringify(live)) return null
    const next = structuredClone(config)
    next.logging = want.logging
    next.apps.http.servers[SERVER].logs = want.logs
    return { method: 'POST', path: '/config/', body: next, doing: `setting ${id}'s access log` }
  })

  return {
    /**
     * What the ingress server routes, as read off Caddy — every route, whoever
     * wrote it (`fjs-` is this process, `fli-` is `fli deploy`, anything else
     * is a hand edit), each reduced to its hostnames and where it sends them.
     * `servers` names every OTHER http server in the config: a second one
     * listening on :443 is the Caddyfile conflict, and it is invisible from
     * the ingress server alone.
     *
     * A machine with no Caddy answers `caddy: false` rather than throwing, so
     * a screen can say so instead of failing.
     */
    async routes() {
      let reply
      try {
        reply = await caddy('GET', '/config/apps/http/servers/')
      } catch (err) {
        if (!err.unreachable) throw err
        return { caddy: false, said: err.message, listen: [], routes: [], servers: [] }
      }
      const servers = reply.status < 300 ? (reply.data ?? {}) : {}
      const live    = servers[SERVER]
      return {
        caddy:   true,
        listen:  live?.listen ?? [],
        routes:  (live?.routes ?? []).map(r => ({
          id:    r['@id'] ?? null,
          hosts: (r.match ?? []).flatMap(m => m.host ?? []),
          paths: (r.match ?? []).filter(m => m.path).map(m => ({ host: m.host?.[0] ?? null, prefix: m.path[0] })),
          to:    targetsOf(r.handle ?? []),
        })),
        servers: Object.entries(servers).filter(([name]) => name !== SERVER)
          .map(([name, s]) => ({ name, listen: s.listen ?? [], routes: (s.routes ?? []).length })),
      }
    },

    /**
     * The routes `door` wrote that name any of `hosts` (`doors.js`). A machine
     * with no Caddy answers none: the route write that follows says so.
     */
    async heldBy(door, hosts) {
      let reply
      try {
        reply = await caddy('GET', '/config/')
      } catch (err) {
        if (!err.unreachable) throw err
        return []
      }
      return reply.status < 300 ? heldBy(reply.data, door, hosts) : []
    },

    /**
     * Route `hosts` to the app on `port`, replacing whatever route the app had.
     *
     * A host another route already names is REFUSED rather than shadowed:
     * Caddy answers the first match, so a second app claiming a live hostname
     * would either take it over or silently never be reached, depending on the
     * order the routes happen to be in.
     *
     * `paths` route a prefix of a host to this app instead, and are the one
     * way two apps share a hostname (`FJS-D1040`): only another app's same
     * host AND prefix is refused, and the routes are kept longest prefix
     * first so the whole-host route answers what no prefix claims.
     *
     * `host` replaces the Host header upstream. The static origin picks an app
     * by its Host label, and a public hostname's first label is not the app's.
     *
     * `redirects` are answered by Caddy and dial nothing, so an app may have
     * them with no `hosts` and no port. Each side the call leaves out is
     * removed, since a release that dropped its last redirect would otherwise
     * keep answering it.
     *
     * `noindex` names hosts, served or redirected, that answer
     * `X-Robots-Tag: noindex`.
     */
    route({ appId, hosts = [], port, host = null, redirects = [], paths = [], noindex = [] }) {
      return serially(async () => {
        checkRouteAppId(appId)
        if (!hosts.length && !redirects.length && !paths.length) throw new Error('a route needs at least one hostname')
        if ((hosts.length || paths.length) && !(Number.isInteger(Number(port)) && Number(port) > 0))
          throw new Error(`a route needs the port the app is published on — got '${port}'`)
        const id     = routeId(appId)
        const pathId = pathRouteId(appId)
        const config = must(await caddy('GET', '/config/'), 'reading its config')
        const http   = config?.apps?.http ?? {}
        const live   = http.servers?.[SERVER]

        const named  = [...hosts, ...redirects.map(r => r.host)]
        const wanted = paths.map(p => p.host + p.prefix)
        for (const other of live?.routes ?? []) {
          const otherId = other['@id']
          if (otherId === id || otherId === redirectsId(appId) || isPathRouteOf(appId, otherId)) continue
          const taken = (other.match ?? []).flatMap(m => m.path
            ? (m.host ?? []).flatMap(h => m.path.slice(0, 1).map(p => h + p)).filter(k => wanted.includes(k))
            : (m.host ?? []).filter(h => named.includes(h)))
          if (taken.length)
            throw new Error(`${taken.join(', ')} is already routed to ${otherId ?? 'a route outpost did not write'}`)
        }

        if (!live) must(await caddy('PUT', `/config/apps/http/servers/${SERVER}`, {
          listen: [`:${http.https_port ?? 443}`],
          routes: [],
        }), 'creating the ingress server')

        // PATCH by id replaces in place; Caddy answers 404 for an id it has not
        // seen, which is a first deploy. An append reset on the way back may
        // have landed, so the next send starts over at the PATCH.
        const put = async (route) => {
          for (let sent = 1; ; sent++) {
            const replaced = await caddy('PATCH', `/id/${route['@id']}`, route)
            if (replaced.status !== 404) return must(replaced, `replacing ${route['@id']}`)
            try {
              return must(await caddy('POST', `/config/apps/http/servers/${SERVER}/routes`, route), `adding ${route['@id']}`)
            } catch (err) {
              if (!(err.reset && sent < RESET_SENDS)) throw err
            }
          }
        }
        const drop = async (dropId) => {
          const reply = await caddy('DELETE', `/id/${dropId}`)
          if (reply.status !== 404) must(reply, `removing ${dropId}`)
        }
        // The static origin answers raw bytes, so without this an SPA's bundle
        // crosses the wire at four times its size and the first paint waits on
        // it. A container encodes its own answers and may stream, so it is left alone.
        const proxy = [...(host ? [ENCODE] : []), {
          handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${port}` }],
          stream_close_delay: STREAM_CLOSE_DELAY,
          ...(host ? { headers: { request: { set: { Host: [host] } } } } : {}),
        }]

        // A side the app no longer has is taken out here, so a release that
        // dropped its last redirect does not keep answering it.
        // A subroute runs its matching routes and then the handler after it,
        // so the header is set on those hosts alone and the proxy still answers.
        const ingressHosts = hosts.filter(h => noindex.includes(h))
        if (hosts.length) await put({
          '@id':    id,
          match:    [{ host: hosts }],
          handle:   [
            ...(ingressHosts.length ? [{ handler: 'subroute', routes: [{
              match: [{ host: ingressHosts }], handle: [{ handler: 'headers', response: { set: NOINDEX } }],
            }] }] : []),
            ...proxy,
          ],
          terminal: true,
        })
        else await drop(id)

        const ids = paths.map((_, i) => `${pathId}${i}`)
        for (const stale of (live?.routes ?? []).map(r => r['@id']).filter(i => isPathRouteOf(appId, i) && !ids.includes(i)))
          await drop(stale)
        for (const [i, p] of paths.entries()) await put({
          '@id':    ids[i],
          match:    [{ host: [p.host], path: [p.prefix, `${p.prefix}/*`] }],
          handle:   proxy,
          terminal: true,
        })

        if (redirects.length) await put({
          '@id':    redirectsId(appId),
          match:    [{ host: redirects.map(r => r.host) }],
          handle:   [{
            handler: 'subroute',
            routes:  redirects.map(r => ({
              match:  [{ host: [r.host] }],
              handle: [{ handler: 'static_response', status_code: 308, headers: {
                Location: [locationFor(r.to)], ...(noindex.includes(r.host) ? NOINDEX : {}),
              } }],
            })),
          }],
          terminal: true,
        })
        else await drop(redirectsId(appId))

        // Appended routes land behind a whole-host route that would answer
        // their prefix, so the order is read back and settled after every write.
        await guarded(`/config/apps/http/servers/${SERVER}/routes`, 'its routes', (read) => {
          const now  = read ?? []
          const sort = ordered(now)
          return sort.some((r, i) => r !== now[i])
            ? { method: 'PATCH', path: `/config/apps/http/servers/${SERVER}/routes`, body: sort, doing: 'ordering its routes' }
            : null
        })
        await logAccess(id, hosts)
        return { hosts, paths, redirects }
      })
    },

    /**
     * Move the app's own routes (the whole-host one and its path routes, never
     * the redirects or another app's) onto `port`, the one its container
     * answers on now (`FJS-D1890`). Answers `{ moved: [{ id, from, to }] }`,
     * empty when nothing dialed another port. A machine with no Caddy, or an
     * app with no route, moves nothing and is not an error: this runs for every
     * App on the box. Each PATCH is by `@id` and carries one `fjs-` route that
     * only this process writes, so it holds no etag: `fli deploy` writes `fli-`
     * ids and cannot have changed the object it replaces.
     */
    repoint({ appId, port }) {
      return serially(async () => {
        checkRouteAppId(appId)
        if (!(Number.isInteger(Number(port)) && Number(port) > 0))
          throw new Error(`a route needs the port the app is published on — got '${port}'`)
        let reply
        try {
          reply = await caddy('GET', `/config/apps/http/servers/${SERVER}/routes`)
        } catch (err) {
          if (!err.unreachable) throw err
          return { moved: [] }
        }
        const own = (reply.status < 300 ? reply.data ?? [] : [])
          .filter(r => r['@id'] === routeId(appId) || isPathRouteOf(appId, r['@id']))
        const { routes, moved } = repointRoutes(own, port)
        const changed = new Set(moved.map(m => m.id))
        for (const route of routes)
          if (changed.has(route['@id'])) must(await caddy('PATCH', `/id/${route['@id']}`, route), `re-pointing ${route['@id']}`)
        return { moved }
      })
    },

    /**
     * The loopback ports the app's own routes dial now, `[]` with none or no
     * Caddy. A swap asks it before removing a leftover `_next`: one the route
     * dials is serving, and removing it takes the app down.
     */
    dialed({ appId }) {
      return serially(async () => {
        checkRouteAppId(appId)
        let reply
        try {
          reply = await caddy('GET', `/config/apps/http/servers/${SERVER}/routes`)
        } catch (err) {
          if (!err.unreachable) throw err
          return []
        }
        const own = (reply.status < 300 ? reply.data ?? [] : [])
          .filter(r => r['@id'] === routeId(appId) || isPathRouteOf(appId, r['@id']))
        // A port no route dials is not one: moving every loopback upstream to 0 reads them all.
        return [...new Set(repointRoutes(own, 0).moved.map(m => m.from))]
      })
    },

    /**
     * Caddy's config loaded again as it stands, so a certificate waiting out
     * its ACME backoff is asked for now (`FJS-D1715`). Caddy skips a load
     * whose config is byte-identical — the case here — unless told
     * `must-revalidate`; without the header this does nothing. Posted to
     * `/config/` and not `/load`, because `/load` ignores `If-Match`.
     */
    reload() {
      return serially(async () => {
        await guarded('/config/', 'its config', (config) => ({
          method: 'POST', path: '/config/', body: config ?? {},
          headers: { 'cache-control': 'must-revalidate' }, doing: 'reloading its config',
        }))
        return { reloaded: true }
      })
    },

    /**
     * Hold the certificate Basecamp minted: one `load_pem` entry per `id`
     * (`FJS-D1975`), so a host under a `*.<zone>` it covers is served by it and
     * Caddy orders nothing for that host. Replaced in place on a repeat push,
     * and nothing is written when the same pair is already loaded -- a push per
     * release would otherwise reload Caddy's config each time. `apps.tls` is
     * made when Caddy has none. Answers `changed`; a machine with no Caddy
     * answers `loaded: false`.
     */
    loadCert({ id, cert, key }) {
      return serially(async () => {
        const read = readCert({ id, cert, key }, now())
        const at   = certId(id)
        try {
          const changed = await guarded('/config/', 'its config', (config) => {
            const held = config?.apps?.tls?.certificates?.load_pem ?? []
            const live = held.find(p => p['@id'] === at)
            if (live?.certificate === cert && live?.key === key) return null
            const next = structuredClone(config ?? {})
            const list = (((next.apps ??= {}).tls ??= {}).certificates ??= {}).load_pem ??= []
            const entry = { '@id': at, certificate: cert, key }
            const i = list.findIndex(p => p['@id'] === at)
            if (i < 0) list.push(entry)
            else list[i] = entry
            return { method: 'POST', path: '/config/', body: next, doing: `loading certificate ${id}` }
          })
          return { ...read, changed, loaded: true }
        } catch (err) {
          if (!err.unreachable) throw err
          return { loaded: false, said: err.message }
        }
      })
    },

    /** Take a pushed certificate out. Answers whether one was there; no Caddy is `removed: false`. */
    dropCert({ id }) {
      return serially(async () => {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))
          throw new Error(`cert id '${id}' is not a plain name`)
        const at = certId(id)
        try {
          const removed = await guarded('/config/', 'its config', (config) => {
            const held = config?.apps?.tls?.certificates?.load_pem ?? []
            if (!held.some(p => p['@id'] === at)) return null
            const next = structuredClone(config)
            next.apps.tls.certificates.load_pem = held.filter(p => p['@id'] !== at)
            return { method: 'POST', path: '/config/', body: next, doing: `dropping certificate ${id}` }
          })
          return { removed }
        } catch (err) {
          if (!err.unreachable) throw err
          return { removed: false }
        }
      })
    },

    /**
     * Take the app's route out. Answers whether one was there.
     *
     * A machine with no Caddy has no route to remove, so an admin API that does
     * not answer is `removed: false` rather than a failure — otherwise every
     * stop on such a machine fails. Caddy ANSWERING with a refusal still throws.
     */
    unroute({ appId }) {
      return serially(async () => {
        checkRouteAppId(appId)
        let removed = false
        let listed
        try {
          listed = await caddy('GET', `/config/apps/http/servers/${SERVER}/routes`)
        } catch (err) {
          if (!err.unreachable) throw err
          return { removed: false }
        }
        const paths = (listed.status < 300 ? listed.data ?? [] : []).map(r => r['@id']).filter(i => isPathRouteOf(appId, i))
        for (const id of [routeId(appId), redirectsId(appId), ...paths]) {
          let reply
          try {
            reply = await caddy('DELETE', `/id/${id}`)
          } catch (err) {
            if (!err.unreachable) throw err
            return { removed: false }
          }
          if (reply.status === 404) continue
          must(reply, `removing ${id}`)
          removed = true
        }
        if (removed) await logAccess(routeId(appId), [])
        return { removed }
      })
    },
  }
}
