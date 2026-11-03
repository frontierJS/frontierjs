/*
 * backup-run.test.ts — what a backup archive holds (FJS-1766).
 *
 * `VACUUM INTO` over the main database copied one file of three. The schema
 * declares `database audit` (a second SQLite file) and the app opens a
 * second SQLite file for the job queue, so an archive restored from the old job
 * had every row and none of the audit trail or the pending jobs.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { Database }          from 'bun:sqlite'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir }          from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createTestEnv }     from '@frontierjs/testing'
import { GatePlugin }        from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { takeBackup, queueBackup, failStaleBackups, checkStaged, STALE_AFTER_MS } from '../src/jobs/backup-run.job.ts'
import { placeHub, lastBackupAt } from '../src/domain/host/host-machine.ts'
import { registerDestination } from '../src/providers/storage/index.ts'
import { deleteArchive, isForeign, pruneBackups, rescanDestination } from '../src/domain/backup/backup-archives.ts'
import { archiveRefusals, MANIFEST_FILE, sha256Of } from '../src/domain/backup/archive-manifest.ts'
import { drillHubArchive } from '../src/domain/backup/archive-drill.ts'
import { verifyHubBackup } from '../src/jobs/backup-verify.job.ts'
import { encryptionKeyFingerprint, jobsDatabasePath } from '../src/core/db.ts'
import { fetchHubArchive, listHubArchives, readBucket, restoreStaged, stageHubArchive, stagedDir } from '../src/domain/backup/hub-restore.ts'

let env: any
let hubId: string

beforeAll(async () => {
  env = await createTestEnv({
    schema:        join(import.meta.dir, '..', '..', 'db', 'schema.lite'),
    migrations:    join(import.meta.dir, '..', '..', 'db', 'migrations'),
    encryptionKey: '0'.repeat(64),
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  // A hub archive is an AppBackup on the hub App (`FJS-D1606`).
  const sys  = env.system as any
  await sys.user.create({ data: { email: 'hub-owner@example.com' } })
  const acct = await sys.account.create({ data: { slug: 'hub-acct', displayName: 'Hub' } })
  const ws   = await sys.workspace.create({ data: { accountId: acct.id, name: 'Hub', slug: 'hub-ws' } })
  const box  = await sys.server.create({ data: { workspaceId: ws.id, name: 'Basecamp host', slug: 'basecamp-host' } })
  await sys.hubConfig.create({ data: { id: 'hub' } })
  hubId = (await placeHub(sys, box)).id
})

describe('a backup archives every database the app keeps', () => {
  test('main, the audit trail and the jobs queue are all in the archive', async () => {
    const sys = env.system as any
    const row = await sys.appBackup.create({ data: { appId: hubId } })

    // The trail's directory is made by its first write, which lands after the
    // create returns. An archive taken before then has no trail to hold.
    const trail = env.app.db.$databases.audit.path as string
    for (let i = 0; i < 100 && !existsSync(trail); i++) await Bun.sleep(20)
    expect(existsSync(trail)).toBe(true)

    await takeBackup(env.app, row.id)

    const done = await sys.appBackup.findUnique({ where: { id: row.id } })
    expect(done.error).toBeNull()
    expect(done.status).toBe('success')

    const dir = done.location as string
    expect(statSync(dir).isDirectory()).toBe(true)
    expect(existsSync(join(dir, 'main.db'))).toBe(true)
    expect(existsSync(join(dir, 'jobs.db'))).toBe(true)
    expect(existsSync(join(dir, 'audit.db'))).toBe(true)

    // The archive opens and carries the row it was asked about.
    const copy = new Database(join(dir, 'main.db'), { readonly: true })
    try {
      expect(copy.query('SELECT id FROM app_backup WHERE id = ?').get(row.id)).toBeTruthy()
    } finally { copy.close() }

    // sizeBytes is the whole archive, not the largest file.
    const total = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile()).reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0)
    expect(done.sizeBytes).toBe(total)
  })
})

// FJS-2358: the declared SQLite files go through the framework's own backup,
// which stamps the copy as a backup (FJS-D665) — a hand-run VACUUM INTO does not.
describe('the archive is the framework\'s backup', () => {
  test('main.db carries the backup stamp', async () => {
    const sys = env.system as any
    const row = await sys.appBackup.create({ data: { appId: hubId } })
    await takeBackup(env.app, row.id)
    const done = await sys.appBackup.findUnique({ where: { id: row.id } })
    expect(done.status).toBe('success')

    const copy = new Database(join(done.location as string, 'main.db'), { readonly: true })
    try {
      expect(copy.query('SELECT value FROM "_litestone_meta" WHERE key LIKE ?').get('%taken%')).toBeTruthy()
    } finally { copy.close() }
  })
})

// ─── The manifest a restore checks first (IDEAS/backups.md 4.3) ────────────
// Each refusal is made on a copy of a real archive, because the check reads
// the staged databases' own migration history and a hand-built one would
// grade what the test assumed rather than what `backup:run` wrote.

describe('an archive carries a manifest, and a restore refuses what it cannot continue', () => {
  const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
  let archive: string

  beforeAll(async () => {
    const sys = env.system as any
    const row = await sys.appBackup.create({ data: { appId: hubId } })
    await takeBackup(env.app, row.id)
    archive = (await sys.appBackup.findUnique({ where: { id: row.id } })).location
  })

  const staged = () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bc-manifest-')), 'staged')
    cpSync(archive, dir, { recursive: true })
    return dir
  }

  test('it lists every other file with its sha256, and the archive as written passes', async () => {
    const manifest = JSON.parse(readFileSync(join(archive, MANIFEST_FILE), 'utf8'))
    const onDisk   = readdirSync(archive, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile() && e.name !== MANIFEST_FILE).length
    expect(manifest.files.map((f: any) => f.path)).toEqual(expect.arrayContaining(['main.db', 'jobs.db', 'audit.db']))
    expect(manifest.files.length).toBe(onDisk)
    for (const f of manifest.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.encryptionKeyFingerprint).toBe(encryptionKeyFingerprint())
    expect(manifest.basecamp).toMatch(/^\d+\.\d+\.\d+/)

    expect(await archiveRefusals(staged(), { migrationsRoot: MIGRATIONS })).toEqual([])
  })

  test('a different key is refused by name', async () => {
    const [reason] = await archiveRefusals(staged(), { migrationsRoot: MIGRATIONS, keyFingerprint: 'ab'.repeat(32) })
    expect(reason).toContain('set ENCRYPTION_KEY')
  })

  test('a file changed since it was listed is damage, and nothing else is graded', async () => {
    const dir = staged()
    appendFileSync(join(dir, 'jobs.db'), 'x')
    expect(await archiveRefusals(dir, { migrationsRoot: MIGRATIONS })).toEqual(['jobs.db does not match its sha256; the archive is damaged.'])
  })

  test('no manifest, or one naming a path outside the archive, is refused', async () => {
    const bare = staged()
    Bun.spawnSync(['rm', join(bare, MANIFEST_FILE)])
    expect((await archiveRefusals(bare, { migrationsRoot: MIGRATIONS }))[0]).toContain(`no ${MANIFEST_FILE}`)

    const out = staged()
    const m   = JSON.parse(readFileSync(join(out, MANIFEST_FILE), 'utf8'))
    m.files.push({ path: '../../etc/passwd', bytes: 0, sha256: '' })
    writeFileSync(join(out, MANIFEST_FILE), JSON.stringify(m))
    expect(await archiveRefusals(out, { migrationsRoot: MIGRATIONS })).toEqual([`${MANIFEST_FILE} names ../../etc/passwd, outside the archive.`])
  })

  // The history is edited and the manifest re-hashed to match, so the
  // migration grade is reached and is the only thing refusing.
  const rewrite = async (dir: string, sql: string) => {
    const db = new Database(join(dir, 'main.db'))
    try { db.run(sql) } finally { db.close() }
    const m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))
    const f = m.files.find((x: any) => x.path === 'main.db')
    f.bytes  = statSync(join(dir, 'main.db')).size
    f.sha256 = new Bun.CryptoHasher('sha256').update(readFileSync(join(dir, 'main.db'))).digest('hex')
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(m))
  }

  test('an archive from a newer Basecamp, one migration this code lacks, is refused', async () => {
    const dir = staged()
    await rewrite(dir, `INSERT INTO "_litestone_migrations" (name, applied_at, checksum) VALUES ('29990101000000_later.sql', '2999-01-01', 'f')`)
    const reasons = await archiveRefusals(dir, { migrationsRoot: MIGRATIONS })
    expect(reasons).toEqual(['main.db applied 29990101000000_later.sql, which this Basecamp does not have; the archive is from a newer version.'])
  })

  test('a migration rewritten in place since the archive was taken is refused', async () => {
    const dir = staged()
    await rewrite(dir, `UPDATE "_litestone_migrations" SET checksum = 'stale' WHERE name LIKE '%initial_schema%'`)
    const [reason] = await archiveRefusals(dir, { migrationsRoot: MIGRATIONS })
    expect(reason).toContain('before it was rewritten')
  })

  test('a migration this code has and the archive has not is left to boot', async () => {
    const dir = staged()
    await rewrite(dir, `DELETE FROM "_litestone_migrations"`)
    expect(await archiveRefusals(dir, { migrationsRoot: MIGRATIONS })).toEqual([])
  })
})

// ─── Restoring a hub at /setup (IDEAS/backups.md 4.4) ───────────────────────
// A real archive, tarred the way backup:run uploads it, staged into a scratch
// database directory and swapped in by the real litestone CLI. The live file
// is a fresh migrated database with no account, as a new box's is.

describe('a hub archive is staged at /setup and swapped in at the next boot', () => {
  const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
  let archive: string, tarball: string
  const log = { info() {}, error() {} }

  beforeAll(async () => {
    const sys = env.system as any
    const row = await sys.appBackup.create({ data: { appId: hubId } })
    await takeBackup(env.app, row.id)
    archive = (await sys.appBackup.findUnique({ where: { id: row.id } })).location
    tarball = join(mkdtempSync(join(tmpdir(), 'bc-hubtar-')), `${basename(archive)}.tar.gz`)
    Bun.spawnSync(['tar', '-czf', tarball, '-C', dirname(archive), basename(archive)])
  })

  /** A box that has booted once: a migrated main.db, no account, its own audit path. */
  const freshBox = () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-hubbox-'))
    const db  = new Database(join(dir, 'basecamp.db'))
    db.run('CREATE TABLE account (id TEXT)')
    db.close()
    return { dbPath: join(dir, 'basecamp.db'), audit: join(dir, 'audit.db') }
  }
  const withAudit = async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
    const was = process.env.AUDIT_PATH
    process.env.AUDIT_PATH = path
    try { return await fn() } finally { if (was === undefined) delete process.env.AUDIT_PATH; else process.env.AUDIT_PATH = was }
  }

  test('a good archive is staged beside the live database, and boot swaps it in once', async () => {
    const box = freshBox()
    const staged = await stageHubArchive(tarball, box.dbPath, { migrationsRoot: MIGRATIONS })
    expect(staged).toEqual({ takenAt: expect.stringMatching(/^\d{4}-/) })
    expect(existsSync(join(stagedDir(box.dbPath), 'main.db'))).toBe(true)
    expect(readdirSync(dirname(box.dbPath)).filter(f => f.startsWith('.restore'))).toEqual([])

    const done = await withAudit(box.audit, () => restoreStaged(box.dbPath, log))
    expect(done).toEqual({ state: 'done', takenAt: (staged as any).takenAt })
    expect(existsSync(stagedDir(box.dbPath))).toBe(false)
    expect(readdirSync(dirname(box.dbPath)).some(f => f.startsWith('restore-done-'))).toBe(true)
    // The restored file is the archive's: it carries the backup row this suite wrote.
    const raw = new Database(box.dbPath, { readonly: true })
    try { expect((raw.query('SELECT count(*) AS n FROM app_backup').get() as any).n).toBeGreaterThan(0) } finally { raw.close() }
    expect(existsSync(box.audit)).toBe(true)
    // No schema names the queue, so the swap leaves it: a restored hub starts with none.
    expect(readdirSync(dirname(box.dbPath)).filter(f => f.includes('jobs'))).toEqual([])

    expect(await withAudit(box.audit, () => restoreStaged(box.dbPath, log))).toBeNull()
  })

  test('a staged archive beside a hub with an account is refused and left in place', async () => {
    const box = freshBox()
    await stageHubArchive(tarball, box.dbPath, { migrationsRoot: MIGRATIONS })
    const db = new Database(box.dbPath)
    db.run(`INSERT INTO account (id) VALUES ('live')`)
    db.close()

    const r = await withAudit(box.audit, () => restoreStaged(box.dbPath, log))
    expect(r?.state).toBe('refused')
    expect(existsSync(join(stagedDir(box.dbPath), 'main.db'))).toBe(true)
    const raw = new Database(box.dbPath, { readonly: true })
    try { expect(raw.query('SELECT id FROM account').all()).toEqual([{ id: 'live' }]) } finally { raw.close() }
  })

  test('a crash between the swap and the rename is finished at the next boot, not refused (FJS-3901)', async () => {
    const box = freshBox()
    await stageHubArchive(tarball, box.dbPath, { migrationsRoot: MIGRATIONS })
    // The swap happened: the live file is the archive's own bytes, and the
    // staged directory is still there because the rename did not.
    cpSync(join(stagedDir(box.dbPath), 'main.db'), box.dbPath)

    const r = await withAudit(box.audit, () => restoreStaged(box.dbPath, log))
    expect(r?.state).toBe('done')
    expect(existsSync(stagedDir(box.dbPath))).toBe(false)
    expect(readdirSync(dirname(box.dbPath)).some(f => f.startsWith('restore-done-'))).toBe(true)
  })

  test('a live file that cannot be read counts as a hub, so --force never runs over it', async () => {
    const box = freshBox()
    await stageHubArchive(tarball, box.dbPath, { migrationsRoot: MIGRATIONS })
    writeFileSync(box.dbPath, 'not a database, and not nothing')
    const r = await withAudit(box.audit, () => restoreStaged(box.dbPath, log))
    expect(r?.state).toBe('refused')
    expect(readFileSync(box.dbPath, 'utf8')).toBe('not a database, and not nothing')
    expect(existsSync(stagedDir(box.dbPath))).toBe(true)
  })

  test('what is not an archive, or does not pass its manifest, is refused with nothing staged', async () => {
    const box = freshBox()
    const junk = join(dirname(box.dbPath), 'junk.tar.gz')
    writeFileSync(junk, 'not a tarball')
    expect((await stageHubArchive(junk, box.dbPath, { migrationsRoot: MIGRATIONS }) as any).refused[0]).toContain('not a gzipped tar')

    const src = mkdtempSync(join(tmpdir(), 'bc-hubodd-'))
    mkdirSync(join(src, 'elsewhere'))
    const wrongTop = join(src, 'wrong.tar.gz')
    Bun.spawnSync(['tar', '-czf', wrongTop, '-C', src, 'elsewhere'])
    expect((await stageHubArchive(wrongTop, box.dbPath, { migrationsRoot: MIGRATIONS }) as any).refused[0]).toContain('holds elsewhere')

    const linked = join(src, basename(archive))
    cpSync(archive, linked, { recursive: true })
    Bun.spawnSync(['ln', '-s', '/etc/passwd', join(linked, 'main.db-extra')])
    const linkedTar = join(src, 'linked.tar.gz')
    Bun.spawnSync(['tar', '-czf', linkedTar, '-C', src, basename(archive)])
    expect((await stageHubArchive(linkedTar, box.dbPath, { migrationsRoot: MIGRATIONS }) as any).refused[0]).toContain('not a plain file')

    appendFileSync(join(linked, 'jobs.db'), 'x')
    Bun.spawnSync(['rm', join(linked, 'main.db-extra')])
    const damagedTar = join(src, 'damaged.tar.gz')
    Bun.spawnSync(['tar', '-czf', damagedTar, '-C', src, basename(archive)])
    expect((await stageHubArchive(damagedTar, box.dbPath, { migrationsRoot: MIGRATIONS }) as any).refused)
      .toEqual(['jobs.db does not match its sha256; the archive is damaged.'])

    expect(existsSync(stagedDir(box.dbPath))).toBe(false)
    expect(readdirSync(dirname(box.dbPath)).filter(f => f.startsWith('.restore'))).toEqual([])
  })

  test('the bucket is listed and fetched over pre-signed URLs, keeping only hub archive names', async () => {
    const asked: string[] = []
    const server = Bun.serve({ port: 0, async fetch(req) {
      const url = new URL(req.url)
      asked.push(url.pathname + url.search)
      if (!url.searchParams.get('X-Amz-Signature')) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
      if (url.searchParams.get('list-type') === '2') return new Response(
        `<ListBucketResult><IsTruncated>false</IsTruncated>` +
        `<Contents><Key>hub/${basename(archive)}.tar.gz</Key><Size>${statSync(tarball).size}</Size></Contents>` +
        `<Contents><Key>hub/basecamp-2020-01-01T00-00-00-000Z.tar.gz</Key><Size>1</Size></Contents>` +
        `<Contents><Key>hub/someone-else.tar.gz</Key><Size>1</Size></Contents>` +
        `</ListBucketResult>`, { headers: { 'content-type': 'application/xml' } })
      return new Response(Bun.file(tarball))
    } })
    try {
      const bucket = readBucket({ endpoint: `http://127.0.0.1:${server.port}`, region: 'us-west-000', bucket: 'b', prefix: 'hub', key: 'id:secret' }) as any
      const listed = await listHubArchives(bucket) as any
      expect(listed.archives.map((a: any) => a.name)).toEqual([basename(archive), 'basecamp-2020-01-01T00-00-00-000Z'])
      expect(asked[0]).toContain('prefix=hub%2Fbasecamp-')

      const to = join(mkdtempSync(join(tmpdir(), 'bc-hubget-')), 'a.tar.gz')
      expect(await fetchHubArchive(bucket, listed.archives[0].key, to)).toBeNull()
      expect(statSync(to).size).toBe(statSync(tarball).size)

      expect(readBucket({ endpoint: 'ftp://x', bucket: 'b', key: 'a:b' })).toEqual({ error: expect.stringContaining('endpoint') })
      expect(readBucket({ endpoint: 'http://x', bucket: 'b', key: 'nocolon' })).toEqual({ error: expect.stringContaining('accessKeyId') })
    } finally { server.stop(true) }
  })

  test('POST /setup/restore is closed once an account exists', async () => {
    const sys = env.system as any
    if (!await sys.account.count())
      await sys.account.create({ data: { slug: `restore-${Date.now()}`, displayName: 'Live' } })
    const res = await env.http.post('/setup/restore/archives').send({})
    expect(res.status).toBe(409)
  })
})

