// test/local-files.test.ts — a local FileStorage's URLs have a route (FJS-3536).
//
// A File column on a client with no provider bound stores under <db dir>/files
// (FJS-D1549), and the URL a read answers must reach those bytes: junction
// serves the directory read-only under apiPrefix, and the client's publicBase
// names that route on the app's own origin.

import { describe, test, expect, afterEach, setSystemTime } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createClient, autoMigrate } from '../../litestone/src/index.js'
import { tempDir } from '../../litestone/src/tmp-dirs.js'
import { createApp, createStubAuth } from '../index.ts'
import { request } from '../src/testing/index.ts'

const SCHEMA = `model Doc {
  id     Int   @id
  resume File?
}`

const ENV = ['FILES_PROVIDER', 'FILES_PUBLIC_BASE', 'FRONTIER_APP_URL'] as const
const before = Object.fromEntries(ENV.map(n => [n, process.env[n]]))
afterEach(() => {
  for (const n of ENV) before[n] == null ? delete process.env[n] : process.env[n] = before[n]
})

async function appWith(apiPrefix?: string) {
  const dir = tempDir('jn-local-files-')
  const db = await createClient({ schema: SCHEMA, db: join(dir, 'app.db') } as never) as any
  await autoMigrate(db)
  const app = createApp({
    config: { name: 'files', debug: false, ...(apiPrefix ? { apiPrefix } : {}) } as never,
    auth: createStubAuth({ users: [] }),
    db,
  } as never)
  return { app, db, dir }
}

const upload = () => new File([new Uint8Array([1, 2, 3])], 'cv.pdf', { type: 'application/pdf' })

describe('a local FileStorage is served by junction', () => {
  test('the URL a read answers is a route that returns the bytes', async () => {
    process.env.FRONTIER_APP_URL = 'https://app.example'
    const { app, db } = await appWith('/api')
    await db.asSystem().doc.create({ data: { id: 1, resume: upload() } })
    // The route registers when the app boots, and a read resolves its URL after.
    const first = await request(app).get('/api/files/none/nothing.pdf')
    expect(first.status).toBe(403)
    const row = await db.asSystem().doc.findUnique({ where: { id: 1 } })
    expect(row.resume).toMatch(/^https:\/\/app\.example\/api\/files\/Doc\/resume\/.+\.pdf\?exp=\d+&sig=[\w-]+$/)
    const url = new URL(row.resume)
    const res = await request(app).get(url.pathname + url.search)
    expect(res.status).toBe(200)
    expect([...res.bytes]).toEqual([1, 2, 3])
  })

  // The key is printed in every list response and is 12 hex chars, so it is no
  // secret: a row the read policy hides was readable by anyone holding it (FJS-3716).
  test('the bytes answer only a URL a read signed, and only until it expires', async () => {
    const { app, db } = await appWith('/api')
    await db.asSystem().doc.create({ data: { id: 1, resume: upload() } })
    await request(app).get('/api/files/none/nothing.pdf')
    const read = async () => new URL((await db.asSystem().doc.findUnique({ where: { id: 1 } })).resume)

    const url = await read()
    expect((await request(app).get(url.pathname)).status, 'no signature').toBe(403)

    const sig = url.searchParams.get('sig')!
    const tampered = new URLSearchParams(url.search)
    tampered.set('sig', (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1))
    expect((await request(app).get(`${url.pathname}?${tampered}`)).status, 'tampered sig').toBe(403)

    const stretched = new URLSearchParams(url.search)
    stretched.set('exp', String(Number(url.searchParams.get('exp')) + 3600))
    expect((await request(app).get(`${url.pathname}?${stretched}`)).status, 'moved exp').toBe(403)

    setSystemTime(new Date(Date.now() - 3 * 3600_000))
    const old = await read()
    setSystemTime()
    expect((await request(app).get(old.pathname + old.search)).status, 'expired').toBe(403)

    // Bucketed to the hour, so two reads in one hour print one URL.
    expect((await read()).href).toBe(url.href)
  })

  test('a key that climbs out of the directory is refused', async () => {
    const { app, dir } = await appWith()
    writeFileSync(join(dir, 'secret.txt'), 'TOP SECRET')
    mkdirSync(join(dir, 'files'), { recursive: true })
    for (const p of ['/files/../secret.txt', '/files/%2e%2e/secret.txt']) {
      const res = await request(app).get(p)
      expect(res.status, p).not.toBe(200)
      expect(res.text, p).not.toContain('TOP SECRET')
    }
  })

  test('an app with no local store mounts no route', async () => {
    const { app } = await appWith()
    // No File column, so no store: nothing at /files.
    expect((await request(app).get('/files/x.pdf')).status).toBe(404)
  })
})
