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
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createTestEnv }     from '@frontierjs/testing'
import { GatePlugin }        from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { takeBackup }        from '../src/jobs/backup-run.job.ts'
import { registerDestination } from '../src/providers/storage/index.ts'
import { pruneBackups, rescanDestination } from '../src/domain/backup/backup-archives.ts'

let env: any

beforeAll(async () => {
  env = await createTestEnv({
    schema:        join(import.meta.dir, '..', '..', 'db', 'schema.lite'),
    migrations:    join(import.meta.dir, '..', '..', 'db', 'migrations'),
    encryptionKey: '0'.repeat(64),
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
})

describe('a backup archives every database the app keeps', () => {
  test('main, the audit trail and the jobs queue are all in the archive', async () => {
    const sys = env.system as any
    const row = await sys.backup.create({ data: {} })

    // The trail's directory is made by its first write, which lands after the
    // create returns. An archive taken before then has no trail to hold.
    const trail = env.app.db.$databases.audit.path as string
    for (let i = 0; i < 100 && !existsSync(trail); i++) await Bun.sleep(20)
    expect(existsSync(trail)).toBe(true)

    await takeBackup(env.app, row.id)

    const done = await sys.backup.findUnique({ where: { id: row.id } })
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
      expect(copy.query('SELECT id FROM backup WHERE id = ?').get(row.id)).toBeTruthy()
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
    const row = await sys.backup.create({ data: {} })
    await takeBackup(env.app, row.id)
    const done = await sys.backup.findUnique({ where: { id: row.id } })
    expect(done.status).toBe('success')

    const copy = new Database(join(done.location as string, 'main.db'), { readonly: true })
    try {
      expect(copy.query('SELECT value FROM "_litestone_meta" WHERE key LIKE ?').get('%taken%')).toBeTruthy()
    } finally { copy.close() }
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
    const ws   = await sys.workspace.create({ data: { accountId: acct.id, name: 'Backups', slug: `bk-${uniq}`, ownerId: 'nobody' } })
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
    const row = await sys.backup.create({ data: { destinationId } })
    await takeBackup(env.app, row.id)
    return sys.backup.findUnique({ where: { id: row.id } })
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
    const first  = await (env.system as any).backup.findFirst({ where: { destinationId, error: null }, orderBy: { createdAt: 'desc' } })
    const second = await run()
    expect(second.error).toBeNull()
    expect(existsSync(localOf(first.location))).toBe(false)
    expect(existsSync(localOf(second.location))).toBe(true)
  })

  test('a refused PUT finishes success with the reason in error, and the archive stays on this disk', async () => {
    const uploaded = await (env.system as any).backup.findFirst({ where: { destinationId, error: null }, orderBy: { createdAt: 'desc' } })
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
    return (env.system as any).backup.create({ data: {
      status: 'success', location: dirOf(name), startedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    } })
  }
  const plantRemote = (daysAgo: number) => (env.system as any).backup.create({ data: {
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
    const ws   = await sys.workspace.create({ data: { accountId: acct.id, name: 'Retention', slug: `rt-${uniq}`, ownerId: 'nobody' } })
    const key  = await sys.secret.create({ data: { workspaceId: ws.id, name: 'backup:Retention', kind: 'backup', data: 'keyid:applicationkey' } })
    dest = await sys.backupDestination.create({ data: {
      workspaceId: ws.id, name: 'Retention', endpoint: `http://127.0.0.1:${server.port}`,
      region: 'us-west-000', bucket: 'frontier-basecamp', prefix: 'basecamp-', secretId: key.id,
    } })
    await registerDestination(env.app, dest)
    if (!await sys.hubConfig.findFirst({ where: { id: 'hub' } }))
      await sys.hubConfig.create({ data: { id: 'hub', baseUrl: 'https://hub.example.test', adminEmail: 'admin@x.co' } })
  })

  afterAll(() => server?.stop(true))

  test('a keep-count of two leaves the newest two on disk; a file outside backups/ is never reached', async () => {
    const sys = env.system as any
    await sys.backup.deleteMany({ where: {} })
    await keep({ backupKeepLocalCount: 2, backupKeepLocalDays: null })
    const rows = [await plantLocal(1), await plantLocal(2), await plantLocal(3), await plantLocal(4)]
    const outside = join(dirname(env.app.sqlite.filename), 'basecamp-2026-01-01T00-00-00-000Z')
    writeFileSync(outside, 'not an archive')
    const odd = await sys.backup.create({ data: { status: 'success', location: outside, startedAt: new Date(NOW - 9 * DAY).toISOString() } })

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
    await sys.backup.deleteMany({ where: {} })
    await keep({ backupKeepLocalCount: 10, backupKeepLocalDays: 30 })
    const fresh = await plantLocal(5), stale = await plantLocal(40)
    expect((await pruneBackups(env.app, NOW)).pruned).toEqual([stale.id])
    expect(existsSync(fresh.location)).toBe(true)

    await sys.backup.deleteMany({ where: { id: fresh.id } })
    const only = await plantLocal(90)
    expect((await pruneBackups(env.app, NOW)).pruned).toEqual([])
    expect(existsSync(only.location)).toBe(true)
  })

  test('remote archives are counted per destination and deleted object first, then row', async () => {
    const sys = env.system as any
    await sys.backup.deleteMany({ where: {} })
    await keep({ backupKeepLocalCount: 10, backupKeepLocalDays: null, backupKeepRemoteCount: 1, backupKeepRemoteDays: null })
    const local = await plantLocal(9)
    const newest = await plantRemote(1), older = await plantRemote(2)
    deletes.length = 0

    expect((await pruneBackups(env.app, NOW)).pruned).toEqual([older.id])
    expect(deletes).toEqual([`/frontier-basecamp/${older.location}`])
    expect(await sys.backup.findFirst({ where: { id: newest.id } })).toBeTruthy()
    expect(await sys.backup.findFirst({ where: { id: local.id } })).toBeTruthy()
  })

  test('a rescan gives a found row to an archive no row names, and nothing else', async () => {
    const sys = env.system as any
    await sys.backup.deleteMany({ where: {} })
    const known = await plantRemote(1)
    const lost  = `basecamp-/${nameAt(3)}.tar.gz`
    listing = [
      { key: known.location, size: 10 },
      { key: lost, size: 42 },
      { key: 'basecamp-/basecamp-notes & things.txt', size: 1 },
      { key: `basecamp-/${nameAt(4)}.tar.gz.part`, size: 1 },
    ]

    expect(await rescanDestination(env.app, dest.id)).toEqual({ listed: 4, found: 1 })
    const found = await sys.backup.findFirst({ where: { location: lost } })
    expect(found).toMatchObject({ kind: 'found', status: 'success', destinationId: dest.id, sizeBytes: 42, requestedBy: null })
    expect(Date.parse(found.startedAt)).toBe(NOW - 3 * DAY)

    expect(await rescanDestination(env.app, dest.id)).toEqual({ listed: 4, found: 0 })
  })
})
