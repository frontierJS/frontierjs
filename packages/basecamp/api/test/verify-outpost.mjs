/*
 * verify-outpost.mjs — `bun run dev:outpost`, run as processes and graded.
 *
 *   bun run verify:outpost
 *
 * The launcher is glue between three processes — the API, itself, and the
 * Outpost it spawns — so what it gets wrong only shows when all three are
 * running: a SIGTERM that stops the launcher and leaves its child holding both
 * ports, an identity file that mints a second Server row per restart, a
 * re-enrollment the API refuses. Nothing in `api/test/` can see any of those.
 *
 * It needs no browser. It does need two ports of the Outpost's own (8180,
 * 8181) and one for the API, which is TEST-tier 7120 rather than 8120, so a
 * developer's dev server — or another session's `verify` — keeps its port.
 *
 * Traps, each paid for once:
 *   - A port that answers is not evidence the right process is on it. Every
 *     port is REFUSED if held at the start, or the checks below grade a stale
 *     API serving a database this run deleted (FJS-740).
 *   - Its own database: DATABASE_URL and AUDIT_PATH point into a temp
 *     directory, and the jobs database follows DATABASE_URL. Deleting `db/`
 *     instead wrecks whatever else is running off it.
 *   - `.outpost/` is the developer's. It is moved aside at the start and put
 *     back at the end, or a run erases the identity their laptop enrolled as.
 *   - SIGTERM, then SIGKILL after a grace. A graceful shutdown that hangs
 *     leaves the port held for the next run, which then reports on it.
 *   - Caddy is a stand-in on 7129, held by this process: the admin API's
 *     config tree, answering as the real one does (outpost's own suite
 *     drives the real Caddy). What it proves is that a Domain written with
 *     no release reaches the machine as a route, dialing the port the
 *     container published (FJS-1610).
 *   - The container release runs on the developer's REAL daemon. It removes
 *     only the container it started and the image only if it pulled it, and
 *     never calls a prune route: on a workstation those delete somebody
 *     else's images. The one volume it touches is the restore's, named for an
 *     app this run made, and removed by that name.
 */

// What `fli prove` queues on: this checkout's ports.
export const holds = ['ports']

import { spawn, spawnSync }                                   from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir }                                             from 'node:os'
import { dirname, join }                                      from 'node:path'
import { fileURLToPath }                                      from 'node:url'
import { createConnection }                                   from 'node:net'
import { portFor }                                            from '@frontierjs/cli/core/ports.js'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const API_PORT = await portFor(import.meta.url, 'be')
const API      = `http://localhost:${API_PORT}`
const SCRATCH  = mkdtempSync(join(tmpdir(), 'basecamp-outpost-'))
const OWN      = join(ROOT, '.outpost')
const ASIDE    = join(ROOT, `.outpost.aside-${process.pid}`)
const MACHINE  = join(OWN, 'machine.json')
const APP_PORT = await portFor(import.meta.url, 'be', { service: 6 })
const CADDY    = await portFor(import.meta.url, 'be', { service: 9 })
// The launcher's two, which it binds and this run only reaches.
const OUTPOST  = await portFor(import.meta.url, 'be', { env: 'dev', project: 'outpost' })
const STATIC   = await portFor(import.meta.url, 'be', { env: 'dev', project: 'outpost', service: 1 })
const IMAGE    = 'traefik/whoami:v1.10.3'
const sh       = (...argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
const hadImage = sh('docker', 'image', 'inspect', IMAGE).status === 0
let container  = null
let volume     = null
let built      = []

const ENV = {
  ...process.env,
  DATABASE_URL: join(SCRATCH, 'basecamp.db'),
  AUDIT_PATH:   join(SCRATCH, 'audit.db'),
  PORT:         String(API_PORT),
  BASECAMP_URL: API,
  OUTPOST_CADDY_ADMIN: `http://127.0.0.1:${CADDY}`,
}

// ─── Caddy's admin API, stood in ─────────────────────────────────────────
//
// A path not created yet is a 400 and an @id never seen a 404, as the real
// one answers; outpost's ingress branches on both.

let caddyConfig = null
const caddyRoutes = () => caddyConfig?.apps?.http?.servers?.ingress?.routes ?? []
function startCaddy() {
  const answer = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status })
  return Bun.serve({ port: CADDY, hostname: '127.0.0.1', async fetch(req) {
    const path = new URL(req.url).pathname
    const text = await req.text()
    const data = text ? JSON.parse(text) : undefined
    const id   = path.startsWith('/id/') ? path.slice(4) : null
    const at   = id ? caddyRoutes().findIndex(r => r['@id'] === id) : -1
    if (req.method === 'GET' && path === '/config/') return answer(200, caddyConfig)
    if (req.method === 'PUT' && path === '/config/apps/http/servers/ingress') {
      caddyConfig = { apps: { http: { servers: { ingress: data } } } }
      return answer(200)
    }
    if (req.method === 'POST' && path === '/config/apps/http/servers/ingress/routes') {
      if (!caddyConfig) return answer(400, { error: 'invalid traversal path at: config/apps/http/servers/ingress' })
      caddyRoutes().push(data)
      return answer(200)
    }
    if (id && at < 0) return answer(404, { error: `unknown object ID '${id}'` })
    if (req.method === 'PATCH')  { caddyRoutes()[at] = data; return answer(200) }
    if (req.method === 'DELETE') { caddyRoutes().splice(at, 1); return answer(200) }
    return answer(400, { error: `unexpected ${req.method} ${path}` })
  } })
}
let caddy = null

