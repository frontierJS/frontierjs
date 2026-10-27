---
title: basecamp:deploy
description: Build the app here — its image, or web/ for a static App — hand it to the machines Basecamp runs the app on, and release that digest
examples:
  - BASECAMP_API_KEY=… fli basecamp:deploy --app <app-id>
  - fli basecamp:deploy --dry
  - BASECAMP_URL=https://basecamp.example.com BASECAMP_API_KEY=… fli basecamp:deploy --app <app-id>
  - fli basecamp:deploy --app <app-id> --server deploy@10.0.0.5
  - fli basecamp:deploy --app <app-id> --dist web/dist
  - fli basecamp:deploy --app <app-id> --dry
  - fli basecamp:deploy --app <app-id> --domain app.example.com --yes
flags:
  app:
    type: string
    description: The Basecamp App to release — its id, from the App's page (default is BASECAMP_APP_ID)
  url:
    type: string
    description: Basecamp's API origin (default is BASECAMP_URL, then the local dev API)
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
    description: "A never-released App's hostname: the Domain, and what both FRONTIER_*_URLs derive from (asked at a terminal)"
    defaultValue: ''
  yes:
    char: y
    type: boolean
    description: Apply a never-released App's settings without asking; with no terminal and no --yes the plan is printed and nothing is written
    defaultValue: false
---

The release path for an app Basecamp runs whose image cannot be built from a
git checkout on the machine (`FJS-D942`). An app `fli new` scaffolded depends on
the framework by `link:` or `workspace:`, and a build can resolve those only
where the workspace is — so this builds HERE, exactly as `fli deploy:local`
does: `deploy/generated/` vendored, then `docker build -f` the app's Dockerfile.

The image goes to each machine by `docker save | ssh <machine> docker load` —
no registry, and a save/load round trip keeps the image id, so the digest the
release names is the digest that starts. The machines are the App's placements
on online servers, reached as `sshUser@ipAddress` (and `sshPort` when it is not
22) off each Server row; `--server` names the destination instead, for an App on
one machine reached by an ssh alias. A machine named `localhost` is this
daemon, and nothing is shipped to it.

Then one Basecamp release, `POST /deployments` with the image as `toImage` and
its id as `builtImage`: a release that names a digest builds nothing, so the
machine starts the bytes just loaded rather than building the app's source. The
command waits for the release and prints its steps.

**A static App (an inline source) is released as its files.** `web/` is built
here with `vite build` into a temp directory, never into `web/dist`, with the
checkout's own `.env` as Vite reads it — the App's Variables in Basecamp are
not what the bundle carries. `--dist` names a folder already built and sends
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
published port or one the app does not listen on, and an env file or database
in the image are errors, and an error stops the release before the build;
`--force` releases anyway. A URL left on a default that is a real outside
service, a health route the App never asks, and a git-ignored file the image
would carry are warnings. `--dry` prints the whole report and builds nothing.

**An App that has never been released is set up here, from those same
declarations** (`FJS-3525`). No release, no port and no Variables of its own
is the sign, detected rather than flagged. Each finding that is a setting
carries its fix, and the command merges them into one plan: the App's port
and container port from the app's `PORT`, its volume at `/db` with every
database path moved onto it, its health check, `NODE_ENV=production`, each
external URL recorded at its default, and `ENCRYPTION_KEY` minted as a secret
and never printed. One question is asked, the hostname — `--domain` answers
it, and both `FRONTIER_*_URL`s derive from it. An app with `web/` gets a
static App for it beside this one, placed on the same machines, and the
Domain goes on that App with the API's prefixes and `/ws` routed back here —
`fli deploy`'s shape, `FJS-D1040`'s rows (`FJS-D1547`); an app without one
gets the Domain itself. The plan is shown, applied on a yes (`--yes` skips
the asking), and the preflight runs again on what Basecamp now holds. With no
terminal and no `--yes` the plan is printed and nothing is written; `--dry`
prints it too. A credential the app requires, a Dockerfile edit and
`widgets/` stay prose: nothing here can know them.

The three settings are read from the environment fli loads — the shell, then
the app's `.env`, then `~/.config/fli/.env` — so the key can live in the
global file and the App in the project's: `BASECAMP_URL`, `BASECAMP_API_KEY`
and `BASECAMP_APP_ID`. With `BASECAMP_APP_ID` set, `fli deploy` is this command.

