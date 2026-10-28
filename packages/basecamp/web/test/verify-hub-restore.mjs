#!/usr/bin/env node
// web/test/verify-hub-restore.mjs — a hub lost and brought back, in a browser.
//
//   bun run verify:hub-restore
//
// Hub A, seeded, takes a real `backup:run` into SeaweedFS, and the pinned
// Litestream replicates one App's database and Basecamp's own to the same
// bucket, from the YAML Outpost writes. A is stopped. Hub B is a fresh box
// with A's key: `/setup`'s restore tab, prefilled by `HUB_RESTORE_*`, lists
// the bucket and stages A's archive; the API restarts, the open page notices by
// itself, A's owner signs in, and the reconcile the restored boot queued finds
// both replicas: the App's card and `/hub/backups/`'s card, each graded against
// the BUCKET's own listing (`IDEAS/backups.md` 4.8).
//
// **bun + docker + Chrome + litestream v0.5 or newer.** `LITESTREAM_BIN` names
// the binary when the one on PATH is older; `litestone`'s `litestreamInstall`
// fetches the pinned build.
//
// Traps, each paid for once:
//   - A port that answers is not evidence the right process is on it. All
//     three are REFUSED if held at the start (FJS-740); the S3 port is
//     `verify:screens`' stand-in's, so the two do not run at once.
//   - Both hubs and both databases are in a temp directory; `db/` is somebody's
//     dev server. The seed and both hubs share one minted ENCRYPTION_KEY,
//     because an archive under another key is refused before anything moves.
//   - Setting `.value` on an input does not notify Mesa; it listens for `input`.
//   - SIGTERM, then SIGKILL after a grace, or the next run reports on this one.

// What `fli prove` queues on: this checkout's ports.
export const holds = ['ports']

import { spawn, spawnSync }       from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes }            from 'node:crypto'
import { createConnection }       from 'node:net'
import { dirname, join }          from 'node:path'
import { fileURLToPath }          from 'node:url'
import { Database }               from 'bun:sqlite'
import { buildYaml }              from '@frontierjs/litestone/replicate'
import { portFor }                from '@frontierjs/cli/core/ports.js'
import { openChrome }             from '../../../mesa/src/drive.js'
import { tempDir }                from '../../../litestone/src/tmp-dirs.js'

const PKG       = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const API_PORT  = await portFor(import.meta.url, 'be')
const WEB_PORT  = await portFor(import.meta.url, 'fe')
const S3_PORT   = await portFor(import.meta.url, 'be', { service: 5 })
const API       = `http://localhost:${API_PORT}`
const BASE      = `http://localhost:${WEB_PORT}`
const S3        = `http://127.0.0.1:${S3_PORT}`
const S3_IMAGE  = 'chrislusf/seaweedfs:4.48'
const CONTAINER = `fjs-verify-hub-restore-s3-${S3_PORT}`
const BUCKET    = 'hub-restore'
const S3_KEY    = 'drive:drive'
const SCRATCH   = tempDir('basecamp-hub-restore-')
const KEY       = randomBytes(32).toString('hex')
const EMAIL     = 'sam@example.com'
const PASSWORD  = 'hunter2hunter2'

const hubEnv = (dir, extra = {}) => ({
  ...process.env,
  DATABASE_URL:          join(dir, 'basecamp.db'),
  AUDIT_PATH:            join(dir, 'audit.db'),
  PORT:                  String(API_PORT),
  FRONTIER_PORT_BE:      String(API_PORT),
  FRONTIER_APP_URL:      BASE,
  ENCRYPTION_KEY:        KEY,
  BASECAMP_STUB_OUTPOST: '1',
  ...extra,
})

// ─── Harness ─────────────────────────────────────────────────────────────

const children = []
const sleep    = ms => new Promise(r => setTimeout(r, ms))
let failed = 0, passed = 0, browser = null

