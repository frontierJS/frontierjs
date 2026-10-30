// test/audit-plugin.test.ts — auditPlugin({ model }): one row per call that
// wrote, into a model the app declares (FJS-D873).
//
// A real Litestone client and a real app, because what the plugin gets wrong is
// at the crossings: the registry's model (a ServiceCaller carries none), the
// system re-read of both sides, and the schema's own reading of which columns
// are protected. Against a fake db every one of those passes unwired.

import { describe, test, expect } from 'bun:test'

import { createClient }  from '../../litestone/src/index.js'
import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import { auditPlugin, assertAuditModel, diffRows } from '../src/plugins/audit/index.ts'

const TRAIL = `
enum ActorKind { user api_key system support }

model AuditEvent {
  id           String    @id @default(uuid())
  workspaceId  String?
  actorId      String?
  actorType    ActorKind @default(user)
  onBehalfOfId String?
  action       String
  subjectType  String
  subjectId    String
  diff         Json?
  createdAt    DateTime  @default(now())
  @@gate(0)
}
`

const SCHEMA = `
${TRAIL}

model Server {
  id          String  @id
  workspaceId String?
  state       String
  password    String? @hashed
  contact     String? @personal(contact)
  sealed      String? @opaque
  @@gate(0)
}
`

async function harness(opts: { except?: string[] } = {}) {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA })
  const app = createApp({ db: db as never })
  app.services.register(createService({
    name:    'servers',
    model:   'Server',
    methods: ['find', 'get', 'create', 'patch', 'remove', 'drain', 'beat', { method: 'stats', read: true }, 'quiet', 'rotate'],
    async drain(ctx: any) { return (ctx.app.db.asSystem() as any).server.update({ where: { id: ctx.id }, data: { state: 'draining' } }) },
    async beat(ctx: any)  { ctx.dispatch = { ok: true }; return { ok: true } },
    async stats()         { return { count: 1 } },
    async quiet(ctx: any) { ctx.dispatch = false; return { ok: true } },
    // A row with a `data` column of its own: `raw.data ?? raw` would file the call under 'inner' (`FJS-2352`).
    async rotate(ctx: any) { ctx.dispatch = { id: ctx.id }; return { id: ctx.id, data: { id: 'inner' } } },
  } as never))
  app.configure(auditPlugin({
    model:   'AuditEvent',
    except:  opts.except ?? ['servers.beat'],
    columns: { workspaceId: (ctx, subject) => (ctx.locals.workspaceId as string | undefined) ?? subject?.workspaceId },
  }))
  await app._startForTest()
  const rows = async () => (db as any).asSystem().auditEvent.findMany({ orderBy: { createdAt: 'asc' } })
  return { app, db, rows }
}

describe('what is recorded', () => {

  test('a create, a patch and a remove each write a row, and a patch says what moved', async () => {
    const { app, rows } = await harness()
    await app.service('servers').create({ id: 's1', workspaceId: 'w1', state: 'up' })
    await app.service('servers').patch('s1', { state: 'down' })
    await app.service('servers').remove('s1')

    const all = await rows()
    expect(all.map((r: any) => r.action)).toEqual(['servers.create', 'servers.patch', 'servers.remove'])
    expect(all.every((r: any) => r.subjectId === 's1' && r.subjectType === 'servers')).toBe(true)
    expect(all[1].diff).toEqual({ state: { before: 'up', after: 'down' } })
    // The app's own column, read off the row the call touched.
    expect(all[1].workspaceId).toBe('w1')
    // No principal is a job acting for itself.
    expect(all[0].actorType).toBe('system')
    expect(all[0].actorId).toBeNull()
  })

  test('a custom method is a write until it declares `read: true`', async () => {
    const { app, rows } = await harness()
    await app.service('servers').create({ id: 's1', state: 'up' })
    await app.service('servers').call('drain', 's1')
    await app.service('servers').call('stats', null)

    const actions = (await rows()).map((r: any) => r.action)
    expect(actions).toContain('servers.drain')
    expect(actions).not.toContain('servers.stats')
  })

  test('a custom method answering a row with its own `data` column is filed under that row', async () => {
    const { app, rows } = await harness()
    await app.service('servers').create({ id: 's1', state: 'up' })
    await app.service('servers').call('rotate', 's1')
    expect((await rows())[1]).toMatchObject({ action: 'servers.rotate', subjectId: 's1' })
  })

  test('reads, `ctx.dispatch = false` and `except` are not recorded', async () => {
    const { app, rows } = await harness()
    await app.service('servers').create({ id: 's1', state: 'up' })
    await app.service('servers').find({})
    await app.service('servers').get('s1')
    await app.service('servers').call('quiet', null)
    await app.service('servers').call('beat', null)
    expect((await rows()).map((r: any) => r.action)).toEqual(['servers.create'])
  })
})