`BASECAMP_API_KEY` is read from the environment and never from a flag, which
would put it in shell history. The key needs `apps:read`,
`deployments:write` and `deployments:read` (to watch the release) — and
`apps:write` for a static App — and a standing that may release in its
workspace. Setting up a never-released App writes through `apps:write`,
`variables:write`, `domains:write` and `domain-routes:write`; a 403 names
the scope the key lacks.

<script>
const { loadFrontierConfig }         = await import(new URL('file://' + global.fliRoot + '/core/utils.js'))
const { vendorApp, GENERATED_DIR }   = await import(new URL('file://' + global.fliRoot + '/core/vendor.js'))
const { createMachine }              = await import(new URL('file://' + global.fliRoot + '/core/machine.js'))
const { releaseFindings, gatherReleaseInputs, releasePlan, neverReleased } = await import(new URL('file://' + global.fliRoot + '/core/release-preflight.js'))
const { routePrefixes, apiPaths }    = await import(new URL('file://' + global.fliRoot + '/core/edge.js'))
const { readAppSnapshot }            = await import(new URL('file://' + global.fliRoot + '/core/app-entry.js'))
const { inspectBuild, inspectIgnored, gatherLocal, gatherIgnored } = await import(new URL('file://' + global.fliRoot + '/core/build-check.js'))

// The dev API's port in basecamp's own CLAUDE.md, as `fli ws:deps --push` has it.
const LOCAL_BASECAMP = 'http://localhost:8120'

// Basecamp's own bound on a release that pulls nothing and starts and health
// checks once, with room for a put-back.
const WAIT_MS = 15 * 60_000