// ─── Leaving the box (IDEAS/backups.md 1.2) ─────────────────────────────────
// An S3 stand-in on a local port, reached through the app's own conduit and
// signer, so the request is what B2 would be sent.

describe('a backup naming a destination is uploaded, and a failed upload keeps the local copy', () => {
  const puts: { path: string; auth: string; bytes: number }[] = []
  let refuse = false
  let server: ReturnType<typeof Bun.serve>
  let destinationId: string

  beforeAll(async () => {
    server = Bun.serve({ port: 0, async fetch(req) {
      if (refuse) return new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 })
      const body = new Uint8Array(await req.arrayBuffer())
      // The archive goes by a pre-signed URL (the credential is in the query);
      // the claim marker goes through conduit (the credential is a header).
      const url = new URL(req.url)
      puts.push({ path: url.pathname, auth: req.headers.get('authorization') ?? url.searchParams.get('X-Amz-Credential') ?? '', bytes: body.length })
      return new Response(null, { headers: { etag: '"stand-in"' } })
    } })

    const sys  = env.system as any
    const uniq = Math.random().toString(36).slice(2, 8)
    const acct = await sys.account.create({ data: { slug: `bk-${uniq}`, displayName: 'Backups' } })
    await sys.user.create({ data: { email: `bk-${uniq}@example.com` } })
    const ws   = await sys.workspace.create({ data: { accountId: acct.id, name: 'Backups', slug: `bk-${uniq}` } })
    const key  = await sys.secret.create({ data: {
      workspaceId: ws.id, name: 'backup-stand-in', kind: 'backup', data: 'keyid:applicationkey',
    } })
    const dest = await sys.backupDestination.create({ data: {
      workspaceId: ws.id, name: 'Stand-in', endpoint: `http://127.0.0.1:${server.port}`,
      region: 'us-west-000', bucket: 'frontier-basecamp', prefix: 'basecamp-', secretId: key.id,
    } })
    destinationId = dest.id
    await registerDestination(env.app, dest)
  })

  afterAll(() => server?.stop(true))

  const localOf = (key: string) => join(dirname(env.app.sqlite.filename), 'backups', basename(key, '.tar.gz'))
  const run = async () => {
    const sys = env.system as any
    const row = await sys.appBackup.create({ data: { appId: hubId, destinationId } })
    await takeBackup(env.app, row.id)
    return sys.appBackup.findUnique({ where: { id: row.id } })
  }

  test('one signed PUT of a tarball under the prefix; the row names the key and the newest stays on disk', async () => {
    const done = await run()
    expect(done.error).toBeNull()
    expect(done.status).toBe('success')
    expect(done.location).toMatch(/^basecamp-\/basecamp-.+\.tar\.gz$/)
    const archives = puts.filter(p => p.path.endsWith('.tar.gz'))
    expect(archives.length).toBe(1)
    expect(archives[0].path).toBe(`/frontier-basecamp/${done.location}`)
    expect(archives[0].auth).toStartWith('keyid/')
    expect(done.sizeBytes).toBe(archives[0].bytes)
    expect(done.sha256).toHaveLength(64)

    // The key carries this install's id, and the prefix is claimed once.
    const installId = (await (env.system as any).hubConfig.findFirst({ where: { id: 'hub' } })).installId
    expect(done.location).toStartWith(`basecamp-/basecamp-${installId}-`)
    const claims = puts.filter(p => p.path.includes('basecamp-claim-'))
    expect(claims.map(c => c.path)).toEqual([`/frontier-basecamp/basecamp-/basecamp-claim-${installId}`])
    expect(claims[0].auth).toStartWith('AWS4-HMAC-SHA256 Credential=keyid/')

    expect(existsSync(join(localOf(done.location), 'main.db'))).toBe(true)
    expect(existsSync(`${localOf(done.location)}.tar.gz`)).toBe(false)
  })

  test('the next backup replaces the local copy of an uploaded one', async () => {
    const first  = await (env.system as any).appBackup.findFirst({ where: { destinationId, error: null }, orderBy: { createdAt: 'desc' } })
    const second = await run()
    expect(second.error).toBeNull()
    expect(existsSync(localOf(first.location))).toBe(false)
    expect(existsSync(localOf(second.location))).toBe(true)
  })

  test('a refused PUT finishes success with the reason in error, and the archive stays on this disk', async () => {
    const uploaded = await (env.system as any).appBackup.findFirst({ where: { destinationId, error: null }, orderBy: { createdAt: 'desc' } })
    refuse = true
    const done = await run()
    refuse = false

    expect(done.status).toBe('success')
    // FJS-3846: a kept-local result is not a backup that reached its destination.
    expect(await lastBackupAt(env.system, hubId)).not.toBe(done.finishedAt)
    expect(done.error).toContain('403')
    expect(done.error).toContain('AccessDenied')
    expect(existsSync(join(done.location, 'main.db'))).toBe(true)
    expect(existsSync(`${done.location}.tar.gz`)).toBe(false)
    // The failed one is now the newest on disk, so the uploaded one's goes.
    expect(existsSync(localOf(uploaded.location))).toBe(false)

    // And a failed upload's copy is the only one there is: the next backup keeps it.
    await run()
    expect(existsSync(join(done.location, 'main.db'))).toBe(true)
  })
})

