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
import { createDocker, createInspector, checkRunConfig, checkSwap, swapFor } from './docker.js'
import { createStatic, validName } from './static.js'
import { createIngress, checkRouteAppId, hostsOf, pathsOf, redirectsOf } from './ingress.js'
import { doorRefusal } from './doors.js'
import { createReplicator } from './replicate.js'
import { createAnalytics } from './analytics.js'

const JSON_HEADERS = { 'content-type': 'application/json' }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

// Each open stream holds a process on this machine for as long as somebody
// watches, so the count is capped here rather than trusted to the caller.
const MAX_STREAMS = 16
// The largest request body. The biggest honest one is a static publish: 24 MiB
// of files travels base64-encoded (x4/3 = 32 MiB) inside JSON, so 40 MiB leaves
// room for paths and keys. Bun's default is 128 MiB and the body is buffered
// whole before the signature can fail, so an unbounded one is memory for anyone
// who can reach the port.
export const MAX_BODY_BYTES = 40 * 1024 * 1024
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
  inspector = createInspector({ appsDir: config.appsDir, exclusive: docker.exclusive }),
  statics   = createStatic({ staticDir: config.staticDir, staticUrl: config.staticUrl }),
  ingress   = createIngress({ admin: config.caddyAdmin }),
  analytics = createAnalytics(),
  replicator = createReplicator({ configPath: config.litestreamConfig, appsDir: config.appsDir, metaDir: config.litestreamMetaDir, litestream: config.litestreamBin, stageDir: config.replicaStageDir, hostDb: config.hostFiles?.db ?? null }),
  log       = console,
} = {}) {

  const TOLERANCE_S = 300
  const exclusive   = docker.exclusive ?? ((_appId, fn) => fn())
  // Per process, like basecamp's own: a captured signature is dead in five
  // minutes either way, and a shared store is the change to make when an
  // Outpost runs more than once on a machine. Twice the tolerance: a timestamp
  // accepted at the limit ahead stays fresh for another full tolerance, and a
  // nonce forgotten sooner replays (FJS-1833).
  // The first second this process answers in. The nonce store above dies with
  // the process, so a request captured before a restart could be sent again
  // inside its 300 s window; a signature stamped before this second is refused
  // instead of remembered (`FJS-D1799`).
  const BOOT_S    = Math.floor(Date.now() / 1000)
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
    // refused rather than built. `app` is an API App's site/, after its release.
    'POST /site/publish': async (body) => {
      const built = await docker.sitePublish({
        appId: body.app_id, source: body.source, branch: body.branch, commit: body.commit,
        token: body.cloudflare?.token, accountId: body.cloudflare?.account_id,
        app: body.app ? { volumePath: body.app.volume_path, env: body.app.env } : undefined,
      })
      return { commit_sha: built.commit, url: built.url, ...(built.skipped ? { skipped: built.skipped } : {}) }
    },
    // An API App's web/ or widgets/ (`FJS-D2032`), built from the commit its
    // image was (`FJS-D1979`) and answered as files: Basecamp publishes them to
    // each static App in front of it, through that App's own machine.
    'POST /web/build': async (body) => {
      const built = await docker.webBuild({
        appId: body.app_id, source: body.source, commit: body.commit,
        surface: body.surface ?? 'web', apiUrl: body.api_url ?? null, widgetsUrl: body.widgets_url ?? null,
      })
      return { commit_sha: built.commit, surface: built.surface, ...(built.skipped ? { skipped: built.skipped } : { files: built.files }) }
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
    // (`FJS-D564`) and its port on loopback (`FJS-D565`). A stop-first writes
    // the route before the swap, dialing the container serving now: a hostname
    // another app holds, or a Caddy that is down, then fails the release before
    // the old container is touched. The swap moves the dial itself once the
    // new one answers (`FJS-4018`).
    //
    // Every refusal comes before the old container is touched, and Basecamp
    // sends no `/stop` ahead of this for that reason (`FJS-1682`): a release
    // refused here leaves the live app serving. A release docker refuses, or
    // one that starts and does not answer, puts the old container back (`FJS-1765`) —
    // so this answers once the release is healthy, not once it has started.
    //
    // `swap: 'start-first'` asks for the new container to start beside the old
    // one, on a port Docker picks, with the route moving once it answers. It
    // runs only when the release's pivot is an expand or unchanged; otherwise
    // the swap is stop-first and `swap_reason` says why. A hostname another
    // app holds refuses a start-first release after the start, with the old
    // container still serving.
    'POST /deploy': async (body) => {
      const appId = body.app_id ?? body.deployment_id
      // The slugs spell the container's name. Left out, it would be named for
      // `undefined` and `docker ps` would show a stranger.
      for (const field of ['project', 'environment', 'app_slug'])
        if (typeof body[field] !== 'string' || !body[field].trim()) throw new Error(`a deploy needs the ${field} that names its container`)
      const hosts     = hostsOf(body.hosts)
      const redirects = redirectsOf(body.redirects)
      const paths     = pathsOf(body.paths)
      const noindex   = hostsOf(body.noindex)
      const fronted   = hosts.length > 0 || paths.length > 0
      const port      = body.config?.port
      if (fronted && !port) throw new Error('hosts need a published port to route to — config.port is not set')
      checkRunConfig(body.config)
      const asked = body.swap ?? 'stop-first'
      checkSwap({ swap: asked, loopback: fronted, exposesPort: body.exposes_port === true, port, path: body.config?.healthCheck ?? null })
      const routeTo = (to) => ingress.route({ appId, hosts, port: to, redirects, paths, noindex })
      // Before the build: `fli deploy`'s install of this hostname keeps its own
      // database and key, and a release here would serve neither (`FJS-D1967`).
      const theirs = await ingress.heldBy('ssh', [...hosts, ...paths.map(p => p.host), ...redirects.map(r => r.host)])
      if (theirs.length) throw new Error(doorRefusal('basecamp', theirs))

      // The build and the route are this app's too, not only the swap: a
      // `/stop` or a second release landing between them acts on a route or a
      // clone this one is changing (`FJS-3849`). `held` tells `docker.deploy`
      // the chain is already taken.
      return exclusive(appId, async () => {
        const image = body.image ?? `fjs-${body.deployment_id}`
        let built   = { digest: body.digest ?? null }
        if (body.source?.kind === 'git' && body.source.repo && !body.digest)
          built = await docker.build({ appId, source: body.source, image })

        // `swap` is what the caller allows; the release's pivot decides whether
        // the old one can serve beside it (`FJS-D1838`). A rollback is asked
        // only for a start-first: the verdict also says whether a failed release
        // may have moved the database (`FJS-D2044`), and a rollback's migrations
        // are already recorded.
        const startFirst = asked === 'start-first'
        const pivot = startFirst || !body.rollback ? await docker.pivot({ appId, image, digest: built.digest ?? body.digest }) : null
        const { swap, reason } = startFirst ? swapFor(pivot) : { swap: 'stop-first', reason: null }

        // A release that dropped its last hostname drops its route too. The
        // live port is Docker's after a start-first, and a route dialing the
        // App's port before the new container holds it answers 502.
        const routed = () => ingress.dialed({ appId })
        let dialing = null
        if (swap === 'stop-first') {
          if (fronted || redirects.length) {
            // With no live container, the one container the route already dials
            // is the serving one: a start-first that died after its route moved
            // leaves it as `_next`, and a route written off it takes it down
            // before the swap can name it into place.
            const dialed = fronted ? await routed().catch(() => []) : []
            dialing = fronted ? (await docker.published({ appId }).catch(() => null))?.port ?? (dialed.length === 1 ? dialed[0] : port) : port
            await routeTo(dialing)
          } else await ingress.unroute({ appId })
        }
        const route = !fronted ? null
          : swap === 'start-first' ? routeTo
          : async (to) => { if (to !== dialing) await routeTo(to) }

        let started
        try {
          started = await docker.deploy({
            appId,
            project:     body.project,
            environment: body.environment,
            appSlug:     body.app_slug,
            image,
            digest:   built.digest ?? body.digest,
            config:   body.config ?? {},
            port,
            loopback:    fronted,
            exposesPort: body.exposes_port === true,
            swap,
            route,
            routed,
            pivot:       body.rollback ? null : pivot?.verdict ?? null,
            rollback:    body.rollback === true,
            held:        true,
          })
        } catch (err) {
          await syncExposed()
          throw err
        }
        await syncExposed()
        return { ...started, hosts, paths, commit_sha: built.commitSha ?? null, pivot: pivot?.verdict ?? null, swap_reason: reason }
      })
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
      // Before `docker.published`, whose own check a `.catch` below swallows.
      checkRouteAppId(appId)
      const hosts     = hostsOf(body.hosts)
      const redirects = redirectsOf(body.redirects)
      const paths     = pathsOf(body.paths)
      const noindex   = hostsOf(body.noindex)
      const fronted   = hosts.length > 0 || paths.length > 0
      const routed    = fronted || redirects.length
      // An inline app has no container: its hostnames go to the static origin,
      // the way `/static/activate` routes them.
      if (body.static) {
        if (fronted && !config.staticPort) throw new Error('this machine serves no static origin (OUTPOST_STATIC_PORT=0), so nothing can route a hostname to these files')
        if (routed) await ingress.route({ appId, hosts, port: config.staticPort, host: `${appId}.localhost`, redirects, paths, noindex })
        else await ingress.unroute({ appId })
        return { hosts, paths, port: config.staticPort, rebind: null }
      }
      if (body.port != null) {
        // A machine with no docker holds no container to collide with.
        if (await docker.published({ appId }).catch(() => null)) throw new Error(`app ${appId} has a container on this machine and is routed to the port it published — send no port`)
        const port = Number(body.port)
        if (routed) await ingress.route({ appId, hosts, port, redirects, paths, noindex })
        else await ingress.unroute({ appId })
        return { hosts, paths, port, rebind: null }
      }
      const live  = await docker.published({ appId })
      if (fronted && !live) throw new Error(`no container for app ${appId} on this machine to route to — deploy it first`)
      if (fronted && !live.port) throw new Error(`app ${appId}'s container publishes no port to route to — set the app's port and redeploy`)

      if (routed) await ingress.route({ appId, hosts, port: live?.port, redirects, paths, noindex })
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
      const noindex   = hostsOf(body.noindex)
      if ((hosts.length || paths.length) && !config.staticPort) throw new Error('this machine serves no static origin (OUTPOST_STATIC_PORT=0), so nothing can route a hostname to these files')
      if (hosts.length || paths.length || redirects.length)
        await ingress.route({ appId: body.app_id, hosts, port: config.staticPort, host: `${body.app_id}.localhost`, redirects, paths, noindex })
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
    // Basecamp's "try again now" for a hostname whose DNS was just fixed.
    'POST /ingress/reload': () => ingress.reload(),
    // The wildcard certificate Basecamp minted, held in Caddy so a host under it
    // is served with no per-name ACME order. The key arrives here and is never
    // sent back; a mismatched pair or an expired one is refused (400) unwritten.
    'POST /certs/load':    (body) => ingress.loadCert({ id: body.id, cert: body.cert, key: body.key }),
    'POST /certs/drop':    (body) => ingress.dropCert({ id: body.id }),

    'POST /system/prune':  (body) => inspector.prune({ targets: body.targets, keepImages: body.keep_images })
      .then(async result => ({ ...result, usage: await inspector.disk() })),
    'POST /volumes/prune': (body) => inspector.pruneVolumes(body.names ?? []),
    // An archive on the machine, or a backup fetched by a pre-signed GET, into the app's stopped volume.
    // `per_file` replaces only the databases the archive holds (`FJS-D1724`).
    'POST /volume/restore': (body) => docker.restore({ appId: body.app_id, path: body.path, url: body.url, sha256: body.sha256, overwrite: body.overwrite, perFile: body.per_file, runId: body.run_id }),
    'POST /volume/restore/began': (body) => docker.restoreBegan({ appId: body.app_id, runId: body.run_id }),
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
    // The drill's staging, kept for the copy's life and served by the release
    // image read-only (`FJS-D1996`), stamped with the newest point the replica
    // reached. A copy that cannot say how old it is is refused, not stamped now.
    // With `host`, and `hosts` while the copy serves the App's main hostnames,
    // the copy is routed there (`fjs-<app>-copy`); without either a route left
    // by an earlier serve is taken out, so a switched-off address never
    // reaches the copy that replaced it.
    // A machine without the image sends `image_url` and `image_sha256`, what
    // `/image/export` uploaded (`FJS-D1914`).
    'POST /replica/serve': async (body) => {
      const [host = null] = hostsOf(body.host == null ? [] : [body.host])
      const hosts = hostsOf(body.hosts).filter(h => h !== host)
      const staged = await replicator.stage({ appId: body.app_id, replica: body.replica, databases: body.databases, at: body.at ?? null })
      let served
      try {
        if (!staged.as_of) throw new Error(`no database's newest point could be read from ${body.replica?.bucket}/${body.replica?.path} (litestream ltx), so the copy cannot say how old it is`)
        served = await docker.serveCopy({ appId: body.app_id, dir: staged.dir, image: body.image, digest: body.digest, imageUrl: body.image_url, imageSha256: body.image_sha256, asOf: staged.as_of, config: body.config ?? {} })
      } catch (err) {
        await replicator.unstage(staged.dir)
        throw err
      }
      for (const old of served.replaced) await replicator.unstage(old.dir)
      if (host || hosts.length) {
        try { await ingress.routeCopy({ appId: body.app_id, host, hosts, dial: served.upstream }) }
        catch (err) {
          const names = [host, ...hosts].filter(Boolean)
          throw new Error(`the copy is up (${served.container}) but ${names.join(', ')} ${names.length > 1 ? 'were' : 'was'} not routed to it: ${err.message}`)
        }
      } else await ingress.unrouteCopy({ appId: body.app_id })
      return { databases: staged.databases, as_of: served.asOf, container: served.container, upstream: served.upstream, host, hosts }
    },
    // The running copy's route rewritten with no restage: the App's main
    // hostnames onto it and back (`IDEAS/read-only-copy.md` 3.1).
    'POST /replica/route': (body) => docker.rerouteCopy({ appId: body.app_id, ingress, host: body.host ?? null, hosts: body.hosts ?? [] }),
    'POST /replica/unserve': async (body) => {
      const { removed } = await docker.unserveCopy({ appId: body.app_id })
      for (const old of removed) await replicator.unstage(old.dir)
      await ingress.unrouteCopy({ appId: body.app_id })
      return { removed: removed.map(c => c.container) }
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
    // The release image saved and PUT to a minted URL, for a copy on a machine
    // that did not build it.
    'POST /image/export':  (body) => docker.exportImage({ appId: body.app_id, image: body.image, digest: body.digest, uploadUrl: body.upload_url }),
    // One of those archives sent to a URL, for a Download of an archive no
    // bucket holds; the path must be a backup of this app under backupDir.
    'POST /backup/send':   (body) => docker.sendBackup({ appId: body.app_id, path: body.path, uploadUrl: body.upload_url }),
    // One of those archives deleted, held to the same rule; and every archive
    // here, including those of an app the hub no longer knows.
    'POST /backup/remove': (body) => docker.removeBackup({ appId: body.app_id, path: body.path }),
    'POST /backups':       () => docker.listBackups(),
    // Every app this machine replicates, each with its own key; the list
    // replaces the last one whole, so an app left out stops replicating.
    'POST /replicate':     (body) => replicator.apply({ replicas: body.replicas, host: body.host, clear: body.clear }),
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

    const verify = (body, nonces) => verifyRequest({
      // Recomputed from the RAW request URL: the query is part of the canonical
      // string since `FJS-678`, and reading a path the router already stripped
      // would sign a different request than the one that arrived.
      publicKey: config.hubKey, method: req.method, path, query: url.search, body, headers: req.headers,
      // This machine's clock, stated: the kit takes no ambient state.
      toleranceSeconds: TOLERANCE_S, now: Math.floor(Date.now() / 1000), seenNonce: nonces,
    })

    // Missing headers, a stale timestamp and a wrong scheme are decided without
    // the body, so they are answered before it is buffered (`FJS-1861`). With the
    // body unread the digest cannot match; that one reason is the real check's.
    // No nonce store here: a nonce is spent only by the check that reads the body.
    const early = await verify('', null)
    const unsigned = !early.ok && early.reason !== 'signature does not match'
    if (!unsigned && Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES)
      return json({ error: `body is over the ${MAX_BODY_BYTES} bytes this machine accepts` }, 413)
    const body     = unsigned ? '' : await req.text()
    const checked  = unsigned ? early : await verify(body, seenNonce)
    if (!checked.ok) {
      // Logged with the reason, answered without it: a caller learns it was
      // refused, not whether the clock or the key was wrong.
      log.warn?.(`outpost: refused ${req.method} ${path} — ${checked.reason}`)
      return json({ error: 'signature required' }, 401)
    }

    // Only a request that verified gets this sentence, so an unsigned caller
    // learns nothing about when this process started. The caller signs afresh
    // on every send, so retrying is the whole remedy.
    if (Number(req.headers.get('X-Fjs-Timestamp')) < BOOT_S) {
      log.warn?.(`outpost: refused ${req.method} ${path} — signed before this process started`)
      return json({ error: 'this request was signed before the Outpost restarted — it predates the restart, so send it again' }, 409)
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
      // how a deploy fails with nothing on screen but a red pill. A flag on the
      // error rides with them: `volume_touched` is how a caller that failed a
      // restore knows whether the data directory is still what it was.
      return json({ error: err.message, ...(err.volumeTouched ? { volume_touched: true } : {}) }, 500)
    }
  }

  return { handle, routes: [...Object.keys(routes), ...Object.keys(streams)] }
}
