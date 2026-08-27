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
import { signRequest } from '@frontierjs/toolbelt/signature'
import { GatePlugin }  from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { grantsFor, grantsWithin } from '../src/core/capabilities.ts'
import { refuseGrantAboveOwn }    from '../src/core/hooks.ts'
import { MEMBERSHIP }             from '@frontierjs/junction'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const ENC_KEY    = '0'.repeat(64)

let env: any
let ws: any, owner: any, developer: any, viewer: any, outsider: any
// The hub tier. Not a member of any workspace — `isSystemAdmin` sits ABOVE
// membership, which is what the four `@@tenant(none)` services are reached at.
let sysadmin: any
// A machine of its own, so the signature tests do not move a server another
// test is asserting the status of.
let machine: any

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
  // Stamped through the app's own table rather than by hand: a fixture that
  // invents its own grants tests a grid nothing in production produces.
  for (const [u, role] of [[o, 'owner'], [d, 'developer'], [v, 'viewer']] as const)
    await sys.workspaceMember.create({ data: {
      workspaceId: ws.id, userId: u.id, role,
      capabilities: grantsFor(role), acceptedAt: new Date().toISOString(),
    } })

  // The workspace id rides on the SESSION here. resolveWorkspaceId() reads the
  // header first, then ?workspace_id, then the principal.
  const at = (u: any) => session({ userId: u.id, workspaceId: ws.id })
  owner = at(o); developer = at(d); viewer = at(v)
  // A real account with no membership anywhere in this workspace — VISITOR(1).
  outsider = at(x)

  // A sysadmin, and deliberately WITHOUT a workspace on the session: the hub
  // tier is not a membership, and every service that takes no workspace has to
  // be reachable without naming one. If `tenantClaimGuard` ever stopped
  // exempting a `@@tenant(none)` service, this is what would go red.
  const a = await mk(`sys-${uniq()}@x.co`)
  await sys.user.update({ where: { id: a.id }, data: { isSystemAdmin: true } })
  sysadmin = session({ userId: a.id, isSystemAdmin: true })

  // The machine the outpost-signature tests check in as. Its own row, so those
  // tests never move a server another test is asserting the status of.
  machine = await sys.server.create({
    data: { workspaceId: ws.id, name: 'outpost-01', slug: `outpost-${uniq()}`, status: 'pending' },
  })

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
      data: { workspaceId: wsp.id, userId: user.id ?? user.userId, role: 'owner',
              capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString() },
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

describe('?workspace_id= — the documented fallback, which had never worked', () => {
  // `autoFilter` grades ctx.query against the model's columns and no model has
  // a `workspace_id`, so the fallback was refused with *Unknown filter key
  // 'workspace_id' — did you mean 'workspaceId'?* before resolveWorkspaceId
  // ever ran, and the app could not fix it from its own side: $-names are
  // directives and everything else is a column, so there was no third answer
  // (`FJS-337`). Every workspace-scoped service now reserves the key, which
  // moves it to ctx.reserved and leaves ctx.query as columns alone.

  test('a principal carrying no workspace resolves one from the query', async () => {
    const sys  = env.system as any
    const uniq = Math.random().toString(36).slice(2, 8)
    const acct = await sys.account.findFirst({ where: {} })
    const u    = await sys.user.create({ data: { email: `q-${uniq}@x.co`, accountId: acct.id } })
    await sys.workspaceMember.create({
      data: { workspaceId: ws.id, userId: u.id, role: 'developer',
              capabilities: grantsFor('developer'), acceptedAt: new Date().toISOString() },
    })

    // No workspaceId on the session — the third fallback cannot answer, so the
    // query is the only thing that can.
    const bare = session({ userId: u.id })

    const rows = await env.as(bare).service('projects').find({ workspace_id: ws.id })
    expect(Array.isArray(rows.data ?? rows)).toBe(true)
  })

  test('and the same call without it is refused rather than answered wrongly', async () => {
    const sys  = env.system as any
    const uniq = Math.random().toString(36).slice(2, 8)
    const acct = await sys.account.findFirst({ where: {} })
    const u    = await sys.user.create({ data: { email: `q2-${uniq}@x.co`, accountId: acct.id } })
    const bare = session({ userId: u.id })

    // Refused by `tenantClaimGuard` now rather than by `requireWorkspace`: the
    // schema declares row tenancy, so junction installs a guard that fires
    // app-level, ahead of any service hook, for exactly this case — a signed-in
    // caller whose principal carries no claim, whose every read would otherwise
    // be an empty list with a 200. The app's own sentence still covers the
    // services that are not row-scoped — and it is not lost here either: the
    // two ways to name a workspace reach the refusal through `namedBy`.
    await expect(env.as(bare).service('projects').find())
      .rejects.toThrow(/names no 'workspaceId'.*X-Workspace-Id header or \?workspace_id=/)
  })

  test('a filter the service honours still filters beside it', async () => {
    // The reservation takes ONE declared name out of the filter set and must
    // not take the rest with it. `status` rather than `name` because this
    // service builds its own where from `status` alone — a query key it does
    // not read reaches no SQL, which is basecamp's shape and not this hole.
    const all    = await env.as(owner).service('projects').find({ workspace_id: ws.id })
    const active = await env.as(owner).service('projects').find({ workspace_id: ws.id, status: 'archived' })

    const rows = (r: any) => r.data ?? r
    expect(rows(all).length).toBeGreaterThan(0)
    expect(rows(active).every((r: any) => r.status === 'archived')).toBe(true)
    expect(rows(active).length).toBeLessThan(rows(all).length)
  })

  test('an unknown key beside it is still a 400 naming it', async () => {
    // autoFilter must keep working on what is left — the reservation is a hole
    // for one declared name, not an amnesty.
    await expect(env.as(owner).service('projects').find({ workspace_id: ws.id, bogusColumn: 7 }))
      .rejects.toThrow(/bogusColumn/)
  })
})