// ─── Retention and rescan (IDEAS/backups.md 1.4) ────────────────────────────
// Rows are planted with archive names and past start times, so the order is
// the stamps' and no test waits on a clock.

describe('retention prunes by count and age, local and remote apart, and a rescan finds what no row names', () => {
  const deletes: string[] = []
  let listing: { key: string; size: number }[] = []
  let server: ReturnType<typeof Bun.serve>
  let dest: any

  const DAY = 86_400_000
  const NOW = Date.parse('2026-06-30T00:00:00.000Z')
  const nameAt = (daysAgo: number) => `basecamp-${new Date(NOW - daysAgo * DAY).toISOString().replace(/[:.]/g, '-')}`
  const dirOf  = (name: string) => join(dirname(env.app.sqlite.filename), 'backups', name)
  const plantLocal = async (daysAgo: number) => {
    const name = nameAt(daysAgo)
    mkdirSync(dirOf(name), { recursive: true })
    writeFileSync(join(dirOf(name), 'main.db'), 'x')
    return (env.system as any).appBackup.create({ data: { appId: hubId,
      status: 'success', location: dirOf(name), startedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    } })
  }
  const plantRemote = (daysAgo: number) => (env.system as any).appBackup.create({ data: { appId: hubId,
    status: 'success', destinationId: dest.id, location: `basecamp-/${nameAt(daysAgo)}.tar.gz`,
    startedAt: new Date(NOW - daysAgo * DAY).toISOString(),
  } })
  const keep = (data: Record<string, unknown>) => (env.system as any).hubConfig.update({ where: { id: 'hub' }, data })
  const esc  = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

  beforeAll(async () => {
    server = Bun.serve({ port: 0, fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'DELETE') { deletes.push(decodeURIComponent(url.pathname)); return new Response(null, { status: 204 }) }
      const prefix = url.searchParams.get('prefix') ?? ''
      const xml = listing.filter(o => o.key.startsWith(prefix)).map(o =>
        `<Contents><Key>${esc(o.key)}</Key><Size>${o.size}</Size><LastModified>2026-06-01T00:00:00.000Z</LastModified></Contents>`).join('')
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${xml}</ListBucketResult>`,
        { headers: { 'content-type': 'application/xml' } })
    } })

    const sys  = env.system as any
    const uniq = Math.random().toString(36).slice(2, 8)
    const acct = await sys.account.create({ data: { slug: `rt-${uniq}`, displayName: 'Retention' } })
    await sys.user.create({ data: { email: `rt-${uniq}@example.com` } })
    const ws   = await sys.workspace.create({ data: { accountId: acct.id, name: 'Retention', slug: `rt-${uniq}` } })
    const key  = await sys.secret.create({ data: { workspaceId: ws.id, name: 'backup-retention', kind: 'backup', data: 'keyid:applicationkey' } })
    dest = await sys.backupDestination.create({ data: {
      workspaceId: ws.id, name: 'Retention', endpoint: `http://127.0.0.1:${server.port}`,
      region: 'us-west-000', bucket: 'frontier-basecamp', prefix: 'basecamp-', secretId: key.id,
    } })
    await registerDestination(env.app, dest)
    if (!await sys.hubConfig.findFirst({ where: { id: 'hub' } }))
      await sys.hubConfig.create({ data: { id: 'hub' } })
  })

  afterAll(() => server?.stop(true))

  test('a keep-count of two leaves the newest two on disk; a file outside backups/ is never reached', async () => {
    const sys = env.system as any
    await sys.appBackup.deleteMany({ where: {} })
    await keep({ backupKeepLocalCount: 2, backupKeepLocalDays: null })
    const rows = [await plantLocal(1), await plantLocal(2), await plantLocal(3), await plantLocal(4)]
    const outside = join(dirname(env.app.sqlite.filename), 'basecamp-2026-01-01T00-00-00-000Z')
    writeFileSync(outside, 'not an archive')
    const odd = await sys.appBackup.create({ data: { appId: hubId, status: 'success', location: outside, startedAt: new Date(NOW - 9 * DAY).toISOString() } })

    const { pruned, kept } = await pruneBackups(env.app, NOW)
    expect(pruned.sort()).toEqual([rows[2].id, rows[3].id, odd.id].sort())
    expect(existsSync(rows[0].location)).toBe(true)
    expect(existsSync(rows[1].location)).toBe(true)
    expect(existsSync(rows[2].location)).toBe(false)
    // Its name is an archive's, so the derived path is backups/<name> — absent;
    // the row goes and the file the column names is untouched.
    expect(kept).toEqual([])
    expect(existsSync(outside)).toBe(true)
  })

  test('an age limit prunes inside the count, and never the newest archive', async () => {
    const sys = env.system as any
    await sys.appBackup.deleteMany({ where: {} })
    await keep({ backupKeepLocalCount: 10, backupKeepLocalDays: 30 })
    const fresh = await plantLocal(5), stale = await plantLocal(40)
    expect((await pruneBackups(env.app, NOW)).pruned).toEqual([stale.id])
    expect(existsSync(fresh.location)).toBe(true)

    await sys.appBackup.deleteMany({ where: { id: fresh.id } })
    const only = await plantLocal(90)
    expect((await pruneBackups(env.app, NOW)).pruned).toEqual([])
    expect(existsSync(only.location)).toBe(true)
  })

  test('remote archives are counted per destination and deleted object first, then row', async () => {
    const sys = env.system as any
    await sys.appBackup.deleteMany({ where: {} })
    await keep({ backupKeepLocalCount: 10, backupKeepLocalDays: null, backupKeepRemoteCount: 1, backupKeepRemoteDays: null })
    const local = await plantLocal(9)
    const newest = await plantRemote(1), older = await plantRemote(2)
    deletes.length = 0

    expect((await pruneBackups(env.app, NOW)).pruned).toEqual([older.id])
    expect(deletes).toEqual([`/frontier-basecamp/${older.location}`])
    expect(await sys.appBackup.findFirst({ where: { id: newest.id } })).toBeTruthy()
    expect(await sys.appBackup.findFirst({ where: { id: local.id } })).toBeTruthy()
  })

  test('the newest of each group is spared, so no destination ages out behind a run of local archives (FJS-3847)', async () => {
    const sys = env.system as any
    await sys.appBackup.deleteMany({ where: {} })
    await keep({ backupKeepLocalCount: 10, backupKeepLocalDays: null, backupKeepRemoteCount: 10, backupKeepRemoteDays: 30 })
    const local  = await plantLocal(1)
    const remote = await plantRemote(90)
    expect((await pruneBackups(env.app, NOW)).pruned).toEqual([])
    expect(await sys.appBackup.findFirst({ where: { id: remote.id } })).toBeTruthy()
    expect(existsSync(local.location)).toBe(true)
    // A second, older remote row in the same group is still aged out.
    const older = await plantRemote(120)
    expect((await pruneBackups(env.app, NOW)).pruned).toEqual([older.id])
    await keep({ backupKeepRemoteDays: null })
  })

  test('a rescan gives a found row to an archive no row names, and nothing else', async () => {
    const sys = env.system as any
    await sys.appBackup.deleteMany({ where: {} })
    const known = await plantRemote(1)
    const lost  = `basecamp-/${nameAt(3)}.tar.gz`
    listing = [
      { key: known.location, size: 10 },
      { key: lost, size: 42 },
      { key: 'basecamp-/basecamp-notes & things.txt', size: 1 },
      { key: `basecamp-/${nameAt(4)}.tar.gz.part`, size: 1 },
    ]

    expect(await rescanDestination(env.app, dest.id)).toEqual({ listed: 4, found: 1 })
    const found = await sys.appBackup.findFirst({ where: { location: lost } })
    expect(found).toMatchObject({ kind: 'found', status: 'success', destinationId: dest.id, sizeBytes: 42, requestedBy: null })
    expect(Date.parse(found.startedAt)).toBe(NOW - 3 * DAY)

    expect(await rescanDestination(env.app, dest.id)).toEqual({ listed: 4, found: 0 })
  })

  test('two hubs on one prefix: the other hub\'s archives are not adopted or deleted, and its claim refuses this one (FJS-D1797)', async () => {
    const sys   = env.system as any
    await sys.appBackup.deleteMany({ where: {} })
    const mine  = (await sys.hubConfig.findFirst({ where: { id: 'hub' } })).installId as string
    const other = crypto.randomUUID()
    const stamp = (d: number) => nameAt(d).slice('basecamp-'.length)
    const theirs = `basecamp-/basecamp-${other}-${stamp(2)}.tar.gz`
    const ours   = `basecamp-/basecamp-${mine}-${stamp(3)}.tar.gz`
    const legacy = `basecamp-/${nameAt(5)}.tar.gz`

    expect(isForeign(theirs, mine)).toBe(true)
    expect(isForeign(ours, mine)).toBe(false)
    // A pre-id archive is nobody's, so this hub does not treat it as foreign.
    expect(isForeign(legacy, mine)).toBe(false)
    expect(isForeign(`basecamp-/basecamp-claim-${other}`, mine)).toBe(true)

    listing = [{ key: theirs, size: 1 }, { key: ours, size: 2 }, { key: legacy, size: 3 }]
    expect(await rescanDestination(env.app, dest.id)).toEqual({ listed: 3, found: 2, foreign: 1 })
    expect(await sys.appBackup.findFirst({ where: { location: theirs } })).toBeNull()
    expect(await sys.appBackup.findFirst({ where: { location: ours } })).toBeTruthy()

    // A row that names the other hub's object (adopted by an earlier build) is
    // kept by the same predicate, and the bucket is not asked to delete it.
    const adopted = await sys.appBackup.create({ data: { appId: hubId, status: 'success', destinationId: dest.id,
      location: theirs, startedAt: new Date(NOW - 2 * DAY).toISOString() } })
    deletes.length = 0
    const done = await deleteArchive(env.app, adopted)
    expect(done).toEqual({ kept: expect.stringContaining('another Basecamp') })
    expect(deletes).toEqual([])

    // Another hub's claim marker on the prefix: this hub is refused it.
    listing.push({ key: `basecamp-/basecamp-claim-${other}`, size: 0 })
    const refused = await rescanDestination(env.app, dest.id)
    expect(refused).toEqual({ error: expect.stringContaining('already claimed by another Basecamp') })
    listing = []
  })
})

