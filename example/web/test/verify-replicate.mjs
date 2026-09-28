/**
 * web/test/verify-replicate.mjs — the way back, driven: stream every file this
 * app writes to a real S3 API, lose the disk, restore, and compare.
 *
 * **bun + docker + litestream v0.5 or newer, no app server.** The bucket is
 * SeaweedFS's S3 gateway on 7116, started and removed by this drive.
 * `LITESTREAM_BIN` names the binary when the one on PATH is older — the 0.3.x
 * that distributions still ship cannot read a litestone database at all.
 *
 * ─── What this drive is FOR ───────────────────────────────────────────────
 *
 * Under `tenancy { strategy database }` a shop's rows are in `shops/<id>.db`,
 * and no `database { }` block names that file. `litestone replicate` and
 * `litestone backup` read the declared set, so both streamed `main` — which
 * under this strategy holds the machinery and no rows — and not one shop, and
 * both reported success (`FJS-1389`). And coming back was one hand-typed
 * `litestream restore` per file until `litestone restore` (`FJS-552`).
 *
 * ─── Reading it ───────────────────────────────────────────────────────────
 *
 *   `replicate.*` — what reached the bucket, read off the bucket's own listing
 *   rather than off the command's output, since the output is what was wrong.
 *
 *   `restore.*` — the headline. One `litestone restore` onto an empty disk,
 *   each file compared to the source by content, table by table; the audit
 *   trail from a `litestone backup`, since litestream never streams it.
 *
 *   `refuses.*` — the ways a restore could leave an app half-there, each of
 *   which must write nothing: a replica with nothing in it, files already in
 *   place, a logger database with no backup to come from, and one tenant whose
 *   replica is gone.
 *
 *   `at.*` — `--at` an instant between two writes: the first comes back and
 *   the second does not.
 *
 *   `verify.*` — `restore --verify` over a copy holding one `@secret` value:
 *   with no key and nothing said it refuses before fetching; with no key and
 *   `--without-key` it passes and names the columns it could not read; with the
 *   key it passes; with another key it fails and keeps the copy. None of them
 *   creates anything at a live path.
 *
 *   `stop.flushesTheLastWrite` — a write made a moment before the replicator
 *   is stopped. A graceful stop that skips its final sync loses up to one sync
 *   interval of every tenant's writes, and nothing else here would notice.
 *
 * Fixtures are COPIES of the development shop taken with `VACUUM INTO`, and
 * every path the CLI is given is in a scratch directory: litestream writes a
 * `.<db>-litestream` directory beside every file it watches, and this drive
 * never points it at `db/`.
 */

import { Database }         from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, rmdirSync, cpSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir }           from 'node:os'
import { join, dirname }    from 'node:path'
import { fileURLToPath }    from 'node:url'
import { connect }          from 'node:net'
import { createTenantRegistry } from '@frontierjs/litestone'
import { results, report }  from './lib/report.mjs'

const HERE   = dirname(fileURLToPath(import.meta.url))
const DB_DIR = join(HERE, '..', '..', 'db')

const S3_PORT   = 7116
const S3_IMAGE  = 'chrislusf/seaweedfs:4.47'
const CONTAINER = 'fjs-verify-replicate-s3'
const BUCKET    = 'fjs-drive'
const S3        = `http://127.0.0.1:${S3_PORT}`
const REPLICA   = `s3://${BUCKET}/example`
const KEY       = 'c'.repeat(64)
const NO_KEY    = { ENCRYPTION_KEY: '', LITESTONE_KEY: '' }

const fail  = (msg) => { console.error(`verify-replicate: ${msg}`); process.exit(1) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ─── Preflight ────────────────────────────────────────────────────────────

const litestream = process.env.LITESTREAM_BIN
  ?? spawnSync('which', ['litestream'], { encoding: 'utf8' }).stdout.trim()
const version = litestream && spawnSync(litestream, ['version'], { encoding: 'utf8' }).stdout?.match(/(\d+)\.(\d+)/)
if (!version || (Number(version[1]) === 0 && Number(version[2]) < 5))
  fail(`needs litestream v0.5 or newer (found ${version?.[0] ?? 'none'}). ` +
       `Install the build deploy:setup pins and point LITESTREAM_BIN at it.`)

if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) fail('needs a running docker daemon')