// ─── The application trail ───────────────────────────────────────────────────
// `AuditEvent.diff` is `Json?` and nothing wrote it, so the trail could say a
// server was drained and not what state it was in (FJS-154). The row-level
// `@@log(audit)` JSONL carries before/after on the host; the application trail,
// which is the one the UI reads, did not.
describe('the audit trail records what changed', () => {
  test('a custom method writes a before/after diff', async () => {
    const sys = env.system as any

    const server = await sys.server.create({
      data: { workspaceId: ws.id, name: 'audit-01', slug: `audit-${Math.random().toString(36).slice(2, 8)}`, status: 'online' },
    })

    // `call(name, id, data, opts)` is the server-side spelling of a custom
    // method — `invoke` is the browser client's.
    await env.as(owner).service('servers').call('drain', server.id)
    // The write is awaited inside the hook, but the hook is an `after` — yield
    // once so the row is queryable.
    await new Promise(r => setImmediate(r))

    const rows = await sys.auditEvent.findMany({
      where:   { action: 'servers.drain', subjectId: server.id },
      orderBy: { createdAt: 'desc' },
    })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].diff).toBeTruthy()
    expect(rows[0].diff.status).toEqual({ before: 'online', after: 'draining' })
  })

  test('a protected column reports that it changed and never what to', async () => {
    // `Secret.value` is `@encrypted`: the trail must say the value moved and
    // must not be a second, plaintext copy of it. The list of protected columns
    // is litestone's own reading of the schema (`$protectedFields`), so a new
    // `@secret` is covered without an edit here.
    const before = await env.as(owner).service('secrets').create({
      name: `TRAIL_${Math.random().toString(36).slice(2, 8)}`, kind: 'generic', data: 'first-value',
    })
    const created = ((before as any).data ?? before) as Record<string, unknown>

    // `Secret.version` is `@version`, so an update states the revision it read.
    await env.as(owner).service('secrets').patch(created.id as string,
      { data: 'second-value', version: created.version })
    const id = created.id as string
    await new Promise(r => setImmediate(r))

    const rows = await (env.system as any).auditEvent.findMany({
      where:   { action: 'secrets.patch', subjectId: id },
      orderBy: { createdAt: 'desc' },
    })
    expect(rows.length).toBeGreaterThan(0)
    // `data` is the COLUMN — `value` is what the service takes and what it
    // encrypts into `Secret.data`. The trail records columns.
    const changed = rows[0].diff as Record<string, { before: unknown; after: unknown }>
    expect(changed.data).toEqual({ before: '[redacted]', after: '[redacted]' })
    expect(JSON.stringify(changed)).not.toContain('second-value')
    expect(JSON.stringify(changed)).not.toContain('first-value')
  })
})

// ─── The endpoints a MACHINE calls ───────────────────────────────────────────
// `servers.heartbeat`, `volumes.report` and `cleanup.report` are exempted from
// sessionScope because an outpost holds no session. Until 2026-08-19 that
// exemption was the whole of the authentication and a comment claimed the
// transport verified an HMAC — nothing did (`FJS-349`). Measured against a
// running API at the time: an unsigned POST moved a server to `online` and
// registered its Conduit target at an address the caller chose, which points
// every later /exec, /deploy and /system/prune for that machine at a host the
// caller owns, signed with this app's own secret.
describe('an outpost endpoint takes a signature or nothing', () => {
  const SECRET = process.env.OUTPOST_SECRET ?? 'outpost-dev-secret'

  /** The same headers conduit sends, from the same module it signs with. */
  async function signed(path: string, body: unknown) {
    return signRequest({
      secret: SECRET, method: 'POST', path, body: JSON.stringify(body),
      // Stated, because the kit is pure and takes neither.
      timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
    })
  }

  test('unsigned is refused, and it is a 401 rather than a service error', async () => {
    const res = await env.http.post(`/servers/${machine.id}`)
      .set('x-service-method', 'heartbeat')
      .send({ outpost_version: '9.9.9', outpost_url: 'http://attacker.invalid' })
    expect(res.status).toBe(401)

    const after = await (env.system as any).server.findUnique({ where: { id: machine.id } })
    expect(after.status).toBe('pending')
    expect(after.outpostVersion).toBeNull()
  })

  test('signed is accepted', async () => {
    const body = { outpost_version: '0.4.1', health: { cpu: 4, memory: 20 } }
    const req  = env.http.post(`/servers/${machine.id}`).set('x-service-method', 'heartbeat')
    for (const [k, v] of Object.entries(await signed(`/servers/${machine.id}`, body))) req.set(k, v)

    const res = await req.send(body)
    expect(res.status).toBe(200)

    const after = await (env.system as any).server.findUnique({ where: { id: machine.id } })
    expect(after.status).toBe('online')
    expect(after.outpostVersion).toBe('0.4.1')
  })

  test('a signature does not move to another endpoint', async () => {
    // The one that matters: /health-check is harmless and /exec runs a shell
    // command, so a signature bound to the path is what stops the first
    // becoming the second.
    const body = { server_id: machine.id, volumes: [] }
    const req  = env.http.post('/volumes').set('x-service-method', 'report')
    for (const [k, v] of Object.entries(await signed(`/servers/${machine.id}`, body))) req.set(k, v)

    expect((await req.send(body)).status).toBe(401)
  })

  test('the body cannot be swapped under a good signature', async () => {
    const honest = { outpost_version: '0.4.1', outpost_url: 'http://outpost.internal:7810' }
    const req    = env.http.post(`/servers/${machine.id}`).set('x-service-method', 'heartbeat')
    for (const [k, v] of Object.entries(await signed(`/servers/${machine.id}`, honest))) req.set(k, v)

    expect((await req.send({ ...honest, outpost_url: 'http://attacker.invalid' })).status).toBe(401)
  })

  // ── replay ──────────────────────────────────────────────────────────
  // The fifth refusal, and the only one with a lifetime: the other four are
  // decidable from the request alone, where this one needs memory of what has
  // already arrived (`FJS-376`).

  test('a captured request replayed is refused, and the first one still worked', async () => {
    const body  = { outpost_version: '0.4.2', health: { cpu: 2, memory: 8 } }
    const path  = `/servers/${machine.id}`
    const heads = await signed(path, body)

    const send = () => {
      const req = env.http.post(path).set('x-service-method', 'heartbeat')
      for (const [k, v] of Object.entries(heads)) req.set(k, v)
      return req.send(body)
    }

    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(401)
  })

  test('the memory is the DATABASE, which is what a second replica shares', async () => {
    // The proof that the store is not a per-process Map: this nonce is written
    // straight into the table and nothing in THIS process has ever verified a
    // signature carrying it. A Map would have no idea and let it through —
    // which is exactly what a second replica used to do with a request
    // captured at the first, and what a restart used to do inside the window.
    const sys   = env.system as any
    const nonce = crypto.randomUUID()
    await sys.outpostNonce.create({ data: { nonce } })

    const body = { outpost_version: '0.4.3' }
    const path = `/servers/${machine.id}`
    const req  = env.http.post(path).set('x-service-method', 'heartbeat')
    const hs   = await signRequest({
      secret: SECRET, method: 'POST', path, body: JSON.stringify(body),
      timestamp: Math.floor(Date.now() / 1000), nonce,
    })
    for (const [k, v] of Object.entries(hs)) req.set(k, v)

    expect((await req.send(body)).status).toBe(401)
  })

  test('a spent nonce is swept once it can no longer be replayed', async () => {
    // The table only has to remember as long as the signature is live — five
    // minutes — and the sweep runs on write rather than on a timer, so there is
    // no clock to own and nothing grows while nothing is arriving.
    const sys  = env.system as any
    const old  = crypto.randomUUID()
    await sys.outpostNonce.create({
      data: { nonce: old, seenAt: new Date(Date.now() - 3_600_000).toISOString() },
    })

    const body = { outpost_version: '0.4.4' }
    const path = `/servers/${machine.id}`
    const req  = env.http.post(path).set('x-service-method', 'heartbeat')
    for (const [k, v] of Object.entries(await signed(path, body))) req.set(k, v)
    expect((await req.send(body)).status).toBe(200)

    expect(await sys.outpostNonce.findUnique({ where: { nonce: old } })).toBeNull()
  })
})

