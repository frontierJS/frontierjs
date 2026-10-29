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

import { ROOTS } from './layout.js'

const SERVER = 'ingress'
/** A DNS name, lowercased. No wildcard: a wildcard certificate is DNS-01, which
 *  would put a DNS vendor's token on every machine (`IDEAS/fleet-ingress.md` D6). */
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

/** One path route's `@id` prefix: an app may hold many, and each is its own
 *  route because Caddy answers the first match in order and the order is by
 *  prefix length, which a route holding two prefixes cannot have. */
export const pathRouteId = (appId) => `${routeId(appId)}-path-`

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

export function createIngress({ admin = 'http://127.0.0.1:2019', fetch: fetchFn = globalThis.fetch } = {}) {
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
   *  its own does not say it was Caddy that was missing. */
  async function caddy(method, path, body) {
    let res
    try {
      res = await fetchFn(`${admin}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body:    body === undefined ? undefined : JSON.stringify(body),
        signal:  AbortSignal.timeout(10_000),
      })
    } catch (err) {
      const unreachable = new Error(`caddy's admin API at ${admin} did not answer: ${err.message}`)
      unreachable.unreachable = true
      throw unreachable
    }
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch {}
    return { status: res.status, data, said: data?.error ?? text.trim() }
  }

  const must = (reply, doing) => {
    if (reply.status >= 300) throw new Error(`caddy refused ${doing} (${reply.status}): ${reply.said}`)
    return reply.data
  }

  /** Writes only what differs, so a redeploy that moved nothing asks Caddy
   *  for nothing. POST on an object key replaces it; PUT would refuse a key
   *  that exists. */
  async function logAccess(config, id, hosts) {
    const want = accessLogFor(config, id, hosts)
    const live = { logs: config?.apps?.http?.servers?.[SERVER]?.logs ?? null, logging: config?.logging ?? null }
    if (!hosts.length && !live.logs) return
    if (JSON.stringify(want.logging) !== JSON.stringify(live.logging))
      must(await caddy('POST', '/config/logging', want.logging), `setting ${id}'s access log`)
    if (JSON.stringify(want.logs) !== JSON.stringify(live.logs))
      must(await caddy('POST', `/config/apps/http/servers/${SERVER}/logs`, want.logs), `logging ${id}'s hostnames`)
  }

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
     */
    route({ appId, hosts = [], port, host = null, redirects = [], paths = [] }) {
      return serially(async () => {
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
          if (otherId === id || otherId === redirectsId(appId) || otherId?.startsWith(pathId)) continue
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
        // seen, which is a first deploy.
        const put = async (route) => {
          const replaced = await caddy('PATCH', `/id/${route['@id']}`, route)
          if (replaced.status === 404)
            must(await caddy('POST', `/config/apps/http/servers/${SERVER}/routes`, route), `adding ${route['@id']}`)
          else
            must(replaced, `replacing ${route['@id']}`)
        }
        const drop = async (dropId) => {
          const reply = await caddy('DELETE', `/id/${dropId}`)
          if (reply.status !== 404) must(reply, `removing ${dropId}`)
        }
        const proxy = [{
          handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${port}` }],
          ...(host ? { headers: { request: { set: { Host: [host] } } } } : {}),
        }]

        // A side the app no longer has is taken out here, so a release that
        // dropped its last redirect does not keep answering it.
        if (hosts.length) await put({
          '@id':    id,
          match:    [{ host: hosts }],
          handle:   proxy,
          terminal: true,
        })
        else await drop(id)

        const ids = paths.map((_, i) => `${pathId}${i}`)
        for (const stale of (live?.routes ?? []).map(r => r['@id']).filter(i => i?.startsWith(pathId) && !ids.includes(i)))
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
              handle: [{ handler: 'static_response', status_code: 308, headers: { Location: [locationFor(r.to)] } }],
            })),
          }],
          terminal: true,
        })
        else await drop(redirectsId(appId))

        // Appended routes land behind a whole-host route that would answer
        // their prefix, so the order is read back and settled after every write.
        const now  = must(await caddy('GET', `/config/apps/http/servers/${SERVER}/routes`), 'reading its routes') ?? []
        const sort = ordered(now)
        if (sort.some((r, i) => r !== now[i]))
          must(await caddy('PATCH', `/config/apps/http/servers/${SERVER}/routes`, sort), 'ordering its routes')
        await logAccess(config, id, hosts)
        return { hosts, paths, redirects }
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
        let removed = false
        let listed
        try {
          listed = await caddy('GET', `/config/apps/http/servers/${SERVER}/routes`)
        } catch (err) {
          if (!err.unreachable) throw err
          return { removed: false }
        }
        const paths = (listed.status < 300 ? listed.data ?? [] : []).map(r => r['@id']).filter(i => i?.startsWith(pathRouteId(appId)))
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
        if (removed) await logAccess(must(await caddy('GET', '/config/'), 'reading its config'), routeId(appId), [])
        return { removed }
      })
    },
  }
}