describe('who acted', () => {

  test('an API key is filed as api_key, not as the person holding it', async () => {
    const { app, rows } = await harness()
    await app.service('servers').create({ id: 's1', state: 'up' }, { user: { id: 'u1', userType: 'user', authMethod: 'apiKey' } } as never)
    const [row] = await rows()
    expect(row.actorType).toBe('api_key')
    expect(row.actorId).toBe('u1')
  })

  test('in support mode the operator is the actor and the subject is who it was done as', async () => {
    const { app, rows } = await harness()
    const user = { id: 'subject', userType: 'user', authMethod: 'session', support: { operatorId: 'op', episodeId: 'e', reason: 'r', endsAt: new Date() } }
    await app.service('servers').create({ id: 's1', state: 'up' }, { user } as never)
    const [row] = await rows()
    expect(row).toMatchObject({ actorType: 'support', actorId: 'op', onBehalfOfId: 'subject' })
  })
})

describe('what changed', () => {

  test('a protected column appears in the diff and its values never do', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA }) as any
    const diff = diffRows({ id: 's1', password: 'a', state: 'up' }, { id: 's1', password: 'b', state: 'up' }, db.$trailMarks('server'))
    expect(diff).toEqual({ password: { before: '[redacted]', after: '[redacted]' } })
  })

  // FJS-3599: litestone's own trail logs these as [personal] and a digest.
  test('a @personal column diffs as [personal] and an @opaque one as a digest of each side', async () => {
    const { app, db, rows } = await harness()
    await app.service('servers').create({ id: 's1', state: 'up', contact: 'ann@example.com', sealed: 'abc' })
    await app.service('servers').patch('s1', { contact: 'bob@example.com', sealed: 'abd' })

    const diff = (await rows())[1].diff
    expect(JSON.stringify(diff)).not.toMatch(/example\.com|abc|abd/)
    expect(diff.contact).toEqual({ before: '[personal]', after: '[personal]' })
    expect(diff.sealed.before).toMatch(/^\[opaque:[\w-]{12}\]$/)
    expect(diff.sealed.after).toMatch(/^\[opaque:[\w-]{12}\]$/)
    expect(diff.sealed.before).not.toBe(diff.sealed.after)

    // The hashed column is still named beside the two the trail only marks.
    expect(Object.keys((db as any).$trailMarks('server')).sort()).toEqual(['contact', 'password', 'sealed'])
  })
})

describe('the model is checked at boot', () => {

  const refused = async (schema: string, columns: string[] = []) => {
    const db = await createClient({ db: ':memory:', schema })
    try { assertAuditModel(db, 'AuditEvent', columns); return null } catch (e) { return (e as Error).message }
  }

  test('the trail model itself passes', async () => {
    expect(await refused(TRAIL, ['workspaceId'])).toBeNull()
  })

  test('a model that is not declared', async () => {
    expect(await refused('model Other { id String @id }')).toContain('is not declared')
  })

  test('a contract column missing', async () => {
    expect(await refused(TRAIL.replace(/^\s*subjectId.*$/m, ''))).toContain("declares no 'subjectId'")
  })

  test('actorId required, which a system call cannot fill', async () => {
    expect(await refused(TRAIL.replace('actorId      String?', 'actorId      String'))).toContain("'actorId' must be optional")
  })

  test('an actor enum missing a kind', async () => {
    expect(await refused(TRAIL.replace('enum ActorKind { user api_key system support }', 'enum ActorKind { user system }'))).toContain('has no api_key, support')
  })

  test('a required column nothing writes', async () => {
    expect(await refused(TRAIL.replace('workspaceId  String?', 'workspaceId  String'))).toContain("'workspaceId' is required and nothing writes it")
    expect(await refused(TRAIL.replace('workspaceId  String?', 'workspaceId  String'), ['workspaceId'])).toBeNull()
  })

  test('a supplied column the model does not declare, or one the trail writes itself', async () => {
    expect(await refused(TRAIL, ['tenantId'])).toContain("declares no 'tenantId'")
    expect(await refused(TRAIL, ['actorId'])).toContain('written by the trail itself')
  })

  test('an app booting with a broken model does not start', async () => {
    const db  = await createClient({ db: ':memory:', schema: 'model Other { id String @id  @@gate(0) }' })
    const app = createApp({ db: db as never })
    app.configure(auditPlugin({ model: 'AuditEvent' }))
    await expect(app._startForTest()).rejects.toThrow('is not declared')
  })
})