// ─── Nobody grades themselves, and nobody grants above their own standing ────
// `WorkspaceMember.role` is the column core/gate.ts reads every level from, so
// the three methods that write it are the three methods that write standing.
//
// The schema denies a self-update at the Data boundary (`FJS-410`), and that is
// what covers a job, a hub screen and a `fli tinker` session — but not these:
// membership is what decides access, so it cannot be read through the caller it
// is deciding about, and all three writers go through `asSystem()`, the one
// context every policy is bypassed in. Measured before the fix, through this
// harness: an admin naming their own userId with `role: 'owner'` got no throw,
// a 200, and OWNER(6).
//
// So the assertions are the answer AND the row after it, never a throw alone:
// the version of this that fails is silent.
describe('a workspace role is not a thing you may hand yourself', () => {
  const uniq = () => Math.random().toString(36).slice(2, 8)

  /** An administrator of `ws`, plus a developer for them to act on. */
  async function team() {
    const sys = env.system as any
    const wsRow = await sys.workspace.findUnique({ where: { id: ws.id } })
    const mk = async (role: string) => {
      const u = await sys.user.create({ data: { email: `${role}-${uniq()}@x.co`, accountId: wsRow.accountId } })
      await sys.workspaceMember.create({
        data: { workspaceId: ws.id, userId: u.id, role, acceptedAt: new Date().toISOString() } })
      return u
    }
    const admin = await mk('admin')
    const pat   = await mk('developer')
    return { admin, adminS: session({ userId: admin.id, workspaceId: ws.id }), pat }
  }

  const roleOfMember = async (userId: string) =>
    (await (env.system as any).workspaceMember.findFirst({ where: { workspaceId: ws.id, userId } })).role

  test('an admin cannot move their own role', async () => {
    const { admin, adminS } = await team()

    // Lateral, not up: the grant-above rule below would refuse `owner` first,
    // and then this case would be proving that rule twice instead of this one.
    await expect(env.as(adminS).service('workspaces')
      .call('setMemberRole', ws.id, { userId: admin.id, role: 'admin' }))
      .rejects.toThrow(/your own role/)

    expect(await roleOfMember(admin.id)).toBe('admin')
  })

  test('…nor hand somebody else a role above their own', async () => {
    // The second door. An admin who cannot promote themselves can promote a
    // puppet and sign in as it, so *not your own row* is not the whole rule.
    const { adminS, pat } = await team()

    await expect(env.as(adminS).service('workspaces')
      .call('setMemberRole', ws.id, { userId: pat.id, role: 'owner' }))
      .rejects.toThrow(/cannot grant the owner role/)

    expect(await roleOfMember(pat.id)).toBe('developer')
  })

  test('…nor invite one, which is the same grant with no account yet', async () => {
    // The third door, and the one with no membership row to deny: an invitation
    // carries a role across the gap where there is no user to hang it on.
    const { adminS } = await team()

    await expect(env.as(adminS).service('invitations')
      .create({ email: `owner-${uniq()}@x.co`, role: 'owner' }))
      .rejects.toThrow(/cannot grant the owner role/)
  })

  test('…nor one SIDEWAYS — a peer on the ladder is not a subset of you', async () => {
    // `FJS-529`, and the case a level comparison structurally cannot see:
    // `billing` and `developer` are both *below admin* on one axis, so
    // `ROLE_LEVEL[granted] > ROLE_LEVEL[mine]` is false and the ordinal guard
    // passes while the two GRIDS contain neither the other.
    //
    // Asked of the RULE rather than staged as a scenario, and deliberately.
    // basecamp has no live sideways pair today: `billing` holds nothing (there
    // is no billing model yet), `admin` and `owner` hold the same grid, and
    // nobody below admin may manage the team at all — so every arrangement of
    // real roles is either legitimate or refused by `requireWorkspaceRole`
    // before this hook is reached. The rule is live now and the app that trips
    // it is one schema change away, which is exactly when a test nobody wrote
    // would have been wanted.
    expect(grantsWithin(['Server.drain'], ['Server.reboot'])).toEqual(['Server.drain'])
    expect(grantsWithin(['Server.reboot'], ['Server.drain'])).toEqual(['Server.reboot'])
    // The negative control: holding it is holding it.
    expect(grantsWithin(['Server.reboot'], ['Server.reboot', 'Server.drain'])).toEqual([])

    // And the hook applies it over BOTH spellings a payload can use, so the two
    // cannot drift into disagreeing about one grant.
    const guard = refuseGrantAboveOwn()
    const asDeveloper = (data: unknown) => ({
      data, locals: { [MEMBERSHIP]: { role: 'developer' } },
    } as unknown as Parameters<typeof guard>[0])

    expect(() => guard(asDeveloper({ capabilities: ['Server.drain'] })))
      .toThrow(/do not hold it yourself/)
    expect(() => guard(asDeveloper({ role: 'admin' }))).toThrow()
    // Their own grid, either way, is not an escalation.
    expect(() => guard(asDeveloper({ capabilities: ['Server.reboot'] }))).not.toThrow()
    expect(() => guard(asDeveloper({ role: 'developer' }))).not.toThrow()
  })

  test('an admin still manages the team at their own level', async () => {
    // The direction that must keep working — a rule that refused this would be
    // caught in a screen rather than here.
    const { adminS, pat } = await team()

    await env.as(adminS).service('workspaces').call('setMemberRole', ws.id, { userId: pat.id, role: 'admin' })
    expect(await roleOfMember(pat.id)).toBe('admin')

    await env.as(adminS).service('invitations').create({ email: `dev-${uniq()}@x.co`, role: 'developer' })
  })

  test('…nor demote a member who outranks them', async () => {
    // The inversion pointed the other way. `Cannot demote the last owner` only
    // catches this where there happens to be exactly one, so a workspace with
    // two owners had an admin able to remove either from the tier above them.
    const { adminS } = await team()
    const sys   = env.system as any
    const wsRow = await sys.workspace.findUnique({ where: { id: ws.id } })
    const second = await sys.user.create({ data: { email: `own2-${uniq()}@x.co`, accountId: wsRow.accountId } })
    await sys.workspaceMember.create({
      data: { workspaceId: ws.id, userId: second.id, role: 'owner',
              capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString() } })

    await expect(env.as(adminS).service('workspaces')
      .call('setMemberRole', ws.id, { userId: second.id, role: 'developer' }))
      .rejects.toThrow(/role of an owner/)

    expect(await roleOfMember(second.id)).toBe('owner')
  })

  test('and the collection-level call reaches no row at all', async () => {
    // A custom method may address the COLLECTION (`invoke(name, null, data)` —
    // `FJS-122`), which is the shape that runs no `$.id` through
    // `stampSelfAsWorkspace`. Measured rather than reasoned about, because the
    // question is what litestone does with `where: { workspaceId: undefined }`:
    // dropped, it would match a membership in ANY workspace through a system
    // client. It matches nothing.
    const { adminS } = await team()
    const o = await (env.system as any).workspaceMember.findFirst({ where: { workspaceId: ws.id, role: 'owner' } })

    await expect(env.as(adminS).service('workspaces')
      .call('setMemberRole', undefined, { userId: o.userId, role: 'viewer' }))
      .rejects.toThrow(/Member not found|role of an owner/)

    expect(await roleOfMember(o.userId)).toBe('owner')
  })

  test('an owner still grants owner', async () => {
    const { pat } = await team()

    await env.as(owner).service('workspaces').call('setMemberRole', ws.id, { userId: pat.id, role: 'owner' })
    expect(await roleOfMember(pat.id)).toBe('owner')
  })
})

