// test/channel-rooms.test.ts
//
// `FJS-1743`, ruled by `FJS-D596`. A room is a channel named for one row, and
// joining one was the app's call, asked once: the notion stressor's
// `pages.enter` read the page as the caller and joined on a hit, and nothing
// asked again. The owner revoked a share while the reader sat in `page:D`, and
// presence frames and `channel.send` kept reaching them both ways until they
// closed the tab — the two paths that are not graded per recipient.
//
// `channels({ rooms })` binds the name to the row. A join asks the Data
// boundary whether the joiner may read it, and every committed write to a
// model the row's read policy reaches asks every member again, evicting the
// ones who lost it with an empty `presence:sync` so their own screen empties.
//
// Every eviction below is paired with a member who stays (`FJS-351`): a room
// that empties for everybody passes a test that only looks at the evicted.
//
// Real sockets and a real Litestone client: the reach is read off the policy,
// and a fake `$readAs` would say whatever the test needed.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, createTenantRegistry } from '../../litestone/src/index.js'
import { createApp }    from '../src/core/app.ts'
import { channels }     from '../src/transport/channels.ts'

const SCHEMA = `
  model Page {
    id      Int     @id @default(autoincrement())
    ownerId String
    title   String  @default("")
    shares  Share[]
    @@allow(read, ownerId == auth().id || shares.some(userId == auth().id))
  }

  model Share {
    id     Int    @id @default(autoincrement())
    pageId Int
    page   Page   @relation(fields: [pageId], references: [id])
    userId String
    seenAt String @default("")
  }

  model Note {
    id   Int    @id @default(autoincrement())
    body String
  }

  model Member {
    id     Int    @id @default(autoincrement())
    userId String
    role   String
  }

  model Doc {
    id    Int    @id @default(autoincrement())
    title String @default("")
    @@allow(read, auth().memberRole == 'editor')
  }
`

const sleep  = (ms: number) => new Promise(r => setTimeout(r, ms))
// The tap defers a tick, the re-ask reads the row, and the frame crosses a real
// socket — bounded by the assertion that follows, not by the sleep.
const settle = () => sleep(150)

const OWNER = '1'
const GUEST = '2'

const running: Array<{ stop: () => Promise<void> }> = []
afterEach(async () => { for (const a of running.splice(0)) await a.stop().catch(() => {}) })

async function mkApp(opts: { claims?: (name: string, conn: unknown) => null } = {}) {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  const page = await sys.page.create({ data: { ownerId: OWNER, title: 'D' } })
  const share = await sys.share.create({ data: { pageId: page.id, userId: GUEST } })

  const app: any = createApp({
    db,
    logLevel: 'silent',
    config: { port: 0 },
    auth: {
      verifySession: async (token: string) => {
        const m = /^u(\d+)$/.exec(token)
        if (!m) throw new Error('bad token')
        return { id: m[1], userType: 'user', authMethod: 'session', verifiedAt: 'x', activatedAt: 'x' }
      },
    },
  })
  const joins: Promise<unknown>[] = []
  app.configure(channels((a: any) => {
    a.channels.on('connection', (_s: unknown, conn: any) => {
      joins.push(Promise.resolve(a.channel(`page:${page.id}`).join(conn)))
    })
  }, { rooms: { 'page:{id}': 'Page' }, presence: ['page:*'], presenceFlushMs: 0, claims: opts.claims }))
  await app.start()
  running.push(app)
  return { app, db, sys, page, share, joins, port: app.http.port as number }
}

interface Sock { frames: any[]; ws: WebSocket }

async function open(port: number, user: string): Promise<Sock> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, ['fjs', `fjs.bearer.u${user}`])
  const frames: any[] = []
  ws.onmessage = (e: any) => { try { frames.push(JSON.parse(String(e.data))) } catch {} }
  for (let i = 0; i < 200 && !frames.some(f => f.type === 'connection'); i++) await sleep(5)
  return { frames, ws }
}

const events = (s: Sock, name: string) => s.frames.filter(f => f.type === 'event' && f.event === name)
const lastSync = (s: Sock) => events(s, 'presence:sync').at(-1)?.data

describe('a bound room grades the join', () => {
  test('a reader of the row joins and a stranger is refused, and the join says which', async () => {
    const { port, joins, app, page } = await mkApp()
    const owner    = await open(port, OWNER)
    const stranger = await open(port, '9')
    await settle()

    expect(await Promise.all(joins)).toEqual([true, false])
    expect(app.channel(`page:${page.id}`).length).toBe(1)
    expect(lastSync(owner)?.members.map((m: any) => m.userId)).toEqual([OWNER])
    expect(events(stranger, 'presence:sync')).toEqual([])
  })
})