// ─── FJS-3881: a restore drill of the newest remote archive ──────────────────

describe('the newest remote hub archive is read back and graded', () => {
  let server: ReturnType<typeof Bun.serve>
  let served = new Uint8Array()
  let dest: any
  let remote: any

  beforeAll(async () => {
    server = Bun.serve({ port: 0, fetch(req) {
      return req.method === 'GET' && new URL(req.url).pathname.endsWith('.tar.gz')
        ? new Response(served) : new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')
    } })
    const sys  = env.system as any
    const uniq = Math.random().toString(36).slice(2, 8)
    const acct = await sys.account.create({ data: { slug: `dr-${uniq}`, displayName: 'Drill' } })
    await sys.user.create({ data: { email: `dr-${uniq}@example.com` } })
    const ws   = await sys.workspace.create({ data: { accountId: acct.id, name: 'Drill', slug: `dr-${uniq}` } })
    const key  = await sys.secret.create({ data: { workspaceId: ws.id, name: 'backup-drill', kind: 'backup', data: 'keyid:applicationkey' } })
    dest = await sys.backupDestination.create({ data: {
      workspaceId: ws.id, name: 'Drill', endpoint: `http://127.0.0.1:${server.port}`,
      region: 'us-west-000', bucket: 'frontier-basecamp', prefix: 'drill-', secretId: key.id,
    } })
    await registerDestination(env.app, dest)

    // A real archive, tarred the way the job tars one.
    await sys.appBackup.deleteMany({ where: {} })
    const row = await sys.appBackup.create({ data: { appId: hubId } })
    await takeBackup(env.app, row.id)
    const dir = (await sys.appBackup.findUnique({ where: { id: row.id } })).location as string
    const tar = join(tmpdir(), `${basename(dir)}.tar.gz`)
    expect(await Bun.spawn(['tar', '-czf', tar, '-C', dirname(dir), basename(dir)]).exited).toBe(0)
    served = await Bun.file(tar).bytes()
    remote = await sys.appBackup.create({ data: { appId: hubId, status: 'success', destinationId: dest.id,
      location: `drill-/${basename(dir)}.tar.gz`, sha256: await sha256Of(tar), startedAt: new Date().toISOString() } })
  })

  afterAll(() => server?.stop(true))

  test('an archive that restores is graded success and leaves nothing behind', async () => {
    const drill = await drillHubArchive(env.app, { kind: 'scheduled' }) as any
    expect(drill.error).toBeNull()
    expect(drill.status).toBe('success')
    expect(drill.kind).toBe('scheduled')
    expect(drill.report).toMatchObject({ backupId: remote.id, reasons: [] })
    expect(readdirSync(dirname(env.app.sqlite.filename)).filter(n => n.startsWith('.drill-'))).toEqual([])
    expect(await verifyHubBackup(env.app, env.system)).toBe('success')
  })

  test('bytes that do not match the recorded sha256 fail the drill, and the failure is reported', async () => {
    await (env.system as any).appBackup.update({ where: { id: remote.id }, data: { sha256: 'f'.repeat(64) } })
    const drill = await drillHubArchive(env.app) as any
    expect(drill.status).toBe('failed')
    expect(drill.error).toContain('does not match the sha256')
    expect(await verifyHubBackup(env.app, env.system)).toBe('failed')
  })

  test('with no uploaded archive there is nothing to drill, and no row is written', async () => {
    const sys = env.system as any
    await sys.appBackup.deleteMany({ where: { destinationId: dest.id } })
    const before = await sys.appDrill.count()
    expect(await drillHubArchive(env.app)).toEqual({ skipped: expect.stringContaining('nothing to drill') })
    expect(await sys.appDrill.count()).toBe(before)
  })

  test('a manifest from another install is refused when the caller knows its own id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-foreign-manifest-'))
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({
      basecamp: 'x', takenAt: new Date().toISOString(), installId: crypto.randomUUID(),
      encryptionKeyFingerprint: encryptionKeyFingerprint(), files: [],
    }))
    const migrationsRoot = join(import.meta.dir, '..', '..', 'db', 'migrations')
    expect(await archiveRefusals(dir, { migrationsRoot })).toEqual([])
    expect(await archiveRefusals(dir, { migrationsRoot, installId: crypto.randomUUID() }))
      .toEqual([expect.stringContaining('another Basecamp')])
  })
})

