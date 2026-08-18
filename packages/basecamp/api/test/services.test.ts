// api/test/services.test.ts
// The API tier, through @frontierjs/testing.
//
// db/test/schema.test.ts grades this app at the Data boundary and stops there.
// Everything between a principal and that boundary is derivation this app
// writes itself and nothing was executing it:
//
//   session → SessionContext → withWorkspaceStanding → memberRole
//           → basecampGateLevel → toDataPrincipal → the scoped client
//
// Four of those five steps are basecamp's, and a principal can arrive correct
// at every one of them and land wrong. `env.as(user).service(name)` is the same
// path a request takes, minus the socket.
//
// The app is the REAL one — `buildBasecampApp({ db, dbPath })` over the
// environment's own client, so the autoloader, the global hooks and every
// service factory are the ones production runs.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join }        from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin }  from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/core/app.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const ENC_KEY    = '0'.repeat(64)

let env: any
let ws: any, owner: any, developer: any, viewer: any, outsider: any

beforeAll(async () => {
  env = await createTestEnv({
    schema:        SCHEMA,
    migrations:    MIGRATIONS,
    encryptionKey: ENC_KEY,
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })

  const sys = env.system as any
  const uniq = () => Math.random().toString(36).slice(2, 8)

  const acct = await sys.account.create({ data: { slug: `acme-${uniq()}`, displayName: 'Acme' } })
  const mk = async (email: string) =>
    sys.user.create({ data: { email, accountId: acct.id } })

  const o = await mk(`owner-${uniq()}@x.co`)
  const d = await mk(`dev-${uniq()}@x.co`)
  const v = await mk(`view-${uniq()}@x.co`)
  const x = await mk(`out-${uniq()}@x.co`)

  ws = await sys.workspace.create({
    data: { accountId: acct.id, name: 'Fleet', slug: `fleet-${uniq()}`, ownerId: o.id },
  })
  for (const [u, role] of [[o, 'owner'], [d, 'developer'], [v, 'viewer']] as const)
    await sys.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role, acceptedAt: new Date().toISOString() } })

  // The workspace id rides on the SESSION here. resolveWorkspaceId() reads the
  // header first, then ?workspace_id, then the principal — and only the third
  // is available to a caller that is not going through HTTP.
  const at = (u: any) => session({ userId: u.id, workspaceId: ws.id })
  owner = at(o); developer = at(d); viewer = at(v)
  // A real account with no membership anywhere in this workspace — VISITOR(1).
  outsider = at(x)

  // A SECOND workspace with a project in it. Without one, "a member sees their
  // own workspace" is true of a database that has only one, which is a test
  // that cannot fail.
  const other = await sys.workspace.create({
    data: { accountId: acct.id, name: 'Other', slug: `other-${uniq()}`, ownerId: o.id },
  })
  await sys.project.create({
    data: { workspaceId: other.id, name: 'Elsewhere', slug: `else-${uniq()}` },
  })
}, 120_000)

afterAll(async () => { await env?.close() })

describe('standing is derived per request, from the membership row', () => {
  test('a developer creates a project and a viewer cannot', async () => {
    const made = await env.as(developer).service('projects').create({ name: 'Website', slug: `web-${Math.random().toString(36).slice(2, 8)}` })
    expect(made.name).toBe('Website')

    // requireWorkspaceRole is a hook, so this is a 403 rather than an empty
    // list — the difference between "you may not" and "there is nothing here".
    await expect(env.as(viewer).service('projects').create({ name: 'Nope', slug: 'nope' }))
      .rejects.toThrow()
  })

  test('a viewer still READS, which is the other half of the same ladder', async () => {
    const rows = await env.as(viewer).service('projects').find()
    expect(Array.isArray(rows.data ?? rows)).toBe(true)
    expect((rows.data ?? rows).length).toBeGreaterThan(0)
  })
})