describe('a write the read policy reaches asks every member again', () => {
  test('a revoked share evicts the reader, empties their roster, and keeps the owner', async () => {
    const { port, sys, share, app, page } = await mkApp()
    const owner = await open(port, OWNER)
    const guest = await open(port, GUEST)
    await settle()
    expect(app.channel(`page:${page.id}`).length).toBe(2)

    await sys.share.delete({ where: { id: share.id } })
    await settle()

    const room = app.channel(`page:${page.id}`)
    expect(room.length).toBe(1)
    expect(lastSync(guest)).toMatchObject({ channelId: `page:${page.id}`, members: [] })
    // The owner's roster is told the guest left.
    const left = events(owner, 'presence:leave').map((f: any) => f.data.member.userId)
    expect(left).toEqual([GUEST])

    // A raw send now reaches the member who stayed and not the one who left.
    room.send('fragment', { html: '<p>secret</p>' })
    await settle()
    expect(events(owner, 'fragment')).toHaveLength(1)
    expect(events(guest, 'fragment')).toHaveLength(0)
  })

  test('a write to the row itself that takes it from a reader evicts them too', async () => {
    const { port, sys, app, page } = await mkApp()
    await open(port, OWNER)
    const guest = await open(port, GUEST)
    await settle()

    await sys.share.deleteMany({ where: { pageId: page.id } })
    await sys.page.update({ where: { id: page.id }, data: { ownerId: GUEST } })
    await settle()

    // The page is the guest's now and no longer the first owner's.
    const room = app.channel(`page:${page.id}`)
    expect([...room.connections].map((c: any) => c.user.id)).toEqual([GUEST])
    expect(lastSync(guest)?.members).not.toEqual([])
  })

  test('a write to a model the policy does not reach asks nobody', async () => {
    // A claims resolver would widen the reach to every write (`FJS-2521`), so
    // the re-asks are counted at the client's own read verdict instead.
    let asked = 0
    const { port, sys, app, page, db } = await mkApp()
    const readAs = db.$readAs.bind(db)
    db.$readAs = (...args: unknown[]) => { asked++; return readAs(...args) }
    await open(port, OWNER)
    await open(port, GUEST)
    await settle()

    asked = 0
    await sys.note.create({ data: { body: 'unrelated' } })
    await settle()
    expect(asked).toBe(0)
    expect(app.channel(`page:${page.id}`).length).toBe(2)

    // The control: a Share is in the reach, so the same count moves.
    await sys.share.create({ data: { pageId: page.id, userId: '3' } })
    await settle()
    expect(asked).toBeGreaterThan(0)
    expect(app.channel(`page:${page.id}`).length).toBe(2)
  })

  // FJS-3303 -- a Share column the page's read policy never reads (a stamp
  // written every few seconds) asked every member again, as a Run.heartbeatAt
  // regraded every open chunk list before FJS-3127.
  test('a write to a column the policy does not read asks nobody, and one it reads still does', async () => {
    let asked = 0
    const { port, sys, app, page, share, db } = await mkApp()
    const readAs = db.$readAs.bind(db)
    db.$readAs = (...args: unknown[]) => { asked++; return readAs(...args) }
    await open(port, OWNER)
    await open(port, GUEST)
    await settle()

    asked = 0
    await sys.share.update({ where: { id: share.id }, data: { seenAt: 'now' } })
    await settle()
    expect(asked).toBe(0)

    await sys.share.updateMany({ where: { id: share.id }, data: { seenAt: 'later' } })
    await settle()
    expect(asked).toBeGreaterThan(0)

    asked = 0
    await sys.share.update({ where: { id: share.id }, data: { userId: '3', seenAt: 'again' } })
    await settle()
    expect(asked).toBeGreaterThan(0)
    expect(app.channel(`page:${page.id}`).length).toBe(1)
  })
})

// `FJS-2521`. The policy says `auth().memberRole == 'editor'` and the app's own
// channels({ claims }) resolver answers memberRole from a Member row. The
// policy's reach is Doc alone, so a write that demotes the member is a write
// the reach cannot see — the reach of app code is not on the AST.
describe('a claim an app resolver derives', () => {
  test('a write to the model behind the claim evicts the member who lost the row, and keeps the other', async () => {
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    const sys = db.asSystem()
    const doc = await sys.doc.create({ data: { title: 'D' } })
    const demoted = await sys.member.create({ data: { userId: GUEST, role: 'editor' } })
    await sys.member.create({ data: { userId: OWNER, role: 'editor' } })

    const app: any = createApp({
      db,
      logLevel: 'silent',
      config: { port: 0 },
      auth: {
        verifySession: async (token: string) => {
          const m = /^u(\d+)$/.exec(token)
          if (!m) throw new Error('bad token')
          return { id: m[1], userType: 'user', authMethod: 'session', verifiedAt: 'x', activatedAt: 'x' }
        },
      },
    })
    app.configure(channels((a: any) => {
      a.channels.on('connection', (_s: unknown, conn: any) => { a.channel(`doc:${doc.id}`).join(conn) })
    }, {
      rooms: { 'doc:{id}': 'Doc' }, presence: ['doc:*'], presenceFlushMs: 0,
      claims: async (_name: string, conn: any) => {
        const m = await sys.member.findFirst({ where: { userId: conn.user.id } })
        return m ? { memberRole: m.role } : null
      },
    }))
    await app.start()
    running.push(app)

    const owner = await open(app.http.port, OWNER)
    const guest = await open(app.http.port, GUEST)
    await settle()
    expect(app.channel(`doc:${doc.id}`).length).toBe(2)

    await sys.member.update({ where: { id: demoted.id }, data: { role: 'viewer' } })
    await settle()

    const room = app.channel(`doc:${doc.id}`)
    expect([...room.connections].map((c: any) => c.user.id)).toEqual([OWNER])
    expect(lastSync(guest)).toMatchObject({ channelId: `doc:${doc.id}`, members: [] })
    expect(lastSync(owner)?.members).not.toEqual([])
  })
})