// ─── FJS-3859, FJS-3881, FJS-3900, FJS-3901 ─────────────────────────────────

describe('an interrupted hub backup does not block the next one', () => {
  test('a running row past the stale window is failed, and a fresh one still blocks', async () => {
    const sys = env.system as any
    await sys.appBackup.deleteMany({ where: {} })
    const old = await sys.appBackup.create({ data: { appId: hubId, status: 'running',
      startedAt: new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString() } })
    const q = await queueBackup(env.app, { kind: 'manual', destinationId: null, requestedBy: null })
    expect('backup' in q).toBe(true)
    const failed = await sys.appBackup.findUnique({ where: { id: old.id } })
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('interrupted')

    // The one just queued is fresh, so it is what the next ask answers.
    const again = await queueBackup(env.app, { kind: 'manual', destinationId: null, requestedBy: null })
    expect('inFlight' in again).toBe(true)
  })

  test('a restore fails every in-flight row, whatever its age', async () => {
    const sys = env.system as any
    await sys.appBackup.deleteMany({ where: {} })
    await sys.appBackup.create({ data: { appId: hubId, status: 'running', startedAt: new Date().toISOString() } })
    await sys.appBackup.create({ data: { appId: hubId, status: 'pending' } })
    expect(await failStaleBackups(env.app, 0)).toBe(2)
    expect(await failStaleBackups(env.app, 0)).toBe(0)
  })
})

