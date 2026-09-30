/*
 * verify-dns.mjs — a Domain pushed to the edge, run as processes and graded.
 *
 *   bun run verify:dns
 *
 * The API, and Cloudflare's stand-in as a process of its own, on a scratch
 * database. What `api/test/edge.test.ts` cannot show is the WHOLE path: a token
 * connected through `/secrets`, the ingress zone set through `/workspaces`,
 * releases run by the job rather than stamped on a row, and the zone read back
 * off the stand-in DIRECTLY — Cloudflare's own view, not basecamp's report of
 * it. Nobody presses sync: a Domain written, a release landed and a Domain
 * deleted each reach the zone through the `domain:dns` job, so every zone
 * assertion WAITS on Cloudflare rather than on an answer from basecamp. And
 * the case `FJS-D561` owes: a release that moves to another machine moves the
 * ingress record with it — and a machine draining or returning with no release
 * moves it too (`FJS-1614`), except off the last machine, where it stays
 * (`FJS-D567`).
 *
 * It needs no browser and no machine: releases go to the stub executor
 * (`BASECAMP_STUB_OUTPOST=1`), which lands on the first ONLINE placement,
 * exactly as a real one is chosen.
 *
 * Traps, each paid for once:
 *   - A port that answers is not evidence the right process is on it. Both are
 *     REFUSED if held at the start (FJS-740). 7120 is the test tier's API,
 *     shared with `verify:outpost`, so the two cannot run at once and say so.
 *   - Its own database in a temp directory; `db/` is somebody's dev server.
 *   - SIGTERM, then SIGKILL after a grace, or the next run reports on this one.
 */

import { spawn }                  from 'node:child_process'
import { mkdtempSync, rmSync }    from 'node:fs'
import { tmpdir }                 from 'node:os'
import { dirname, join }          from 'node:path'
import { fileURLToPath }          from 'node:url'
import { createConnection }       from 'node:net'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const API_PORT = 7120
const CF_PORT  = 7128           // test tier, basecamp — the unit file holds 7127
const API      = `http://localhost:${API_PORT}`
const CF       = `http://localhost:${CF_PORT}/client/v4`
const CF_TOKEN = 'cfat_devtoken'
const SCRATCH  = mkdtempSync(join(tmpdir(), 'basecamp-dns-'))

const ENV = {
  ...process.env,
  DATABASE_URL:          join(SCRATCH, 'basecamp.db'),
  AUDIT_PATH:            join(SCRATCH, 'audit/'),
  PORT:                  String(API_PORT),
  BASECAMP_URL:          API,
  CLOUDFLARE_URL:        CF,
  CF_SINK_PORT:          String(CF_PORT),
  BASECAMP_STUB_OUTPOST: '1',
}

// ─── Harness ─────────────────────────────────────────────────────────────

const children = []
const sleep    = ms => new Promise(r => setTimeout(r, ms))
let failed = 0, passed = 0

function start(args) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT, env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.out = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { child.out += d })
  children.push(child)
  return child
}

