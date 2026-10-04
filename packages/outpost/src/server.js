/*
 * server.js — the Outpost's inbound half.
 *
 * Basecamp reaches this over Conduit at `outpost:<server-id>`, and the paths
 * below are the protocol its engines already speak. They were written against
 * nothing: `deployment.engine.ts`, `fleet.engine.ts` and two services have been
 * sending to these routes since before this package existed, so the shapes here
 * are read off those call sites rather than invented (`FJS-257`).
 *
 * EVERY route but `GET /health` requires a valid signature. The scheme is
 * `@frontierjs/toolbelt/signature`, which is the same module conduit signs
 * with — one definition, two ends. `/exec` runs a shell command as this
 * process's user, so an unsigned request reaching it is remote code execution
 * with extra steps; that is why the default is refuse-everything and a route
 * opts OUT rather than in.
 */

import { verifyRequest } from '@frontierjs/toolbelt/signature'
import { createDocker, createInspector, checkRunConfig } from './docker.js'
import { createStatic } from './static.js'
import { createIngress, hostsOf } from './ingress.js'

const JSON_HEADERS = { 'content-type': 'application/json' }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

/** Nonces seen inside the freshness window. Per process, like basecamp's own:
 *  a captured signature is dead in five minutes either way, and a shared store
 *  is the change to make when an Outpost runs more than once on a machine. */
function nonceMemory(windowMs) {
  const seen = new Map()
  return (nonce) => {
    const now = Date.now()
    for (const [n, at] of seen) if (now - at > windowMs) seen.delete(n)
    if (seen.has(nonce)) return true
    seen.set(nonce, now)
    return false
  }
}