// ─── What a job runs as, and what it may touch ───────────────────────────────
// `FJS-384`. Five handlers opened `app.data.asSystem()` behind a comment saying
// a job has no caller to scope to. It has one: caravan records the actor and
// the tenant at dispatch, junction re-binds both through `app.runAs`, and the
// membership is re-read when the job runs.
//
// What that CANNOT change is which rows may be written — `RecipeRun`,
// `DeploymentStep`, `CleanupRun` and `JobRun` are gated at SYSTEM for update,
// the schema saying an outcome belongs to the machine, and no standing a
// workspace grants reaches them (`owner` is 6). So what the conversion buys is
// the CONFINEMENT, and that is what these cases are about: the engine methods
// read their parent through the caller's own client, so a row in another
// workspace answers nothing where an id off a payload used to be written
// wherever it pointed.
describe('a job runs as whoever asked for it', () => {
  const uniq = () => Math.random().toString(36).slice(2, 8)

  /** A second workspace, with a machine and a recipe run of its own. */
  async function elsewhere() {
    const sys = env.system as any
    const acct = await sys.account.create({ data: { slug: `other-${uniq()}`, displayName: 'Other' } })
    const u    = await sys.user.create({ data: { email: `o-${uniq()}@x.co`, accountId: acct.id } })
    const w    = await sys.workspace.create({
      data: { accountId: acct.id, name: 'Elsewhere', slug: `else-${uniq()}`, ownerId: u.id } })
    await sys.workspaceMember.create({
      data: { workspaceId: w.id, userId: u.id, role: 'owner',
              capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString() } })
    const server = await sys.server.create({
      data: { workspaceId: w.id, name: 'far-01', slug: `far-${uniq()}`, status: 'online' } })
    const recipe = await sys.recipe.create({
      data: { workspaceId: w.id, name: 'Far', slug: `far-${uniq()}`, script: 'echo far' } })
    const run = await sys.recipeRun.create({
      data: { recipeId: recipe.id, serverId: server.id, script: 'echo far', status: 'pending' } })
    return { workspace: w, run }
  }

  test('a handler cannot open a run in another workspace', async () => {
    // The confinement, executed. `owner` in `ws` is the highest standing this
    // app grants and it is still nothing here: `RecipeRun` reaches its tenant
    // through Recipe and Server, so the scoped read answers no row and the
    // system write below it never happens.
    const far = await elsewhere()

    const mine = await (env.system as any).workspaceMember.findFirst({
      where: { workspaceId: ws.id, role: 'owner' } })

    await expect(env.app.runAs(mine.userId, { tenant: ws.id }, () =>
      env.app.service('recipes').call('startRun', far.run.id)))
      .rejects.toThrow(/not found/i)

    // Still pending: nothing was written by an id that pointed elsewhere.
    const after = await (env.system as any).recipeRun.findUnique({ where: { id: far.run.id } })
    expect(after.status).toBe('pending')
  })

  test('…and the owner of THAT workspace can', async () => {
    // The other direction, so the case above is proving a boundary rather than
    // a broken method.
    const far = await elsewhere()
    const member = await (env.system as any).workspaceMember.findFirst({
      where: { workspaceId: far.workspace.id } })

    const opened = await env.app.runAs(member.userId, { tenant: far.workspace.id }, () =>
      env.app.service('recipes').call('startRun', far.run.id)) as { runId: string; script: string }

    expect(opened.runId).toBe(far.run.id)
    expect((await (env.system as any).recipeRun.findUnique({ where: { id: far.run.id } })).status)
      .toBe('running')
  })

  test('an engine method is not reachable over the wire', async () => {
    // `internalOnly`, and the case has to hold the principal STILL while moving
    // the transport — a 401 from an anonymous fetch would prove the session
    // hook and nothing about this one. The method is declared surface (junction
    // answers 405 to a name `methods:` leaves out, in-process included), so
    // what keeps a person from writing their own run history is this hook
    // rather than an absence.
    const far = await elsewhere()
    const member = await (env.system as any).workspaceMember.findFirst({
      where: { workspaceId: far.workspace.id } })

    const overWire = env.app.runAs(member.userId, { tenant: far.workspace.id }, () =>
      env.app.service('recipes').call('startRun', far.run.id, {}, { transport: 'http' }))

    await expect(overWire).rejects.toThrow(/not found/i)
    expect((await (env.system as any).recipeRun.findUnique({ where: { id: far.run.id } })).status)
      .toBe('pending')
  })
})

// ─── The declaration itself ──────────────────────────────────────────────────
// The dispatch site declares and the handler asserts. These two cases are the
// assert half: they are what stops a handler that wanted a caller, found none,
// and helped itself to system — which is exactly how the old shape was built.
describe('a handler declares who it runs as', () => {
  test('runsAsCaller refuses when the queue recorded no actor', async () => {
    const { runsAsCaller } = await import('../src/jobs/context.ts')

    // No `runAs` around it: this is a dispatch made outside a request that
    // forgot to state an actor, which is the shape that used to run at SYSTEM
    // against rows nobody had checked it may touch.
    expect(() => runsAsCaller({ app: env.app } as any, 'recipe:run'))
      .toThrow(/no actor/)
  })

  test('runsAsApp refuses when it recorded one', async () => {
    const { runsAsApp } = await import('../src/jobs/context.ts')
    const mine = await (env.system as any).workspaceMember.findFirst({
      where: { workspaceId: ws.id, role: 'owner' } })

    // The other direction, and it is not symmetry for its own sake: somebody
    // asked for this work, and running their request as the app is the
    // escalation the first case prevents, pointed the other way.
    await env.app.runAs(mine.userId, { tenant: ws.id }, () => {
      expect(() => runsAsApp({ app: env.app } as any, 'job:run'))
        .toThrow(/recorded actor/)
    })
  })
})