const exited = child => new Promise(r => child.exitCode !== null ? r() : child.once('exit', r))
const until  = async (ask, ms) => {
  for (let t = 0; t < ms; t += 250) { if (await ask()) return true; await sleep(250) }
  return false
}
const answers = port => new Promise(done => {
  const s = createConnection({ port, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); done(true) })
  s.once('error',   () => done(false))
})

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`)
  ok ? passed++ : failed++
}

let auth = {}
async function call(path, { method, body, serviceMethod } = {}) {
  const headers = { accept: 'application/json' }
  if (body)             headers['content-type']     = 'application/json'
  if (auth.token)       headers.authorization       = `Bearer ${auth.token}`
  if (auth.workspace)   headers['x-workspace-id']   = auth.workspace
  if (serviceMethod)    headers['x-service-method'] = serviceMethod
  const res  = await fetch(API + path, {
    method:  method ?? (body || serviceMethod ? 'POST' : 'GET'),
    headers, body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
  return { status: res.status, body: json }
}

/** The zone as Cloudflare holds it — asked of the stand-in, never of basecamp. */
async function zone(zoneId) {
  const res = await fetch(`${CF}/zones/${zoneId}/dns_records?per_page=5000&page=1`, {
    headers: { authorization: `Bearer ${CF_TOKEN}` } })
  const all = []
  let body = await res.json()
  all.push(...body.result)
  for (let page = 2; page <= body.result_info.total_pages; page++) {
    body = await (await fetch(`${CF}/zones/${zoneId}/dns_records?per_page=5000&page=${page}`, {
      headers: { authorization: `Bearer ${CF_TOKEN}` } })).json()
    all.push(...body.result)
  }
  return all
}

async function released(appId) {
  const release = (await call('/deployments', { body: { appId } })).body
  let row = null
  await until(async () => {
    row = (await call(`/deployments/${release?.id}`)).body
    return ['success', 'failed'].includes(row?.status)
  }, 30_000)
  return row
}

const edge = (method, data, id) => call(id ? `/edge/${id}` : '/edge', { serviceMethod: method, body: data ?? {} })

async function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM') } catch {} }
  await sleep(2000)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
  rmSync(SCRATCH, { recursive: true, force: true })
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => cleanup().then(() => process.exit(130)))

// ─── The run ─────────────────────────────────────────────────────────────

console.log('\nBasecamp — a Domain pushed to the edge\n')

try {
  for (const port of [API_PORT, CF_PORT])
    if (await answers(port))
      throw new Error(`port ${port} is already held — this would test a process it did not start`)

  const seed = start(['db/seed.js'])
  await exited(seed)
  if (seed.exitCode !== 0) throw new Error(`db/seed.js exited ${seed.exitCode}\n${seed.out}`)

  start(['api/src/providers/edge/cloudflare-sink.ts'])
  const api = start(['api/index.ts'])
  const up  = await until(() => fetch(`${API}/health`).then(r => r.ok, () => false), 30_000)
    && await until(() => answers(CF_PORT), 10_000)
  check('the API and the Cloudflare stand-in come up on their own ports', up)
  if (!up) throw new Error(`did not come up:\n${api.out.slice(-2000)}`)

  const login = await call('/auth/login', { body: { email: 'sam@example.com', password: 'hunter2hunter2' } })
  auth.token  = login.body?.token
  const workspaces = (await call('/workspaces')).body?.data ?? []
  // Two machines that can take a release. The seed's statuses are its own:
  // machines it marked as having spoken go `unreachable` once nothing
  // heartbeats for them, and only a machine can bring one back. A DRAINING
  // one an operator can undrain, and one that never checked in is left alone
  // by the reachability sweep — so online plus draining is the pool.
  let chosen = null
  for (const w of workspaces) {
    auth.workspace = w.id
    const servers = ((await call('/servers?$limit=200')).body?.data ?? [])
      .filter(s => ['online', 'draining'].includes(s.status) && s.ipAddress && !s.lastHeartbeatAt)
    if (servers.length >= 2) { chosen = { w, servers: servers.slice(0, 2) }; break }
  }
  if (!chosen) throw new Error('the seed left no workspace with two machines that can be made to take a release')
  auth.workspace = chosen.w.id
  for (const s of chosen.servers)
    if (s.status === 'draining') await call(`/servers/${s.id}`, { serviceMethod: 'undrain', body: {} })
  const online = ((await call('/servers?$limit=200')).body?.data ?? []).filter(s => s.status === 'online')
  check('two machines are online to release onto', chosen.servers.every(c => online.some(s => s.id === c.id)))
  const [one, two] = chosen.servers

  // ── Connected the way the screen connects it ──
  const secret = (await call('/secrets', { body: {
    name: `cf-${process.pid}`, kind: 'provider_key', providerKind: 'cloudflare', data: CF_TOKEN } })).body
  check('a Cloudflare token is accepted as a workspace account', !!secret?.id, JSON.stringify(secret))

  const refused = await edge('sync', {}, 'nothing')
  check('sync before anything is set answers, and does not crash', [404, 409].includes(refused.status), JSON.stringify(refused))

  const ws = (await call(`/workspaces/${chosen.w.id}`)).body
  const set = await call(`/workspaces/${chosen.w.id}`, { method: 'PATCH',
    body: { ingressAccountId: secret?.id, ingressZoneId: 'zone-shop', version: ws?.version } })
  check('the ingress zone is set through /workspaces', set.status === 200 && set.body?.ingressZoneId === 'zone-shop',
    JSON.stringify(set))

  // ── An app, a hostname, and no release yet ──
  const environment = (await call('/environments')).body?.data?.[0]
  const name = `dns-${process.pid}`
  const app  = (await call('/apps', { body: {
    environmentId: environment?.id, name, slug: name, type: 'container',
    source: { kind: 'image', image: 'nginx:alpine' }, port: 7129,
  } })).body
  if (!app?.id) throw new Error(`the app was not made: ${JSON.stringify(app)}`)
  await call(`/apps/${app.id}`, { serviceMethod: 'place', body: { serverId: one.id, replicaIndex: 0 } })
  await call(`/apps/${app.id}`, { serviceMethod: 'place', body: { serverId: two.id, replicaIndex: 1 } })

  const hostname = `${name}.example.test`
  const ingress  = `${app.id}.shop.test`
  const cnameAt  = async () => (await zone('zone-example')).filter(r => r.name === hostname)
  const aAt      = async () => (await zone('zone-shop')).filter(r => r.name === ingress)
  const domain   = (await call('/domains', { body: { appId: app.id, hostname, proxied: true } })).body
  // The Domain's own push has run and been skipped — the app runs nowhere, so
  // there is nothing to point at. Waited out rather than raced.
  await sleep(1500)
  const plan = await edge('records', { accountId: secret?.id, zoneId: 'zone-example' })
  check('before a release, the hostname is MISSING from its zone — nothing was published pointing nowhere',
    (plan.body?.missing ?? []).some(d => d.hostname === hostname) && !(await cnameAt()).length,
    JSON.stringify(plan.body?.missing))

  // ── The release is what publishes it, read back off Cloudflare itself ──
  const first = await released(app.id)
  check('a release lands on the first machine', first?.status === 'success', JSON.stringify(first?.error ?? first))

  await until(async () => (await cnameAt()).length > 0, 15_000)
  const cname = await cnameAt()
  check('with nobody pressing sync, Cloudflare holds ONE CNAME at the hostname, to the app\'s ingress record, proxied as the row says',
    cname.length === 1 && cname[0].type === 'CNAME' && cname[0].content === ingress && cname[0].proxied === true,
    JSON.stringify(cname))
  check('…marked as this Domain\'s', cname[0]?.comment === `basecamp:domain:${domain?.id}`)

  const a1 = await aAt()
  check('the ingress record holds only the machine the release landed on — not the one merely placed',
    a1.length === 1 && a1[0].type === 'A' && a1[0].content === one.ipAddress, JSON.stringify(a1))
  check('…marked as this App\'s', a1[0]?.comment === `basecamp:app:${app.id}`)

  const again = await edge('sync', {}, domain?.id)
  const same  = await aAt()
  check('sync by hand answers what is there, and changes nothing',
    again.status === 200 && again.body?.ingress?.name === ingress && same.length === 1 && same[0].id === a1[0]?.id,
    JSON.stringify(again.body))

  // ── The machine drains with no release, and the app runs nowhere ──
  // The drain's own push runs and is refused as not-yet: an app on no online
  // machine keeps its record where it last ran (FJS-D567). Waited out rather
  // than raced, like the skip above.
  await call(`/servers/${one.id}`, { serviceMethod: 'drain', body: {} })
  await sleep(1500)
  const kept = await aAt()
  check('draining the app\'s only machine leaves its record where it last ran — it is never emptied',
    kept.length === 1 && kept[0].content === one.ipAddress, JSON.stringify(kept))
  const down = await edge('records', { accountId: secret?.id, zoneId: 'zone-shop' })
  check('…and drift names the app down', (down.body?.stale ?? []).some(s => s.appId === app.id && s.down),
    JSON.stringify(down.body?.stale))

  // ── The next release moves; the record follows ──
  const moved = await released(app.id)
  check('with the first machine draining, the next release lands on the second', moved?.status === 'success',
    JSON.stringify(moved?.error ?? moved))

  const a2 = await until(async () => { const a = await aAt(); return a.length === 1 && a[0].content === two.ipAddress }, 15_000)
  check('the ingress record follows the release to the second machine, with nobody pressing sync', !!a2,
    JSON.stringify(await aAt()))
  const after = await edge('records', { accountId: secret?.id, zoneId: 'zone-shop' })
  check('…and no drift is left', !(after.body?.stale ?? []).some(s => s.appId === app.id), JSON.stringify(after.body?.stale))

  // ── The first machine comes back with no release: the record takes it again ──
  await call(`/servers/${one.id}`, { serviceMethod: 'undrain', body: {} })
  const both = await until(async () => (await aAt()).length === 2, 15_000)
  check('undraining the first machine puts it back in the record, with no release and nobody pressing sync', !!both,
    JSON.stringify(await aAt()))

  // ── Somebody else's record at the name: refused, left, named ──
  const before = await zone('zone-shop')
  const theirs = (await call('/domains', { body: { appId: app.id, hostname: 'www.shop.test' } })).body
  await sleep(1500)
  check('the job pushing a hostname that holds a record basecamp did not write leaves Cloudflare\'s zone untouched',
    JSON.stringify(await zone('zone-shop')) === JSON.stringify(before))
  const conflict = await edge('sync', {}, theirs?.id)
  check('…and sync by hand is refused as a conflict, naming the record',
    conflict.status === 409 && String(conflict.body?.message).includes('192.0.2.10'), JSON.stringify(conflict.body))
  const named = await edge('records', { accountId: secret?.id, zoneId: 'zone-shop' })
  check('…and drift names it', (named.body?.conflicts ?? []).some(d => d.hostname === 'www.shop.test'))

  // ── A deleted Domain takes its record with it ──
  // The first hostname an app gets is its primary, and a primary is not
  // deleted — so the other one is promoted first, as the screen asks.
  await call(`/domains/${theirs?.id}`, { serviceMethod: 'makePrimary', body: {} })
  const removed = await call(`/domains/${domain?.id}`, { method: 'DELETE' })
  check('the Domain is deleted', removed.status === 200, JSON.stringify(removed))
  const cleared = await until(async () => (await cnameAt()).length === 0, 15_000)
  check('…and its CNAME leaves Cloudflare', cleared, JSON.stringify(await cnameAt()))
  const left = await edge('records', { accountId: secret?.id, zoneId: 'zone-example' })
  check('…leaving no orphan behind', !(left.body?.orphans ?? []).some(r => r.name === hostname), JSON.stringify(left.body?.orphans))
  check('…and the app\'s ingress record stays, for its other hostnames', (await aAt()).length === 2)
} catch (err) {
  failed++
  console.log(`  FAIL  ${err.message}`)
} finally {
  await cleanup()
}

console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`)
process.exit(failed ? 1 : 0)
