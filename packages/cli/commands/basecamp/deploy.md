---
title: basecamp:deploy
description: Build the app here — its image, or web/ for a static App — hand it to the machines Basecamp runs the app on, and release that digest
examples:
  - BASECAMP_API_KEY=… fli basecamp:deploy --app <app-id>
  - BASECAMP_URL=https://basecamp.example.com BASECAMP_API_KEY=… fli basecamp:deploy --app <app-id>
  - fli basecamp:deploy --app <app-id> --server deploy@10.0.0.5
  - fli basecamp:deploy --app <app-id> --dist web/dist
  - fli basecamp:deploy --app <app-id> --dry
flags:
  app:
    type: string
    description: The Basecamp App to release — its id, from the App's page
    required: true
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

`BASECAMP_API_KEY` is read from the environment and never from a flag, which
would put it in shell history. The key needs `apps:read`,
`deployments:write` and `deployments:read` (to watch the release) — and
`apps:write` for a static App — and a standing that may release in its
workspace.

<script>
const { loadFrontierConfig }         = await import(new URL('file://' + global.fliRoot + '/core/utils.js'))
const { vendorApp, GENERATED_DIR }   = await import(new URL('file://' + global.fliRoot + '/core/vendor.js'))
const { createMachine }              = await import(new URL('file://' + global.fliRoot + '/core/machine.js'))

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

const app    = await basecamp(origin, key, `/apps/${encodeURIComponent(flag.app)}`)
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