// ─── createApp({ tenants }) ───────────────────────────────────────────────
//
// `FJS-2522`. A tenanted app has no `app.db`, so a room found neither its row
// nor a write to tap. The room name now carries the tenant, and the room reads
// through that tenant's client. Every assertion is paired with the other
// tenant's room, so a client that reached the wrong shop cannot pass.

describe('a room under createApp({ tenants })', () => {
  async function fleet(pattern = '{tenant}:page:{id}') {
    const dir  = mkdtempSync(join(tmpdir(), 'junction-rooms-'))
    const path = join(dir, 'schema.lite')
    writeFileSync(path, `
tenancy { strategy database  dir "${dir}/tenants"  registry "${dir}/registry.db" }
database main { path "./app.db" }
model Page {
  id      Int     @id @default(autoincrement())
  ownerId String
  @@allow(read, ownerId == auth().id)
  @@db(main)
}
`)
    const registry: any = await createTenantRegistry({ path })
    for (const id of ['a', 'b']) await registry.create(id)
    const pages: Record<string, any> = {}
    for (const id of ['a', 'b']) pages[id] = await (await registry.get(id)).asSystem().page.create({ data: { ownerId: OWNER } })

    const app: any = createApp({
      tenants: registry,
      logLevel: 'silent',
      config: { port: 0 },
      auth: {
        verifySession: async (token: string) => {
          const m = /^u(\d+)$/.exec(token)
          if (!m) throw new Error('bad token')
          return { id: m[1], userType: 'user', authMethod: 'session', verifiedAt: 'x', activatedAt: 'x' }
        },
      },
    })
    const joins: Record<string, Promise<unknown>[]> = { a: [], b: [] }
    app.configure(channels((a: any) => {
      a.channels.on('connection', (_s: unknown, conn: any) => {
        for (const t of ['a', 'b']) joins[t].push(Promise.resolve(a.channel(`${t}:page:${pages[t].id}`).join(conn)))
      })
    }, { rooms: { [pattern]: 'Page' }, presence: ['*:page:*'], presenceFlushMs: 0 }))
    await app.start()
    running.push(app)
    return { app, registry, pages, joins, port: app.http.port as number }
  }

  test('the tenant in the name picks the client: the owner joins and a stranger is refused, in both tenants', async () => {
    const { port, joins, app, pages } = await fleet()
    await open(port, OWNER)
    await open(port, '9')
    await settle()

    expect((await Promise.all(joins.a)).sort()).toEqual([false, true])
    expect((await Promise.all(joins.b)).sort()).toEqual([false, true])
    expect(app.channel(`a:page:${pages.a.id}`).length).toBe(1)
    expect(app.channel(`b:page:${pages.b.id}`).length).toBe(1)
  })

  test('a write in one tenant evicts from that tenant\'s room and leaves the other\'s alone', async () => {
    const { port, registry, app, pages } = await fleet()
    const owner = await open(port, OWNER)
    await settle()
    expect(app.channel(`a:page:${pages.a.id}`).length).toBe(1)
    expect(app.channel(`b:page:${pages.b.id}`).length).toBe(1)

    await (await registry.get('a')).asSystem().page.update({ where: { id: pages.a.id }, data: { ownerId: GUEST } })
    await settle()

    expect(app.channel(`a:page:${pages.a.id}`).length).toBe(0)
    expect(app.channel(`b:page:${pages.b.id}`).length).toBe(1)
    expect(lastSync(owner)).toMatchObject({ channelId: `a:page:${pages.a.id}`, members: [] })
  })

  test('a room of a tenant nobody has admits nobody', async () => {
    const { port, app, joins } = await fleet()
    await open(port, OWNER)
    await settle()
    const ghost = await app.channel('zzz:page:1').join([...app.channels.connections.values()][0])
    expect(ghost).toBe(false)
    expect(joins.a.length).toBe(1)
  })

  test('a pattern that names no tenant is refused at boot, and so is one that names a tenant with no registry', async () => {
    await expect(fleet('page:{id}')).rejects.toThrow(/must name the tenant exactly once/)
    const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
    const app: any = createApp({ db, logLevel: 'silent', config: { port: 0 } })
    expect(() => app.configure(channels(undefined, { rooms: { '{tenant}:page:{id}': 'Page' } })))
      .toThrow(/names \{tenant\} and this app has no createApp/)
  })
})