describe('who sees what', () => {
  test('a non-member is refused BY NAME rather than shown an empty list', async () => {
    // The hazard CLAUDE.md names is that a policy FILTERS, so a caller outside
    // the workspace gets a working screen with nothing on it and no way to
    // tell that from "there is nothing here yet". This app answers it in the
    // hook — `scopeToWorkspace` says *You are not a member of this workspace*
    // and the row policy never has to. Asserting the message is the point: a
    // 403 with a vaguer sentence would pass a status check and lose the answer.
    await expect(env.as(outsider).service('projects').find())
      .rejects.toThrow(/not a member of this workspace/)
  })

  test('and a member sees their OWN workspace only — the policy, through the scoped client', async () => {
    // The second line of defence, reached by a caller the hook admits. Nothing
    // below the API boundary can grade this: the WHERE comes from the
    // principal `toDataPrincipal()` built, and it is compiled per request.
    const rows = await env.as(developer).service('projects').find()
    const list = rows.data ?? rows
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((p: any) => p.workspaceId === ws.id)).toBe(true)
    expect(list.some((p: any) => p.name === 'Elsewhere')).toBe(false)
  })

  test('a stranger — no principal at all — is refused at the transport', async () => {
    await expect(env.service('projects').find()).rejects.toThrow(/Authentication required/)
  })
})

describe('optimistic locking — the lost update, executed', () => {
  const slug = () => `lock-${Math.random().toString(36).slice(2, 8)}`

  test('two editors of one project: the second is refused, and the first survives', async () => {
    const dev  = () => env.as(developer).service('projects')
    const made = await dev().create({ name: 'Roadmap', slug: slug() })

    // Both people are looking at the same row. This is the whole scenario and
    // it has to be TWO reads: taking one row and patching it twice grades
    // nothing, because the second patch would carry the version the first
    // wrote.
    const alice = await dev().get(made.id)
    const bob   = await dev().get(made.id)
    expect(alice.version).toBe(bob.version)

    await dev().patch(made.id, { name: 'Roadmap Q3', version: alice.version })

    // 409, and retryable — the pair `isStaleWrite` reads to tell a race from a
    // domain refusal. A plain 409 would be indistinguishable from "you cannot
    // do that at all", which is the wrong sentence to put in front of someone
    // whose next action is to reload.
    const failed = await dev().patch(made.id, { name: 'Roadmap Q4', version: bob.version })
      .then(() => null, (e: any) => e)
    expect(failed).not.toBeNull()
    expect(failed.code ?? failed.status).toBe(409)
    expect(failed.data?.retryable ?? failed.retryable).toBe(true)

    // The half that matters: without the column BOTH writes land and the
    // second silently wins. Asserting the status alone would pass against a
    // boundary that refused the call and wrote the row anyway.
    const now = await dev().get(made.id)
    expect(now.name).toBe('Roadmap Q3')
    expect(now.version).toBe(alice.version + 1)
  })

  test('bob re-reads and his edit lands — a race is retryable, not a dead end', async () => {
    const dev  = () => env.as(developer).service('projects')
    const made = await dev().create({ name: 'Backlog', slug: slug() })

    const stale = await dev().get(made.id)
    await dev().patch(made.id, { name: 'Backlog v2', version: stale.version })

    const fresh   = await dev().get(made.id)
    const settled = await dev().patch(made.id, { name: 'Backlog v3', version: fresh.version })
    expect(settled.name).toBe('Backlog v3')
  })

  test('a patch carrying no version is a 400 that names the column', async () => {
    // The failure a hand-written client hits, and the one that tells it what
    // to send. A resource injects the version it read; a curl does not.
    const dev  = () => env.as(developer).service('projects')
    const made = await dev().create({ name: 'Notes', slug: slug() })

    await expect(dev().patch(made.id, { name: 'Notes 2' }))
      .rejects.toThrow(/version/i)
  })

  test('a patch that changes nothing does not bump, so it cannot make anyone else stale', async () => {
    // `version` rides on every patch of a versioned model, so counting it as a
    // change turns an untouched form into a write. Two people with the row
    // open, one of them pressing Save without editing, and the other is
    // refused for a change nobody made.
    const dev  = () => env.as(developer).service('projects')
    const made = await dev().create({ name: 'Ideas', slug: slug() })
    const read = await dev().get(made.id)

    await dev().patch(made.id, { version: read.version })
    expect((await dev().get(made.id)).version).toBe(read.version)
  })

  test('the models a machine also writes carry no version, and their patches still work', async () => {
    // Server is the named exclusion: an outpost heartbeat writes the row on its
    // own schedule, so a version would refuse an edit for a change the person
    // never made. Executed rather than asserted about the schema text — the
    // question is whether a patch with no version goes through.
    const dev  = () => env.as(developer).service('servers')
    const made = await dev().create({
      name: 'edge-1', slug: slug(), hostname: `edge-${Math.random().toString(36).slice(2, 8)}.test`,
      role: 'general', provider: 'manual',
    })
    expect(made.version).toBeUndefined()

    const patched = await dev().patch(made.id, { name: 'edge-1a' })
    expect(patched.name).toBe('edge-1a')
  })
})