describe('a staged copy that is not a database is refused', () => {
  test('integrity_check passes a real database and names a damaged file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-integrity-'))
    const ok  = new Database(join(dir, 'ok.db')); ok.run('CREATE TABLE t (a)'); ok.close()
    expect(checkStaged(dir)).toBeNull()
    writeFileSync(join(dir, 'bad.db'), 'SQLite format 3\0' + 'x'.repeat(4096))
    expect(checkStaged(dir)).toContain('bad.db')
  })
})

describe('the queue database path', () => {
  test('only a trailing .db is replaced, and a path with none is suffixed', () => {
    expect(jobsDatabasePath('/data/basecamp.db')).toBe('/data/basecamp-jobs.db')
    expect(jobsDatabasePath('/data.db/app.db')).toBe('/data.db/app-jobs.db')
    expect(jobsDatabasePath('/data.db/app')).toBe('/data.db/app-jobs.db')
    expect(jobsDatabasePath('/data/basecamp')).not.toBe('/data/basecamp')
  })
})

// ─── FJS-3908 ───────────────────────────────────────────────────────────────

describe('a backup is refused when the disk cannot hold the copy', () => {
  const GB = 1024 ** 3
  const volume = (free: number) => ({ statfs: () => ({ bavail: free / 4096, bsize: 4096, blocks: 100 * GB / 4096 }) })

  test('nothing is staged, the row is failed with the sentence, and the error is thrown for the retry', async () => {
    const sys    = env.system as any
    const dir    = join(dirname(env.app.sqlite.filename), 'backups')
    const before = existsSync(dir) ? readdirSync(dir).sort() : []
    const row    = await sys.appBackup.create({ data: { appId: hubId } })

    // 1 GB free of 100: under both the database multiple and a tenth of the volume.
    await expect(takeBackup(env.app, row.id, volume(GB))).rejects.toThrow('Nothing was staged')

    const done = await sys.appBackup.findUnique({ where: { id: row.id } })
    expect(done.status).toBe('failed')
    expect(done.error).toContain('free on')
    expect(done.error).toContain('Nothing was staged')
    expect(existsSync(dir) ? readdirSync(dir).sort() : []).toEqual(before)
  })

  test('a disk with room takes the backup', async () => {
    const sys = env.system as any
    const row = await sys.appBackup.create({ data: { appId: hubId } })
    await takeBackup(env.app, row.id, volume(50 * GB))
    expect((await sys.appBackup.findUnique({ where: { id: row.id } })).status).toBe('success')
  })
})