// ─── Harness ─────────────────────────────────────────────────────────────

const children = []
const sleep    = ms => new Promise(r => setTimeout(r, ms))
let failed = 0, passed = 0

function start(args, { echo = false } = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT, env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.out = ''
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', d => { child.out += d; if (echo) process.stdout.write(d) })
  children.push(child)
  return child
}

const exited = child => new Promise(r => child.exitCode !== null ? r() : child.once('exit', r))
const until  = async (ask, ms) => {
  for (let t = 0; t < ms; t += 500) { if (await ask()) return true; await sleep(500) }
  return false
}
// A connect, not a fetch: the command port speaks TLS, and a plain-http fetch at it fails
// whether or not anything is listening.
const answers = port => new Promise(done => {
  const s = createConnection({ port, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); done(true) })
  s.once('error',   () => done(false))
})

function check(name, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`)
  ok ? passed++ : failed++
}

async function call(path, { token, workspace, body, serviceMethod, method } = {}) {
  const headers = { accept: 'application/json' }
  if (body)          headers['content-type']     = 'application/json'
  if (token)         headers.authorization       = `Bearer ${token}`
  if (workspace)     headers['x-workspace-id']   = workspace
  if (serviceMethod) headers['x-service-method'] = serviceMethod
  const res  = await fetch(API + path, {
    method:  method ?? (body || serviceMethod ? 'POST' : 'GET'),
    headers, body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

const machine = () => JSON.parse(readFileSync(MACHINE, 'utf8'))

async function released(appId, auth) {
  const release = await call('/deployments', { ...auth, body: { appId } })
  let row = null
  await until(async () => {
    row = await call(`/deployments/${release?.id}`, auth)
    return ['success', 'failed'].includes(row?.status)
  }, 30_000)
  return row
}

async function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM') } catch {} }
  caddy?.stop(true)
  await sleep(3000)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
  if (container) sh('docker', 'rm', '-f', container)
  if (volume)    sh('docker', 'volume', 'rm', '-f', volume)
  for (const [name, tag] of built) { sh('docker', 'rm', '-f', name); sh('docker', 'rmi', tag) }
  if (!hadImage) sh('docker', 'rmi', IMAGE)
  rmSync(OWN, { recursive: true, force: true })
  if (existsSync(ASIDE)) renameSync(ASIDE, OWN)
  rmSync(SCRATCH, { recursive: true, force: true })
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => cleanup().then(() => process.exit(130)))

// ─── The run ─────────────────────────────────────────────────────────────

console.log('\nBasecamp — dev:outpost\n')

try {
  for (const port of [API_PORT, OUTPOST, STATIC, APP_PORT, CADDY])
    if (await answers(port))
      throw new Error(`port ${port} is already held — this would test a process it did not start`)
  if (sh('docker', 'info').status !== 0)
    throw new Error('no docker daemon answers — the container release needs one')

  if (existsSync(OWN)) renameSync(OWN, ASIDE)
  caddy = startCaddy()

  const seed = start(['db/seed.js'])
  await exited(seed)
  if (seed.exitCode !== 0) throw new Error(`db/seed.js exited ${seed.exitCode}\n${seed.out}`)

  start(['api/index.ts'])
  check('the API comes up on its own port and its own database',
    await until(() => fetch(`${API}/health`).then(r => r.ok, () => false), 30_000))

  // ── First run: enroll, come online ──
  let dev = start(['api/src/providers/outpost-dev.ts'], { echo: true })
  check('the launcher reports the machine ONLINE, not merely started',
    await until(() => dev.out.includes('is online'), 40_000))
  check('…and remembers which machine it is', existsSync(MACHINE))
  const first = machine()

  // ── A second launcher refuses the ports rather than sharing them ──
  const second = start(['api/src/providers/outpost-dev.ts'])
  await exited(second)
  check('a second launcher refuses the held port, by number',
    second.out.includes(`port ${OUTPOST} is already answering`))
  // Pinned the way Basecamp pins it: the certificate the launcher enrolled with.
  const health = await fetch(`https://localhost:${OUTPOST}/health`, {
    tls: { ca: first.cert, checkServerIdentity: () => undefined },
  }).then(r => r.json(), () => ({}))
  check('…and the first is still the machine answering', health.server_id === first.serverId)

  // ── A release reaches it, and the page comes back off the disk ──
  const { token } = await call('/auth/login', { body: { email: 'sam@example.com', password: 'hunter2hunter2' } })
  const auth = { token, workspace: first.workspaceId }

  // The Outpost posts its posture once at start: signed, accepted, graded, kept
  // (FJS-2713). This laptop is no fleet box, so what it grades is not asserted.
  let posture = null
  check('the machine\'s own posture report landed and was graded',
    await until(async () => {
      posture = await call(`/posture/${first.serverId}`, { ...auth, serviceMethod: 'latest' }).catch(() => null)
      return posture?.reported === true
    }, 60_000))
  check('…every control answered, unknown where the box could not read',
    posture?.controls?.length > 0 && posture.controls.every(c => [true, false, 'unknown'].includes(c.ok)))

  // Its own app rather than whichever one the seed put in this workspace:
  // the seed spreads its app kinds across workspaces by a counter.
  const environment = (await call('/environments', auth))?.data?.[0]
  const slug = `pasted-${process.pid}`
  const app  = await call('/apps', { ...auth, body: {
    environmentId: environment?.id, name: 'pasted', slug, type: 'static',
    source: { kind: 'inline', files: [
      { path: 'index.html', content: '<!doctype html><title>pasted</title><h1>served off this laptop</h1>' },
    ] },
  } })
  check('an inline app is made in the workspace the machine enrolled into', !!app?.id)

  // A seeded placement on a machine that does not exist sits beside it, as it
  // would for anybody who places a seeded app on their laptop — the executor
  // has to pick the replica it can REACH, not the first one that says online.
  //
  // The decoy is replica 0 and this laptop replica 5, because the executor
  // walks placements in replica order: tied at 0, the order is the database's,
  // and a run that happened to list the laptop first would pass against the
  // bug this exists for.
  const decoy = ((await call('/servers?$limit=200', auth))?.data ?? [])
    .find(s => s.status === 'online' && s.id !== first.serverId)
  check('the seed left an online machine with no outpost to place beside it', !!decoy)
  await call(`/apps/${app.id}`, { ...auth, serviceMethod: 'place', body: { serverId: decoy?.id, replicaIndex: 0 } })
  await call(`/apps/${app.id}`, { ...auth, serviceMethod: 'place', body: { serverId: first.serverId, replicaIndex: 5 } })

  const shipped = await released(app.id, auth)
  check('a release goes to the replica that can be reached', shipped?.status === 'success')
  check('…and the page is served off this laptop',
    (await fetch(`http://localhost:${STATIC}/${slug}/`).then(r => r.text(), () => '')).includes('served off this laptop'))

  // ── Stopped the way `bun run stop` stops it: a SIGTERM to the launcher ──
  process.kill(dev.pid, 'SIGTERM')
  check('stopping the launcher takes its Outpost with it — both ports free',
    await until(async () => !(await answers(OUTPOST)) && !(await answers(STATIC)), 10_000))

  // ── A restart is the same machine ──
  dev = start(['api/src/providers/outpost-dev.ts'])
  check('a restart comes online again', await until(() => dev.out.includes('is online'), 40_000))
  check('…as the SAME server row', machine().serverId === first.serverId)
  const rows = ((await call('/servers?$limit=200', auth))?.data ?? []).filter(s => s.slug === 'dev-outpost')
  check('…and the fleet has exactly one of it', rows.length === 1)

  // ── A lost identity file finds the row it left, and rotates its key ──
  process.kill(dev.pid, 'SIGTERM')
  await until(async () => !(await answers(OUTPOST)), 10_000)
  rmSync(MACHINE)
  dev = start(['api/src/providers/outpost-dev.ts'])
  const back = await until(() => dev.out.includes('is online'), 40_000)
  check('a lost identity file re-enrolls the row it left behind', back)
  if (!back) throw new Error(`re-enrollment did not come online:\n${dev.out}`)
  check('…which is the same row', machine().serverId === first.serverId)
  check('…under a ROTATED key', machine().secret !== first.secret)

  // The rotation has to reach the SENDER, or every release after a
  // re-enrollment is signed with a key the machine no longer holds.
  const after = await released(app.id, auth)
  check('a release after re-enrolling still reaches the machine', after?.status === 'success')

  // ── A container app, released the way the app screen releases one ──
  // `{ appId }` and nothing else: the image is the one its SOURCE names, and
  // the release carries it to /pull, /deploy and /health-check on this
  // laptop's own daemon.
  // Every runtime column set, so each one is read back off the container the
  // daemon started rather than off the request (`FJS-1605`). whoami answers
  // any path, so `/health` proves the path is asked, not that it is checked.
  const name = `whoami-${process.pid}`
  const box  = await call('/apps', { ...auth, body: {
    environmentId: environment?.id, name, slug: name, type: 'container',
    source: { kind: 'image', image: IMAGE },
    port: APP_PORT, containerPort: 80, healthCheck: '/health', cpuLimit: 0.5, memLimitMb: 64,
  } })
  if (!box?.id) throw new Error(`the app was not made: ${JSON.stringify(box)}`)
  await call('/variables', { ...auth, body: { appId: box.id, key: 'WHOAMI_NAME', value: name } })
  container = `fjs-${box?.id}`
  await call(`/apps/${box?.id}`, { ...auth, serviceMethod: 'place', body: { serverId: first.serverId, replicaIndex: 0 } })

  const ran   = await released(box?.id, auth)
  const steps = ran?.steps ?? []
  if (ran?.status !== 'success')
    console.log(`\n${ran?.error ?? ''}\n${steps.map(s => `    ${s.status.padEnd(8)} ${s.name}  ${s.output ?? ''}`).join('\n')}\n`)
  check('a container app releases through the real daemon', ran?.status === 'success')
  check('…recording the image its source names', ran?.toImage === IMAGE)
  check('…which a step PULLED', steps.some(s => /pull/i.test(s.name) && s.status === 'success'))

  const imageId = sh('docker', 'image', 'inspect', '--format', '{{.Id}}', IMAGE).stdout.trim()
  const running = sh('docker', 'inspect', '--format', '{{.Image}}', container).stdout.trim()
  check('…and the digest it records is the bytes the daemon holds', !!imageId && ran?.builtImage === imageId)
  check('…the bytes the container named for the app is running', !!imageId && running === imageId)
  check('…answering on the port its columns name, with its variable',
    (await fetch(`http://localhost:${APP_PORT}/`).then(r => r.text(), () => '')).includes(`Name: ${name}`))
  const limits = sh('docker', 'inspect', '--format', '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}', container).stdout.trim()
  check('…started with the limits its columns name', limits === `500000000 ${64 * 1024 * 1024}`)
  check('…and its health step asked the path', steps.some(s => /health/i.test(s.name) && s.status === 'success'))

  const again = await released(box?.id, auth)
  const held  = sh('docker', 'ps', '-a', '--filter', `name=^${container}$`, '--format', '{{.ID}}').stdout.trim().split('\n').filter(Boolean)
  check('a second release replaces the container rather than adding one', again?.status === 'success' && held.length === 1)

  // ── A hostname added with no release reaches the machine's Caddy ──
  // The domain:dns job pushes it; nothing here presses deploy. Its zone is
  // skipped (no edge account), and the route is pushed anyway.
  let runningId  = sh('docker', 'inspect', '--format', '{{.Id}}', container).stdout.trim()
  const releases  = (await call(`/deployments?appId=${box.id}`, auth))?.data?.length
  const hostname  = `${name}.example.test`
  const domain    = await call('/domains', { ...auth, body: { appId: box.id, hostname } })
  const routeOf   = () => caddyRoutes().find(r => r['@id'] === container)
  const routed    = await until(() => routeOf()?.match?.[0]?.host?.includes(hostname), 30_000)
  check('a Domain added after the release is routed on the machine with nobody pressing release', routed)
  check('…dialing the port the container published',
    routeOf()?.handle?.[0]?.upstreams?.[0]?.dial === `127.0.0.1:${APP_PORT}`)
  // The container was released with no hostname, so its port answers on every
  // interface, around Caddy. The route moved and the bind did not, and that
  // is a release of the live bytes (`FJS-D577`).
  let rebound = null
  await until(async () => {
    rebound = ((await call(`/deployments?appId=${box.id}`, auth))?.data ?? []).find(d => d.trigger === 'rebind')
    return ['success', 'failed'].includes(rebound?.status)
  }, 60_000)
  check('…and the stale bind is moved by a release of its own', rebound?.status === 'success'
    && (await call(`/deployments?appId=${box.id}`, auth))?.data?.length === releases + 1)
  check('…of the bytes that were live, built nothing', rebound?.builtImage === imageId && rebound?.toImage === IMAGE)
  check('…which binds the port to loopback',
    sh('docker', 'inspect', '--format', '{{json .HostConfig.PortBindings}}', container).stdout.includes('"HostIp":"127.0.0.1"'))
  runningId = sh('docker', 'inspect', '--format', '{{.Id}}', container).stdout.trim()

  // ── A release the machine refuses leaves the live one serving ──
  // With Caddy gone, /deploy refuses an app that has a hostname. A release
  // that stopped the old container first and only then asked /deploy took
  // the app down for a release that never started (`FJS-1682`).
  caddy.stop(true)
  const refused = await released(box.id, auth)
  const said    = (refused?.steps ?? []).find(s => s.status === 'failed' && /caddy/i.test(s.output ?? ''))
  if (refused?.status !== 'failed' || !said)
    console.log(`\n${refused?.status}\n${(refused?.steps ?? []).map(s => `    ${s.status.padEnd(8)} ${s.name}  ${s.output ?? ''}`).join('\n')}\n`)
  check('a release the machine refuses fails, naming why', refused?.status === 'failed' && !!said)
  check('…and the container it would have replaced is still the one running',
    sh('docker', 'inspect', '--format', '{{.Id}} {{.State.Running}}', container).stdout.trim() === `${runningId} true`)
  check('…still answering',
    (await fetch(`http://localhost:${APP_PORT}/`).then(r => r.text(), () => '')).includes(`Name: ${name}`))
  caddy = startCaddy()

  await call(`/domains/${domain?.id}`, { ...auth, method: 'DELETE' })
  // Gone only counts after it was there.
  check('…and deleted, its route goes with it', routed && await until(() => !routeOf(), 30_000))
  // Loopback with no route in front of it reaches nothing, so the last
  // hostname gone is a release too.
  let unbound = null
  await until(async () => {
    unbound = ((await call(`/deployments?appId=${box.id}`, auth))?.data ?? []).filter(d => d.trigger === 'rebind')
    return unbound.length === 2 && ['success', 'failed'].includes(unbound.find(d => d.id !== rebound?.id)?.status)
  }, 60_000)
  check('…and the release that follows puts the port back on every interface',
    unbound?.find(d => d.id !== rebound?.id)?.status === 'success'
      && !sh('docker', 'inspect', '--format', '{{json .HostConfig.PortBindings}}', container).stdout.includes('127.0.0.1'))

  // ── Adopting an app's data: an archive on the machine, into its volume ──
  // Placed and never released, the order an adoption takes: the files land
  // before a container holds the volume (`FJS-D943`).
  const adopt = await call('/apps', { ...auth, body: {
    environmentId: environment?.id, name: `adopt-${process.pid}`, slug: `adopt-${process.pid}`, type: 'container',
    source: { kind: 'image', image: IMAGE }, volumePath: '/data',
  } })
  volume = `fjs-${adopt?.id}-data`
  await call(`/apps/${adopt?.id}`, { ...auth, serviceMethod: 'place', body: { serverId: first.serverId, replicaIndex: 0 } })
  const tree = join(OWN, 'restore', 'tree')
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, 'app.db'), 'the adopted database')
  sh('tar', '-czf', join(OWN, 'restore', 'adopt.tar.gz'), '-C', tree, 'app.db')
  const restore = (body) => call(`/apps/${adopt?.id}`, { ...auth, serviceMethod: 'restoreVolume', body: { serverId: first.serverId, ...body } })
  const restored = await restore({ path: 'adopt.tar.gz' })
  check('an archive on the machine restores into the app\'s volume', restored?.volume === volume && restored?.files === 1)
  check('…holding the bytes the archive did',
    sh('docker', 'run', '--rm', '-v', `${volume}:/data`, 'busybox:1.36', 'cat', '/data/app.db').stdout === 'the adopted database')
  const again2 = await restore({ path: 'adopt.tar.gz' })
  check('a second restore into a volume with files is refused in the machine\'s words', /overwrite: true/.test(again2?.message ?? ''))
  const off = await restore({ path: '/etc/passwd' })
  check('…and a path off the restore directory is refused', /under/.test(off?.message ?? ''))

  // ── An image built where the workspace is, released by digest (`FJS-D942`) ──
  // `fli deploy:basecamp` from an app root: build here, load onto the machine
  // (this laptop's daemon, so nothing is shipped), release the image id. The
  // App's source is a git repository that does not exist, so a release that
  // built anything would fail on the clone.
  const me     = await call('/account/me', auth).catch(() => null)
  const minted = await call('/api-keys', { ...auth, body: {
    userId: me?.id ?? me?.user?.id, name: `deploy-${process.pid}`, scopes: ['apps:read', 'deployments:read', 'deployments:write'],
  } })
  const fliApp = await call('/apps', { ...auth, body: {
    environmentId: environment?.id, name: `fli-${process.pid}`, slug: `fli-${process.pid}`, type: 'container',
    source: { kind: 'git', repo: 'https://git.invalid/nothing.git' },
  } })
  await call(`/apps/${fliApp?.id}`, { ...auth, serviceMethod: 'place', body: { serverId: first.serverId, replicaIndex: 0 } })
  const appDir = join(OWN, 'fli-app')
  // `db/schema.lite` is what fli reads as an app root; without one it walks up to basecamp's own.
  mkdirSync(join(appDir, 'deploy'), { recursive: true })
  mkdirSync(join(appDir, 'db'), { recursive: true })
  writeFileSync(join(appDir, 'db', 'schema.lite'), 'model Note {\n  id Integer @id\n}\n')
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'fli-app', private: true }))
  writeFileSync(join(appDir, 'deploy', 'Dockerfile'), `FROM ${IMAGE}\nLABEL fjs.verify=${process.pid}\n`)
  const fli = spawnSync(process.execPath, [join(ROOT, '..', 'cli', 'bin', 'fli.js'), 'deploy:basecamp', '--app', String(fliApp?.id), '--url', API, '--server', 'localhost'], {
    cwd: appDir, encoding: 'utf8', env: { ...ENV, BASECAMP_API_KEY: minted?.token ?? '' }, timeout: 300_000,
  })
  const tag  = `fjs-${fliApp?.id}:`
  const made = sh('docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}').stdout.split('\n').find(l => l.startsWith(tag))
  if (made) built.push([`fjs-${fliApp?.id}`, made.split(' ')[0]])
  if (fli.status !== 0) console.log(`\n${fli.stdout}\n${fli.stderr}\n`)
  check('fli deploy:basecamp builds here and releases what it built', fli.status === 0 && !!made)
  const fliRelease = ((await call(`/deployments?appId=${fliApp?.id}`, auth))?.data ?? [])[0]
  const steps2  = (await call(`/deployments/${fliRelease?.id}`, auth))?.steps ?? []
  const madeId  = made ? sh('docker', 'image', 'inspect', '--format', '{{.Id}}', made.split(' ')[0]).stdout.trim() : null
  check('…naming the image id as the release\'s bytes', !!madeId && fliRelease?.builtImage === madeId && fliRelease?.status === 'success')
  check('…and building nothing from the app\'s git source', steps2.length > 0 && !steps2.some(s => /build/i.test(s.name)))
  check('…the container runs those bytes',
    !!madeId && sh('docker', 'inspect', '--format', '{{.Image}}', `fjs-${fliApp?.id}`).stdout.trim() === madeId)
} catch (err) {
  console.log(`\n  ✗ ${err.message}`)
  failed++
} finally {
  await cleanup()
  console.log(`\n${passed}/${passed + failed} checks passed\n`)
  process.exit(failed ? 1 : 0)
}
