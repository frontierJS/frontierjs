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
import { createDocker, createInspector } from './docker.js'

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
    'POST /stop':          (body) => docker.stop({ appId: body.app_id }),
    'POST /health-check':  (body) => docker.healthCheck({ appId: body.app_id }),

    // Build-then-run, or run what it was told to. A `source.kind === 'git'`
    // deploy builds on this machine — V1's answer, and the reason the digest
    // comes back from here rather than being stated by the caller.
    'POST /deploy': async (body) => {
      const image = body.image ?? `fjs-${body.deployment_id}`
      let built   = { digest: body.digest ?? null }
      if (body.source?.kind === 'git' && body.source.repo)
        built = await docker.build({ appId: body.app_id ?? body.deployment_id, source: body.source, image })

      const started = await docker.deploy({
        appId:  body.app_id ?? body.deployment_id,
        image,
        digest: built.digest ?? body.digest,
        config: body.config ?? {},
        port:   body.config?.port,
      })
      return { ...started, commit_sha: built.commitSha ?? null }
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
      secret: config.secret, method: req.method, path, body, headers: req.headers,
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
