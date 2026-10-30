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
import { takeBackup }        from '../src/jobs/backup-run.job.ts'
import { placeHub }          from '../src/domain/host/host-machine.ts'
import { registerDestination } from '../src/providers/storage/index.ts'
import { pruneBackups, rescanDestination } from '../src/domain/backup/backup-archives.ts'
import { archiveRefusals, MANIFEST_FILE } from '../src/domain/backup/archive-manifest.ts'
import { encryptionKeyFingerprint } from '../src/core/db.ts'
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
      puts.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization') ?? '', bytes: body.length })
      return new Response(null, { headers: { etag: '"stand-in"' } })
    } })

    const sys  = env.system as any
    const uniq = Math.random().toString(36).slice(2, 8)
    const acct = await sys.account.create({ data: { slug: `bk-${uniq}`, displayName: 'Backups' } })
    await sys.user.create({ data: { email: `bk-${uniq}@example.com` } })
    const ws   = await sys.workspace.create({ data: { accountId: acct.id, name: 'Backups', slug: `bk-${uniq}` } })
    const key  = await sys.secret.create({ data: {
      workspaceId: ws.id, name: 'backup:Stand-in', kind: 'backup', data: 'keyid:applicationkey',
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
    expect(puts.length).toBe(1)
    expect(puts[0].path).toBe(`/frontier-basecamp/${done.location}`)
    expect(puts[0].auth).toStartWith('AWS4-HMAC-SHA256 Credential=keyid/')
    expect(done.sizeBytes).toBe(puts[0].bytes)

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
    expect(done.error).toContain('forbidden')
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
    const key  = await sys.secret.create({ data: { workspaceId: ws.id, name: 'backup:Retention', kind: 'backup', data: 'keyid:applicationkey' } })
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
})