// ─── The proxy in front of it ────────────────────────────────────────────────
// `web/config/api-paths.js` decides what the dev proxy and the deploy's Caddy
// config send to the API. It used to be a hand-kept list and went stale six
// times; it now parses `surface.snapshot.md`. That moves the failure rather
// than removing it — a change to junction's output shape would leave the parse
// finding fewer paths and saying nothing, which is the same silence one layer
// along (`FJS-375`).
//
// So the derivation is graded against the RUNNING app rather than against the
// file it read. The snapshot itself is CI's job (the `snapshots` phase reruns
// `junction surface --check`); what this asks is whether the parse of it still
// answers what the router actually mounted.
describe('the proxy path list is what the app mounts', () => {
  test('every mounted service and raw route is proxied, and the shell is not', async () => {
    const { API_PATHS, WS_PATH } = await import('../../web/config/api-paths.js')
    const { buildRoutes }        = await import('@frontierjs/junction/manifest')

    const derived = new Set(API_PATHS)

    // Every service, including the ones a PLUGIN registered. Three of the six
    // stalenesses were these — `connections` is junction's channels plugin,
    // `account`/`sessions` are auth's, `conduit-targets` is conduit's — and
    // nothing in this app's source names any of them.
    for (const name of env.app.services.list())
      expect(derived).toContain(`/${name}`)

    // Every hand-registered route, by the one segment it is proxied under.
    for (const r of buildRoutes(env.app)) {
      if (r.kind !== 'raw') continue
      if (r.path === '/' || r.path.includes('*') || r.path.includes('{')) continue
      expect(derived).toContain('/' + r.path.split('/')[1])
    }

    // `/` is mounted (staticRoutes serves the built SPA) and must never be
    // proxied — the shell request would be answered by the API.
    expect(derived).not.toContain('/')
    expect(derived).not.toContain('/*')

    // The socket is not in any router — the channels plugin upgrades in the
    // transport — so it is stated rather than derived, and nothing can find it
    // missing except this.
    expect(WS_PATH).toBe('/ws')
  })

  test('a prefix would retire the list rather than break it', async () => {
    // The durable fix `FJS-375` names is an apiPrefix, at which point one rule
    // covers everything and there is no ambiguity to resolve. Asserted here so
    // adopting it is a config change and not also a proxy rewrite.
    expect(env.app.config.apiPrefix ?? '').toBe('')
  })
})

// ─── The catalogue, and the four services that take no workspace ─────────────
// `Blueprint`, `HubConfig`, `Backup` and `NotificationPreference` are all
// `@@tenant(none)`, which means junction's `tenantClaimGuard` exempts them —
// `isRowScoped(db, service)` is false, so a caller with no workspace claim is
// not refused. That exemption is load-bearing and invisible: it lives in
// junction, keyed off this app's schema, and nothing in either file names the
// other. These tests are what would catch it moving.

describe('the catalogue takes no workspace', () => {
  test('a caller with no membership anywhere can read it', async () => {
    // `outsider` is authenticated and belongs to nothing — VISITOR(1), which is
    // exactly what `@@gate("1.7")` admits. Through a workspace-scoped service
    // the same principal is refused by name ("not a member of this workspace"),
    // so this is the tenancy exemption and not a weak gate.
    const list = await env.as(outsider).service('blueprints').find()
    expect(Array.isArray(list.data)).toBe(true)
  })

  test('and writing it is the hub tier, not a workspace role', async () => {
    // An OWNER of a workspace — the highest standing a workspace grants — is
    // still refused, because the catalogue belongs to the installation.
    await expect(env.as(owner).service('blueprints').create({
      name: 'Nope', slug: 'nope', category: 'Database',
      description: 'x', version: '1', image: 'nope:1',
    })).rejects.toThrow()
  })

  test('a sysadmin creates one, and its params come back in the order they were sent', async () => {
    const made = await env.as(sysadmin).service('blueprints').create({
      name: 'Redis', slug: `redis-${Math.random().toString(36).slice(2, 8)}`,
      category: 'Cache', description: 'In-memory store', version: '7.2',
      image: 'redis:7.2-alpine', appType: 'container', port: 6379,
    })
    expect(made.port).toBe(6379)
    expect(made.params).toEqual([])

    const bp = await env.as(sysadmin).service('blueprints').call('setParams', made.id, {
      params: [
        { key: 'REDIS_PASSWORD', label: 'Password', secret: true },
        { key: 'MAXMEMORY',      label: 'Max memory', defaultValue: '256mb' },
      ],
    })
    expect(bp.params.map((p: any) => p.key)).toEqual(['REDIS_PASSWORD', 'MAXMEMORY'])
    expect(bp.params.map((p: any) => p.position)).toEqual([0, 1])
    expect(bp.params[0].secret).toBe(true)

    // Replaced whole and REORDERED — the case a per-row patch cannot do without
    // racing every other row's position.
    const after = await env.as(sysadmin).service('blueprints').call('setParams', bp.id, {
      params: [
        { key: 'MAXMEMORY',      label: 'Max memory' },
        { key: 'REDIS_PASSWORD', label: 'Password', secret: true },
      ],
    })
    expect(after.params.map((p: any) => p.key)).toEqual(['MAXMEMORY', 'REDIS_PASSWORD'])
  })

  test('params inline are refused by name rather than silently dropped', async () => {
    // The create schema litestone derives is CLOSED and `params` is a relation,
    // so `autoValidate` strips the key before any method sees it — a caller
    // sending a blueprint with its form inline would get a blueprint with no
    // form and no error. The refusal runs in a hook AHEAD of the validator,
    // which is the only place the key is still there to see.
    await expect(env.as(sysadmin).service('blueprints').create({
      name: 'Inline', slug: `inline-${Math.random().toString(36).slice(2, 8)}`,
      category: 'Cache', description: 'x', version: '1', image: 'x:1',
      params: [{ key: 'A', label: 'A' }],
    })).rejects.toThrow(/set with `setParams`/)
  })

  test('remove withdraws rather than deletes, so what was built from it still resolves', async () => {
    const slug = `withdrawn-${Math.random().toString(36).slice(2, 8)}`
    const bp = await env.as(sysadmin).service('blueprints').create({
      name: 'Old', slug, category: 'Database', description: 'x', version: '1', image: 'old:1',
    })
    await env.as(sysadmin).service('blueprints').remove(bp.id)

    // Off the list…
    const listed = await env.as(sysadmin).service('blueprints').find()
    expect(listed.data.some((b: any) => b.id === bp.id)).toBe(false)
    // …and still there by id, which is what an App pointing at it needs.
    expect((await env.as(sysadmin).service('blueprints').get(bp.id)).deprecatedAt).toBeTruthy()
  })
})