describe('what a mutation announced', () => {
  test('a service create announces; arranging below the boundary does not', async () => {
    const t = env.phases({ as: developer })

    // Cleared by hand FIRST. The buffer is cleared when `act` begins, not when
    // `arrange` does — so a read taken between the two still holds whatever
    // earlier tests announced, and asserting 0 there passes or fails on test
    // ORDER rather than on anything this test is about.
    env.clearAnnounced()

    // arrange writes through asSystem(), so no service runs and nothing
    // announces. That is correct, and it is the reason `announced()` is scoped
    // to the act rather than to the test.
    await t.arrange(async ({ system }: any) => {
      await (system as any).project.create({ data: { workspaceId: ws.id, name: 'Seeded', slug: `seed-${Math.random().toString(36).slice(2, 8)}` } })
    })
    expect(env.announced()).toHaveLength(0)

    await t.act(() => env.as(developer).service('projects').create({ name: 'Announced', slug: `ann-${Math.random().toString(36).slice(2, 8)}` }))
    expect(env.announced('projects:created')).toHaveLength(1)
  })
})

describe('the HTTP pipeline answers the same app', () => {
  test('an unauthenticated request is refused at the transport, not in a service', async () => {
    const res = await env.http.get('/projects')
    expect([401, 403]).toContain(res.status)
  })
})

// ─── Transport parity ────────────────────────────────────────────────────────
// A service is reachable two ways and the two paths share almost nothing: HTTP
// goes URL → router → bridge.toContext(), WebSocket goes frame → channels() →
// bridge.internal(). Everything the first DERIVES from a request — the id, the
// filters, the $-directives, the method — the second lifts out of a JSON object
// by hand, and nothing else in this app puts the same call down both.
//
// Its own env, because this is the only test here that binds a port.

describe('the two transports answer the same app', () => {
  let penv: any
  let token: string

  beforeAll(async () => {
    penv = await createTestEnv({
      schema:        SCHEMA,
      migrations:    MIGRATIONS,
      encryptionKey: ENC_KEY,
      plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
      listen:        true,
      api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
    })

    // A REAL session, issued by the app's own auth: the parity runner speaks to
    // the running server over both transports, so a synthetic principal object
    // cannot cross either. The workspace claim rides on the session because
    // resolveWorkspaceId() falls through to the principal.
    const sys  = penv.system as any
    const uniq = () => Math.random().toString(36).slice(2, 8)
    const acct = await sys.account.create({ data: { slug: `p-${uniq()}`, displayName: 'Parity' } })
    const email = `parity-${uniq()}@x.co`
    const user  = await penv.app.auth.createUser({ email, password: 'hunter2hunter2', name: 'Parity' })
    await sys.user.update({ where: { id: user.id ?? user.userId }, data: { accountId: acct.id } })
    const wsp = await sys.workspace.create({
      data: { accountId: acct.id, name: 'Parity', slug: `pw-${uniq()}`, ownerId: user.id ?? user.userId },
    })
    await sys.workspaceMember.create({
      data: { workspaceId: wsp.id, userId: user.id ?? user.userId, role: 'owner', acceptedAt: new Date().toISOString() },
    })
    const login = await penv.app.auth.login(email, 'hunter2hunter2')
    token = login.token ?? login.accessToken
  }, 120_000)

  afterAll(async () => { await penv?.close() })

  test('every derived call agrees, for a member and for a stranger', async () => {
    const found = await penv.verifyTransportParity({
      as: [{ label: 'owner', token }, { label: 'anonymous' }],
      only: ['projects'],
    })
    // A mismatch names both answers, so the message IS the report.
    expect(found.map((m: any) => m.message ?? JSON.stringify(m))).toEqual([])
  }, 180_000)
})