function start(args, env, opts = {}) {
  const child = spawn(opts.bin ?? process.execPath, args, {
    cwd: opts.cwd ?? PKG, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.out = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { child.out += d })
  children.push(child)
  return child
}

const exited = child => new Promise(r => child.exitCode !== null ? r() : child.once('exit', r))
async function stop(child) {
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  const gone = await Promise.race([exited(child).then(() => true), sleep(5000).then(() => false)])
  if (!gone) { try { process.kill(-child.pid, 'SIGKILL') } catch {} ; await exited(child) }
}
const until = async (ask, ms) => {
  for (let t = 0; t < ms; t += 250) { if (await ask()) return true; await sleep(250) }
  return false
}
const answers = port => new Promise(done => {
  const s = createConnection({ port, host: '127.0.0.1' })
  s.once('connect', () => { s.destroy(); done(true) })
  s.once('error',   () => done(false))
})

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${String(detail).slice(0, 600)}`}`)
  ok ? passed++ : failed++
}

let auth = {}
async function call(path, { method, body, serviceMethod } = {}) {
  const headers = { accept: 'application/json' }
  if (body)           headers['content-type']     = 'application/json'
  if (auth.token)     headers.authorization       = `Bearer ${auth.token}`
  if (auth.workspace) headers['x-workspace-id']   = auth.workspace
  if (serviceMethod)  headers['x-service-method'] = serviceMethod
  const res  = await fetch(API + path, {
    method: method ?? (body || serviceMethod ? 'POST' : 'GET'),
    headers, body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
  return { status: res.status, body: json }
}

async function signIn() {
  const login = await call('/auth/login', { body: { email: EMAIL, password: PASSWORD } })
  auth = { token: login.body?.token }
  return login
}

/** What the bucket holds under `prefix`, asked of SeaweedFS and never of basecamp. */
async function bucketObjects(prefix) {
  const xml = await (await fetch(`${S3}/${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}`)).text()
  return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, c]) => ({
    key: c.match(/<Key>([^<]+)<\/Key>/)[1],
    at:  new Date(c.match(/<LastModified>([^<]+)<\/LastModified>/)[1]).toISOString(),
  }))
}
const newest = objects => objects.reduce((n, o) => o.at > n ? o.at : n, '')

async function startApi(dir, extra) {
  const api = start(['api/index.ts'], hubEnv(dir, extra))
  const up  = await until(() => fetch(`${API}/health`).then(r => r.ok, () => false), 30_000)
  if (!up) throw new Error(`the API did not come up:\n${api.out.slice(-2000)}`)
  return api
}

async function evaluate(expression) {
  const r = await browser.cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result?.value
}
const seen = (expression, ms = 15_000) => until(() => evaluate(expression).then(Boolean, () => false), ms)
const goto = async path => { await browser.cmd('Page.navigate', { url: BASE + path }); await sleep(800) }
const fill = fields => evaluate(`(() => {
  ${Object.entries(fields).map(([id, v]) => `{ const el = document.getElementById(${JSON.stringify(id)})
    el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })) }`).join('\n')}
})()`)
const textOf = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent?.replace(/\\s+/g, ' ').trim() ?? null`)
const clickText = (sel, text) => evaluate(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.includes(${JSON.stringify(text)}))
  if (!el) throw new Error('no ' + ${JSON.stringify(`${sel} "${text}"`)})
  el.click(); return true })()`)

async function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM') } catch {} }
  await sleep(1500)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
  await browser?.close().catch(() => {})
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
  rmSync(SCRATCH, { recursive: true, force: true })
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => cleanup().then(() => process.exit(130)))

// ─── Preflight ───────────────────────────────────────────────────────────

const litestream = process.env.LITESTREAM_BIN ?? spawnSync('which', ['litestream'], { encoding: 'utf8' }).stdout.trim()
const version    = litestream && spawnSync(litestream, ['version'], { encoding: 'utf8' }).stdout?.match(/(\d+)\.(\d+)/)
if (!version || (Number(version[1]) === 0 && Number(version[2]) < 5)) {
  console.error(`verify-hub-restore: needs litestream v0.5 or newer (found ${version?.[0] ?? 'none'}); point LITESTREAM_BIN at the pinned build`)
  process.exit(1)
}
if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  console.error('verify-hub-restore: needs a running docker daemon')
  process.exit(1)
}

// ─── The run ─────────────────────────────────────────────────────────────

console.log('\nBasecamp — a hub restored from its archive, and the replicas it finds\n')