describe('the registry mirror is a tenant service, unlike the catalogue beside it', () => {
  test('one workspace cannot see another workspace images', async () => {
    const sys = env.system as any
    const other = await sys.workspace.findFirst({ where: { name: 'Other' } })

    await sys.registryImage.create({ data: {
      workspaceId: ws.id, repository: 'acme/dashboard', tag: 'v1',
      digest: 'sha256:aaa', sizeBytes: 100, inUse: true } })
    await sys.registryImage.create({ data: {
      workspaceId: other.id, repository: 'other/secret', tag: 'v1',
      digest: 'sha256:bbb', sizeBytes: 100 } })

    const rows = await env.as(developer).service('registry').find()
    expect(rows.data.length).toBeGreaterThan(0)
    expect(rows.data.every((r: any) => r.workspaceId === ws.id)).toBe(true)
    expect(rows.data.some((r: any) => r.repository === 'other/secret')).toBe(false)
  })

  test('a repository total charges a shared digest once', async () => {
    const sys = env.system as any
    const repo = `acme/shared-${Math.random().toString(36).slice(2, 8)}`

    // `latest` and `v2.14.1` are the SAME image. A registry stores those layers
    // once, so summing per tag reports double what the disk holds — which is the
    // number an operator would use to decide what to delete.
    await sys.registryImage.create({ data: {
      workspaceId: ws.id, repository: repo, tag: 'v2.14.1',
      digest: 'sha256:shared', sizeBytes: 1000, inUse: true } })
    await sys.registryImage.create({ data: {
      workspaceId: ws.id, repository: repo, tag: 'latest',
      digest: 'sha256:shared', sizeBytes: 1000 } })

    const out  = await env.as(developer).service('registry').call('repositories')
    const mine = out.repositories.find((r: any) => r.repository === repo)
    expect(mine.tags).toBe(2)
    expect(mine.inUse).toBe(1)
    expect(mine.sizeBytes).toBe(1000)
  })
})

describe('the installation settings are one row, behind the hub tier', () => {
  test('unconfigured answers a sentence, not an invented row of defaults', async () => {
    await expect(env.as(sysadmin).service('hub-config').call('current'))
      .rejects.toThrow(/no settings yet/)
  })

  test('save creates it, then updates it', async () => {
    const made = await env.as(sysadmin).service('hub-config').call('save', null, {
      name: 'Acme Fleet', baseUrl: 'https://hub.acme.test', adminEmail: 'ops@acme.test',
    })
    expect(made.id).toBe('hub')
    expect(made.name).toBe('Acme Fleet')

    // The version is required on an update — `@version` on a settings row is
    // exactly the two-administrators case, and litestone refuses a write that
    // does not carry the revision it read.
    await expect(env.as(sysadmin).service('hub-config').call('save', null, { sessionTtlHours: 24 }))
      .rejects.toThrow(/Send `version`/)

    await env.as(sysadmin).service('hub-config')
      .call('save', null, { sessionTtlHours: 24, version: made.version })
    const now = await env.as(sysadmin).service('hub-config').call('current')
    expect(now.sessionTtlHours).toBe(24)
    // Still one row — the failure a singleton has is a second one.
    expect(now.name).toBe('Acme Fleet')
    expect(await (env.system as any).hubConfig.count()).toBe(1)
  })

  test('an owner of a workspace is not a sysadmin', async () => {
    await expect(env.as(owner).service('hub-config').call('current')).rejects.toThrow()
  })
})

describe('a person notification preferences are their own', () => {
  test('every kind answers, defaulted, before anybody has chosen', async () => {
    const out = await env.as(developer).service('notification-preferences').find()
    expect(out.data.length).toBe(7)
    expect(out.data.every((r: any) => r.source === 'default')).toBe(true)
    // The defaults are a judgement, not a shrug: a failure is emailed, a success
    // is not. Asserting one of each keeps that from being quietly inverted.
    expect(out.data.find((r: any) => r.kind === 'deploy_failed').email).toBe(true)
    expect(out.data.find((r: any) => r.kind === 'deploy_success').email).toBe(false)
  })

  test('choosing one transport does not silently reset the other', async () => {
    // `deploy_success` defaults to email:false, inApp:true. Turning email ON
    // writes the row for the first time — and the OTHER column must come from
    // the kind's default rather than the column's, which is `true` for `inApp`
    // by coincidence here and would not be for a kind whose default is off.
    await env.as(developer).service('notification-preferences')
      .call('save', null, { kind: 'deploy_success', email: true })

    const out = await env.as(developer).service('notification-preferences').find()
    const row = out.data.find((r: any) => r.kind === 'deploy_success')
    expect(row.email).toBe(true)
    expect(row.inApp).toBe(true)
    expect(row.source).toBe('chosen')

    // And it is still the default for somebody else — the policy, not a filter
    // this service wrote.
    const theirs = await env.as(viewer).service('notification-preferences').find()
    expect(theirs.data.find((r: any) => r.kind === 'deploy_success').source).toBe('default')
  })

  test('reset forgets the choice rather than storing the opposite', async () => {
    await env.as(developer).service('notification-preferences')
      .call('reset', null, { kind: 'deploy_success' })
    const out = await env.as(developer).service('notification-preferences').find()
    expect(out.data.find((r: any) => r.kind === 'deploy_success').source).toBe('default')
  })

  test('an unknown kind is a sentence naming the seven', async () => {
    await expect(env.as(developer).service('notification-preferences')
      .call('save', null, { kind: 'deploy_fail', email: true }))
      .rejects.toThrow(/Unknown notification kind/)
  })
})

describe('a backup is asked for by a person and run by the app', () => {
  test('create writes a pending row and refuses a second one beside it', async () => {
    const made = await env.as(sysadmin).service('backups').create({})
    expect(made.status).toBe('pending')
    expect(made.kind).toBe('manual')
    // Who asked is a COLUMN, because the job runs as the app: a hub action has
    // no tenant, so there is no membership for `runsAsCaller` to re-resolve.
    expect(made.requestedBy).toBeTruthy()

    await expect(env.as(sysadmin).service('backups').create({}))
      .rejects.toThrow(/already pending/)
  })

  test('a destination with nothing behind it is refused by name, not queued to fail', async () => {
    await (env.system as any).backup.deleteMany({ where: {} })
    await expect(env.as(sysadmin).service('backups').create({ destination: 's3' }))
      .rejects.toThrow(/Only 'local' backups are implemented/)
  })

  test('and the handler refuses to run as somebody', async () => {
    const { runsAsApp } = await import('../src/jobs/context.ts')
    const mine = await (env.system as any).workspaceMember.findFirst({
      where: { workspaceId: ws.id, role: 'owner' } })

    // The mirror of the dispatch's `actor: null`. If somebody ever removed that
    // option, the queue would record the sysadmin who clicked and this refusal
    // is what turns it into an error instead of a silent mode switch.
    await env.app.runAs(mine.userId, { tenant: ws.id }, () => {
      expect(() => runsAsApp({ app: env.app } as any, 'backup:run'))
        .toThrow(/recorded actor/)
    })
  })
})

