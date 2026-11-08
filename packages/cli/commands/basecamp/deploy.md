---
title: basecamp:deploy
description: Build the app here — its image, or web/ for a static App — hand it to the machines Basecamp runs the app on, and release that digest
examples:
  - fli basecamp:deploy --app <app-id>
  - fli basecamp:deploy --dry
  - fli basecamp:deploy --app <app-id> --basecamp ops
  - fli basecamp:deploy --app <app-id> --server deploy@10.0.0.5
  - fli basecamp:deploy --app <app-id> --dist web/dist
  - fli basecamp:deploy --app <app-id> --dry
  - fli basecamp:deploy --app <app-id> --domain app.example.com --yes
flags:
  app:
    type: string
    description: The Basecamp App to release — its id, from the App's page (default is BASECAMP_APP_ID)
  basecamp:
    type: string
    description: The Basecamp to call, by its name in basecamps.json (default the one holding the App — with several entries each is asked for it, and none or two holding it is refused by name)
    defaultValue: ''
  server:
    type: string
    description: "An ssh destination for an App on one machine: an alias from ~/.ssh/config, or user@host. Replaces the Server row's address"
    defaultValue: ''
  dist:
    type: string
    description: "A static App's files, already built: this folder is sent as it is, with index.html at its root, and web/ is not built"
    defaultValue: ''
  force:
    type: boolean
    description: Release a container App although its preflight found an error
    defaultValue: false
  domain:
    type: string
    description: "The App's hostname, when it has no Domain: the Domain, and what both FRONTIER_*_URLs derive from (asked at a terminal)"
    defaultValue: ''
  widgets-domain:
    type: string
    description: "The widgets App's hostname, when the app has widgets/ and no Domain for it (default deploy.widgets.domain in frontier.config; asked at a terminal, and never guessed under --yes)"
    defaultValue: ''
  yes:
    char: y
    type: boolean
    description: Apply what the App is missing without asking; with no terminal and no --yes the plan is printed and nothing is written
    defaultValue: false
---

The release path for an app Basecamp runs whose image cannot be built from a
git checkout on the machine (`FJS-D942`). An app `fli new` scaffolded depends on
the framework by `link:` or `workspace:`, and a build can resolve those only
where the workspace is — so this builds HERE, exactly as `fli deploy:local`
does: `deploy/generated/` vendored, then `docker build -f` the app's Dockerfile.
The Dockerfile is the one a push would build (`FJS-D1560`): `deploy.api.dockerfile`
in `frontier.config.js` when set, else the Outpost's order — the copy stored on
the App, `deploy/Dockerfile`, the root's — and `deploy/generated/` is vendored
only when that file installs from it, so a plain repository with its own
Dockerfile and no `package.json` builds as it is.

**The release is HEAD as committed** (`FJS-D1968`), on this door and on `fli
deploy`'s SSH one, from the same module (`core/release-build.js`): `git archive`
of the app's directory into a scratch directory the build reads instead of the
working tree. An uncommitted change is listed and left out, and an untracked
Dockerfile is never chosen, so the tag and the row name a commit that a rollback
rebuilds from the same tree. The App's stored Dockerfile is written into that
directory and the checkout is not touched.

**A machine holds one door's install of an app** (`FJS-D1967`). The SSH door
keeps its database in `<path>/db`, its env in `.env.production` and its own
`ENCRYPTION_KEY`, and never sees this App's volume or Variables. Outpost's
`/deploy` refuses a release whose hostnames, path hosts or redirect hosts an
SSH-door route holds on the machine (`@frontierjs/outpost/doors`), and names
`fli deploy:move --to=basecamp`, which carries that install's database, env
and key into this App; `fli deploy`'s preflight refuses the reverse.

The image goes to each machine by `docker save | ssh <machine> docker load` —
no registry. The release names the id the MACHINE's daemon gives the tag after
the load, not this one's: a daemon on the containerd image store ids an image
by its manifest digest and the classic store by its config digest, so one
round trip can change the id. The machines are the App's placements
on online servers, reached as `sshUser@ipAddress` (and `sshPort` when it is not
22) off each Server row; `--server` names the destination instead, for an App on
one machine reached by an ssh alias. A machine named `localhost` is this
daemon, and nothing is shipped to it.

Then one Basecamp release, `POST /deployments` with the image as `toImage` and
its id as `builtImage`: a release that names a digest builds nothing, so the
machine starts the bytes just loaded rather than building the app's source. The
command waits for the release and prints its steps. Building nothing, the
machine never reads the Dockerfile, so its last `EXPOSE` is read here
(`FJS-D1567`): an App storing no container port takes it before the preflight,
and one stating another number keeps it and is told where the two differ.

**A static App (an inline source) is released as its files, from its own
surface.** The source's `surface` says which (`web` when absent). `web/` of the
same staged commit is built here with `vite build` into a temp directory, never
into `web/dist`, resolving its dependencies through the checkout's
`node_modules`, with `VITE_FJS_BUILD` set to the commit (`FJS-D1969`) and no API
origin, since the Domain routes the API back (`FJS-D1547`); where the app has a
widgets App the build bakes `FRONTIER_PUBLIC_WIDGETS_URL` with its hostname.
`widgets/` is built with `sierra widgets` in the staged tree, and bakes
`FRONTIER_PUBLIC_API_URL` with web's hostname, because a widget runs on a
stranger's page and has no origin of its own to call; it is built into a folder
this command names with `--out-dir` (`FJS-D2036`). The
hostnames are the Domains Basecamp holds, else `deploy.web.domain` and
`deploy.widgets.domain` in `frontier.config`. The `.env` files it
bakes are the committed ones — the App's Variables in Basecamp are
not what the bundle carries, and the build is preceded by a line naming the
`VITE_` / `FRONTIER_PUBLIC_` keys it will bake and the file each comes from
(never a value; `FJS-3475`). `--dist` names a folder already built and sends
it as it is. The files go to `apps.publish`, where Basecamp sends them to the
App's machine and releases the digest the machine answers, the path a
preview's Freeze takes; this laptop never holds the machine's secret. Outpost
bounds a build at 500 files, 4 MB a file and 24 MB in all, and Basecamp's
request at 10 MB of JSON, binary files at a third over their size.