try {
  for (const port of [API_PORT, WEB_PORT, S3_PORT])
    if (await answers(port))
      throw new Error(`port ${port} is already held — this would test a process it did not start`)

  const s3 = spawnSync('docker', ['run', '-d', '--rm', '--name', CONTAINER,
    '-p', `127.0.0.1:${S3_PORT}:8333`, S3_IMAGE, 'server', '-s3', '-dir=/data'], { encoding: 'utf8' })
  if (s3.status !== 0) throw new Error(`docker run: ${s3.stderr.trim()}`)
  // The gateway answers before it accepts a bucket, so the create is the poll.
  const made = await until(() => fetch(`${S3}/${BUCKET}`, { method: 'PUT' }).then(r => r.ok, () => false), 30_000)
  if (!made) throw new Error('SeaweedFS never accepted the bucket')

  // ── Hub A ──
  const hubA = join(SCRATCH, 'a'), hubB = join(SCRATCH, 'b')
  mkdirSync(hubA); mkdirSync(hubB)
  const seed = start(['db/seed.js'], hubEnv(hubA))
  await exited(seed)
  if (seed.exitCode !== 0) throw new Error(`db/seed.js exited ${seed.exitCode}\n${seed.out}`)

  let api = await startApi(hubA)
  await signIn()
  // The workspace the browser will open after sign-in, so the App is on its screen.
  auth.workspace = (await call('/auth/workspace')).body?.workspace_id
  const destination = async (name, prefix) => (await call('/backup-destinations', { body: {
    name, endpoint: S3, region: 'us-east-1', bucket: BUCKET, prefix, secret: S3_KEY } })).body
  const archives = await destination('Hub archives', 'hub')
  const appDest  = await destination('App replica', 'apps')
  const hubDest  = await destination('Hub replica', 'hubrep')
  check('three destinations on SeaweedFS', [archives, appDest, hubDest].every(d => d?.id), JSON.stringify([archives, appDest, hubDest]))

  const current = (await call('/hub-config', { serviceMethod: 'current', body: {} })).body
  const saved   = await call('/hub-config', { serviceMethod: 'save',
    body: { replicaDestinationId: hubDest.id, ...(current?.version ? { version: current.version } : {}) } })
  check('the hub replicates to a destination of its own', saved.status < 300 && saved.body?.replicaDestinationId === hubDest.id,
    JSON.stringify(saved))

  const listed = (await call('/apps?$limit=200')).body?.data ?? []
  let target = null
  for (const a of listed) {
    const full = (await call(`/apps/${a.id}`)).body
    if (full?.placement?.length) { target = full; break }
  }
  if (!target) throw new Error('the seed left no placed app to replicate')
  const patched = await call(`/apps/${target.id}`, { method: 'PATCH',
    body: { replicaDestinationId: appDest.id, version: target.version } })
  check(`app '${target.slug}' replicates to its own destination`, patched.body?.replicaDestinationId === appDest.id,
    JSON.stringify(patched))

  // Litestream, from the YAML Outpost writes: one directory target per
  // replica, each file to `<path>/<file>`. The App's volume is a database of
  // its own; Basecamp's is a copy of A's, which Outpost lays out under
  // `<prefix>/basecamp/`.
  const appVol = join(SCRATCH, 'app-volume'), hubVol = join(SCRATCH, 'hub-volume')
  mkdirSync(appVol); mkdirSync(hubVol)
  const vol = new Database(join(appVol, 'main.db'))
  vol.run('PRAGMA journal_mode = WAL')
  vol.run('CREATE TABLE note (body TEXT)')
  vol.run(`INSERT INTO note VALUES ('before the hub was lost')`)
  vol.close()
  const live = new Database(join(hubA, 'basecamp.db'), { readonly: true })
  live.run('VACUUM INTO ?', [join(hubVol, 'basecamp.db')])
  live.close()
  const replica = (path) => ({ bucket: BUCKET, path, endpoint: S3, region: 'us-east-1', accessKeyId: 'drive', secretAccessKey: 'drive' })
  const yaml = buildYaml([
    { dir: appVol, pattern: '*.db', metaDir: join(SCRATCH, 'meta', target.id), replica: replica(`apps/${target.id}`) },
    { dir: hubVol, pattern: '*.db', metaDir: join(SCRATCH, 'meta', '_host'),    replica: replica('hubrep/basecamp') },
  ], { syncInterval: '1s' })
  writeFileSync(join(SCRATCH, 'litestream.yml'), yaml)
  const streamer = start(['replicate', '-config', join(SCRATCH, 'litestream.yml')], process.env, { bin: litestream, cwd: SCRATCH })
  const streamed = await until(async () =>
    (await bucketObjects(`apps/${target.id}/main.db/`)).length > 0 && (await bucketObjects('hubrep/basecamp/basecamp.db/')).length > 0, 30_000)
  check('Litestream wrote both replicas to the bucket', streamed, streamer.out.slice(-1500))
  await stop(streamer)

  // `BACKUPS.md` § 7's restore of the hub from its own replica, over `s3://`
  // as the runbook spells it, read back table by table.
  const q = new URLSearchParams({ endpoint: S3, region: 'us-east-1', 'force-path-style': 'true' })
  const pulled = spawnSync(litestream, ['restore', '-integrity-check', 'quick', '-o', join(SCRATCH, 'from-replica.db'),
    `s3://${BUCKET}/hubrep/basecamp/basecamp.db?${q}`],
    { encoding: 'utf8', env: { ...process.env, LITESTREAM_ACCESS_KEY_ID: 'drive', LITESTREAM_SECRET_ACCESS_KEY: 'drive' } })
  const counts = file => {
    const d = new Database(file, { readonly: true })
    try { return ['app', 'user', 'workspace', 'secret'].map(t => d.query(`SELECT count(*) AS n FROM "${t}"`).get().n).join() }
    finally { d.close() }
  }
  check('the runbook\'s litestream restore over s3:// brings back the hub\'s rows',
    pulled.status === 0 && counts(join(SCRATCH, 'from-replica.db')) === counts(join(hubVol, 'basecamp.db')),
    `${pulled.stderr}${pulled.stdout}`)

  const asked  = await call('/backups', { body: { destinationId: archives.id } })
  const backup = asked.body?.backup ?? asked.body
  let row = null
  await until(async () => {
    row = (await call(`/backups/${backup?.id}`)).body
    return ['success', 'failed', 'timeout'].includes(row?.status)
  }, 60_000)
  const archived = (await bucketObjects('hub/basecamp-')).filter(o => o.key.endsWith('.tar.gz'))
  check('backup:run finishes success with no error', row?.status === 'success' && !row?.error, JSON.stringify(row))
  check('…and the bucket holds the archive it names', archived.length === 1 && archived[0].key === row?.location,
    JSON.stringify({ archived, location: row?.location }))
  await stop(api)

  // ── Hub B: a new box, A's key, the bucket named by its env ──
  const restoreEnv = { HUB_RESTORE_ENDPOINT: S3, HUB_RESTORE_BUCKET: BUCKET, HUB_RESTORE_PREFIX: 'hub', HUB_RESTORE_KEY: S3_KEY }
  api = await startApi(hubB, restoreEnv)
  auth = {}
  const probe = (await call('/setup/probe')).body
  check('the new box needs setup and reports the bucket without its key',
    probe?.needs_setup === true && probe?.restore_bucket?.bucket === BUCKET && probe?.restore_bucket?.key === true,
    JSON.stringify(probe))

  const web = start(['run', 'web'], { ...process.env, API_PORT: String(API_PORT), UI_PORT: String(WEB_PORT) }, { bin: 'bun' })
  if (!await until(() => fetch(BASE).then(() => true, () => false), 60_000))
    throw new Error(`the web server did not come up:\n${web.out.slice(-1500)}`)
  browser = await openChrome()
  const consoleErrors = []
  browser.on('Runtime.consoleAPICalled', (p) => {
    if (!['error', 'warning'].includes(p.type)) return
    const t = p.args.map(a => a.value ?? a.description ?? '').join(' ')
    if (!/favicon|\[vite\]|Download the .* DevTools/i.test(t)) consoleErrors.push(t)
  })

  await goto('/setup/')
  await seen(`!!document.getElementById('restore-endpoint')`)
  await clickText('[role=tab], button', 'Restore a hub')
  const prefilled = await evaluate(`({ endpoint: document.getElementById('restore-endpoint')?.value,
    bucket: document.getElementById('restore-bucket')?.value, prefix: document.getElementById('restore-prefix')?.value,
    key: document.getElementById('restore-key')?.value })`)
  check('the restore tab is prefilled from HUB_RESTORE_*, the key left blank',
    prefilled.endpoint === S3 && prefilled.bucket === BUCKET && prefilled.prefix === 'hub' && prefilled.key === '',
    JSON.stringify(prefilled))
  await clickText('#setup-restore button', 'List archives')
  const rowsShown = await seen(`document.querySelectorAll('#restore-archives li').length === 1`)
  check('List archives shows the one archive in the bucket', rowsShown, await textOf('#setup-restore'))
  await clickText('#restore-archives button', 'Restore this')
  const staged = await seen(`document.querySelector('#setup-restore .alert.info')?.textContent.includes('is staged')`, 60_000)
  check('Restore this stages it and says to restart', staged, await textOf('#setup-restore'))

  await stop(api)
  api = await startApi(hubB, restoreEnv)
  const done = await seen(`document.querySelector('#setup-restore .alert.success')?.textContent.includes('Restored from the archive')`, 20_000)
  check('after the restart, the open page notices the restore by itself', done, await textOf('#setup-restore'))
  check('/setup/probe answers done', (await call('/setup/probe')).body?.restore === 'done')
  const again = await call('/setup/restore', { body: { endpoint: S3, bucket: BUCKET, key: S3_KEY, archive: row?.location } })
  check('a second restore is refused: the hub has an account now', again.status === 409, JSON.stringify(again))

  await goto('/login/')
  await seen(`!!document.getElementById('email')`)
  await fill({ email: EMAIL, password: PASSWORD })
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  check("A's owner signs in to B", await seen(`location.pathname === '/'`))
  await signIn()
  auth.workspace = target.workspaceId

  // The reconcile is a job the restored boot queued; nobody pressed anything.
  let found = null
  await until(async () => (found = (await call(`/apps/${target.id}`)).body)?.replicaFoundAt, 30_000)
  const appNewest = newest(await bucketObjects(`apps/${target.id}/`))
  check('the reconcile records the App replica, last synced at the bucket\'s newest object',
    !!found?.replicaFoundAt && found?.replicaSyncedAt === appNewest, JSON.stringify({ found: found?.replicaSyncedAt, appNewest }) + '\n' +
      api.out.split('\n').filter(l => /reconcile|replica|restore/i.test(l)).slice(-12).join('\n'))
  const hub = (await call('/hub-config', { serviceMethod: 'current', body: {} })).body
  const hubNewest = newest(await bucketObjects('hubrep/basecamp/'))
  check('…and Basecamp\'s own replica on HubConfig', !!hub?.replicaFoundAt && hub?.replicaSyncedAt === hubNewest,
    JSON.stringify({ hub: hub?.replicaSyncedAt, hubNewest }))
  const told = (await call('/notifications?$limit=50')).body?.data ?? []
  check('the owner is told which apps were found', told.some(n => n.type === 'ReplicaFound' && n.data?.apps?.some(a => a.id === target.id)),
    JSON.stringify(told.map(n => n.type)))

  await goto(`/apps/${target.id}/`)
  const card = await seen(`!!document.getElementById('app-found')`)
  const cardText = await textOf('#app-found')
  check('the App screen shows Replica found, with the sync time and a line per placement',
    card && cardText?.includes('last synced') && !cardText.includes('unknown time')
      && await evaluate(`document.querySelectorAll('#app-found-targets li').length`) === found.placement.length,
    cardText ?? JSON.stringify({ page: (await textOf('main'))?.slice(0, 400),
      placement: found.placement.map(p => ({ status: p.server?.status, replication: p.replication })) }))
  await evaluate(`document.getElementById('app-found-dismiss').click()`)
  const dismissed = await seen(`!document.getElementById('app-found')`)
  check('Dismiss takes the card away, and the row agrees', dismissed && !(await call(`/apps/${target.id}`)).body?.replicaFoundAt)

  await goto('/hub/backups/')
  const hubCard = await seen(`!!document.getElementById('hub-found')`)
  const hubText = await textOf('#hub-found')
  check('/hub/backups/ shows the hub\'s Replica found and names the runbook',
    hubCard && hubText?.includes('BACKUPS.md') && !hubText.includes('unknown time'), hubText)

  check('no console error or warning across the run', consoleErrors.length === 0, consoleErrors.join('\n'))
} catch (err) {
  check('the drive ran to the end', false, err?.stack ?? err)
} finally {
  await cleanup()
}

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
