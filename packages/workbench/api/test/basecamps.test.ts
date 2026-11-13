/**
 * basecamps.test.ts -- the Basecamps screen's verbs against a stub Basecamp,
 * over a temp `basecamps.json` so the laptop's own index is never read. The
 * stub answers what `takeHubBackup` asks: `/health`, the `/hub-backups` list,
 * `hub-config current`, the `take`, and the row it polls until settled.
 * Download asks `download` for a link and fetches a real tar.gz the stub
 * built. Restart and the key copy run over ssh, so only their refusals are tested here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'
import { writeBasecamp } from '@frontierjs/cli/core/basecamps.js'

import { spawnSync } from 'node:child_process'
import { listBasecamps, startBackup, startRestart, outcomeOf, deleteLocal, startB2Setup, startB2Undo, summarizePlan, startDownload, archiveLink, keyCopy, saveKey, type BackupsPlan } from '../src/domain/basecamps/basecamps.ts'

const home = mkdtempSync(join(tmpdir(), 'wb-basecamps-'))
const KEY  = 'bc_admin_secret_key'

const older: Record<string, unknown> = { id: 'hb_1', status: 'success', createdAt: '2026-11-01T10:00:00.000Z', startedAt: '2026-11-01T10:00:00.000Z' }
const rows: Array<Record<string, unknown>> = [older]
const asked: string[] = []
let server: ReturnType<typeof Bun.serve>

// One hub archive as `/setup` writes it: a basecamp-<stamp>/ directory whose manifest hashes its files.
const FINGERPRINT = 'f'.repeat(64)
const sha = (b: Uint8Array | string) => new Bun.CryptoHasher('sha256').update(b).digest('hex')
let tar: Uint8Array<ArrayBuffer>
let tarSha: string

function buildArchive () {
  const scratch = mkdtempSync(join(tmpdir(), 'wb-archive-'))
  const top = join(scratch, 'basecamp-stub')
  mkdirSync(top)
  const db = 'not really sqlite'
  writeFileSync(join(top, 'main.db'), db)
  writeFileSync(join(top, 'manifest.json'), JSON.stringify({
    takenAt: '2026-11-05T09:00:00.000Z', encryptionKeyFingerprint: FINGERPRINT,
    files: [{ path: 'main.db', bytes: db.length, sha256: sha(db) }],
  }))
  const r = spawnSync('tar', ['-czf', join(scratch, 'a.tar.gz'), '-C', scratch, 'basecamp-stub'])
  if (r.status !== 0) throw new Error(String(r.stderr))
  tar = new Uint8Array(readFileSync(join(scratch, 'a.tar.gz')))
  tarSha = sha(tar)
  rmSync(scratch, { recursive: true, force: true })
}

beforeAll(() => {
  buildArchive()
  older.sha256 = tarSha
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch (req) {
      const url    = new URL(req.url)
      const method = req.headers.get('x-service-method')
      asked.push(`${req.method} ${url.pathname}${method ? ` ${method}` : ''}`)
      if (url.pathname === '/health') return Response.json({ status: 'ok' })
      if (url.pathname.startsWith('/archive/')) return new Response(new Blob([tar]), { headers: { 'content-type': 'application/gzip' } })
      if (req.headers.get('authorization') !== `Bearer ${KEY}`) return Response.json({ message: 'no key' }, { status: 401 })
      if (url.pathname === '/hub-config' && method === 'current') return Response.json({ data: { app: { backupDestinationId: null } } })
      if (url.pathname === '/hub-backups' && req.method === 'GET') {
        const newest = [...rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        return Response.json({ data: newest.slice(0, Number(url.searchParams.get('$limit') ?? 100)) })
      }
      if (url.pathname === '/hub-backups' && method === 'take') {
        const row = { id: 'hb_2', status: 'running', createdAt: '2026-11-05T09:00:00.000Z', startedAt: '2026-11-05T09:00:00.000Z', sha256: tarSha }
        rows.push(row)
        return Response.json({ data: row })
      }
      const one = url.pathname.match(/^\/hub-backups\/([^/]+)$/)
      if (one && method === 'download') return Response.json({ data: { url: `/archive/${one[1]}`, name: 'basecamp-stub.tar.gz' } })
      if (one && req.method === 'GET') {
        const row = rows.find(r => r.id === decodeURIComponent(one[1]))
        if (!row) return Response.json({ message: 'not found' }, { status: 404 })
        row.status = 'success'
        return Response.json({ data: row })
      }
      return Response.json({ message: `stub has no ${req.method} ${url.pathname}` }, { status: 404 })
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  writeBasecamp('stub',   { url, apiKey: KEY, scopedKey: 'bc_scoped_secret', peerKeyId: 'key_peer_secret' }, { home })
  writeBasecamp('nokey',  { url }, { home })
  writeBasecamp('down',   { url: 'http://127.0.0.1:9', host: 'down-box', apiKey: KEY }, { home })
})

afterAll(() => { server?.stop(true); rmSync(home, { recursive: true, force: true }) })

async function settled (name: string) {
  for (let i = 0; i < 100; i++) {
    const o = outcomeOf(name)
    if (o && o.state !== 'working') return o
    await Bun.sleep(20)
  }
  throw new Error(`${name}'s verb never settled`)
}

describe('list', () => {
  test('every entry, whether it answers, its newest backup — and no key', async () => {
    const listed = await listBasecamps({ home })
    const by = Object.fromEntries(listed.map(e => [e.name, e]))
    expect(Object.keys(by).sort()).toEqual(['down', 'nokey', 'stub'])

    expect(by.stub.answers.ok).toBe(true)
    expect(by.stub.hasKey).toBe(true)
    expect(by.stub.hasScopedKey).toBe(true)
    expect(by.stub.host).toBeNull()
    expect(by.stub.newestBackup?.id).toBe('hb_1')
    expect(by.stub.outcome).toBeNull()

    expect(by.nokey.answers.ok).toBe(true)
    expect(by.nokey.hasKey).toBe(false)
    expect(by.nokey.newestBackup).toBeNull()

    expect(by.down.answers.ok).toBe(false)
    expect(by.down.host).toBe('down-box')
    expect(by.down.newestBackup).toBeNull()

    const said = JSON.stringify(listed)
    for (const secret of [KEY, 'bc_scoped_secret', 'key_peer_secret']) expect(said).not.toContain(secret)
    for (const field of ['apiKey', 'scopedKey', 'peerKeyId']) expect(said).not.toContain(field)
  })

  test('hostKnown says whether ~/.ssh/config defines the entry\'s Host', async () => {
    const before = Object.fromEntries((await listBasecamps({ home })).map(e => [e.name, e]))
    expect(before.down.hostKnown).toBe(false)
    expect(before.stub.hostKnown).toBe(false)

    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'config'), 'Host other down-box\n  HostName 127.0.0.1\n')
    try {
      const after = Object.fromEntries((await listBasecamps({ home })).map(e => [e.name, e]))
      expect(after.down.hostKnown).toBe(true)
      expect(after.stub.hostKnown).toBe(false)
    } finally {
      rmSync(join(home, '.ssh'), { recursive: true, force: true })
    }
  })
})

describe('backup', () => {
  test('takes Basecamp\'s own backup and holds the row it recorded', async () => {
    const started = await startBackup('stub', { home })
    expect('refused' in started).toBe(false)
    const o = await settled('stub')
    expect(o).toMatchObject({ verb: 'backup', state: 'done', row: { id: 'hb_2', status: 'success' } })
    expect(o.finishedAt).toBeString()
    expect(asked).toContain('POST /hub-backups take')
    expect(asked.some(a => a.startsWith('GET /hub-backups/hb_2'))).toBe(true)
    expect(asked.some(a => a.includes('download'))).toBe(false)

    const listed = await listBasecamps({ home })
    const stub   = listed.find(e => e.name === 'stub')!
    expect(stub.newestBackup?.id).toBe('hb_2')
    expect(stub.outcome?.state).toBe('done')
  })

  test('an entry with no key is refused, naming the command that files one', async () => {
    const out = await startBackup('nokey', { home })
    expect(out).toEqual({ refused: expect.stringContaining('fli basecamp:key') })
    expect(outcomeOf('nokey')).toBeNull()
  })

  test('a Basecamp that does not answer ends in error, saying so', async () => {
    await startBackup('down', { home })
    const o = await settled('down')
    expect(o.state).toBe('error')
    expect(o.error).toMatch(/could not reach Basecamp/)
  })
})

describe('restart', () => {
  test('an entry with no ssh Host is refused by name', async () => {
    const out = await startRestart('stub', { home })
    expect(out).toEqual({ refused: expect.stringContaining('no ssh Host') })
  })

  test('an entry not in the index is refused', async () => {
    expect(await startRestart('nowhere', { home })).toEqual({ refused: expect.stringContaining("No Basecamp named 'nowhere'") })
  })
})

describe('local copies', () => {
  const dir = join(home, '.local', 'share', 'fli', 'basecamp', 'stub')
  const at  = join(dir, '2026-11-06T10-00-00-000Z')

  test('list shows the backup directories pulled for an entry, with bytes; an entry with none has an empty list', async () => {
    mkdirSync(at, { recursive: true })
    writeFileSync(join(at, 'x.tar.gz'), 'z'.repeat(1234))
    const by = Object.fromEntries((await listBasecamps({ home })).map(e => [e.name, e]))
    expect(by.stub.local).toEqual([expect.objectContaining({ file: '2026-11-06T10-00-00-000Z', bytes: 1234, kind: 'unreadable' })])
    expect(typeof by.stub.local[0].mtime).toBe('string')
    expect(by.nokey.local).toEqual([])
  })

  test('refuses a path, a traversal, an unknown file and an unknown entry, and removes nothing', async () => {
    for (const file of ['../stub', '..', '.', '', 'a/b', `${at}`, 'nothing'])
      expect(await deleteLocal('stub', file, { home })).toHaveProperty('refused')
    expect(await deleteLocal('../stub', '2026-11-06T10-00-00-000Z', { home })).toHaveProperty('refused')
    expect(existsSync(at)).toBe(true)
  })

  test('removes one copy and says what it freed', async () => {
    expect(await deleteLocal('stub', '2026-11-06T10-00-00-000Z', { home })).toEqual({ freed: 1234 })
    expect(existsSync(at)).toBe(false)
  })
})

describe('B2 backups', () => {
  test('setting up or undoing is refused without approved: true, before anything is read', async () => {
    expect(await startB2Setup('stub', {}, { home })).toEqual({ refused: expect.stringContaining('not approved') })
    expect(await startB2Setup('stub', { approved: 'yes' as never }, { home })).toEqual({ refused: expect.stringContaining('not approved') })
    expect(await startB2Undo('stub', {}, { home })).toEqual({ refused: expect.stringContaining('not approved') })
    expect(outcomeOf('stub')?.verb).not.toMatch(/^b2/)
  })

  test('an approved run on an entry with no ssh Host is refused, and an unknown name is refused', async () => {
    expect(await startB2Setup('stub', { approved: true }, { home })).toEqual({ refused: expect.stringContaining('no ssh host') })
    expect(await startB2Undo('nope', { approved: true }, { home })).toEqual({ refused: "No Basecamp named 'nope' in basecamps.json" })
    expect(await startB2Setup('stub', { approved: true, apps: 'ela' }, { home })).toEqual({ refused: 'apps is a list of App slugs' })
  })

  test('the plan summary names buckets, keys and destinations and carries no email or id of a member', () => {
    const plan = {
      name: 'box',
      buckets: { archive: { name: 'basecamp-box', held: null }, replica: { name: 'basecamp-box-replica', held: { lockDays: 0 } } },
      workspaces: [{
        id: 'ws_1', name: 'Hub', holder: { email: 'owner@example.com', workspaceId: 'ws_1', workspace: 'Hub' },
        archive: { bucket: 'basecamp-box', prefix: 'ws_1', name: 'B2 basecamp-box', keyName: 'basecamp-box-ws-1', row: null },
        replica: { bucket: 'basecamp-box-replica', prefix: 'hub', name: 'B2 basecamp-box-replica', keyName: 'basecamp-box-replica-hub', row: { lastTestAt: '2026-11-01' } },
      }, {
        id: 'ws_2', name: 'Other', holder: null,
        archive: { bucket: 'basecamp-box', prefix: 'ws_2', name: 'B2 basecamp-box', keyName: 'basecamp-box-ws-2', row: { lastTestAt: null } },
      }],
      hub: { backupDestinationId: null, replicaDestinationId: 'bd_9', backupCron: null },
      apps: [{ slug: 'ela', backupDestinationId: null, backupCron: null }],
      unset: [{ id: 'app_1', slug: 'ela' }],
    } as unknown as BackupsPlan
    const out = summarizePlan(plan, 7)
    expect(out.buckets[0]).toMatchObject({ name: 'basecamp-box', held: false, makeLockDays: 7 })
    expect(out.buckets[1]).toMatchObject({ held: true, makeLockDays: null })
    expect(out.destinations.map(d => d.action)).toEqual(['make', 'keep', 'test'])
    expect(out.hub.map(h => h.action)).toEqual(['set', 'keep', 'set'])
    expect(out.blocked).toEqual(['Other'])
    expect(out.unset).toEqual([{ slug: 'ela' }])
    expect(JSON.stringify(out)).not.toMatch(/owner@example\.com|app_1|holder/)
  })
})

describe('download', () => {
  test('fetches the newest archive into the local copies, unpacked and checked, taking no backup', async () => {
    const before = asked.filter(a => a.endsWith(' take')).length
    const started = await startDownload('stub', { home })
    expect('refused' in started).toBe(false)
    const o = await settled('stub')
    expect(o.verb).toBe('download')
    expect(o.error).toBeUndefined()
    expect(o.state).toBe('done')
    expect(asked.filter(a => a.endsWith(' take')).length).toBe(before)

    const stub = (await listBasecamps({ home })).find(e => e.name === 'stub')!
    const copy = stub.local.find(c => c.file === '2026-11-05T09-00-00-000Z')
    expect(copy?.kind).toBe('archive')
  })

  test('a second press finds it on this laptop and fetches nothing', async () => {
    const fetched = asked.filter(a => a.startsWith('GET /archive/')).length
    await startDownload('stub', { home })
    const o = await settled('stub')
    expect(o.note).toContain('on this laptop already')
    expect(asked.filter(a => a.startsWith('GET /archive/')).length).toBe(fetched)
  })

  test('Save .tar.gz answers an absolute link and the sha256 Basecamp recorded, and no key', async () => {
    const link = await archiveLink('stub', { home })
    if ('refused' in link) throw new Error(link.refused)
    expect(link.url).toBe(`http://127.0.0.1:${server.port}/archive/hb_2`)
    expect(link.sha256).toBe(tarSha)
    expect(JSON.stringify(link)).not.toContain(KEY)
  })

  test('an entry with no key is refused', async () => {
    expect(await startDownload('nokey', { home })).toEqual({ refused: expect.stringContaining('fli basecamp:key') })
    expect(await archiveLink('nokey', { home })).toEqual({ refused: expect.stringContaining('fli basecamp:key') })
  })
})

describe('key copy', () => {
  test('an entry with no ssh Host is refused before anything is read', async () => {
    expect(await keyCopy('stub', { home })).toEqual({ refused: expect.stringContaining('no ssh Host') })
    expect(await saveKey('stub', { home })).toEqual({ refused: expect.stringContaining('no ssh Host') })
    expect(await keyCopy('nope', { home })).toEqual({ refused: expect.stringContaining("No Basecamp named 'nope'") })
  })
})