**A container App is checked before anything is built.** The App's settings
are read against what the app declares — its `defineEnv` spec, its schema's
`database` blocks, its health route, its Dockerfile — and the build context
against what git ignores (`core/release-preflight.js`, `core/build-check.js`).
A required variable set nowhere, a database written inside the container, no
published port or one the app does not listen on, a schema its migrations do
not build (`fli check`'s `migration-history`), and an env file or database in
the image are errors, and an error stops the release before the build;
`--force` releases anyway. A URL left on a default that is a real outside
service, a health route the App never asks, and a git-ignored file the image
would carry are warnings. `--dry` prints the whole report and builds nothing.

**What the App is missing is set up here, from those same declarations**
(`FJS-3525`), on every run rather than the first (`FJS-D1599`), so a setup
that stopped part way is finished by the next one. Each finding that is a
missing setting carries its fix, and the command merges them into one plan:
a Variable the App already holds is never written again, and a Domain or
route already there is read rather than made twice. The plan holds the App's
container port from the app's `PORT` and its host port the first from there
that no other App on its machines publishes (`FJS-3563`), its volume at `/db` with every
database path moved onto it, its health check, `NODE_ENV=production`, each
external URL recorded at its default, and `ENCRYPTION_KEY` minted as a secret
and never printed. One question is asked, the hostname — `--domain` answers
it, and both `FRONTIER_*_URL`s derive from it. At a terminal it offers the
package's name under Basecamp's own domain (`@acme/kos` beside
`yuma.acme.cloud` offers `kos.acme.cloud`) and `-` leaves it unset; `--yes`
offers nothing, since a guessed hostname would write DNS unasked. An app with
`widgets/` gets a second static App, `widgets`, beside the first, on the same
machines, once a widgets hostname is stated: `--widgets-domain`, else
`deploy.widgets.domain`, else at a terminal `widgets.<the web hostname>` is
offered. Its Domain carries no route back to the API (the prefixes go to web's
Domain only). An app with `web/` gets a
static App for it beside this one, placed on the same machines and named
`app`, and this one is renamed `api` — the front door is the one called the
app. A slug never changes, so the static App's is `app`, or `web` where this
one already holds `app`. The
Domain goes on that App with the API's prefixes and `/ws` routed back here —
`fli deploy`'s shape, `FJS-D1040`'s rows (`FJS-D1547`); an app without one
gets the Domain itself. A Domain on the static App missing a route back is a
finding whose fix is the route (`FJS-3529`). On an App no release of which
has succeeded, a finding the plan fixes is printed only as a line of the plan,
headed *New deployment*, and the preflight's Errors and Warnings keep what the
plan cannot set; the error count that stops the release still counts every
one. The plan is shown, applied on a yes (`--yes` skips
the asking), and the preflight runs again on what Basecamp now holds. With no
terminal and no `--yes` the plan is printed and nothing is written; `--dry`
prints it too. A credential the app requires and a Dockerfile edit
stay prose: nothing here can know them. `fli env:push` sets the
credentials from `.env.production`, skipping every key this plan sets.

The Basecamp is an entry in `basecamps.json` (`~/.config/fli/`), whose origin
and key `--basecamp` chooses: the one named, else the only entry, else the one
entry answering for the App when each is asked; none or two holding it is
refused by name (`FJS-4065`). The App is `--app` or
`BASECAMP_APP_ID` in the app's `.env`. With `BASECAMP_APP_ID` set, `fli deploy`
is this command for that App and then for the static App in front of it.

The key is read from the entry and never from a flag, which
would put it in shell history. The key needs `apps:read`,
`deployments:write` and `deployments:read` (to watch the release) — and
`apps:write` for a static App, or one that takes its container port — and a standing that may release in its
workspace. Setting up what the App is missing reads `domainRoutes:read` and
writes through `apps:write`, `variables:write`, `domains:write` and
`domainRoutes:write`; a static App's build also reads `domains:read` for the hostnames it bakes; a 403 names
the scope the key lacks.

<script>
const { loadFrontierConfig }         = await import(new URL('file://' + global.fliRoot + '/core/utils.js'))
const { GENERATED_DIR, exposedPort } = await import(new URL('file://' + global.fliRoot + '/core/vendor.js'))
const { stageRelease, webBuildEnv, widgetsBuildEnv, originOf, suggestedWidgetsHostname } = await import(new URL('file://' + global.fliRoot + '/core/release-build.js'))
const { createMachine }              = await import(new URL('file://' + global.fliRoot + '/core/machine.js'))
const { releaseFindings, gatherReleaseInputs, releasePlan, surfaceOf } = await import(new URL('file://' + global.fliRoot + '/core/release-preflight.js'))
const { routePrefixes, apiPaths }    = await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
const { readAppSnapshot }            = await import(new URL('file://' + global.fliRoot + '/core/app-entry.js'))
const { bundleEnvKeys, bundleEnvLine } = await import(new URL('file://' + global.fliRoot + '/core/bundle-env.js'))
const { inspectBuild, inspectIgnored, gatherLocal, gatherIgnored, gatherSqliteCopies } = await import(new URL('file://' + global.fliRoot + '/core/build-check.js'))

// Basecamp's own bound on a release that pulls nothing and starts and health
// checks once, with room for a put-back.
const WAIT_MS = 15 * 60_000

/** Where ssh reaches a Server row. The URI form carries a port with no `-p`, which machine.js cannot pass. */
function sshDestination(server) {
  if (!server.ipAddress) throw new Error(`server '${server.name}' records no ipAddress — pass --server with an ssh destination for it`)
  const user = server.sshUser || 'root'
  return Number(server.sshPort ?? 22) === 22
    ? `${user}@${server.ipAddress}`
    : `ssh://${user}@${server.ipAddress}:${server.sshPort}`
}

/** The hostname offered when nothing names one: the package's name under the
 *  domain Basecamp itself answers on — `@acme/kos` beside yuma.acme.cloud is
 *  kos.acme.cloud. Null where a half is no DNS name: a localhost or bare-IP
 *  Basecamp has no domain to share, and a two-label one would offer a TLD. */
function suggestedHostname(packageName, origin) {
  const label = String(packageName ?? '').replace(/^@[^/]+\//, '').toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null
  let host
  try { host = new URL(origin).hostname } catch { return null }
  const parts = host.split('.')
  if (parts.length < 3 || /^\d+$/.test(parts.at(-1))) return null
  return `${label}.${parts.slice(1).join('.')}`
}

/** The App with its container port off the Dockerfile's last EXPOSE (`FJS-D1567`).
 *  A release naming a digest builds nothing on the machine, so the Outpost's
 *  /build never reads the file, and an App storing no container port is
 *  started with its host port mapped to itself — healthy to docker, a 502 at
 *  Caddy (`FJS-4047`). Written before the preflight and the release, which
 *  both read the App. One stating a number keeps it, and the line says where
 *  the two differ. */
async function withExposedPort({ origin, key, app, text, dockerfile, dry, log, echo }) {
  const exposed = exposedPort(text)
  if (exposed == null) return app
  if (app.containerPort != null) {
    if (Number(app.containerPort) !== exposed)
      log.warn(`${dockerfile} says EXPOSE ${exposed} where the App says ${app.containerPort} — the App's number is the one the release starts`)
    return app
  }
  if (dry) {
    log.dry(`Would set App '${app.name}' container port to ${exposed}, the EXPOSE in ${dockerfile}`)
  } else {
    await basecamp(origin, key, `/apps/${encodeURIComponent(app.id)}`, { method: 'PATCH', body: { containerPort: exposed } })
    echo`  App '${app.name}' container port {bold ${exposed}}{dim , the EXPOSE in ${dockerfile}}`
  }
  return { ...app, containerPort: exposed }
}

async function packageName(root) {
  const { readFileSync } = await import('fs')
  try { return JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).name }
  catch { return null }
}

/** A list read that answers null and why, rather than throwing: the preflight
 *  reports what it could not read and grades the rest. */
async function readList(origin, key, path) {
  try { return { rows: await basecampAll(origin, key, path) } }
  catch (err) { return { rows: null, error: err.message } }
}

/** Whether the App has never gone live: no release of it succeeded, a rolled
 *  back one included. An unreadable history answers false, so a live App is
 *  never shown its gaps as a first setup. */
async function neverReleased(origin, key, app) {
  for (const status of ['success', 'rolledBack']) {
    const rows = await basecamp(origin, key, `/deployments?appId=${encodeURIComponent(app.id)}&status=${status}&$limit=1`).catch(() => null)
    if (!rows || rows.some(r => r.appId === app.id)) return false
  }
  return true
}

/** Everything the preflight finds for a container App, errors first, with the
 *  API's route prefixes the plan routes back to it. */
async function preflight({ origin, key, app, root, dir, dockerfile, text }) {
  const fs = await import('fs')
  const { spawnSync } = await import('child_process')
  const vars     = await readList(origin, key, `/variables?environmentId=${encodeURIComponent(app.environmentId)}`)
  const siblings = await readList(origin, key, `/apps?environmentId=${encodeURIComponent(app.environmentId)}`)
  const routes   = await readList(origin, key, '/domainRoutes')
  const prefixes = routePrefixes(apiPaths(readAppSnapshot(root)))
  const build    = gatherLocal({ root: dir, fs, dockerfile })
  const level    = { error: 0, warn: 1, info: 2 }
  const findings = [
    ...releaseFindings({
      app, variables: vars.rows, siblings: siblings.rows, routes: routes.rows, prefixes,
      unread: { ...(vars.error ? { variables: vars.error } : {}), ...(routes.error ? { routes: routes.error } : {}) },
      ...gatherReleaseInputs(root, { dockerfile, dockerfileText: text }),
    }),
    ...(build.missing ? [] : inspectBuild(build)),
    ...(build.missing ? [] : inspectIgnored({
      dockerfile: build.dockerfile, dockerignore: build.dockerignore,
      groups: gatherIgnored({ root, fs, spawnSync }), sqliteCopies: gatherSqliteCopies({ root, fs }), expected: [GENERATED_DIR],
    })),
  ].sort((a, b) => level[a.level] - level[b.level])
  return { findings, prefixes }
}

/** The page a static App serves until its surface is released onto it. */
const PLACEHOLDER = (name, id, surface = 'web') => `<!doctype html>
<meta charset="utf-8"><title>${name}</title>
<body><p>${surface}/ of ${name} is not released yet — <code>fli basecamp:deploy --app ${id}</code> releases it.</p></body></html>
`

/** An app split in two: the image is `api`, and the static App the Domain sits on is `app`. */
const API_NAME = 'api'
const WEB_NAME = 'app'
const WIDGETS_NAME = 'widgets'

/** The lines a plan prints, each a write it would make; empty when there is nothing to do. */
function planLines(plan, app, servers) {
  const lines = []
  const apiName  = plan.app.name ?? app.name
  const settings = Object.entries(plan.app).map(([k, v]) => `${k} ${v}`)
  if (settings.length) lines.push(`App '${app.name}': ${settings.join(', ')}`)
  if (plan.variables.length)
    lines.push(`Variables: ${plan.variables.map(v => v.generate ? `${v.key} (a generated secret)` : `${v.key}=${v.value}`).join(', ')}`)
  if (plan.web) lines.push(`Static App '${WEB_NAME}' for web/${servers.length ? `, placed on ${servers.join(', ')}` : ''}`)
  if (plan.domain)
    lines.push(`Domain ${plan.domain.hostname} on '${plan.domain.on === 'web' ? WEB_NAME : apiName}'` +
      (plan.domain.routes.length ? `, ${plan.domain.routes.join(' and ')} → '${apiName}'` : ''))
  if (plan.widgets) lines.push(`Static App '${WIDGETS_NAME}' for widgets/${servers.length ? `, placed on ${servers.join(', ')}` : ''}`)
  if (plan.widgetsDomain) lines.push(`Domain ${plan.widgetsDomain.hostname} on '${WIDGETS_NAME}', routing nothing back`)
  for (const r of plan.routes) lines.push(`Routes on ${r.hostname}: ${r.prefixes.join(' and ')} → '${apiName}'`)
  return lines
}

/** The plan written to Basecamp, in the order each write needs the one before. */
async function applyPlan({ origin, key, app, plan }) {
  const { randomBytes } = await import('crypto')
  if (Object.keys(plan.app).length)
    await basecamp(origin, key, `/apps/${encodeURIComponent(app.id)}`, { method: 'PATCH', body: plan.app })
  for (const v of plan.variables)
    await basecamp(origin, key, '/variables', { method: 'POST', body: {
      environmentId: app.environmentId, appId: app.id, key: v.key, isSecret: !!v.isSecret,
      value: v.generate === 'hex32' ? randomBytes(32).toString('hex') : v.value,
    } })
  const web     = plan.web ? await makeStatic({ origin, key, app, name: WEB_NAME, altSlug: 'web', surface: 'web' }) : null
  const widgets = plan.widgets ? await makeStatic({ origin, key, app, name: WIDGETS_NAME, altSlug: 'widgets-static', surface: 'widgets' }) : null
  if (plan.domain) {
    const owner  = plan.domain.on === 'web' ? (web ?? { id: plan.domain.webId }) : app
    const domain = await domainOn({ origin, key, ownerId: owner.id, hostname: plan.domain.hostname })
    await routeBack({ origin, key, app, domainId: domain.id, hostname: plan.domain.hostname, prefixes: plan.domain.routes })
  }
  // The widget origin is cross-origin by definition: its Domain routes nothing
  // back to the API (`FJS-D1547` puts the prefixes on web's Domain only).
  if (plan.widgetsDomain)
    await domainOn({ origin, key, ownerId: (widgets ?? { id: plan.widgetsDomain.widgetsId }).id, hostname: plan.widgetsDomain.hostname })
  for (const r of plan.routes) await routeBack({ origin, key, app, ...r })
  return { web, widgets }
}

/** A static App for one surface, serving a placeholder until that surface is
 *  released onto it, and placed on the API's machines. */
async function makeStatic({ origin, key, app, name, altSlug, surface }) {
  const source = (id) => ({ kind: 'inline', ...(surface === 'web' ? {} : { surface }), files: [{ path: 'index.html', content: PLACEHOLDER(app.name, id, surface) }] })
  const made = await basecamp(origin, key, '/apps', { method: 'POST', body: {
    environmentId: app.environmentId, name, slug: app.slug === name ? altSlug : name, kind: 'static', source: source('<its id>'),
  } })
  // The page names the command that replaces it, and that needs the id just issued.
  await basecamp(origin, key, `/apps/${encodeURIComponent(made.id)}`, { method: 'PATCH', body: { source: source(made.id) } })
  // Caddy routes a prefix only between Apps on one machine (`FJS-D1040`).
  for (const p of app.placement ?? [])
    await basecamp(origin, key, `/apps/${encodeURIComponent(made.id)}`, { method: 'POST', headers: { 'x-service-method': 'place' }, body: { serverId: p.serverId } })
  return made
}

/** The Domain row for `hostname` on `ownerId`: its own when a run that stopped
 *  after this write left it, since a second POST is refused by the
 *  per-workspace unique hostname. Basecamp's find filters on appId only, so
 *  the hostname is matched here. */
async function domainOn({ origin, key, ownerId, hostname }) {
  const host  = hostname.toLowerCase()
  const found = (await basecampAll(origin, key, '/domains')).find(d => d.hostname.toLowerCase() === host)
  if (found && found.appId !== ownerId)
    throw new Error(`${hostname} is already a Domain of another App (${found.appId}) — move it in Basecamp, or pass a different hostname`)
  return found ?? await basecamp(origin, key, '/domains', { method: 'POST', body: { appId: ownerId, hostname } })
}

/** Each of `prefixes` on the Domain routed to `app`, posting only what is not
 *  there. A prefix already routed elsewhere is a hand edit, and a reconcile
 *  never overwrites one (`FJS-D1599`). Basecamp stores a prefix lowercased
 *  with no trailing slash, so the plan's is compared in that form. */
async function routeBack({ origin, key, app, domainId, hostname, prefixes }) {
  const norm   = (p) => String(p).trim().toLowerCase().replace(/\/+$/, '')
  const routed = new Map((await basecampAll(origin, key, `/domainRoutes?domainId=${encodeURIComponent(domainId)}`))
    .filter(r => r.domainId === domainId).map(r => [norm(r.pathPrefix), r]))
  for (const pathPrefix of prefixes) {
    const have = routed.get(norm(pathPrefix))
    if (have && have.appId !== app.id)
      throw new Error(`${hostname}${pathPrefix} already routes to another App (${have.appId}) — change it in Basecamp, or remove the route`)
    if (!have) await basecamp(origin, key, '/domainRoutes', { method: 'POST', body: { domainId, pathPrefix, appId: app.id } })
  }
}

/** What frontier.config states for the two public hostnames, or null where it
 *  states none. */
async function configuredHosts(root) {
  const deploy = (await loadFrontierConfig(root))?.deploy
  return { web: deploy?.web?.domain ?? null, widgets: deploy?.widgets?.domain ?? null }
}

/** The hostname each static surface answers on, as Basecamp holds it. A read
 *  that fails answers nothing and the config's word stands. */
async function staticHostnames({ origin, key, app }) {
  const siblings = (await readList(origin, key, `/apps?environmentId=${encodeURIComponent(app.environmentId)}`)).rows ?? []
  const domains  = (await readList(origin, key, '/domains')).rows ?? []
  const hostOf   = (surface) => {
    const front = siblings.find(s => s.source?.kind === 'inline' && surfaceOf(s) === surface)
    return domains.find(d => front && d.appId === front.id)?.hostname ?? null
  }
  return { web: hostOf('web'), widgets: hostOf('widgets') }
}

/** The origins one surface's bundle bakes (`FJS-D1969`): web/ the widget
 *  origin when there is one, and widgets/ the API origin, which a widget on
 *  another site cannot take from its own page. web/ reaches the API through
 *  its own Domain (`FJS-D1547`), so the API origin is that Domain's. */
async function bundleOrigins({ surface, origin, key, app, root }) {
  const held   = await staticHostnames({ origin, key, app })
  const config = await configuredHosts(root)
  if (surface === 'widgets') {
    const web = held.web ?? config.web
    return { apiOrigin: web ? originOf(web, 'the web hostname') : null }
  }
  const widgets = held.widgets ?? config.widgets
  return { widgetsOrigin: widgets ? originOf(widgets, 'the widgets hostname') : null }
}

/** web/ built with vite into `out`. The API is reached through this App's own
 *  Domain (`FJS-D1547`), so no API origin is passed (`FJS-D1969`). */
async function buildWeb({ $, staged, tree, config, out, origins, log }) {
  const { join, relative } = await import('path')
  const stagedWeb = join(staged.dir, 'web')
  log.info(bundleEnvLine(bundleEnvKeys(stagedWeb)))
  log.info(`Building ${stagedWeb} at ${staged.short}...`)
  $.exec({
    command: 'bun --bun vite build', cwd: stagedWeb,
    args: ['-c', join(stagedWeb, relative(tree, config)), '--outDir', out, '--emptyOutDir'],
    env: { ...process.env, NODE_ENV: 'production', ...webBuildEnv({ commit: staged.sha, widgetsOrigin: origins.widgetsOrigin }) },
  })
  return out
}

/** widgets/ built with `sierra widgets` into `out` (`FJS-D2036`). A Sierra
 *  older than `--out-dir` writes to its own outDir and leaves `out` empty, so an
 *  empty one is refused by name rather than published as an empty release. */
async function buildWidgets({ $, staged, out, origins, log }) {
  const { join } = await import('path')
  const { readdirSync } = await import('fs')
  const stagedWidgets = join(staged.dir, 'widgets')
  if (!origins.apiOrigin)
    throw new Error("widgets/ bakes the API's origin, and none is known: the web App holds no Domain in Basecamp and deploy.web.domain is not set in frontier.config")
  log.info(bundleEnvLine(bundleEnvKeys(stagedWidgets), 'widgets'))
  log.info(`Building ${stagedWidgets} at ${staged.short} against ${origins.apiOrigin}...`)
  $.exec({
    command: 'bunx --bun sierra widgets', cwd: stagedWidgets, args: ['--out-dir', out],
    env: { ...process.env, NODE_ENV: 'production', ...widgetsBuildEnv({ commit: staged.sha, apiOrigin: origins.apiOrigin }) },
  })
  if (!readdirSync(out).some(f => f.endsWith('.js')))
    throw new Error(`sierra widgets wrote no script to ${out} — a Sierra older than --out-dir builds into its own outDir; move @frontierjs/sierra to a release with --out-dir (FJS-D2036)`)
  return out
}

/** The release once it stops moving, or as it stands after WAIT_MS. */
async function settle(origin, key, id) {
  let row = { status: 'pending' }
  for (const started = Date.now(); !['success', 'failed', 'cancelled'].includes(row?.status) && Date.now() - started < WAIT_MS;) {
    await new Promise(r => setTimeout(r, 2_000))
    row = await basecamp(origin, key, `/deployments/${id}`)
  }
  return row
}

// Sierra's layout first; a plain Vite app keeps its config beside index.html.
const VITE_CONFIGS = ['config/vite.config.js', 'config/vite.config.ts', 'vite.config.js', 'vite.config.ts', 'vite.config.mjs']

/** The checkout's installed node_modules, linked into the staged tree: a build
 *  there resolves `link:`/`workspace:` dependencies through the symlink, which
 *  a git archive does not carry. */
async function linkNodeModules(root, dir) {
  const { existsSync, symlinkSync } = await import('fs')
  const { join } = await import('path')
  for (const rel of ['node_modules', 'web/node_modules', 'widgets/node_modules']) {
    const from = join(root, rel)
    if (existsSync(from)) symlinkSync(from, join(dir, rel))
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** Every file of a static build as Outpost takes it, text as text and the rest
 *  as base64. Sierra writes the page under `client/` when it builds a server
 *  half beside it. */
async function filesUnder(out) {
  const { existsSync, readdirSync, readFileSync } = await import('fs')
  const { join, relative } = await import('path')
  const root = existsSync(join(out, 'index.html')) ? out : join(out, 'client')
  if (!existsSync(join(root, 'index.html'))) throw new Error(`${out} holds no index.html, so the App's address would serve nothing`)
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => {
      const abs   = join(e.parentPath, e.name)
      const bytes = readFileSync(abs)
      const path  = relative(root, abs)
      try { return { path, content: UTF8.decode(bytes) } }
      catch { return { path, content_base64: bytes.toString('base64') } }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}
</script>

```js
const { existsSync, mkdtempSync, readFileSync, rmSync } = await import('fs')
const { tmpdir }           = await import('os')
const { join, relative, resolve } = await import('path')

const root = $.paths.root
const appId  = flag.app || process.env.BASECAMP_APP_ID
if (!appId) throw new Error("needs --app or BASECAMP_APP_ID — the App's id, from its page in Basecamp, or fli basecamp:app to make one and store it")
const target = await reachFor(flag.basecamp, appId, log)
if (!target) return
const { url: origin, apiKey: key } = target

let   app    = await basecamp(origin, key, `/apps/${encodeURIComponent(appId)}`)
const inline = app?.source?.kind === 'inline'
if (flag.dist && !inline)
  throw new Error(`--dist sends files, and App '${app.name}' is not inline — its release is an image built here`)
if (flag.server && inline)
  throw new Error(`--server names an ssh destination, and App '${app.name}' is inline — its files go through Basecamp, not over ssh`)

// A read, so it runs under --dry too: a dry run names the commit it would release.
const git    = (args) => { try { return String($.exec({ command: `git -C ${root} ${args}`, dry: false, stdio: ['ignore', 'pipe', 'ignore'] }) ?? '').trim() } catch { return '' } }
const sha    = git('rev-parse HEAD')
const branch = git('rev-parse --abbrev-ref HEAD')
// The row names HEAD because the release is HEAD as committed, which
// `stageRelease` builds; only `--dist` ships files that came from elsewhere.
const commit = { trigger: 'laptop', ...(sha ? { commitSha: sha } : {}), ...(branch && branch !== 'HEAD' ? { branch } : {}) }

let release, named
if (inline) {
  // ─── A static App: its files ───────────────────────────────────────────────
  // Each static App builds its own surface (`widgets-deploy`): the row's
  // source says which, and a row without one is web/'s.
  const surface = surfaceOf(app)
  const tree    = join(root, surface)
  const config  = flag.dist || surface !== 'web' ? null : VITE_CONFIGS.map(c => join(tree, c)).find(existsSync)
  if (!flag.dist && !existsSync(tree))
    throw new Error(`App '${app.name}' releases ${surface}/, and ${tree} does not exist — pass --dist with a folder already built`)
  if (!flag.dist && surface === 'web' && !config)
    throw new Error(`${tree} has no vite config (looked for ${VITE_CONFIGS.join(', ')}) — pass --dist with a folder already built`)

  if (flag.dry) {
    log.dry(flag.dist ? `Would send ${resolve(flag.dist)} as it is` : surface === 'web' ? `Would build ${tree} with ${config}` : `Would build ${tree} with sierra widgets`)
    log.dry(`Would publish the files to App '${app.name}' on ${origin} and release their digest`)
    return
  }

  // Into a directory of its own, never web/dist: `vite build` empties its
  // outDir, and a dev server running from this checkout serves that one.
  const out    = flag.dist ? null : mkdtempSync(join(tmpdir(), 'basecamp-deploy-'))
  const staged = flag.dist ? null : stageRelease({ appRoot: root, image: false, log })
  try {
    let built = null
    if (staged) {
      // Built from HEAD as committed, so the .env files it bakes are the
      // committed ones.
      await linkNodeModules(root, staged.dir)
      const origins = await bundleOrigins({ surface, origin, key, app, root })
      built = surface === 'web'
        ? await buildWeb({ $, staged, tree, config, out, origins, log })
        : await buildWidgets({ $, staged, out, origins, log })
    }
    const files = await filesUnder(built ?? resolve(flag.dist))
    log.info(`Publishing ${files.length} files to App '${app.name}'...`)
    release = await basecamp(origin, key, `/apps/${encodeURIComponent(app.id)}`, {
      method: 'POST', headers: { 'x-service-method': 'publish' }, body: { files, ...commit },
    })
  } finally {
    if (out) rmSync(out, { recursive: true, force: true })
    staged?.cleanup()
  }
  named = release.builtImage
} else {
  // ─── A container App: its image, on each machine ───────────────────────────
  const placed = (app.placement ?? []).filter(p => p.server?.status === 'online')
  if (!placed.length)
    throw new Error(`App '${app.name}' is on no online server — place it on one in Basecamp first`)
  if (flag.server && placed.length > 1)
    throw new Error(`App '${app.name}' is on ${placed.length} online servers, and --server names one destination — leave it off to reach each by its Server row`)
  const destinations = flag.server
    ? [{ name: placed[0].server.name, host: flag.server }]
    : placed.map(p => ({ name: p.server.name, host: sshDestination(p.server) }))

  // The release is HEAD as committed, staged beside the checkout (`FJS-D1968`).
  // The Dockerfile is told by frontier.config.js, else the Outpost's own order
  // (`FJS-D1560`): the App's stored copy, deploy/Dockerfile, the root's, judged
  // against that staged tree.
  const told   = (await loadFrontierConfig(root))?.deploy?.api?.dockerfile
  const staged = stageRelease({ appRoot: root, told, stored: app.source?.dockerfile, dry: flag.dry, log })
  const { dir, dockerfile, vendors } = staged
  try {
    if (!staged.present) {
      log.info('fli make:deploy writes one for a scaffolded app; deploy.api.dockerfile in frontier.config.js names one elsewhere')
      throw new Error(`no Dockerfile in ${staged.short}: looked for deploy/Dockerfile, then Dockerfile, as the Outpost does — is it committed?`)
    }
    const dockerfilePath = join(dir, dockerfile)
    const text    = readFileSync(dockerfilePath, 'utf8')
    app = await withExposedPort({ origin, key, app, text, dockerfile, dry: flag.dry, log, echo })

    // Named for the release rather than reused: a tag two builds share is a tag
    // the older one loses on a machine still running it.
    const tag = `fjs-${app.id}:${staged.sha.slice(0, 12)}`.toLowerCase()

    const mark   = { error: chalk.red('✗'), warn: chalk.yellow('!'), info: chalk.dim('·') }
    // On an App never released, a finding the plan fixes is its first setup
    // rather than a fault, and is printed once, as a line of that plan. The
    // count stays over every finding: it is what stops a release the plan
    // was not applied to.
    const report = (findings, { setup = false } = {}) => {
    const count  = (l) => findings.filter(f => f.level === l).length
    const shown  = setup ? findings.filter(f => !f.fix) : findings
    const tally  = (l) => shown.filter(f => f.level === l).length
    const held   = findings.length - shown.length
    echo('')
    echo(`  Preflight — ${tally('error')} error(s), ${tally('warn')} warning(s)` +
      (held ? chalk.dim(` · ${plural(held, 'finding')} set up below, as a new deployment`) : ''))
    // One group per level, each under its own header, so where the errors end
    // and the warnings begin is read off the page rather than counted.
    const groups = [['error', 'Errors', chalk.red], ['warn', 'Warnings', chalk.yellow], ['info', 'Notes', chalk.dim]]
    for (const [level, label, color] of groups) {
      const these = shown.filter(f => f.level === level)
      if (!these.length) continue
      echo('')
      echo(`  ${color(`${label}:`)}`)
      echo(`  ${color('─'.repeat(label.length + 1))}`)
      for (const [i, f] of these.entries()) {
        if (i) echo('')
        echo(`  ${mark[f.level]} ${f.title}${f.line ? chalk.dim(`  (${dockerfile}:${f.line})`) : ''}`)
        if (f.detail) echo(chalk.dim(`      ${f.detail}`))
        if (f.hint)   echo(`      ${chalk.bold(chalk.cyan('fix:'))} ${f.hint}`)
      }
    }
    echo('')
    return count
    }

    let { findings, prefixes } = await preflight({ origin, key, app, root, dir, dockerfile, text })
    const fresh = await neverReleased(origin, key, app)
    let count = report(findings, { setup: fresh })

    // ─── What the App is missing, from what the app declares ──────────────────
    // On every run, so a setup that stopped part way is finished by the next
    // one rather than skipped (`FJS-3529`); a settled App plans nothing.
    // The widgets hostname is stated by the flag or frontier.config; neither is
    // ever guessed past a terminal (a guessed hostname writes DNS).
    const stated  = flag['widgets-domain'] || (await configuredHosts(root)).widgets || ''
    const missing = releasePlan(findings, { prefixes, widgetsHostname: stated })
    if (!missing.empty || missing.asked.length || missing.askedWidgets) {
      const asking   = process.stdin.isTTY && !flag.yes
      const ask      = async (q, hint) => (await tty.line(`  ${q} ${chalk.dim(hint)}\n  ${chalk.cyan('›')}`)).trim()
      let hostname = flag.domain
      if (!hostname && asking && missing.asked.length) {
        echo(`  App '${app.name}' is missing what its hostname gives it. One question shapes it:`)
        const offered = suggestedHostname(await packageName(root), origin)
        hostname = await ask('Its hostname', offered
          ? `Enter: ${offered} — '-': none yet, the URLs and the Domain stay unset`
          : 'e.g. app.example.com — Enter: none yet, the URLs and the Domain stay unset')
        if (offered && !hostname) hostname = offered
        if (hostname === '-') hostname = ''
      }
      let widgetsHostname = stated
      if (!widgetsHostname && asking && missing.askedWidgets) {
        echo(`  App '${app.name}' has a widgets/ surface, and no hostname for its widget origin.`)
        const offered = suggestedWidgetsHostname(hostname || (await configuredHosts(root)).web)
        widgetsHostname = await ask('The widgets hostname', offered
          ? `Enter: ${offered} — '-': none yet, widgets/ is not released`
          : "e.g. widgets.example.com — Enter: none yet, widgets/ is not released")
        if (offered && !widgetsHostname) widgetsHostname = offered
        if (widgetsHostname === '-') widgetsHostname = ''
      }
      const plan    = releasePlan(findings, { hostname, widgetsHostname, prefixes })
      if (plan.web && app.name !== API_NAME) plan.app = { name: API_NAME, ...plan.app }
      const servers = (app.placement ?? []).map(p => p.server?.name).filter(Boolean)
      const lines   = planLines(plan, app, servers)
      if (lines.length) {
        const apply = !flag.dry && (flag.yes || process.stdin.isTTY)
        echo(fresh
          ? `  ${chalk.bold('New deployment')} — App '${app.name}' has never been released, so ${apply ? 'this run sets' : 'a run would set'} up:`
          : `  ${chalk.bold(apply ? 'Setting up' : 'Would set up')} App '${app.name}' from what the app declares:`)
        for (const l of lines) echo(`    ${chalk.cyan('+')} ${l}`)
        if (plan.asked.length) echo(chalk.dim(`    ${plan.asked.join(', ')} wait on a hostname — pass --domain <hostname>.`))
        if (plan.askedWidgets) echo(chalk.dim('    widgets/ waits on a hostname — pass --widgets-domain <hostname>, or set deploy.widgets.domain in frontier.config.'))
        echo('')
        if (!apply) {
          if (!flag.dry) log.info('No terminal — pass --yes (and --domain <hostname>) to apply this, or set the App in Basecamp')
        } else if (!flag.yes && (await ask('Apply it?', '[Y/n]')).toLowerCase().startsWith('n')) {
          log.info('Left as it is — nothing was written')
        } else {
          const { web, widgets } = await applyPlan({ origin, key, app, plan })
          const made = [web, widgets].filter(Boolean).map(a => `'${a.name}' (${a.id})`)
          log.done(`Set up App '${app.name}'${made.length ? ` and its static App${made.length > 1 ? 's' : ''} ${made.join(' and ')}` : ''}`)
          app = await basecamp(origin, key, `/apps/${encodeURIComponent(appId)}`)
          ;({ findings } = await preflight({ origin, key, app, root, dir, dockerfile, text }))
          log.info('Preflight again, on what Basecamp now holds:')
          count = report(findings)
        }
      } else if (plan.askedWidgets) {
        log.info('widgets/ waits on a hostname — pass --widgets-domain <hostname>, or set deploy.widgets.domain in frontier.config')
      }
    }

    if (count('error') && !flag.dry) {
      if (!flag.force) throw new Error(`the preflight found ${count('error')} error(s) — fix them, or pass --force to release anyway`)
      log.warn(`Releasing with ${count('error')} preflight error(s) — --force`)
    }

    if (flag.dry) {
      log.dry(vendors ? `Would vendor ${GENERATED_DIR}/ and build ${tag} from ${dockerfile}` : `Would build ${tag} from ${dockerfile}, which installs from the repository`)
      for (const d of destinations) log.dry(`Would load ${tag} onto ${d.name} over ${d.host}`)
      log.dry(`Would release ${tag} on ${origin} as App '${app.name}'`)
      return
    }

    log.info(`Building ${tag} from ${dockerfile}...`)
    // The context goes over stdin: a snap-installed docker cannot read the
    // temp directory the release is staged in, and answers `path not found`.
    $.exec({ command: `tar -C ${dir} -c . | docker build -t ${tag} -f ${dockerfile} -` })
    const imageId = String($.exec({ command: `docker image inspect --format '{{.Id}}' ${tag}`, stdio: ['ignore', 'pipe', 'inherit'] }) ?? '').trim()
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error(`docker named no image id for ${tag} — got '${imageId}'`)
    log.done(`Built ${tag} → ${imageId.slice(0, 19)}`)

    const machineFor = (host, transport = null) => createMachine({ host, exec: $.exec, transport })
    const here = machineFor('localhost', 'local')
    // A daemon on the containerd image store names an image by its manifest
    // digest and the classic store by its config digest, so the same bytes
    // loaded there carry another id. Released under this daemon's id, Outpost
    // holds no such image and pulls the tag, which no registry has.
    const landed = new Map()
    for (const d of destinations) {
      log.info(`Loading ${tag} onto ${d.name} (${d.host})...`)
      const there = machineFor(d.host)
      const shipped = here.shipTo(there, tag)
      if (!shipped) log.info(`${d.name} is this machine's daemon — the image is already there`)
      landed.set(d.name, shipped ? there.capture(`docker image inspect --format '{{.Id}}' ${tag}`) : imageId)
    }
    const ids = new Set(landed.values())
    if (ids.size > 1)
      throw new Error(`the machines name ${tag} by different ids (${[...landed].map(([n, id]) => `${n}: ${id.slice(0, 19)}`).join(', ')}) — one release names one digest, so give them one Docker image store`)
    const releasedId = ids.size ? [...ids][0] : imageId
    if (!/^sha256:[0-9a-f]{64}$/.test(releasedId)) throw new Error(`the machine named no image id for ${tag} — got '${releasedId}'`)

    release = await basecamp(origin, key, '/deployments', {
      method: 'POST',
      body:   { appId: app.id, toImage: tag, builtImage: releasedId, ...commit },
    })
    named = `${tag} — ${releasedId.slice(0, 19)}`
  } finally {
    staged.cleanup()
  }
}

// ─── The release ──────────────────────────────────────────────────────────────
log.info(`Release ${release.id} queued — waiting for it...`)
const row = await settle(origin, key, release.id)

echo('')
for (const s of row?.steps ?? []) echo(`    ${String(s.status).padEnd(8)} ${s.name}${s.output ? `  ${s.output}` : ''}`)
echo('')
if (row?.status === 'success') {
  log.done(`Released ${named}`)
  echo(chalk`  {dim Deployment} ${origin}/deployments/${release.id}/\n`)
  return
}
if (!['failed', 'cancelled'].includes(row?.status))
  throw new Error(`Release ${release.id} is still ${row?.status} after ${WAIT_MS / 60_000} minutes — follow it in Basecamp`)
throw new Error(`Release ${release.id} ${row.status}`)
```