const answers = (port) => new Promise(done => {
  const s = connect(port, '127.0.0.1')
  s.on('connect', () => { s.destroy(); done(true) })
  s.on('error',   () => done(false))
})
// A port that answers is not evidence the right process holds it.
if (await answers(S3_PORT)) fail(`port ${S3_PORT} already answers — refusing to test whatever holds it`)

const seededShop = join(DB_DIR, 'shops', 'flagship.db')
if (!existsSync(seededShop)) fail('no seeded shop — run `bun run db:seed` first')

// ─── Helpers ──────────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), 'fjs-replicate-'))
const live    = join(scratch, 'live')
const dest    = join(scratch, 'backup')

const env = {
  ...process.env,
  LITESTREAM_BIN:        litestream,
  AWS_ACCESS_KEY_ID:     'drive',
  AWS_SECRET_ACCESS_KEY: 'drive',
  AWS_REGION:            'us-east-1',
  AWS_ENDPOINT_URL_S3:   S3,
}

// Every path the schema resolves, moved under one root: `main` and `audit`
// through the env vars they declare, the tenancy block through its flags.
const at = (root) => ({
  env:   { ...env, SHOP_DB_PATH: join(root, 'shop.db'), AUDIT_PATH: join(root, 'audit') + '/' },
  flags: ['--dir', join(root, 'shops'), '--registry', join(root, 'shops-registry.db')],
})

const litestone = (root, ...args) => litestoneWith({}, root, ...args)
const litestoneWith = (extra, root, ...args) => {
  const { env, flags } = at(root)
  const r = spawnSync('litestone', [...args, ...flags], { cwd: DB_DIR, env: { ...env, ...extra }, encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '') }
}

const bucketKeys = async () => {
  const xml = await (await fetch(`${S3}/${BUCKET}?list-type=2&prefix=example/`)).text()
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1])
}

