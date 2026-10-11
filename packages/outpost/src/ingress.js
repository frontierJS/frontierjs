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

const SERVER = 'ingress'
/** A DNS name, lowercased. No wildcard: a wildcard certificate is DNS-01, which
 *  would put a DNS vendor's token on every machine (`IDEAS/fleet-ingress.md` D6). */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** The route's `@id`, which is the container's name — one noun for one app. */
export const routeId = (appId) => `fjs-${appId}`

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

/** A target naming only an origin keeps the request's path and query, so
 *  `www.shop.test/cart` lands on `shop.test/cart`; one naming a page IS that page. */
const locationFor = (to) => {
  const url = new URL(to)
  return url.pathname === '/' && !url.search && !url.hash ? `${url.origin}{http.request.uri}` : to
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

  return {
    /**
     * Route `hosts` to the app on `port`, replacing whatever route the app had.
     *
     * A host another route already names is REFUSED rather than shadowed:
     * Caddy answers the first match, so a second app claiming a live hostname
     * would either take it over or silently never be reached, depending on the
     * order the routes happen to be in.
     *
     * `host` replaces the Host header upstream. The static origin picks an app
     * by its Host label, and a public hostname's first label is not the app's.
     *
     * `redirects` are answered by Caddy and dial nothing, so an app may have
     * them with no `hosts` and no port. Each side the call leaves out is
     * removed, since a release that dropped its last redirect would otherwise
     * keep answering it.
     */
    route({ appId, hosts = [], port, host = null, redirects = [] }) {
      return serially(async () => {
        if (!hosts.length && !redirects.length) throw new Error('a route needs at least one hostname')
        if (hosts.length && !(Number.isInteger(Number(port)) && Number(port) > 0))
          throw new Error(`a route needs the port the app is published on — got '${port}'`)
        const id   = routeId(appId)
        const http = must(await caddy('GET', '/config/'), 'reading its config')?.apps?.http ?? {}
        const live = http.servers?.[SERVER]

        const named = [...hosts, ...redirects.map(r => r.host)]
        for (const other of live?.routes ?? []) {
          if (other['@id'] === id || other['@id'] === redirectsId(appId)) continue
          const taken = (other.match ?? []).flatMap(m => m.host ?? []).filter(h => named.includes(h))
          if (taken.length)
            throw new Error(`${taken.join(', ')} is already routed to ${other['@id'] ?? 'a route outpost did not write'}`)
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

        // A side the app no longer has is taken out here, so a release that
        // dropped its last redirect does not keep answering it.
        if (hosts.length) await put({
          '@id':    id,
          match:    [{ host: hosts }],
          handle:   [{
            handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${port}` }],
            ...(host ? { headers: { request: { set: { Host: [host] } } } } : {}),
          }],
          terminal: true,
        })
        else await drop(id)

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
        return { hosts, redirects }
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
        for (const id of [routeId(appId), redirectsId(appId)]) {
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
        return { removed }
      })
    },
  }
}
