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
 */

import { spawn }                                              from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir }                                             from 'node:os'
import { dirname, join }                                      from 'node:path'
import { fileURLToPath }                                      from 'node:url'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const API_PORT = 7120
const API      = `http://localhost:${API_PORT}`
const SCRATCH  = mkdtempSync(join(tmpdir(), 'basecamp-outpost-'))
const OWN      = join(ROOT, '.outpost')
const ASIDE    = join(ROOT, `.outpost.aside-${process.pid}`)
const MACHINE  = join(OWN, 'machine.json')

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
const answers = port => fetch(`http://localhost:${port}/`).then(() => true, () => false)

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
  rmSync(OWN, { recursive: true, force: true })
  if (existsSync(ASIDE)) renameSync(ASIDE, OWN)
  rmSync(SCRATCH, { recursive: true, force: true })
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => cleanup().then(() => process.exit(130)))

// ─── The run ─────────────────────────────────────────────────────────────

console.log('\nBasecamp — dev:outpost\n')

try {
  for (const port of [API_PORT, 8180, 8181])
    if (await answers(port))
      throw new Error(`port ${port} is already held — this would test a process it did not start`)

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
  const health = await fetch('http://localhost:8180/health').then(r => r.json(), () => ({}))
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
} catch (err) {
  console.log(`\n  ✗ ${err.message}`)
  failed++
} finally {
  await cleanup()
  console.log(`\n${passed}/${passed + failed} checks passed\n`)
  process.exit(failed ? 1 : 0)
}