// ─── The state machine ───────────────────────────────────────────────────────
// `Server.status` used to be a machine written out in servers.service.ts: a
// from-list per verb, a second from-set inside heartbeat, a provider status map
// inside sync, and a fourth copy in the browser deciding which buttons to draw.
// It is `@@transitions(status, …)` on the model now (FJS-507).
//
// These four cases are the properties the declaration buys and the hand-rolled
// version could not have. Nothing here asserts that drain works — the audit
// test above already does — because a machine that only moves is a machine
// nobody needed.
describe('Server.status is a declared machine', () => {
  const uniq = () => Math.random().toString(36).slice(2, 8)

  const makeServer = async (status: string) => {
    const sys = env.system as any
    return sys.server.create({
      data: { workspaceId: ws.id, name: `sm-${uniq()}`, slug: `sm-${uniq()}`, status },
    })
  }

  test('an illegal move is refused by name, as a conflict rather than a 400', async () => {
    const server = await makeServer('pending')

    // The old code raised `BadRequest('Cannot drain a server with status …')`.
    // A request that is well-formed and disagrees with the row's current state
    // is a 409, and the message names what IS legal from here.
    await expect(env.as(owner).service('servers').call('drain', server.id))
      .rejects.toThrow(/from 'pending'/)
  })

  test('the level for a move is the schema and not a hook', async () => {
    const server = await makeServer('online')

    // `reboot` declares no gate, so it takes the model's own update level —
    // USER(4), which a developer holds.
    const rebooted = await env.as(developer).service('servers').call('reboot', server.id)
    expect(rebooted.status).toBe('pending')

    // `drain` declares @gate(5). The hook that used to say so is gone, and the
    // refusal now comes from the Data boundary — through the app's own error
    // mapper, so it names a ROLE and not a level. A level is litestone's
    // vocabulary and an operator has never seen one.
    const online = await makeServer('online')
    await expect(env.as(developer).service('servers').call('drain', online.id))
      .rejects.toThrow(/admin role/)
  })

  test('two drains of one server: one wins, the other is told to re-read', async () => {
    // The bug the declaration closes. `getScoped()` read the row and
    // `update()` wrote it in a second statement, so both callers read `online`,
    // both passed the from-check and both wrote — a lost update with no error,
    // and a server recorded online while it was draining. The UPDATE's WHERE is
    // narrowed to the from-state now, so exactly one row matches.
    const server = await makeServer('online')

    const results = await Promise.allSettled([
      env.as(owner).service('servers').call('drain', server.id),
      env.as(owner).service('servers').call('drain', server.id),
    ])

    const won  = results.filter(r => r.status === 'fulfilled')
    const lost = results.filter(r => r.status === 'rejected')
    expect(won.length).toBe(1)
    expect(lost.length).toBe(1)

    // Whichever way the loser is refused, it must not read as "try something
    // else": the row moved, and both of litestone's two answers here are 409.
    const err = (lost[0] as PromiseRejectedResult).reason
    expect(err.code ?? err.status).toBe(409)

    const sys = env.system as any
    const after = await sys.server.findUnique({ where: { id: server.id } })
    expect(after.status).toBe('draining')
  })

  test('a caller cannot drive status through patch', async () => {
    // narrowPatch has always dropped `status`, and that is still where the
    // closed-machine property is enforced for the CRUD door — a declared
    // machine does not make an undeclared write illegal, it makes an illegal
    // MOVE illegal, and `online -> draining` is a legal move.
    const server = await makeServer('online')

    await env.as(owner).service('servers').patch(server.id, { status: 'draining' })

    const sys = env.system as any
    const after = await sys.server.findUnique({ where: { id: server.id } })
    expect(after.status).toBe('online')
  })
})

// ─── the audit trail, at the Data boundary ───────────────────────────────
// `AuditEvent` was `@@tenant(none)` and unpolicied, so the only thing keeping
// one workspace's trail out of another's was `audit.service.ts` putting
// `workspaceId: ws()` in its own where — one door, where a gate is every door
// (`FJS-432`). It takes the declared tenancy now, and these read through the
// scoped CLIENT rather than the service, because a service test cannot tell a
// policy from a hook.
describe('the audit trail is scoped by the schema, not by one service', () => {
  // The principal the app builds, minus the request: `memberRole` is what
  // basecampGateLevel grades and `workspaceId` is the claim the desugar
  // compares. Anything less reads as VISITOR(1) and is refused by the gate
  // instead of filtered by the policy, which would pass this test for the
  // wrong reason.
  const asAdminOf = (userId: string, workspaceId: string) =>
    (env.actingAs as any)({ id: userId, workspaceId, memberRole: 'admin' })

  let mine: any, theirs: any, nobodys: any, otherWs: any, adminId: string

  beforeAll(async () => {
    const sys  = env.system as any
    const uniq = () => Math.random().toString(36).slice(2, 8)

    adminId = (await sys.user.findFirst({ where: { id: (await sys.workspaceMember.findFirst({ where: { workspaceId: ws.id, role: 'owner' } })).userId } })).id

    otherWs = await sys.workspace.create({
      data: { accountId: ws.accountId, name: 'Rival', slug: `rival-${uniq()}`, ownerId: adminId },
    })

    const row = (workspaceId: string | null, action: string) =>
      sys.auditEvent.create({
        data: { workspaceId, action, subjectType: 'test', subjectId: `s-${uniq()}` },
      })

    mine    = await row(ws.id,     'trail.mine')
    theirs  = await row(otherWs.id, 'trail.theirs')
    nobodys = await row(null,       'trail.hub')
  })

  test('an admin reads their own workspace and not the one next door', async () => {
    const db   = asAdminOf(adminId, ws.id)
    const rows = await db.auditEvent.findMany({ where: { subjectType: 'test' } })
    const ids  = rows.map((r: any) => r.id)

    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
  })

  test('a null workspaceId belongs to NOBODY, so no tenant reads it', async () => {
    // The decision this pins (`FJS-D141`). A null is not a shared row: it is a
    // row no workspace owns, and the hub reaches it through asSystem() alone.
    // If null ever came to mean *global* it would be indistinguishable from a
    // stamp that failed to land, which is the shape that cost twelve job runs.
    for (const wsId of [ws.id, otherWs.id]) {
      const rows = await asAdminOf(adminId, wsId).auditEvent.findMany({ where: { subjectType: 'test' } })
      expect(rows.map((r: any) => r.id)).not.toContain(nobodys.id)
    }

    const all = await (env.system as any).auditEvent.findMany({ where: { subjectType: 'test' } })
    expect(all.map((r: any) => r.id)).toContain(nobodys.id)
  })
})