/** One call to Basecamp's API, answering the body, or throwing with what Basecamp said. */
async function basecamp(origin, key, path, { method = 'GET', body, headers = {} } = {}) {
  let res
  try {
    res = await fetch(`${origin}${path}`, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    throw new Error(`could not reach Basecamp at ${origin}: ${err.message}`)
  }
  const answer = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Basecamp refused ${method} ${path} (${res.status}): ${answer?.message ?? answer?.error ?? res.statusText}`)
  return answer?.data ?? answer
}

/** Where ssh reaches a Server row. The URI form carries a port with no `-p`, which machine.js cannot pass. */
function sshDestination(server) {
  if (!server.ipAddress) throw new Error(`server '${server.name}' records no ipAddress — pass --server with an ssh destination for it`)
  const user = server.sshUser || 'root'
  return Number(server.sshPort ?? 22) === 22
    ? `${user}@${server.ipAddress}`
    : `ssh://${user}@${server.ipAddress}:${server.sshPort}`
}

/** A list read that answers null and why, rather than throwing: the preflight
 *  reports what it could not read and grades the rest. */
async function readList(origin, key, path) {
  try { return { rows: await basecamp(origin, key, path) } }
  catch (err) { return { rows: null, error: err.message } }
}

/** Everything the preflight finds for a container App, errors first, with the
 *  Variables it read (the walkthrough asks them whether the App has any). */
async function preflight({ origin, key, app, root, dockerfile }) {
  const fs = await import('fs')
  const { spawnSync } = await import('child_process')
  const vars     = await readList(origin, key, `/variables?environmentId=${encodeURIComponent(app.environmentId)}&$limit=200`)
  const siblings = await readList(origin, key, `/apps?environmentId=${encodeURIComponent(app.environmentId)}&$limit=200`)
  const build    = gatherLocal({ root, fs, dockerfile })
  const level    = { error: 0, warn: 1, info: 2 }
  const findings = [
    ...releaseFindings({
      app, variables: vars.rows, siblings: siblings.rows,
      unread: { ...(vars.error ? { variables: vars.error } : {}) },
      ...gatherReleaseInputs(root, { dockerfile }),
    }),
    ...(build.missing ? [] : inspectBuild(build)),
    ...(build.missing ? [] : inspectIgnored({
      dockerfile: build.dockerfile, dockerignore: build.dockerignore,
      groups: gatherIgnored({ root, fs, spawnSync }), expected: [GENERATED_DIR],
    })),
  ].sort((a, b) => level[a.level] - level[b.level])
  return { findings, variables: vars.rows }
}

/** The page a static App serves until web/ is released onto it. */
const PLACEHOLDER = (name, id) => `<!doctype html>
<meta charset="utf-8"><title>${name}</title>
<body><p>web/ of ${name} is not released yet — <code>fli basecamp:deploy --app ${id}</code> releases it.</p></body></html>
`

/** The lines a plan prints, each a write it would make; empty when there is nothing to do. */
function planLines(plan, app, servers) {
  const lines = []
  const settings = Object.entries(plan.app).map(([k, v]) => `${k} ${v}`)
  if (settings.length) lines.push(`App '${app.name}': ${settings.join(', ')}`)
  if (plan.variables.length)
    lines.push(`Variables: ${plan.variables.map(v => v.generate ? `${v.key} (a generated secret)` : `${v.key}=${v.value}`).join(', ')}`)
  if (plan.web) lines.push(`Static App '${app.name} web' for web/${servers.length ? `, placed on ${servers.join(', ')}` : ''}`)
  if (plan.domain)
    lines.push(`Domain ${plan.domain.hostname} on '${plan.domain.on === 'web' ? `${app.name} web` : app.name}'` +
      (plan.domain.routes.length ? `, ${plan.domain.routes.join(' and ')} → '${app.name}'` : ''))
  return lines
}

/** The plan written to Basecamp, in the order each write needs the one before. */
async function applyPlan({ origin, key, app, plan }) {
  const { randomBytes } = await import('crypto')
  if (Object.keys(plan.app).length)
    await basecamp(origin, key, `/apps/${encodeURIComponent(app.id)}`, { method: 'PATCH', body: plan.app })
  for (const v of plan.variables)
    await basecamp(origin, key, '/variables', { method: 'POST', body: {
      environmentId: app.environmentId, appId: app.id, key: v.key, secret: !!v.secret,
      value: v.generate === 'hex32' ? randomBytes(32).toString('hex') : v.value,
    } })
  let web = null
  if (plan.web) {
    const page = (id) => ({ kind: 'inline', files: [{ path: 'index.html', content: PLACEHOLDER(app.name, id) }] })
    web = await basecamp(origin, key, '/apps', { method: 'POST', body: {
      environmentId: app.environmentId, name: `${app.name} web`, slug: `${app.slug ?? app.id}-web`, type: 'static', source: page('<its id>'),
    } })
    // The page names the command that replaces it, and that needs the id just issued.
    await basecamp(origin, key, `/apps/${encodeURIComponent(web.id)}`, { method: 'PATCH', body: { source: page(web.id) } })
    // Caddy routes a prefix only between Apps on one machine (`FJS-D1040`).
    for (const p of app.placement ?? [])
      await basecamp(origin, key, `/apps/${encodeURIComponent(web.id)}`, { method: 'POST', headers: { 'x-service-method': 'place' }, body: { serverId: p.serverId } })
  }
  if (plan.domain) {
    const owner  = plan.domain.on === 'web' ? web : app
    const domain = await basecamp(origin, key, '/domains', { method: 'POST', body: { appId: owner.id, hostname: plan.domain.hostname } })
    for (const pathPrefix of plan.domain.routes)
      await basecamp(origin, key, '/domain-routes', { method: 'POST', body: { domainId: domain.id, pathPrefix, appId: app.id } })
  }
  return { web }
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
const { existsSync, mkdtempSync, rmSync } = await import('fs')
const { tmpdir }           = await import('os')
const { join, resolve }    = await import('path')

const root = $.paths.root
const key  = process.env.BASECAMP_API_KEY
if (!key) throw new Error('needs BASECAMP_API_KEY — a key issued at /api-keys/ in the Basecamp workspace the app is in')
const origin = (flag.url || process.env.BASECAMP_URL || LOCAL_BASECAMP).replace(/\/+$/, '')
const appId  = flag.app || process.env.BASECAMP_APP_ID
if (!appId) throw new Error("needs --app or BASECAMP_APP_ID — the App's id, from its page in Basecamp")

let   app    = await basecamp(origin, key, `/apps/${encodeURIComponent(appId)}`)
const inline = app?.source?.kind === 'inline'
if (flag.dist && !inline)
  throw new Error(`--dist sends files, and App '${app.name}' is not inline — its release is an image built here`)
if (flag.server && inline)
  throw new Error(`--server names an ssh destination, and App '${app.name}' is inline — its files go through Basecamp, not over ssh`)

const git    = (args) => { try { return String($.exec({ command: `git -C ${root} ${args}`, stdio: ['ignore', 'pipe', 'ignore'] }) ?? '').trim() } catch { return '' } }
const sha    = git('rev-parse HEAD')
const branch = git('rev-parse --abbrev-ref HEAD')
const commit = { ...(sha ? { commitSha: sha } : {}), ...(branch && branch !== 'HEAD' ? { branch } : {}) }

let release, named
if (inline) {
  // ─── A static App: its files ───────────────────────────────────────────────
  const web    = join(root, 'web')
  const config = flag.dist ? null : VITE_CONFIGS.map(c => join(web, c)).find(existsSync)
  if (!flag.dist && !config)
    throw new Error(`${web} has no vite config (looked for ${VITE_CONFIGS.join(', ')}) — pass --dist with a folder already built`)

  if (flag.dry) {
    log.dry(flag.dist ? `Would send ${resolve(flag.dist)} as it is` : `Would build ${web} with ${config}`)
    log.dry(`Would publish the files to App '${app.name}' on ${origin} and release their digest`)
    return
  }

  // Into a directory of its own, never web/dist: `vite build` empties its
  // outDir, and a dev server running from this checkout serves that one.
  const out = flag.dist ? null : mkdtempSync(join(tmpdir(), 'basecamp-deploy-'))
  try {
    if (out) {
      log.info(`Building ${web}...`)
      $.exec({ command: 'bun --bun vite build', args: ['-c', config, '--outDir', out, '--emptyOutDir'], cwd: web, env: { ...process.env, NODE_ENV: 'production' } })
    }
    const files = await filesUnder(out ?? resolve(flag.dist))
    log.info(`Publishing ${files.length} files to App '${app.name}'...`)
    release = await basecamp(origin, key, `/apps/${encodeURIComponent(app.id)}`, {
      method: 'POST', headers: { 'x-service-method': 'publish' }, body: { files, ...commit },
    })
  } finally {
    if (out) rmSync(out, { recursive: true, force: true })
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

  const deployConf     = (await loadFrontierConfig(root))?.deploy
  const dockerfile     = deployConf?.api?.dockerfile ?? 'deploy/Dockerfile'
  const dockerfilePath = resolve(root, dockerfile)
  if (!existsSync(dockerfilePath)) {
    log.info('Run fli make:deploy to scaffold one, or set deploy.api.dockerfile in frontier.config.js')
    throw new Error(`Dockerfile not found: ${dockerfile}`)
  }

  // Named for the release rather than reused: a tag two builds share is a tag
  // the older one loses on a machine still running it.
  const tag = `fjs-${app.id}:${sha ? sha.slice(0, 12) : Date.now()}`.toLowerCase()

  const mark   = { error: chalk.red('✗'), warn: chalk.yellow('!'), info: chalk.dim('·') }
  const report = (findings) => {
  const count = (l) => findings.filter(f => f.level === l).length
  echo('')
  echo(`  Preflight — ${count('error')} error(s), ${count('warn')} warning(s)`)
  // One group per level, each under its own header, so where the errors end
  // and the warnings begin is read off the page rather than counted.
  const groups = [['error', 'Errors', chalk.red], ['warn', 'Warnings', chalk.yellow], ['info', 'Notes', chalk.dim]]
  for (const [level, label, color] of groups) {
    const these = findings.filter(f => f.level === level)
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

  let { findings, variables } = await preflight({ origin, key, app, root, dockerfile })
  let count = report(findings)

  // ─── A never-released App: its settings, from what the app declares ───────
  if (neverReleased(app, variables)) {
    const prefixes = routePrefixes(apiPaths(readAppSnapshot(root)))
    const asking   = process.stdin.isTTY && !flag.yes
    const ask      = async (q, hint) => (await tty.line(`  ${q} ${chalk.dim(hint)}\n  ${chalk.cyan('›')}`)).trim()
    let hostname = flag.domain
    if (!hostname && asking && releasePlan(findings, { prefixes }).asked.length) {
      echo(`  App '${app.name}' has never been released. One question shapes it:`)
      hostname = await ask('Its hostname', 'e.g. app.example.com — Enter: none yet, the URLs and the Domain stay unset')
    }
    const plan    = releasePlan(findings, { hostname, prefixes })
    const servers = (app.placement ?? []).map(p => p.server?.name).filter(Boolean)
    const lines   = planLines(plan, app, servers)
    if (lines.length) {
      const apply = !flag.dry && (flag.yes || process.stdin.isTTY)
      echo(`  ${chalk.bold(apply ? 'Setting up' : 'Would set up')} App '${app.name}' from what the app declares:`)
      for (const l of lines) echo(`    ${chalk.cyan('+')} ${l}`)
      if (plan.asked.length) echo(chalk.dim(`    ${plan.asked.join(', ')} wait on a hostname — pass --domain <hostname>.`))
      echo('')
      if (!apply) {
        if (!flag.dry) log.info('No terminal — pass --yes (and --domain <hostname>) to apply this, or set the App in Basecamp')
      } else {
        if (!flag.yes && (await ask('Apply it?', '[Y/n]')).toLowerCase().startsWith('n')) throw new Error('left as it is — nothing was written')
        const { web } = await applyPlan({ origin, key, app, plan })
        log.success(`Set up App '${app.name}'${web ? ` and its static App '${web.name}' (${web.id})` : ''}`)
        app = await basecamp(origin, key, `/apps/${encodeURIComponent(appId)}`)
        ;({ findings } = await preflight({ origin, key, app, root, dockerfile }))
        log.info('Preflight again, on what Basecamp now holds:')
        count = report(findings)
      }
    }
  }

  if (count('error') && !flag.dry) {
    if (!flag.force) throw new Error(`the preflight found ${count('error')} error(s) — fix them, or pass --force to release anyway`)
    log.warn(`Releasing with ${count('error')} preflight error(s) — --force`)
  }

  if (flag.dry) {
    log.dry(`Would vendor ${GENERATED_DIR}/ and build ${tag} from ${dockerfile}`)
    for (const d of destinations) log.dry(`Would load ${tag} onto ${d.name} over ${d.host}`)
    log.dry(`Would release ${tag} on ${origin} as App '${app.name}'`)
    return
  }

  log.info('Vendoring dependencies into the build context...')
  vendorApp(root, log)
  log.info(`Building ${tag} from ${dockerfile}...`)
  $.exec({ command: `docker build -t ${tag} -f ${dockerfilePath} ${root}` })
  const imageId = String($.exec({ command: `docker image inspect --format '{{.Id}}' ${tag}`, stdio: ['ignore', 'pipe', 'inherit'] }) ?? '').trim()
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error(`docker named no image id for ${tag} — got '${imageId}'`)
  log.success(`Built ${tag} → ${imageId.slice(0, 19)}`)

  const machineFor = (host, transport = null) => createMachine({ host, exec: $.exec, transport })
  const here = machineFor('localhost', 'local')
  for (const d of destinations) {
    log.info(`Loading ${tag} onto ${d.name} (${d.host})...`)
    const shipped = here.shipTo(machineFor(d.host), tag)
    if (!shipped) log.info(`${d.name} is this machine's daemon — the image is already there`)
  }

  release = await basecamp(origin, key, '/deployments', {
    method: 'POST',
    body:   { appId: app.id, toImage: tag, builtImage: imageId, ...commit },
  })
  named = `${tag} — ${imageId.slice(0, 19)}`
}

// ─── The release ──────────────────────────────────────────────────────────────
log.info(`Release ${release.id} queued — waiting for it...`)
const row = await settle(origin, key, release.id)

echo('')
for (const s of row?.steps ?? []) echo(`    ${String(s.status).padEnd(8)} ${s.name}${s.output ? `  ${s.output}` : ''}`)
echo('')
if (row?.status === 'success') { log.success(`Released ${named}`); return }
if (!['failed', 'cancelled'].includes(row?.status))
  throw new Error(`Release ${release.id} is still ${row?.status} after ${WAIT_MS / 60_000} minutes — follow it in Basecamp`)
throw new Error(`Release ${release.id} ${row.status}`)
```
