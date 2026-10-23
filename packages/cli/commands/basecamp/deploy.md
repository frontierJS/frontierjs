---
title: basecamp:deploy
description: Build the app's image here, load it onto every machine Basecamp runs the app on, and release that digest
examples:
  - BASECAMP_API_KEY=… fli basecamp:deploy --app <app-id>
  - BASECAMP_URL=https://basecamp.example.com BASECAMP_API_KEY=… fli basecamp:deploy --app <app-id>
  - fli basecamp:deploy --app <app-id> --server deploy@10.0.0.5
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

`BASECAMP_API_KEY` is read from the environment and never from a flag, which
would put it in shell history. The key needs `apps:read`,
`deployments:write` and `deployments:read` (to watch the release), and a
standing that may release in its workspace.

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
async function basecamp(origin, key, path, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(`${origin}${path}`, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
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
</script>

```js
const { existsSync } = await import('fs')
const { resolve }    = await import('path')

const root = $.paths.root
const key  = process.env.BASECAMP_API_KEY
if (!key) throw new Error('needs BASECAMP_API_KEY — a key issued at /api-keys/ in the Basecamp workspace the app is in')
const origin = (flag.url || process.env.BASECAMP_URL || LOCAL_BASECAMP).replace(/\/+$/, '')

// ─── The app, and the machines it runs on ─────────────────────────────────────
const app = await basecamp(origin, key, `/apps/${encodeURIComponent(flag.app)}`)
if (app?.source?.kind === 'inline')
  throw new Error(`App '${app.name}' is inline — its release is its files, and it has no image to build`)

const placed = (app.placement ?? []).filter(p => p.server?.status === 'online')
if (!placed.length)
  throw new Error(`App '${app.name}' is on no online server — place it on one in Basecamp first`)
if (flag.server && placed.length > 1)
  throw new Error(`App '${app.name}' is on ${placed.length} online servers, and --server names one destination — leave it off to reach each by its Server row`)
const destinations = flag.server
  ? [{ name: placed[0].server.name, host: flag.server }]
  : placed.map(p => ({ name: p.server.name, host: sshDestination(p.server) }))

// ─── What gets built ──────────────────────────────────────────────────────────
const deployConf     = (await loadFrontierConfig(root))?.deploy
const dockerfile     = deployConf?.api?.dockerfile ?? 'deploy/Dockerfile'
const dockerfilePath = resolve(root, dockerfile)
if (!existsSync(dockerfilePath)) {
  log.info('Run fli make:deploy to scaffold one, or set deploy.api.dockerfile in frontier.config.js')
  throw new Error(`Dockerfile not found: ${dockerfile}`)
}

const git    = (args) => { try { return String($.exec({ command: `git -C ${root} ${args}`, stdio: ['ignore', 'pipe', 'ignore'] }) ?? '').trim() } catch { return '' } }
const sha    = git('rev-parse HEAD')
const branch = git('rev-parse --abbrev-ref HEAD')
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

// ─── Onto each machine ────────────────────────────────────────────────────────
const machineFor = (host, transport = null) => createMachine({ host, exec: $.exec, transport })
const here = machineFor('localhost', 'local')
for (const d of destinations) {
  log.info(`Loading ${tag} onto ${d.name} (${d.host})...`)
  const shipped = here.shipTo(machineFor(d.host), tag)
  if (!shipped) log.info(`${d.name} is this machine's daemon — the image is already there`)
}

// ─── The release ──────────────────────────────────────────────────────────────
const release = await basecamp(origin, key, '/deployments', {
  method: 'POST',
  body:   { appId: app.id, toImage: tag, builtImage: imageId, ...(sha ? { commitSha: sha } : {}), ...(branch && branch !== 'HEAD' ? { branch } : {}) },
})
log.info(`Release ${release.id} queued — waiting for it...`)

let row = release
for (const started = Date.now(); !['success', 'failed', 'cancelled'].includes(row?.status) && Date.now() - started < WAIT_MS;) {
  await new Promise(r => setTimeout(r, 2_000))
  row = await basecamp(origin, key, `/deployments/${release.id}`)
}

echo('')
for (const s of row?.steps ?? []) echo(`    ${String(s.status).padEnd(8)} ${s.name}${s.output ? `  ${s.output}` : ''}`)
echo('')
if (row?.status === 'success') { log.success(`Released ${tag} — ${imageId.slice(0, 19)}`); return }
if (!['failed', 'cancelled'].includes(row?.status))
  throw new Error(`Release ${release.id} is still ${row?.status} after ${WAIT_MS / 60_000} minutes — follow it in Basecamp`)
throw new Error(`Release ${release.id} ${row.status}`)
```
