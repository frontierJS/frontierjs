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
 *   - The container release runs on the developer's REAL daemon. It removes
 *     only the container it started and the image only if it pulled it, and
 *     never calls a prune or volume route: on a workstation those delete
 *     somebody else's images.
 */

import { spawn, spawnSync }                                   from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir }                                             from 'node:os'
import { dirname, join }                                      from 'node:path'
import { fileURLToPath }                                      from 'node:url'
import { createConnection }                                   from 'node:net'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const API_PORT = 7120
const API      = `http://localhost:${API_PORT}`
const SCRATCH  = mkdtempSync(join(tmpdir(), 'basecamp-outpost-'))
const OWN      = join(ROOT, '.outpost')
const ASIDE    = join(ROOT, `.outpost.aside-${process.pid}`)
const MACHINE  = join(OWN, 'machine.json')
const APP_PORT = 7126
const IMAGE    = 'traefik/whoami:v1.10.3'
const sh       = (...argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
const hadImage = sh('docker', 'image', 'inspect', IMAGE).status === 0
let container  = null

const ENV = {
  ...process.env,
  DATABASE_URL: join(SCRATCH, 'basecamp.db'),
  AUDIT_PATH:   join(SCRATCH, 'audit/'),
  PORT:         String(API_PORT),
  BASECAMP_URL: API,
}

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
// A connect, not a fetch: 8180 speaks TLS, and a plain-http fetch at it fails
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

async function call(path, { token, workspace, body, serviceMethod } = {}) {
  const headers = { accept: 'application/json' }
  if (body)          headers['content-type']     = 'application/json'
  if (token)         headers.authorization       = `Bearer ${token}`
  if (workspace)     headers['x-workspace-id']   = workspace
  if (serviceMethod) headers['x-service-method'] = serviceMethod
  const res  = await fetch(API + path, {
    method:  body || serviceMethod ? 'POST' : 'GET',
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
  await sleep(3000)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
  if (container) sh('docker', 'rm', '-f', container)
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
  for (const port of [API_PORT, 8180, 8181, APP_PORT])
    if (await answers(port))
      throw new Error(`port ${port} is already held — this would test a process it did not start`)
  if (sh('docker', 'info').status !== 0)
    throw new Error('no docker daemon answers — the container release needs one')

  if (existsSync(OWN)) renameSync(OWN, ASIDE)

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
    second.out.includes('port 8180 is already answering'))
  // Pinned the way Basecamp pins it: the certificate the launcher enrolled with.
  const health = await fetch('https://localhost:8180/health', {
    tls: { ca: first.cert, checkServerIdentity: () => undefined },
  }).then(r => r.json(), () => ({}))
  check('…and the first is still the machine answering', health.server_id === first.serverId)

  // ── A release reaches it, and the page comes back off the disk ──
  const { token } = await call('/auth/login', { body: { email: 'sam@example.com', password: 'hunter2hunter2' } })
  const auth = { token, workspace: first.workspaceId }

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
    (await fetch(`http://localhost:8181/${slug}/`).then(r => r.text(), () => '')).includes('served off this laptop'))

  // ── Stopped the way `bun run stop` stops it: a SIGTERM to the launcher ──
  process.kill(dev.pid, 'SIGTERM')
  check('stopping the launcher takes its Outpost with it — both ports free',
    await until(async () => !(await answers(8180)) && !(await answers(8181)), 10_000))

  // ── A restart is the same machine ──
  dev = start(['api/src/providers/outpost-dev.ts'])
  check('a restart comes online again', await until(() => dev.out.includes('is online'), 40_000))
  check('…as the SAME server row', machine().serverId === first.serverId)
  const rows = ((await call('/servers?$limit=200', auth))?.data ?? []).filter(s => s.slug === 'dev-outpost')
  check('…and the fleet has exactly one of it', rows.length === 1)

  // ── A lost identity file finds the row it left, and rotates its key ──
  process.kill(dev.pid, 'SIGTERM')
  await until(async () => !(await answers(8180)), 10_000)
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
} catch (err) {
  console.log(`\n  ✗ ${err.message}`)
  failed++
} finally {
  await cleanup()
  console.log(`\n${passed}/${passed + failed} checks passed\n`)
  process.exit(failed ? 1 : 0)
}
