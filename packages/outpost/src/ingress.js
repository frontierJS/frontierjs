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
     */
    route({ appId, hosts, port }) {
      return serially(async () => {
        if (!hosts?.length) throw new Error('a route needs at least one hostname')
        if (!(Number.isInteger(Number(port)) && Number(port) > 0))
          throw new Error(`a route needs the port the app is published on — got '${port}'`)
        const id   = routeId(appId)
        const http = must(await caddy('GET', '/config/'), 'reading its config')?.apps?.http ?? {}
        const live = http.servers?.[SERVER]

        for (const other of live?.routes ?? []) {
          if (other['@id'] === id) continue
          const taken = (other.match ?? []).flatMap(m => m.host ?? []).filter(h => hosts.includes(h))
          if (taken.length)
            throw new Error(`${taken.join(', ')} is already routed to ${other['@id'] ?? 'a route outpost did not write'}`)
        }

        if (!live) must(await caddy('PUT', `/config/apps/http/servers/${SERVER}`, {
          listen: [`:${http.https_port ?? 443}`],
          routes: [],
        }), 'creating the ingress server')

        const route = {
          '@id':    id,
          match:    [{ host: hosts }],
          handle:   [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${port}` }] }],
          terminal: true,
        }
        // PATCH by id replaces in place; Caddy answers 404 for an id it has not
        // seen, which is a first deploy.
        const replaced = await caddy('PATCH', `/id/${id}`, route)
        if (replaced.status === 404)
          must(await caddy('POST', `/config/apps/http/servers/${SERVER}/routes`, route), `adding ${id}`)
        else
          must(replaced, `replacing ${id}`)
        return { hosts }
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
        let reply
        try {
          reply = await caddy('DELETE', `/id/${routeId(appId)}`)
        } catch (err) {
          if (!err.unreachable) throw err
          return { removed: false }
        }
        if (reply.status === 404) return { removed: false }
        must(reply, `removing ${routeId(appId)}`)
        return { removed: true }
      })
    },
  }
}
