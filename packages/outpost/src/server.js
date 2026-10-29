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

import { verifyRequest, nonceMemory } from '@frontierjs/toolbelt/signature'
import { createDocker, createInspector, checkRunConfig } from './docker.js'
import { createStatic, validName } from './static.js'
import { createIngress, hostsOf, pathsOf, redirectsOf } from './ingress.js'
import { createReplicator } from './replicate.js'
import { createAnalytics } from './analytics.js'

const JSON_HEADERS = { 'content-type': 'application/json' }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

// Each open stream holds a process on this machine for as long as somebody
// watches, so the count is capped here rather than trusted to the caller.
const MAX_STREAMS = 16
// Bun.serve closes a connection idle for 10s, and a quiet container writes
// nothing for minutes. A comment line keeps it open and SSE readers drop it.
const KEEPALIVE_MS = 5_000

/**
 * An async sequence as `text/event-stream`: one `data:` event per item, then
 * `event: end`, or `event: error` with the machine's sentence. The sequence is
 * pulled, so a slow reader slows the source rather than filling memory here.
 */
function eventStream(events, abort, done) {
  const enc = new TextEncoder()
  const it  = events[Symbol.asyncIterator]()
  let ping  = null, closed = false
  const finish = () => { if (closed) return; closed = true; clearInterval(ping); abort.abort(); done() }

  return new Response(new ReadableStream({
    start(controller) {
      ping = setInterval(() => { try { controller.enqueue(enc.encode(': keepalive\n\n')) } catch {} }, KEEPALIVE_MS)
    },
    async pull(controller) {
      try {
        const next = await it.next()
        if (!next.done) return controller.enqueue(enc.encode(`data: ${JSON.stringify(next.value)}\n\n`))
        controller.enqueue(enc.encode('event: end\ndata: {}\n\n'))
      } catch (err) {
        controller.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`))
      }
      finish()
      controller.close()
    },
    cancel() { finish(); it.return?.() },
  }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}

export function createOutpostServer(config, {
  docker    = createDocker({ workDir: config.workDir, appsDir: config.appsDir, restoreDir: config.restoreDir, backupDir: config.backupDir, deployKeyDir: config.deployKeyDir }),
  inspector = createInspector({ appsDir: config.appsDir }),
  statics   = createStatic({ staticDir: config.staticDir, staticUrl: config.staticUrl }),
  ingress   = createIngress({ admin: config.caddyAdmin }),
  analytics = createAnalytics(),
  replicator = createReplicator({ configPath: config.litestreamConfig, appsDir: config.appsDir, metaDir: config.litestreamMetaDir, litestream: config.litestreamBin, stageDir: config.replicaStageDir, hostDb: config.hostFiles?.db ?? null }),
  log       = console,
} = {}) {

  const TOLERANCE_S = 300
  // Per process, like basecamp's own: a captured signature is dead in five
  // minutes either way, and a shared store is the change to make when an
  // Outpost runs more than once on a machine. Twice the tolerance: a timestamp
  // accepted at the limit ahead stays fresh for another full tolerance, and a
  // nonce forgotten sooner replays (FJS-1833).
  const seen      = nonceMemory()
  const seenNonce = (nonce) => seen(nonce, Math.floor(Date.now() / 1000), 2 * TOLERANCE_S)

  // After any change to which containers exist. A failed refill leaves the
  // release standing: the set fails closed, and the posture report says so.
  const syncExposed = () => docker.syncExposed()
    .catch(err => log.error?.(`outpost: the firewall's exposed set was not refilled — ${err.message}`))

  const routes = {
    // snake_case in, camelCase inside. The bodies are basecamp's wire contract
    // — `app_id`, `timeout_s`, `keep_images` — and a route that passed one
    // straight through read `appId` as undefined and addressed a container
    // called `fjs-undefined`, which exists on no machine and reports healthy
    // nowhere.
    'POST /pull':          (body) => docker.pull({ image: body.image, digest: body.digest }),
    // The build alone, so a failing one is its own step and happens before the
    // old container is touched. `/deploy` given the digest this answers starts
    // those bytes and builds nothing.
    'POST /build': async (body) => {
      if (body.source?.kind !== 'git' || !body.source.repo) throw new Error('a build needs a git source with a repo')
      const built = await docker.build({
        appId: body.app_id, source: body.source, image: body.image ?? `fjs-${body.app_id}`,
      })
      return { digest: built.digest, commit_sha: built.commitSha, dockerfile: built.dockerfile, exposed_port: built.exposedPort ?? null }
    },
    // Asked when the App is made, so its public half is on screen to add at the
    // forge before the first build needs it. The id names a key file.
    'POST /deploy-key': async (body) => {
      const bad = validName(body.app_id, 'app_id')
      if (bad) throw new Error(bad)
      const { publicKey } = await docker.deployKey({ appId: body.app_id })
      return { app_id: body.app_id, public_key: publicKey }
    },
    // A file off the app's clone, so a private repository's Dockerfile can be
    // seeded onto the App after its first build (`apps.importDockerfile`).
    'POST /source/file': (body) => docker.sourceFile({ appId: body.app_id, path: body.path }),
    // A static site's branch as a review build, uploaded as a Worker version
    // and never deployed; nothing on this machine serves it afterwards.
    'POST /site/preview': async (body) => {
      const built = await docker.sitePreview({
        appId: body.app_id, source: body.source, branch: body.branch, alias: body.alias, editor: body.editor,
        token: body.cloudflare?.token, accountId: body.cloudflare?.account_id,
      })
      return { commit_sha: built.commit, url: built.url, version_url: built.versionUrl }
    },
    // The same build without `--preview`, deployed as the live site. `commit`
    // is the one basecamp decided to ship, and a branch that moved since is
    // refused rather than built.
    'POST /site/publish': async (body) => {
      const built = await docker.sitePublish({
        appId: body.app_id, source: body.source, branch: body.branch, commit: body.commit,
        token: body.cloudflare?.token, accountId: body.cloudflare?.account_id,
      })
      return { commit_sha: built.commit, url: built.url }
    },
    // The route goes with the container: left behind, Caddy answers the app's
    // hostnames with a 502 from a port nothing holds. A redeploy's own stop
    // takes it too, and its `/deploy` puts it back.
    'POST /stop': async (body) => {
      const stopped = await docker.stop({ appId: body.app_id })
      await syncExposed()
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
    // Every refusal comes before the old container is touched, and Basecamp
    // sends no `/stop` ahead of this for that reason (`FJS-1682`): a release
    // refused here leaves the live app serving. A release docker refuses, or
    // one that starts and does not answer, puts the old container back (`FJS-1765`) —
    // so this answers once the release is healthy, not once it has started.
    'POST /deploy': async (body) => {
      const appId = body.app_id ?? body.deployment_id
      const hosts     = hostsOf(body.hosts)
      const redirects = redirectsOf(body.redirects)
      const paths     = pathsOf(body.paths)
      const fronted   = hosts.length > 0 || paths.length > 0
      const port      = body.config?.port
      if (fronted && !port) throw new Error('hosts need a published port to route to — config.port is not set')
      checkRunConfig(body.config)

      const image = body.image ?? `fjs-${body.deployment_id}`
      let built   = { digest: body.digest ?? null }
      if (body.source?.kind === 'git' && body.source.repo && !body.digest)
        built = await docker.build({ appId, source: body.source, image })

      // A release that dropped its last hostname drops its route too.
      if (fronted || redirects.length) await ingress.route({ appId, hosts, port, redirects, paths })
      else await ingress.unroute({ appId })

      let started
      try {
        started = await docker.deploy({
          appId,
          image,
          digest:   built.digest ?? body.digest,
          config:   body.config ?? {},
          port,
          loopback:    fronted,
          exposesPort: body.exposes_port === true,
        })
      } catch (err) {
        await syncExposed()
        // The route already moved to the new port. A put-back container
        // answers on the port IT published, so a route left dialing the new
        // one sends the restored app's hostnames a 502.
        if (err.restored && fronted) {
          const live = await docker.published({ appId }).catch(() => null)
          if (live?.port && live.port !== port)
            await ingress.route({ appId, hosts, port: live.port, redirects, paths })
              .catch(e => log.error?.(`outpost: re-routing fjs-${appId} to the restored container failed — ${e.message}`))
        }
        throw err
      }
      await syncExposed()
      return { ...started, hosts, paths, commit_sha: built.commitSha ?? null }
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
    //
    // A stated `port` is for an app with no container — a dev server a
    // preview's worktree runs on this machine. Refused beside a container,
    // which answers on the port IT published and nowhere else.
    'POST /route': async (body) => {
      const appId = body.app_id
      if (!appId) throw new Error('a route needs the app_id it is for')
      const hosts     = hostsOf(body.hosts)
      const redirects = redirectsOf(body.redirects)
      const paths     = pathsOf(body.paths)
      const fronted   = hosts.length > 0 || paths.length > 0
      const routed    = fronted || redirects.length
      // An inline app has no container: its hostnames go to the static origin,
      // the way `/static/activate` routes them.
      if (body.static) {
        if (fronted && !config.staticPort) throw new Error('this machine serves no static origin (OUTPOST_STATIC_PORT=0), so nothing can route a hostname to these files')
        if (routed) await ingress.route({ appId, hosts, port: config.staticPort, host: `${appId}.localhost`, redirects, paths })
        else await ingress.unroute({ appId })
        return { hosts, paths, port: config.staticPort, rebind: null }
      }
      if (body.port != null) {
        // A machine with no docker holds no container to collide with.
        if (await docker.published({ appId }).catch(() => null)) throw new Error(`fjs-${appId} is a container on this machine and is routed to the port it published — send no port`)
        const port = Number(body.port)
        if (routed) await ingress.route({ appId, hosts, port, redirects, paths })
        else await ingress.unroute({ appId })
        return { hosts, paths, port, rebind: null }
      }
      const live  = await docker.published({ appId })
      if (fronted && !live) throw new Error(`no container fjs-${appId} on this machine to route to — deploy it first`)
      if (fronted && !live.port) throw new Error(`fjs-${appId} publishes no port to route to — set the app's port and redeploy`)

      if (routed) await ingress.route({ appId, hosts, port: live?.port, redirects, paths })
      else await ingress.unroute({ appId })

      const rebind = !live?.port ? null
        : fronted && !live.loopback ? `port ${live.port} still answers off this machine, around Caddy, until the next release binds it to loopback`
        : !fronted && live.loopback ? `port ${live.port} is bound to loopback with no route in front of it, so nothing reaches the app until the next release`
        : null
      return { hosts, paths, port: live?.port ?? null, rebind }
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
    // A route's traffic in a window, counted off its Caddy access log. The
    // caller names the route — `fjs-<app>` or `fli-<app>…` — and no prefix is
    // added here, because `fli deploy` writes routes this process never made.
    'POST /analytics': (body) => analytics.report({ routeId: body.route_id, from: body.from, to: body.to }),

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
    //
    // `/static/activate` names the app's hostnames the way `/deploy` does, and
    // Caddy routes them to the static origin under the app's ID — never its
    // slug, which another app on this machine may hold. The route moves first:
    // a swap that fails leaves the hostnames on the release already live. A
    // list that dropped its last hostname drops the route.
    'POST /static/activate': async (body) => {
      const hosts     = hostsOf(body.hosts)
      const redirects = redirectsOf(body.redirects)
      const paths     = pathsOf(body.paths)
      if ((hosts.length || paths.length) && !config.staticPort) throw new Error('this machine serves no static origin (OUTPOST_STATIC_PORT=0), so nothing can route a hostname to these files')
      if (hosts.length || paths.length || redirects.length)
        await ingress.route({ appId: body.app_id, hosts, port: config.staticPort, host: `${body.app_id}.localhost`, redirects, paths })
      else if (body.hosts || body.redirects || body.paths) await ingress.unroute({ appId: body.app_id })
      return { ...await statics.activate({ appId: body.app_id, slug: body.slug, digest: body.digest }), hosts, paths }
    },
    'POST /static/health':   (body) => statics.healthCheck({ appId: body.app_id, digest: body.digest }),
    // Off the air means off every hostname too, whichever port the route dialed.
    'POST /static/retire':   async (body) => ({
      ...await statics.retire({ appId: body.app_id, slug: body.slug }),
      ...await ingress.unroute({ appId: body.app_id }).then(r => ({ unrouted: r.removed })),
    }),
    'POST /static/releases': (body) => statics.releases({ appId: body.app_id }),

    // A read, signed like every other route: the hostnames a machine serves
    // are the fleet's map, and the static origin beside this is public.
    'POST /ingress':       () => ingress.routes(),

    'POST /system/prune':  (body) => inspector.prune({ targets: body.targets, keepImages: body.keep_images })
      .then(async result => ({ ...result, usage: await inspector.disk() })),
    'POST /volumes/prune': (body) => inspector.pruneVolumes(body.names ?? []),
    // An archive on the machine, or a backup fetched by a pre-signed GET, into the app's stopped volume.
    'POST /volume/restore': (body) => docker.restore({ appId: body.app_id, path: body.path, url: body.url, sha256: body.sha256, overwrite: body.overwrite }),
    // An app's databases out of its Litestream replica, at an instant or the
    // latest, into its stopped volume. The key rides in the body like
    // `/replicate`'s, so the machine holds nothing it was not already handed.
    // A drill: the same restore into a staging directory, proven by the app's
    // own image, never touching the app's volume (`FJS-D1524`).
    'POST /replica/drill': async (body) => {
      const staged = await replicator.stage({ appId: body.app_id, replica: body.replica, databases: body.databases, at: body.at ?? null })
      try {
        const verified = await docker.verifyCopy({ appId: body.app_id, dir: staged.dir, image: body.image, digest: body.digest, env: body.env })
        return { databases: staged.databases, ...verified }
      } finally { await replicator.unstage(staged.dir) }
    },
    'POST /replica/restore': async (body) => {
      const appId = body.app_id
      await docker.refuseHeld({ appId })
      const staged = await replicator.stage({ appId, replica: body.replica, databases: body.databases, at: body.at ?? null })
      try {
        const restored = await docker.restoreFiles({ appId, dir: staged.dir, overwrite: body.overwrite === true })
        return { ...restored, databases: staged.databases, ...await replicator.reregister() }
      } finally {
        await replicator.unstage(staged.dir)
      }
    },
    // An app's data volume, tarred into this machine's backup directory and,
    // given a pre-signed URL, uploaded from there.
    'POST /backup':        (body) => docker.backup({ appId: body.app_id, uploadUrl: body.upload_url }),
    // Every app this machine replicates, each with its own key; the list
    // replaces the last one whole, so an app left out stops replicating.
    'POST /replicate':     (body) => replicator.apply({ replicas: body.replicas, host: body.host }),
    // Basecamp's *check now*: the readings come back in the answer and
    // Basecamp ingests them, rather than this posting a report beside it.
    'POST /posture':       () => inspector.posture(),
  }

  // Routes that answer a STREAM rather than a body: `(body, signal)` returns
  // an async sequence, and `signal` aborts when the caller goes away.
  const streams = {
    'POST /logs/follow': (body, signal) => docker.follow({
      appId: body.app_id, tail: body.tail, since: body.since, signal,
    }),
  }
  let streaming = 0

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
      publicKey: config.hubKey, method: req.method, path, query: url.search, body, headers: req.headers,
      // This machine's clock, stated: the kit takes no ambient state.
      toleranceSeconds: TOLERANCE_S, now: Math.floor(Date.now() / 1000), seenNonce,
    })
    if (!checked.ok) {
      // Logged with the reason, answered without it: a caller learns it was
      // refused, not whether the clock or the key was wrong.
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

    const opener = streams[`${req.method} ${path}`]
    if (opener) {
      if (streaming >= MAX_STREAMS) return json({ error: `this machine already serves ${MAX_STREAMS} streams` }, 429)
      const abort = new AbortController()
      req.signal?.addEventListener('abort', () => abort.abort(), { once: true })
      streaming++
      try {
        return eventStream(opener(payload, abort.signal), abort, () => { streaming-- })
      } catch (err) {
        streaming--
        return json({ error: err.message }, 500)
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

  return { handle, routes: [...Object.keys(routes), ...Object.keys(streams)] }
}