describe('an audited action files under the workspace that owns its subject', () => {
  test('a method exempt from sessionScope is still stamped', async () => {
    // `jobs.startRun` is internalOnly() and therefore outside the scope hook,
    // so `ctx.locals.workspaceId` is absent and the trail row used to land with
    // a null — twelve of them in the dev database, on a `Job` whose own
    // workspaceId is required and present. Under `FJS-D141` a null means the
    // row belongs to no workspace, so those runs were invisible to the very
    // workspace whose feed exists to show them.
    const sys = env.system as any
    const job = await sys.job.create({
      data: { workspaceId: ws.id, name: 'nightly', kind: 'one_shot', command: 'true' },
    })

    await env.as(owner).service('jobs').call('startRun', job.id, { trigger: 'manual' })

    // The audit write is fire-and-forget behind a swallowed catch, so yield
    // once rather than waiting on it — same reason litestone's own logger
    // needs a tick (CLAUDE.md § Data).
    await new Promise(r => setImmediate(r))

    const row = await sys.auditEvent.findFirst({
      where:   { action: 'jobs.startRun', subjectId: job.id },
      orderBy: { createdAt: 'desc' },
    })
    expect(row).toBeTruthy()
    expect(row.workspaceId).toBe(ws.id)
  })
})

// ─── @system, at the two doors it has ────────────────────────────────────
// `tokenHint` and `credentialId` are derived from a token that does not exist
// when the request is made. They used to be ordinary writable columns, which
// put `tokenHint` in create-mode `required` and made a browser validating
// against the schema refuse every create by naming a field the caller was
// never meant to send — the reason `ApiKey.mesa` turns validation off
// (`FJS-095`). `@system` is the declaration that says so.
describe('a column the system writes and its caller does not', () => {
  test('the mint still lands, and it lands through the SCOPED client', async () => {
    const made: any = await env.as(owner).service('api-keys').create({
      name: `ci-${Math.random().toString(36).slice(2, 8)}`,
      scopes: ['servers:read'], expiresIn: '30d',
    })

    // The plaintext is answered once and is on no later read.
    expect(typeof made.token).toBe('string')
    expect(made.tokenHint).toBeTruthy()
    expect(made.tokenHint).not.toBe(made.token)

    // Written by the application naming the column, not by asSystem() — so the
    // row still carries the audit actor, which is the whole of why `system:`
    // exists rather than a bypass.
    const sys = env.system as any
    const row = await sys.apiKey.findUnique({ where: { id: made.id } })
    expect(row.credentialId).toBeTruthy()
    expect(row.createdBy).toBeTruthy()
  })

  test('a forged hint is not what lands — the mint overwrites it', async () => {
    // `@system` refuses a non-system write naming the column, and on THIS
    // model that refusal is a backstop rather than the thing a caller meets:
    // `stampKey` is a before hook and it assigns `data.tokenHint` from the
    // token it just minted, so a forged value is replaced before the payload
    // reaches the Data boundary. Asserting the outcome rather than the throw,
    // because the throw is unreachable here and a test claiming otherwise
    // would pass for a reason that is not the reason.
    const made: any = await env.as(owner).service('api-keys').create({
      name: `forged-${Math.random().toString(36).slice(2, 8)}`,
      scopes: ['servers:read'], expiresIn: '30d',
      tokenHint: 'fjs_not…mine',
    })
    expect(made.tokenHint).not.toBe('fjs_not…mine')
  })

  test('the DECLARATION is what refuses — the boundary, asked directly', async () => {
    // Where `@system` actually lives. No hook in front of it, so this is the
    // rule itself: a scoped client naming the column is refused by name, and
    // `system: [...]` on the same write is the application saying it meant to.
    // Without this the service test above would pass on a schema that had
    // dropped the annotation entirely.
    const sys  = env.system as any
    const user = await sys.user.findFirst({ where: {} })
    const db   = (env.actingAs as any)({ id: user.id, workspaceId: ws.id, memberRole: 'admin' })
    const row  = { workspaceId: ws.id, userId: user.id, name: `direct-${Math.random().toString(36).slice(2, 8)}` }

    await expect(db.apiKey.create({ data: { ...row, tokenHint: 'fjs_a…b' } }))
      .rejects.toThrow(/tokenHint/)

    const ok = await db.apiKey.create({
      data:   { ...row, tokenHint: 'fjs_a…b' },
      system: ['tokenHint'],
    })
    expect(ok.tokenHint).toBe('fjs_a…b')
  })
})

// ─── an engine move is the application's, and the schema says so ─────────
// `Server`'s report* moves are decided by a provider and REQUESTED by a person
// pressing *Sync from provider*, so they carry `@system @gate(5)`: the engine
// makes the move, an administrator asks for it (`FJS-506`). Before `@system`
// existed the only marker was `@gate(8)`, which admits no caller at all — so
// `sync` would have had to drop to `asSystem()` and lose the audit actor.
describe('a move the engine makes, asked for by a person', () => {
  const uniq = () => Math.random().toString(36).slice(2, 8)

  const aServer = async (status: string) => (env.system as any).server.create({
    data: { workspaceId: ws.id, name: `sys-${uniq()}`, slug: `sys-${uniq()}`, status },
  })

  test('an owner cannot make one by hand, at any level', async () => {
    const server = await aServer('online')
    await expect(env.as(owner).service('servers').patch(server.id, { status: 'stopped' }))
      .resolves.toBeTruthy()   // narrowPatch drops `status` — this is the CRUD door

    // The row did not move, which is narrowPatch. The Data boundary is the
    // door that matters, and it refuses by name.
    const sys = env.system as any
    expect((await sys.server.findUnique({ where: { id: server.id } })).status).toBe('online')

    const db = (env.actingAs as any)({ id: 'someone', workspaceId: ws.id, memberRole: 'owner' })
    await expect(db.server.transition(server.id, 'reportStopped')).rejects.toThrow(/is @system/)
  })

  test('the screen is told not to offer it, and told WHY', async () => {
    // `refusedBy` is the half a status cannot carry: *not you, ever* renders as
    // no button, where *not senior enough* renders as a disabled one that says
    // ask an administrator — advice that would be wrong here.
    const server = await aServer('online')
    const db     = (env.actingAs as any)({ id: 'someone', workspaceId: ws.id, memberRole: 'owner' })
    const moves  = await db.server.transitions(server)

    const report = moves.find((t: any) => t.name === 'reportStopped')
    expect(report.system).toBe(true)
    expect(report.allowed).toBe(false)
    expect(report.refusedBy).toBe('system')

    // A person's move on the same row is unaffected and still graded.
    expect(moves.find((t: any) => t.name === 'drain')).toMatchObject({ system: false, allowed: true })
  })

  test('checkIn is the machine\'s move and the from-set comes from the schema', async () => {
    // The heartbeat writes `status` as one column of one update, so it asks the
    // machine rather than keeping its own copy of the from-set. A server that
    // is DRAINING is not checking in — it stays where it is.
    const sys      = env.system as any
    const draining = await aServer('draining')
    const pending  = await aServer('pending')

    const can = async (row: any) =>
      (await sys.server.transitions(row)).some((t: any) => t.name === 'checkIn')

    expect(await can(pending)).toBe(true)
    expect(await can(draining)).toBe(false)
  })
})