export function createOutpostServer(config, {
  docker    = createDocker({ workDir: config.workDir }),
  inspector = createInspector(),
  statics   = createStatic({ staticDir: config.staticDir, staticUrl: config.staticUrl }),
  ingress   = createIngress({ admin: config.caddyAdmin }),
  log       = console,
} = {}) {

  const TOLERANCE_S = 300
  const seenNonce   = nonceMemory(TOLERANCE_S * 1_000)

  const routes = {
    // snake_case in, camelCase inside. The bodies are basecamp's wire contract
    // — `app_id`, `timeout_s`, `keep_images` — and a route that passed one
    // straight through read `appId` as undefined and addressed a container
    // called `fjs-undefined`, which exists on no machine and reports healthy
    // nowhere.
    'POST /pull':          (body) => docker.pull({ image: body.image }),
    // The route goes with the container: left behind, Caddy answers the app's
    // hostnames with a 502 from a port nothing holds. A redeploy's own stop
    // takes it too, and its `/deploy` puts it back.
    'POST /stop': async (body) => {
      const stopped = await docker.stop({ appId: body.app_id })
      const { removed } = await ingress.unroute({ appId: body.app_id })
      return { ...stopped, unrouted: removed }
    },
    'POST /health-check':  (body) => docker.healthCheck({ appId: body.app_id, port: body.port, path: body.path }),

    // Build-then-run, or run what it was told to. A `source.kind === 'git'`
    // deploy builds on this machine — V1's answer, and the reason the digest
    // comes back from here rather than being stated by the caller.
    //
    // `hosts` are the app's hostnames, and naming any puts Caddy in front of it
    // (`FJS-D564`) and its port on loopback (`FJS-D565`). The route is pushed
    // before the container starts: a hostname another app holds, or a Caddy
    // that is down, then fails the release rather than leaving a container on
    // loopback that nothing can reach.
    //
    // Every refusal comes before the old container goes, and Basecamp sends no
    // `/stop` ahead of this for that reason (`FJS-1682`): a release refused here
    // leaves the live app serving.
    'POST /deploy': async (body) => {
      const appId = body.app_id ?? body.deployment_id
      const hosts = hostsOf(body.hosts)
      const port  = body.config?.port
      if (hosts.length && !port) throw new Error('hosts need a published port to route to — config.port is not set')
      checkRunConfig(body.config)

      const image = body.image ?? `fjs-${body.deployment_id}`
      let built   = { digest: body.digest ?? null }
      if (body.source?.kind === 'git' && body.source.repo)
        built = await docker.build({ appId, source: body.source, image })

      // A release that dropped its last hostname drops its route too.
      if (hosts.length) await ingress.route({ appId, hosts, port })
      else await ingress.unroute({ appId })

      const started = await docker.deploy({
        appId,
        image,
        digest:   built.digest ?? body.digest,
        config:   body.config ?? {},
        port,
        loopback: hosts.length > 0,
      })
      return { ...started, hosts, commit_sha: built.commitSha ?? null }
    },

    // The app's hostnames, changed between releases (`FJS-1610`): a Domain
    // added, deleted or redirected. Same `hosts` as `/deploy`, and the route
    // dials whatever port the running container published, so nothing is
    // restarted.
    //
    // The container's BIND moves only with a release: an app deployed with no
    // hostname keeps its port on every interface after its first route, and
    // one that loses its last hostname stays on loopback where nothing reaches
    // it. `rebind` says which, and the next release puts it right — routing
    // anyway is the smaller harm than a hostname that answers nothing.
    'POST /route': async (body) => {
      const appId = body.app_id
      if (!appId) throw new Error('a route needs the app_id it is for')
      const hosts = hostsOf(body.hosts)
      const live  = await docker.published({ appId })
      if (hosts.length && !live) throw new Error(`no container fjs-${appId} on this machine to route to — deploy it first`)
      if (hosts.length && !live.port) throw new Error(`fjs-${appId} publishes no port to route to — set the app's port and redeploy`)

      if (hosts.length) await ingress.route({ appId, hosts, port: live.port })
      else await ingress.unroute({ appId })

      const rebind = !live?.port ? null
        : hosts.length && !live.loopback ? `port ${live.port} still answers off this machine, around Caddy, until the next release binds it to loopback`
        : !hosts.length && live.loopback ? `port ${live.port} is bound to loopback with no route in front of it, so nothing reaches the app until the next release`
        : null
      return { hosts, port: live?.port ?? null, rebind }
    },

    // Two callers, two shapes: `fleet.engine.ts` sends a recipe as `command`,
    // and `deployment.engine.ts` forwards a build/migration STEP as `step`.
    // A step with no command is acknowledged and does nothing — the honest
    // answer for a pipeline stage this machine has no work for, and it is not
    // a failure of the release.
    'POST /exec': async (body) => {
      if (body.command) return docker.exec({ command: body.command, timeoutSeconds: body.timeout_s })
      return { exit_code: 0, stdout: `step '${body.step ?? 'unnamed'}' needs no work on this machine`, stderr: '' }
    },

    // POST, and the parameters ride in the body like every other route here.
    // It was a security property before `FJS-678`: the canonical string covered
    // the method, the path and a hash of the body and nothing else, so a
    // `GET /logs?app_id=…` let a caller swap the container name under a
    // signature that was otherwise valid. The query is signed now; the body
    // stays the shape, because a route reached both ways is two canonical
    // strings for one request.
    'POST /logs': (body) => docker.logs({
      appId: body.app_id ?? body.deployment_id,
      tail:  body.tail,
      since: body.since,
    }),

    // ── Static releases ───────────────────────────────────────────────
    //
    // An app whose source is a pasted file has no image and no container, so
    // none of the routes above describe it: the bytes ARE the release. They are
    // written under their own digest and a symlink swap makes them live, which
    // is why `activate` needs nothing but a digest this machine already holds.
    //
    // The digest in every reply is read off the bytes that landed. A caller
    // states none — `/deploy` answers its own for the same reason.
    'POST /static/publish':  (body) => statics.publish({
      appId: body.app_id, slug: body.slug, files: body.files, keep: body.keep,
    }),
    'POST /static/activate': (body) => statics.activate({ appId: body.app_id, slug: body.slug, digest: body.digest }),
    'POST /static/health':   (body) => statics.healthCheck({ appId: body.app_id, digest: body.digest }),
    'POST /static/retire':   (body) => statics.retire({ appId: body.app_id, slug: body.slug }),
    'POST /static/releases': (body) => statics.releases({ appId: body.app_id }),

    'POST /system/prune':  (body) => inspector.prune({ targets: body.targets, keepImages: body.keep_images })
      .then(async result => ({ ...result, usage: await inspector.disk() })),
    'POST /volumes/prune': (body) => inspector.pruneVolumes(body.names ?? []),
  }

  async function handle(req) {
    const url  = new URL(req.url)
    const path = url.pathname

    // Liveness, and the only unsigned route. It says nothing about the machine
    // — that is what a signed report is for — so there is nothing here to
    // learn by asking.
    if (req.method === 'GET' && path === '/health')
      return json({ ok: true, version: config.version, server_id: config.serverId })

    const body    = await req.text()
    const checked = await verifyRequest({
      // Recomputed from the RAW request URL: the query is part of the canonical
      // string since `FJS-678`, and reading a path the router already stripped
      // would sign a different request than the one that arrived.
      secret: config.secret, method: req.method, path, query: url.search, body, headers: req.headers,
      // This machine's clock, stated: the kit takes no ambient state.
      toleranceSeconds: TOLERANCE_S, now: Math.floor(Date.now() / 1000), seenNonce,
    })
    if (!checked.ok) {
      // Logged with the reason, answered without it: a caller learns it was
      // refused, not whether the clock or the secret was wrong.
      log.warn?.(`outpost: refused ${req.method} ${path} — ${checked.reason}`)
      return json({ error: 'signature required' }, 401)
    }

    let payload = {}
    try { payload = body ? JSON.parse(body) : {} } catch { return json({ error: 'body is not JSON' }, 400) }

    // DELETE /volumes/<name> — the one route with something in its path.
    const volume = req.method === 'DELETE' && /^\/volumes\/[^/]+$/.test(path)
    if (volume) {
      try {
        return json(await inspector.removeVolume(decodeURIComponent(path.slice('/volumes/'.length))))
      } catch (err) {
        // 409, not 500: a volume a container still holds is a refusal with a
        // reason, and basecamp keeps the row rather than forgetting a full disk.
        return json({ error: err.message }, 409)
      }
    }

    const route = routes[`${req.method} ${path}`]
    if (!route) return json({ error: `no such route: ${req.method} ${path}` }, 404)

    try {
      return json(await route(payload) ?? {})
    } catch (err) {
      log.error?.(`outpost: ${req.method} ${path} failed — ${err.message}`)
      // The machine's own words, back to the operator. A generic 500 here is
      // how a deploy fails with nothing on screen but a red pill.
      return json({ error: err.message }, 500)
    }
  }

  return { handle, routes: Object.keys(routes) }
}