// Every table's rows, order-free. Litestream's own bookkeeping is excluded: it
// is written to the source and is not part of what the app stored.
const fingerprint = (path) => {
  const db = new Database(path, { readonly: true })
  try {
    const tables = db.query(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' ORDER BY name`).all()
    const out = {}
    for (const { name } of tables)
      out[name] = db.query(`SELECT * FROM "${name}"`).all().map(r => JSON.stringify(r)).sort().join('\n')
    return out
  } finally { db.close() }
}
const sameContent = (a, b) => existsSync(b) && JSON.stringify(fingerprint(a)) === JSON.stringify(fingerprint(b))

const copyOf = (from, to) => {
  const db = new Database(from, { readonly: true })
  try { db.run(`VACUUM INTO ?`, [to]) } finally { db.close() }
  const out = new Database(to)
  out.run('PRAGMA journal_mode = WAL')
  out.close()
}

const marks = (shopFile) => {
  if (!existsSync(shopFile)) return []
  const db = new Database(shopFile, { readonly: true })
  try { return db.query(`SELECT name FROM color WHERE name LIKE 'drive-%'`).all().map(r => r.name) }
  finally { db.close() }
}
const writeMarker = (id, mark) => {
  const db = new Database(join(live, 'shops', `${id}.db`))
  db.run(`INSERT INTO color (name, hex) VALUES (?, ?)`, [mark, '#000000'])
  db.close()
}
// A refused restore leaves no database behind — not even a staged one.
const noDatabases = (root) => !existsSync(root)
  || readdirSync(root, { recursive: true }).every(f => !/\.db(\.restoring)?$/.test(String(f)))

// ─── Drive ────────────────────────────────────────────────────────────────

const { got, t } = results()
let replicator   = null
let stoppedEarly = null

try {
  const run = spawnSync('docker', ['run', '-d', '--rm', '--name', CONTAINER,
    '-p', `127.0.0.1:${S3_PORT}:8333`, S3_IMAGE, 'server', '-s3', '-dir=/data'], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`docker run: ${run.stderr.trim()}`)
  // The gateway answers before it accepts a bucket, so the create is the poll.
  let made = null
  for (let i = 0; i < 60 && !made?.ok; i++) {
    made = await fetch(`${S3}/${BUCKET}`, { method: 'PUT' }).catch(() => null)
    if (!made?.ok) await sleep(500)
  }
  if (!made?.ok) throw new Error(`bucket create answered ${made?.status ?? 'nothing'}`)

  mkdirSync(join(live, 'shops'), { recursive: true })
  copyOf(seededShop, join(live, 'shops', 'flagship.db'))
  copyOf(join(DB_DIR, 'shops-registry.db'), join(live, 'shops-registry.db'))
  copyOf(join(DB_DIR, 'shop.db'), join(live, 'shop.db'))
  if (existsSync(join(DB_DIR, 'audit'))) cpSync(join(DB_DIR, 'audit'), join(live, 'audit'), { recursive: true })

  // One `@secret` value, sealed under KEY through the app's own client, so the
  // verify has something only the right key can read.
  const tenants = await createTenantRegistry({
    path: join(DB_DIR, 'schema.lite'), dir: join(live, 'shops'), registry: join(live, 'shops-registry.db'),
    encryptionKey: KEY, clientOptions: { databases: { audit: { path: join(live, 'audit') + '/' } } },
  })
  try {
    const shop  = (await tenants.get('flagship')).asSystem()
    const first = await shop.credential.findFirst({ select: { id: true } })
    await shop.credential.update({ where: { id: first.id }, data: { accessToken: 'drive-sealed' } })
  } finally { tenants.close() }

  // ─── replicate ──────────────────────────────────────────────────────────

  replicator = spawn('litestone', ['replicate', '--url', REPLICA, ...at(live).flags],
    { cwd: DB_DIR, env: at(live).env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  replicator.stdout.on('data', d => { log += d })
  replicator.stderr.on('data', d => { log += d })

  const has = (keys, prefix) => keys.some(k => k.startsWith(`example/${prefix}`))
  const waitFor = async (prefixes) => {
    for (let i = 0; i < 60; i++) {
      const keys = await bucketKeys()
      if (prefixes.every(p => has(keys, p))) return keys
      await sleep(500)
    }
    return bucketKeys()
  }

  let keys = await waitFor(['main/', 'tenant-files/flagship.db/', 'tenant-registry/shops-registry.db/'])
  t('replicate.coversMain',            has(keys, 'main/'))
  t('replicate.coversEveryTenantFile', has(keys, 'tenant-files/flagship.db/'))
  t('replicate.coversTheRegistry',     has(keys, 'tenant-registry/shops-registry.db/'))

  // A shop that signs up while the replicator is running, through the same
  // command an operator would type, and a write into it.
  const created = litestone(live, 'tenant', 'create', 'latecomer')
  t('tenant.createSucceeds', created.code === 0)
  if (created.code !== 0) console.log(created.out)
  writeMarker('latecomer', 'drive-late')
  writeMarker('flagship', 'drive-mid')

  keys = await waitFor(['tenant-files/latecomer.db/'])
  t('replicate.coversATenantCreatedMidRun', has(keys, 'tenant-files/latecomer.db/'))

  // `between` falls after drive-mid has synced and before drive-at-stop exists.
  await sleep(3000)
  const between = new Date().toISOString()
  await sleep(1500)
  writeMarker('flagship', 'drive-at-stop')
  replicator.kill('SIGINT')
  await new Promise(done => replicator.on('exit', done))
  replicator = null
  // litestream ignores a misplaced l0-retention without a word, so the window
  // is read off what it says it started with.
  t('replicate.timeTravelWindowIsTheDeclaredOne', /L0 retention monitor.*retention=24h0m0s/.test(log))

  // ─── backup: the audit trail's only way back ────────────────────────────

  const bk = litestone(live, 'backup', dest)
  t('backup.succeeds', bk.code === 0)
  if (bk.code !== 0) console.log(bk.out)
  const bkMatches = (from, to) => sameContent(join(live, from), join(dest, to))
  t('backup.coversEveryTenantFile', bkMatches('shops/flagship.db', 'tenant-files/flagship.db')
                                 && bkMatches('shops/latecomer.db', 'tenant-files/latecomer.db'))
  t('backup.coversTheRegistry',     bkMatches('shops-registry.db', 'tenant-registry/shops-registry.db'))

  // ─── restore onto an empty disk ─────────────────────────────────────────

  const nothing = join(scratch, 'nothing')
  const nr = litestone(nothing, 'restore', '--url', `${REPLICA}-nothing-here`, '--from-backup', dest)
  t('refuses.aReplicaWithNothingInIt', nr.code !== 0 && noDatabases(nothing))

  const back = join(scratch, 'restored')
  const rs = litestone(back, 'restore', '--url', REPLICA, '--from-backup', dest)
  t('restore.succeeds', rs.code === 0)
  if (rs.code !== 0) console.log(rs.out)

  const matches = (rel) => sameContent(join(live, rel), join(back, rel))
  t('restore.mainMatches',      matches('shop.db'))
  t('restore.registryMatches',  matches('shops-registry.db'))
  t('restore.flagshipMatches',  matches('shops/flagship.db'))
  t('restore.latecomerMatches', matches('shops/latecomer.db'))
  const trail = (root) => existsSync(join(root, 'audit', 'auditLogs.jsonl')) ? readFileSync(join(root, 'audit', 'auditLogs.jsonl'), 'utf8') : null
  t('restore.auditTrailFromBackup', trail(live) !== null && trail(back) === trail(live))

  const listed = litestone(back, 'tenant', 'list').out
  t('restore.appListsEveryTenant', ['flagship', 'latecomer'].every(id => new RegExp(`^\\s+${id}\\b`, 'm').test(listed)))

  const restoredMarks = marks(join(back, 'shops', 'flagship.db'))
  t('restore.carriesAWriteMadeMidRun', restoredMarks.includes('drive-mid'))
  t('stop.flushesTheLastWrite',        restoredMarks.includes('drive-at-stop'))

  // ─── refusals: each writes nothing ──────────────────────────────────────

  const before = JSON.stringify(fingerprint(join(back, 'shops', 'flagship.db')))
  const again = litestone(back, 'restore', '--url', REPLICA, '--from-backup', dest)
  t('refuses.overExistingFiles', again.code !== 0 && /--force/.test(again.out)
    && JSON.stringify(fingerprint(join(back, 'shops', 'flagship.db'))) === before)

  const forced = litestone(back, 'restore', '--url', REPLICA, '--from-backup', dest, '--force')
  t('restore.forceReplaces', forced.code === 0 && matches('shops/flagship.db'))
  if (forced.code !== 0) console.log(forced.out)

  const noTrail = join(scratch, 'no-trail')
  const nt = litestone(noTrail, 'restore', '--url', REPLICA)
  t('refuses.aLoggerWithNoBackup', nt.code !== 0 && /--from-backup/.test(nt.out) && noDatabases(noTrail))

  // ─── --at ───────────────────────────────────────────────────────────────
  //
  // Before the refusal below deletes latecomer's replica: an instant names
  // every file, so a missing one refuses the whole set.

  const then = join(scratch, 'then')
  const pit = litestone(then, 'restore', '--url', REPLICA, '--from-backup', dest, '--at', between)
  if (pit.code !== 0) console.log(pit.out)
  const thenMarks = marks(join(then, 'shops', 'flagship.db'))
  t('at.bringsBackTheEarlierWrite', thenMarks.includes('drive-mid'))
  t('at.leavesOutTheLaterOne',      pit.code === 0 && !thenMarks.includes('drive-at-stop'))

  // ─── --verify ───────────────────────────────────────────────────────────
  //
  // `root` names where the LIVE paths would resolve; nothing may appear there.

  const untouched = join(scratch, 'live-paths')
  const verify = (extra, into) => litestoneWith(extra, untouched, 'restore', '--url', REPLICA, '--from-backup', dest, '--verify', into)

  // No key and nothing said: a cron line that lost its environment. Refused
  // before anything is fetched.
  const unstated = verify(NO_KEY, join(scratch, 'v-unstated'))
  t('verify.refusesAMissingKeyNobodyStated', unstated.code !== 0 && /--without-key/.test(unstated.out) && !existsSync(join(scratch, 'v-unstated')))

  const keyless = litestoneWith(NO_KEY, untouched, 'restore', '--url', REPLICA, '--from-backup', dest, '--verify', join(scratch, 'v-keyless'), '--without-key')
  t('verify.passesWithoutTheKey',        keyless.code === 0 && !existsSync(join(scratch, 'v-keyless')))
  t('verify.namesWhatItCouldNotRead',    /NOT checked/.test(keyless.out) && /Credential\.accessToken/.test(keyless.out))
  if (keyless.code !== 0) console.log(keyless.out)

  const keyed = verify({ ENCRYPTION_KEY: KEY }, join(scratch, 'v-keyed'))
  t('verify.passesWithTheKey',           keyed.code === 0 && !/NOT checked/.test(keyed.out))
  if (keyed.code !== 0) console.log(keyed.out)

  const wrong = verify({ ENCRYPTION_KEY: 'd'.repeat(64) }, join(scratch, 'v-wrong'))
  t('verify.failsUnderAnotherKey',       wrong.code !== 0 && /Credential/.test(wrong.out) && /decrypt/i.test(wrong.out))
  t('verify.keepsTheCopyThatFailed',     existsSync(join(scratch, 'v-wrong', 'tenant-files', 'flagship.db')))
  t('verify.refusesADirectoryInUse',     verify({ ENCRYPTION_KEY: KEY }, join(scratch, 'v-wrong')).code !== 0)
  t('verify.touchesNoLivePath',          !existsSync(untouched))

  for (const k of (await bucketKeys()).filter(k => k.startsWith('example/tenant-files/latecomer.db/')))
    await fetch(`${S3}/${BUCKET}/${k}`, { method: 'DELETE' })
  const partial = join(scratch, 'partial')
  const pt = litestone(partial, 'restore', '--url', REPLICA, '--from-backup', dest)
  t('refuses.aTenantWhoseReplicaIsGone', pt.code !== 0 && /latecomer/.test(pt.out) && noDatabases(partial))

  if (Object.values(got).includes(false)) console.log(log.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(0, 40).join('\n'))
} catch (e) {
  stoppedEarly = e
  console.error(e)
} finally {
  replicator?.kill('SIGKILL')
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
  rmSync(scratch, { recursive: true, force: true })
  // The CLI writes its generated litestream config under the schema's directory
  // and removes the file on exit, not the directory.
  try { rmdirSync(join(DB_DIR, '.litestone')) } catch {}
}

// ─── Report ───────────────────────────────────────────────────────────────

const expected = {
  'replicate.coversMain':                  true,
  'replicate.coversEveryTenantFile':       true,
  'replicate.coversTheRegistry':           true,
  'tenant.createSucceeds':                 true,
  'replicate.coversATenantCreatedMidRun':  true,
  'replicate.timeTravelWindowIsTheDeclaredOne': true,
  'backup.succeeds':                       true,
  'backup.coversEveryTenantFile':          true,
  'backup.coversTheRegistry':              true,
  'refuses.aReplicaWithNothingInIt':       true,
  'restore.succeeds':                      true,
  'restore.mainMatches':                   true,
  'restore.registryMatches':               true,
  'restore.flagshipMatches':               true,
  'restore.latecomerMatches':              true,
  'restore.auditTrailFromBackup':          true,
  'restore.appListsEveryTenant':           true,
  'restore.carriesAWriteMadeMidRun':       true,
  'stop.flushesTheLastWrite':              true,
  'refuses.overExistingFiles':             true,
  'restore.forceReplaces':                 true,
  'refuses.aLoggerWithNoBackup':           true,
  'at.bringsBackTheEarlierWrite':          true,
  'at.leavesOutTheLaterOne':               true,
  'verify.refusesAMissingKeyNobodyStated': true,
  'verify.passesWithoutTheKey':            true,
  'verify.namesWhatItCouldNotRead':        true,
  'verify.passesWithTheKey':               true,
  'verify.failsUnderAnotherKey':           true,
  'verify.keepsTheCopyThatFailed':         true,
  'verify.refusesADirectoryInUse':         true,
  'verify.touchesNoLivePath':              true,
  'refuses.aTenantWhoseReplicaIsGone':     true,
}

process.exit(report(got, expected, { stoppedEarly }) ? 1 : 0)
