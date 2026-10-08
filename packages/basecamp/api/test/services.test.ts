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
import { ensureCert }  from '@frontierjs/outpost/cert'
import { mkdtempSync } from 'node:fs'
import { tmpdir }      from 'node:os'
import { createTestEnv, session } from '@frontierjs/testing'
import { signRequest } from '@frontierjs/toolbelt/signature'
import { seriesKey }   from '@frontierjs/junction'
import { GatePlugin }  from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { grantsFor, grantsWithin } from '../src/core/capabilities.ts'
import { refuseGrantAboveOwn }    from '../src/core/hooks.ts'
import { MEMBERSHIP }             from '@frontierjs/junction'
import { SERVER_READINGS, readingOf } from '../src/core/server-metrics.ts'
import { NOTIFICATION_KINDS }     from '../src/services/notification-preferences/kinds.ts'
import { notifyPeople }           from '../src/core/notify.ts'
import { createJunctionClient }   from '@frontierjs/junction/client'
import { snapshotVariables, releaseEnv } from '../src/core/variables.ts'

// The certificate a machine's command port answers with, which enrollment pins
// on its Conduit target (FJS-1603). Every enrollment below presents it.
const CERT = ensureCert(mkdtempSync(join(tmpdir(), 'basecamp-outpost-cert-'))).cert

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

// A Server is born `pending`, even for the system, so a fixture in any other
// state walks the declared moves to it.
const WALK_TO: Record<string, string[]> = {
  pending: [], online: ['checkIn'], stopped: ['reportStopped'], draining: ['checkIn', 'drain'],
}
async function serverAt(status: string, data: Record<string, unknown>) {
  const sys = env.system as any
  let row = await sys.server.create({ data })
  for (const move of WALK_TO[status]) row = await sys.server.transition(row.id, move)
  return row
}

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
    // The second line of defense, reached by a caller the hook admits. Nothing
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

  test('a patch carrying no version is a 400 that reads for the person, not the author', async () => {
    // The failure a hand-written client hits. A resource injects the version
    // it read; a curl does not. The message reaches a screen, so it says to
    // reload; which column to send rides on the server-side `hint`.
    const dev  = () => env.as(developer).service('projects')
    const made = await dev().create({ name: 'Notes', slug: slug() })

    let err: any = null
    try { await dev().patch(made.id, { name: 'Notes 2' }) } catch (e) { err = e }
    expect(err?.code).toBe(400)
    expect(err.retryable).toBe(false)
    expect(err.message).toMatch(/reload/i)
    expect(err.message).not.toMatch(/asSystem|data\.version|@version/)
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
      name: 'edge-1', slug: slug(), role: 'general',
      providerKind: 'custom', ipAddress: '203.0.113.10',
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
  let parityUser: string

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
    // Active, because a registered account starts `pending_verification` and
    // `notifyPeople` pages nobody who is not.
    await sys.user.update({ where: { id: user.id ?? user.userId }, data: { accountId: acct.id, status: 'active' } })
    const wsp = await sys.workspace.create({
      data: { accountId: acct.id, name: 'Parity', slug: `pw-${uniq()}`, ownerId: user.id ?? user.userId },
    })
    await sys.workspaceMember.create({
      data: { workspaceId: wsp.id, userId: user.id ?? user.userId, role: 'owner',
              capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString() },
    })
    const login = await penv.app.auth.login(email, 'hunter2hunter2')
    token = login.token ?? login.accessToken
    parityUser = user.id ?? user.userId
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

  test('a notification sent in the API reaches the notifications store of an open socket', async () => {
    // The whole route, with nothing standing in: the real browser client, a
    // real session, the connect handler's join, the inApp driver's push, and
    // the client's own routing of a frame to a service. Each half was tested
    // alone and the pair never met — the driver pushed `notification:created`,
    // which the client does not route to any service, and no bell moved.
    const client = createJunctionClient({ url: penv.url })
    try {
      client.setToken(token)
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error('the socket never connected')), 8000)
        client.once('connect', () => { clearTimeout(t); res() })
      })
      const got: any[] = []
      client.service('notifications').on('created', (row: any) => got.push(row))

      // The join runs in the connection handler after `connect` is emitted, so
      // the send is repeated until one lands rather than timed against it.
      const deadline = Date.now() + 5000
      while (!got.length && Date.now() < deadline) {
        await notifyPeople(penv.app, 'deploy_failed', [parityUser],
          { deploymentId: 'd-1', appName: 'Site', environment: 'prod', step: 'build' })
        await new Promise(r => setTimeout(r, 200))
      }
      expect(got.length).toBeGreaterThan(0)
      expect(got[0].userId).toBe(parityUser)
      expect(got[0].data.title).toBe('Deploy failed')
    } finally {
      client.disconnect()
    }
  }, 30_000)

  test('a flow reaches its own workspace’s open socket on orion’s shared channel, and no other workspace’s', async () => {
    // `flows` is one channel for every workspace, so it names no tenant and
    // the claims resolver answers nothing for it: every recipient was refused
    // (`FJS-1772`). The stranger is an admin of ANOTHER workspace on the same
    // channel, which is the refusal the acceptance is paired with.
    const sys    = penv.system as any
    const uniq   = () => Math.random().toString(36).slice(2, 8)
    const acct   = await sys.account.create({ data: { slug: `s-${uniq()}`, displayName: 'Stranger' } })
    const email  = `stranger-${uniq()}@x.co`
    const user   = await penv.app.auth.createUser({ email, password: 'hunter2hunter2', name: 'Stranger' })
    const theirs = user.id ?? user.userId
    await sys.user.update({ where: { id: theirs }, data: { accountId: acct.id, status: 'active' } })
    const wsp = await sys.workspace.create({ data: { accountId: acct.id, name: 'Elsewhere', slug: `sw-${uniq()}`, ownerId: theirs } })
    await sys.workspaceMember.create({ data: { workspaceId: wsp.id, userId: theirs, role: 'admin',
      capabilities: grantsFor('admin'), acceptedAt: new Date().toISOString() } })
    const strangerToken = (await penv.app.auth.login(email, 'hunter2hunter2')).token

    const open = async (t: string) => {
      const client = createJunctionClient({ url: penv.url })
      client.setToken(t)
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => rej(new Error('the socket never connected')), 8000)
        client.once('connect', () => { clearTimeout(timer); res() })
      })
      const got: any[] = []
      client.service('flows').on('created', (row: any) => got.push(row))
      return { client, got }
    }
    const owner = await open(token), stranger = await open(strangerToken)
    try {
      const ownerWs = (await sys.workspaceMember.findFirst({ where: { userId: parityUser } })).workspaceId
      const flows   = penv.as(session({ userId: parityUser, workspaceId: ownerWs })).service('flows')
      // The joins run after `connect`, so a flow is drafted until one lands.
      const deadline = Date.now() + 5000
      while (!owner.got.length && Date.now() < deadline) {
        await flows.create({ name: `Watched ${uniq()}` })
        await new Promise(r => setTimeout(r, 200))
      }
      expect(owner.got.length).toBeGreaterThan(0)
      expect(owner.got[0].ownerId).toBe(parityUser)
      await new Promise(r => setTimeout(r, 300))
      expect(stranger.got).toEqual([])
    } finally {
      owner.client.disconnect()
      stranger.client.disconnect()
    }
  }, 30_000)
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

  test('a filter the service honors still filters beside it', async () => {
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

describe('?search= — a search box over a name, which answered 400 on every use', () => {
  // Three services read `$.query.search` and build `name contains` from it, and
  // no model has a `search` column, so autoFilter refused the key before the
  // service ran (`FJS-1284`). It is not the `$search` directive: that one is
  // full-text and needs `@@fts`, and a substring of a name is a different
  // question. Each service reserves the key instead.
  const uniq = () => Math.random().toString(36).slice(2, 8)
  const names = (r: any) => (r.data ?? r).map((row: any) => row.name)

  test('the servers box narrows to the names that hold it', async () => {
    const sys = env.system as any
    const tag = uniq()
    await sys.server.create({ data: { workspaceId: ws.id, name: `box-${tag}-a`, slug: `box-${tag}-a` } })
    await sys.server.create({ data: { workspaceId: ws.id, name: `box-${tag}-b`, slug: `box-${tag}-b` } })

    const found = names(await env.as(owner).service('servers').find({ search: tag }))
    expect(found.sort()).toEqual([`box-${tag}-a`, `box-${tag}-b`])
  })

  test('the recipes box, the same way', async () => {
    const sys = env.system as any
    const tag = uniq()
    await sys.recipe.create({ data: { workspaceId: ws.id, name: `Box ${tag}`, slug: `box-${tag}`, script: 'true' } })

    expect(names(await env.as(owner).service('recipes').find({ search: tag }))).toEqual([`Box ${tag}`])
  })

  test('the volumes box, the same way', async () => {
    const sys = env.system as any
    const tag = uniq()
    await sys.volume.create({ data: { serverId: machine.id, name: `vol-${tag}` } })

    expect(names(await env.as(owner).service('volumes').find({ search: tag }))).toEqual([`vol-${tag}`])
  })

  test('a column filter beside it still filters, and a stray key is still refused', async () => {
    const tag = uniq()
    await serverAt('online',  { workspaceId: ws.id, name: `mix-${tag}-on`,  slug: `mix-${tag}-on` })
    await serverAt('stopped', { workspaceId: ws.id, name: `mix-${tag}-off`, slug: `mix-${tag}-off` })

    expect(names(await env.as(owner).service('servers').find({ search: tag, status: 'online' })))
      .toEqual([`mix-${tag}-on`])
    await expect(env.as(owner).service('servers').find({ search: tag, bogusColumn: 7 }))
      .rejects.toThrow(/bogusColumn/)
  })
})

// ─── The application trail ───────────────────────────────────────────────────
// `AuditEvent.diff` is `Json?` and nothing wrote it, so the trail could say a
// server was drained and not what state it was in (FJS-154). The row-level
// `@@trail(audit)` JSONL carries before/after on the host; the application trail,
// which is the one the UI reads, did not.
describe('the audit trail records what changed', () => {
  test('a custom method writes a before/after diff', async () => {
    const sys = env.system as any

    const server = await serverAt('online',
      { workspaceId: ws.id, name: 'audit-01', slug: `audit-${Math.random().toString(36).slice(2, 8)}` })

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


/**
 * Enroll a machine and hand back the credential it went away with.
 *
 * There is no fleet-wide outpost secret any more: every machine holds one of
 * its own, minted at enrollment, and a machine that has not enrolled is refused
 * whatever it signs with. So a test that wants to be an outpost has to become
 * one first — which is the same two steps a real machine takes, cloud-init or a
 * pasted command.
 *
 * The token is written straight onto the row rather than issued through the
 * service, because these fixtures are not testing the issuing path — that is
 * `compute.test.ts`'s, along with the gate on it.
 */
async function enrollMachine(serverId: string): Promise<string> {
  const { mintEnrollToken, hashEnrollToken } =
    await import('../src/providers/compute/enrollment.ts')
  const token = mintEnrollToken().token
  await (env.system as any).server.update({
    where: { id: serverId },
    data:  { enrollTokenHash: hashEnrollToken(token), enrollExpiresAt: new Date(Date.now() + 60_000) },
  })
  const res = await env.http.post(`/servers/${serverId}/enroll`).send({ token, cert: CERT })
  const secret = (res.body as { secret?: string }).secret
  if (!secret) throw new Error(`enrollMachine(${serverId}): ${res.status} ${res.text}`)
  return secret
}

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
  // The machine's OWN credential. There is no fleet key to borrow: a machine
  // that has not enrolled is refused whatever it signs with, so this fixture
  // enrolls first, exactly as a real one does.
  let SECRET: string
  beforeAll(async () => { SECRET = await enrollMachine(machine.id as string) })

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

  test('a good signature is a machine principal and reaches no other method (FJS-1715)', async () => {
    // The credential is app-wide, so a signature on a request that is not one of
    // the three endpoints is refused at the transport rather than passed on as
    // anonymous: `drain` is what a machine must never be able to call.
    const path = `/servers/${machine.id}`
    const req  = env.http.post(path).set('x-service-method', 'drain')
    for (const [k, v] of Object.entries(await signed(path, {}))) req.set(k, v)

    expect((await req.send({})).status).toBe(401)
    const after = await (env.system as any).server.findUnique({ where: { id: machine.id } })
    expect(after.status).not.toBe('draining')
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

  test('a nonce is remembered for as long as its timestamp can still be fresh', async () => {
    // Seen 400s ago — past one tolerance, inside two. A sender clock 300s
    // ahead signs a timestamp that is still fresh here, so a memory of one
    // tolerance had swept the nonce and let the replay through (FJS-1833).
    const sys   = env.system as any
    const nonce = crypto.randomUUID()
    await sys.outpostNonce.create({
      data: { nonce, seenAt: new Date(Date.now() - 400_000).toISOString() },
    })

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
    // The table only has to remember as long as a timestamp can be fresh —
    // twice the tolerance — and the sweep runs on write rather than on a timer,
    // so there is no clock to own and nothing grows while nothing is arriving.
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
    const server = await serverAt('online', { workspaceId: w.id, name: 'far-01', slug: `far-${uniq()}` })
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
    const { buildRoutes }        = await import('@frontierjs/junction')

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

// ─── The catalog, and the four services that take no workspace ─────────────
// `Blueprint`, `HubConfig`, `Backup` and `NotificationPreference` are all
// `@@tenant(none)`, which means junction's `tenantClaimGuard` exempts them —
// `isRowScoped(db, service)` is false, so a caller with no workspace claim is
// not refused. That exemption is load-bearing and invisible: it lives in
// junction, keyed off this app's schema, and nothing in either file names the
// other. These tests are what would catch it moving.

describe('the catalog takes no workspace', () => {
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
    // still refused, because the catalog belongs to the installation.
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

describe('the registry mirror is a tenant service, unlike the catalog beside it', () => {
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
    // The count is derived, not typed in: `kinds.ts` IS the list this screen
    // renders, and a literal here freezes at whatever it was the day it was
    // written — which is what a kind added to the enum and the files but not to
    // the table would slip past.
    expect(out.data.length).toBe(NOTIFICATION_KINDS.length)
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

  const makeServer = async (status: string) =>
    serverAt(status, { workspaceId: ws.id, name: `sm-${uniq()}`, slug: `sm-${uniq()}` })

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

describe('a job\'s next run is the clock\'s answer', () => {
  test('a scheduled job answers when its own expression next fires', async () => {
    // `FJS-1241`. It was a column written once on create as a minute from now,
    // so a weekly job showed that minute for ever — and a member could set it.
    const job = await env.as(owner).service('jobs').create({
      name: 'weekly', kind: 'scheduled', cronExpression: '0 9 * * 1', command: 'true',
    }) as any
    const got = await env.as(owner).service('jobs').get(job.id) as any

    const next = new Date(got.nextRunAt)
    expect(next.getTime()).toBeGreaterThan(Date.now())
    expect([next.getDay(), next.getHours(), next.getMinutes()]).toEqual([1, 9, 0])
  })

  test('a job off the clock answers null', async () => {
    const job = await env.as(owner).service('jobs').create({
      name: 'once', kind: 'one_shot', command: 'true',
    }) as any
    const got = await env.as(owner).service('jobs').get(job.id) as any
    expect(got.nextRunAt).toBeNull()
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

  const aServer = async (status: string) =>
    serverAt(status, { workspaceId: ws.id, name: `sys-${uniq()}`, slug: `sys-${uniq()}` })

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

// ─── the metric store, read back ─────────────────────────────────────────
//
// `metricsPlugin` writes these; this service is the only thing that reads
// them, and until it existed they were three models nothing could reach —
// which is the shape `AlertRule` sat in for a month (`FJS-123`).
//
// What makes the reader worth testing separately from the fold is the TIER
// CHOICE: raw exists for 48 hours and hourly rows exist for every hour ever
// folded, so which one answers depends on the window asked for and NOT on
// anything the caller says. A chart that silently changed resolution when its
// range crossed 48 hours would show a step nobody could account for.
describe('the metric store is readable, and picks its own resolution', () => {
  const HOUR = 3_600_000
  let seriesId: string

  beforeAll(async () => {
    const sys = env.system as any
    const s = await sys.metricSeries.create({
      data: { name: 'test.gaugeReading', labelsKey: 'test.gaugeReading', type: 'gauge',
              lastSeenAt: new Date().toISOString() },
    })
    seriesId = s.id
    // Recent minutes, inside the raw window.
    for (let i = 0; i < 5; i++)
      await sys.metricPoint.create({ data: { seriesId: s.id, at: Date.now() - i * 60_000, value: i } })
    // An hour far outside it, folded — which is the only thing that exists out
    // there, because the raw covering it would have been pruned.
    await sys.metricHour.create({
      data: { seriesId: s.id, hour: Math.floor((Date.now() - 200 * HOUR) / HOUR) * HOUR,
              min: 0, max: 9, sum: 45, count: 10, increase: null },
    })
  })

  test('a workspace member is refused at the hub tier, by the level the service declares', async () => {
    // These series are `@@tenant(none)` and belong to no workspace, so even a
    // workspace owner stands below them. A declared SYSADMIN and not a hook,
    // so junction refuses by the number an agent's tool list reads (FJS-D408).
    await expect(env.as(owner).service('metrics-store').find()).rejects.toThrow(/requires level 7, caller has level 6/)
  })

  test('a sysadmin lists the series, and each one says whether anything is still writing it', async () => {
    const res  = await env.as(sysadmin).service('metrics-store').find()
    const rows = (res as any).data ?? res
    const mine = rows.find((r: any) => r.labelsKey === 'test.gaugeReading')
    expect(mine).toBeTruthy()
    // The column that earns its place: a scrape that STOPPED and a value that
    // is not CHANGING draw the same flat line, and nothing else separates them.
    expect(mine.stale).toBe(false)
  })

  test('a window inside the raw retention is answered at minute resolution', async () => {
    const r = await env.as(sysadmin).service('metrics-store')
      .call('read', null, { name: 'test.gaugeReading', from: Date.now() - 2 * HOUR, to: Date.now() })
    expect(r.tier).toBe('raw')
    expect(r.points.length).toBe(5)
  })

  test('a window reaching past it is answered from the fold instead', async () => {
    // Not a preference and not a fallback: the minutes out there were pruned,
    // so hour rows are the only thing that exists. Asserting the TIER and not
    // just the point count is the whole point — a reader that returned an empty
    // raw list would look identical to one that had no data.
    const r = await env.as(sysadmin).service('metrics-store')
      .call('read', null, { name: 'test.gaugeReading', from: Date.now() - 300 * HOUR, to: Date.now() })
    expect(r.tier).toBe('hour')
    expect(r.points.length).toBe(1)
    expect(r.points[0].count).toBe(10)
  })

  test('a series nobody ever wrote is empty rather than an error', async () => {
    const r = await env.as(sysadmin).service('metrics-store')
      .call('read', null, { name: 'test.neverWritten', from: Date.now() - HOUR, to: Date.now() })
    expect(r.series).toBe(null)
    expect(r.points).toEqual([])
  })

  test('a backwards window is refused rather than answered with nothing', async () => {
    // An empty chart and a nonsense range look the same to a reader, so the
    // range is graded instead of being allowed to return zero rows.
    await expect(env.as(sysadmin).service('metrics-store')
      .call('read', null, { name: 'test.gaugeReading', from: Date.now(), to: Date.now() - HOUR }))
      .rejects.toThrow(/from must be before to/)
  })
})

// ─── A rule watching a metric that does not exist ────────────────────────
//
// `AlertRule.metricName` is not a foreign key, and it cannot be: a series is
// MINTED by the first scrape that sees it, so a rule legitimately precedes the
// row it names. What that costs is a rule watching a typo — it never fires, and
// from every screen it looks exactly like a threshold nobody has crossed.
//
// So `get` answers whether the series exists and when it was last seen. Both
// rows below are PAIRED, because an answer of `null` for every rule would
// satisfy a test that only asked about the typo.
describe('an alert rule says whether anything writes the metric it watches', () => {
  const tag = () => Math.random().toString(36).slice(2, 8)
  let live: any, typo: any

  beforeAll(async () => {
    const sys = env.system as any
    await sys.metricSeries.create({
      data: { name: 'alertcheck.written', labelsKey: 'alertcheck.written', type: 'gauge',
              lastSeenAt: new Date().toISOString() },
    })
    live = await sys.alertRule.create({
      data: { workspaceId: ws.id, name: `live-${tag()}`, metricName: 'alertcheck.written',
              severity: 'warning', operator: 'gt', threshold: 10 },
    })
    typo = await sys.alertRule.create({
      data: { workspaceId: ws.id, name: `typo-${tag()}`, metricName: 'alertcheck.writen',
              severity: 'warning', operator: 'gt', threshold: 10 },
    })
  })

  test('a rule over a real series answers it, live', async () => {
    const r = await env.as(owner).service('alerts').get(live.id) as any
    expect(r.series?.name).toBe('alertcheck.written')
    expect(r.series.stale).toBe(false)
  })

  test('…and one letter out answers null, which is the whole point', async () => {
    // One character apart from the row above. The series models are
    // `@@gate("8")` and `@@tenant(none)`, so the lookup is `asSystem()` and the
    // only thing that reaches the response is the name, the type and the
    // freshness — never a reading.
    const r = await env.as(owner).service('alerts').get(typo.id) as any
    expect(r.series).toBe(null)
  })
})

describe('snoozing a rule silences it for a while, and the server keeps the clock', () => {
  const tag = () => Math.random().toString(36).slice(2, 8)
  let rule: any

  beforeAll(async () => {
    rule = await (env.system as any).alertRule.create({
      data: { workspaceId: ws.id, name: `snooze-${tag()}`, metricName: 'snooze.metric',
              severity: 'warning', operator: 'gt', threshold: 10 },
    })
  })

  test('a snooze is minutes from NOW, and unsnooze clears it', async () => {
    const before = Date.now()
    const r = await env.as(owner).service('alerts').call('snooze', rule.id, { minutes: 60 }) as any
    const until = Date.parse(r.snoozedUntil)
    expect(until).toBeGreaterThanOrEqual(before + 60 * 60_000)
    expect(until).toBeLessThan(Date.now() + 60 * 60_000 + 5_000)
    // The rule comes back with its delivery, like attach/detach, so a card
    // assigning the answer keeps the sections it was drawing.
    expect(Array.isArray(r.channels)).toBe(true)

    const cleared = await env.as(owner).service('alerts').call('unsnooze', rule.id) as any
    expect(cleared.snoozedUntil).toBe(null)
  })

  test('a snooze past a week is refused, and so is none at all', async () => {
    await expect(env.as(owner).service('alerts').call('snooze', rule.id, { minutes: 7 * 24 * 60 + 1 }))
      .rejects.toThrow(/1 to 10080/)
    await expect(env.as(owner).service('alerts').call('snooze', rule.id, {}))
      .rejects.toThrow(/1 to 10080/)
    // Paired: the ceiling itself is allowed.
    const r = await env.as(owner).service('alerts').call('snooze', rule.id, { minutes: 7 * 24 * 60 }) as any
    expect(r.snoozedUntil).toBeTruthy()
    await env.as(owner).service('alerts').call('unsnooze', rule.id)
  })

  test('a developer cannot silence the pager, and a patch cannot write the column', async () => {
    await expect(env.as(developer).service('alerts').call('snooze', rule.id, { minutes: 5 }))
      .rejects.toThrow(/admin or owner/)
    // `@system`: the ordinary edit is not a second door to the same silence.
    // It carries the version it read, so the refusal is the column's and not
    // the compare-and-swap's.
    const far = new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString()
    const { version } = await (env.system as any).alertRule.findFirst({ where: { id: rule.id } })
    await expect(env.as(owner).service('alerts').patch(rule.id, { snoozedUntil: far, version }))
      .rejects.toThrow(/snoozedUntil/)
    const row = await (env.system as any).alertRule.findFirst({ where: { id: rule.id } })
    expect(row.snoozedUntil).toBe(null)
  })
})

describe('an app made from a blueprint', () => {
  const tag = () => Math.random().toString(36).slice(2, 8)
  let bp: any, gone: any, environment: any

  beforeAll(async () => {
    const sys = env.system as any
    bp = await sys.blueprint.create({ data: {
      slug: `kv-${tag()}`, name: 'KV', category: 'Data', description: 'A store', version: '7',
      image: 'redis:7.2-alpine', appType: 'database', port: 6379,
      volumePath: '/data', healthCheck: '/ping', cpuLimit: 0.5, memLimitMb: 256,
    } })
    for (const [i, p] of [
      { key: 'KV_PASSWORD', label: 'Password',      required: true,  secret: true },
      { key: 'KV_POLICY',   label: 'Policy',        defaultValue: 'allkeys-lru' },
      { key: 'KV_KEY',      label: 'Encryption key', required: true, secret: true, generate: 'random_hex_16' },
      { key: 'KV_NOTE',     label: 'Note' },
    ].entries())
      await sys.blueprintParam.create({ data: { blueprintId: bp.id, position: i, ...p } })
    gone = await sys.blueprint.create({ data: {
      slug: `old-${tag()}`, name: 'Old', category: 'Data', description: 'x', version: '1',
      image: 'old:1', deprecatedAt: new Date().toISOString(),
    } })
    const project = await sys.project.create({ data: { workspaceId: ws.id, name: 'BP', slug: `bp-${tag()}` } })
    environment = await sys.environment.create({ data: {
      workspaceId: ws.id, projectId: project.id, name: 'Prod', slug: `prod-${tag()}` } })
  })

  const make = (who: any, payload: Record<string, unknown>) =>
    env.as(who).service('apps').call('fromBlueprint', null, payload)

  test('a developer makes one; it records the blueprint and copies what it said', async () => {
    const r = await make(developer, {
      blueprintId: bp.id, environmentId: environment.id, name: 'Cache',
      values: { KV_PASSWORD: 'hunter2-kv' },
    }) as any

    expect(r.blueprintId).toBe(bp.id)
    expect(r.type).toBe('database')
    expect(r.port).toBe(6379)
    expect(r.source).toEqual({ kind: 'image', image: 'redis:7.2-alpine' })
    // Every setting the blueprint states lands on the column `core/runtime.ts`
    // reads, which is what makes it reach `docker run` (`FJS-1605`).
    expect([r.volumePath, r.healthCheck, r.cpuLimit, r.memLimitMb]).toEqual(['/data', '/ping', 0.5, 256])

    // Every parameter is a variable on the app. A default stands in for a
    // blank field; a blank optional one is absent.
    const vars = await env.as(developer).service('variables').find({ appId: r.id }) as any
    expect(vars.data.map((v: any) => [v.key, v.secret, v.value])).toEqual([
      ['KV_KEY', true, null], ['KV_PASSWORD', true, null], ['KV_POLICY', false, 'allkeys-lru'],
    ])

    // The typed password is in no read — paired with the release resolving
    // it, so "not there" is not "not anywhere".
    expect(JSON.stringify(vars)).not.toContain('hunter2-kv')
    expect(JSON.stringify(await env.as(developer).service('apps').get(r.id))).not.toContain('hunter2-kv')
    const snap = await snapshotVariables(env.system, r)
    expect(JSON.stringify(snap)).not.toContain('hunter2-kv')
    const shipped = await releaseEnv(env.system, snap)
    expect(shipped.KV_PASSWORD).toBe('hunter2-kv')
    expect(shipped.KV_POLICY).toBe('allkeys-lru')
    // `random_hex_16` is sixteen BYTES, the way `openssl rand -hex 16` reads.
    expect(shipped.KV_KEY).toMatch(/^[0-9a-f]{32}$/)

    // No Secret row: /secrets/ is the workspace's credentials, not an app's env.
    const secrets = await (env.system as any).secret.findMany({ where: { workspaceId: ws.id } })
    expect(secrets.some((x: any) => x.name.startsWith('cache/'))).toBe(false)
  })

  test('deleting the app takes its variables with it, and a restore brings them back', async () => {
    const r = await make(developer, {
      blueprintId: bp.id, environmentId: environment.id, name: 'Cache three',
      values: { KV_PASSWORD: 'pw-three' },
    }) as any
    const sys  = env.system as any
    const live = () => sys.variable.count({ where: { appId: r.id } })
    expect(await live()).toBe(3)

    await env.as(owner).service('apps').remove(r.id)
    expect(await live()).toBe(0)

    await env.as(owner).service('apps').call('restore', r.id)
    expect(await live()).toBe(3)
    expect((await releaseEnv(env.system, await snapshotVariables(env.system, r))).KV_PASSWORD).toBe('pw-three')
  })

  test('a gone secret fails the release by name rather than starting without it', async () => {
    const r = await make(developer, {
      blueprintId: bp.id, environmentId: environment.id, name: 'Cache two',
      values: { KV_PASSWORD: 'x' },
    }) as any
    const snap = await snapshotVariables(env.system, r)
    await (env.system as any).variable.delete({ where: { id: snap.secretEnv.KV_PASSWORD } })
    await expect(releaseEnv(env.system, snap)).rejects.toThrow(/KV_PASSWORD/)
  })

  test('a required parameter is refused by its label, an unknown one by its key', async () => {
    await expect(make(developer, { blueprintId: bp.id, environmentId: environment.id, name: 'No pw' }))
      .rejects.toThrow(/Required: Password/)
    await expect(make(developer, { blueprintId: bp.id, environmentId: environment.id, name: 'Typo',
      values: { KV_PASSWORD: 'x', KV_PASWORD: 'y' } }))
      .rejects.toThrow(/KV_PASWORD/)
    // Neither left an app behind.
    expect(await (env.system as any).app.count({ where: { name: { in: ['No pw', 'Typo'] } } })).toBe(0)
  })

  test('a withdrawn blueprint is not offered, and a viewer cannot make an app', async () => {
    await expect(make(developer, { blueprintId: gone.id, environmentId: environment.id, name: 'Old' }))
      .rejects.toThrow(/withdrawn/)
    await expect(make(viewer, { blueprintId: bp.id, environmentId: environment.id, name: 'V',
      values: { KV_PASSWORD: 'x' } }))
      .rejects.toThrow(/you have: viewer/)
  })

  test('where an app came from is not a column its editor writes', async () => {
    const plain = await env.as(developer).service('apps').create({
      environmentId: environment.id, name: 'Plain', type: 'container',
      source: { kind: 'image', image: 'nginx:alpine' },
    }) as any
    await expect(env.as(developer).service('apps').patch(plain.id, { blueprintId: bp.id }))
      .rejects.toThrow(/blueprintId/)
  })
})

describe('variables', () => {
  const tag = () => Math.random().toString(36).slice(2, 8)
  let environment: any, web: any, api: any

  beforeAll(async () => {
    const sys     = env.system as any
    const project = await sys.project.create({ data: { workspaceId: ws.id, name: 'Vars', slug: `vars-${tag()}` } })
    environment   = await sys.environment.create({ data: {
      workspaceId: ws.id, projectId: project.id, name: 'Staging', slug: `stg-${tag()}` } })
    const app = (name: string) => sys.app.create({ data: {
      workspaceId: ws.id, environmentId: environment.id, name, slug: `${name}-${tag()}`,
      source: { kind: 'image', image: 'nginx:alpine' } } })
    web = await app('web')
    api = await app('api')
  })

  const vars = (who: any = developer) => env.as(who).service('variables')

  test("a release gets its environment's variables with its own on top", async () => {
    await vars().create({ environmentId: environment.id, key: 'LOG_LEVEL', value: 'debug' })
    await vars().create({ environmentId: environment.id, key: 'DATABASE_URL', value: 'pg://shared-pw', secret: true })
    await vars().create({ appId: web.id, key: 'LOG_LEVEL', value: 'info' })
    // The app's own plain value replaces the environment's secret of that key.
    await vars().create({ appId: web.id, key: 'DATABASE_URL', value: 'pg://web-only' })

    expect(await releaseEnv(env.system, await snapshotVariables(env.system, web)))
      .toEqual({ LOG_LEVEL: 'info', DATABASE_URL: 'pg://web-only' })
    expect(await releaseEnv(env.system, await snapshotVariables(env.system, api)))
      .toEqual({ LOG_LEVEL: 'debug', DATABASE_URL: 'pg://shared-pw' })
  })

  test('a viewer reads the keys and never a secret, and writes nothing', async () => {
    const list = await vars(viewer).find({ environmentId: environment.id, appId: null }) as any
    expect(list.data.map((v: any) => v.key)).toEqual(['DATABASE_URL', 'LOG_LEVEL'])
    expect(JSON.stringify(list)).not.toContain('shared-pw')
    await expect(vars(viewer).create({ environmentId: environment.id, key: 'X', value: 'y' })).rejects.toThrow()
  })

  test('a key is a name a container can take, and one key per scope', async () => {
    await expect(vars().create({ environmentId: environment.id, key: 'NO SPACES', value: 'x' }))
      .rejects.toThrow(/letters, digits and underscores/)
    await expect(vars().create({ environmentId: environment.id, key: 'LOG_LEVEL', value: 'again' })).rejects.toThrow()
  })

  test('a removed variable frees its key, and a secret stays secret on an edit', async () => {
    const row = await vars().create({ appId: api.id, key: 'TOKEN', value: 'first', secret: true }) as any
    const edited = await vars().patch(row.id, { value: 'second', version: row.version }) as any
    expect(edited.value).toBe(null)
    const stored = await (env.system as any).variable.findFirst({ where: { id: row.id } })
    expect(stored.secretValue).toBe('second')
    await expect(vars().patch(row.id, { secret: false, version: edited.version })).rejects.toThrow(/secret/)

    await vars().remove(row.id)
    await vars().create({ appId: api.id, key: 'TOKEN', value: 'third', secret: true })
  })

  test('a runtime setting the machine would refuse is refused at the write', async () => {
    // The machine checks too, but only after the old container is gone.
    const apps = env.as(developer).service('apps')
    await expect(apps.patch(web.id, { volumePath: '/etc:/host' })).rejects.toThrow(/volumePath|absolute path/)
    await expect(apps.patch(web.id, { cpuLimit: 0 })).rejects.toThrow(/cpuLimit/)
    await expect(apps.patch(web.id, { port: null, healthCheck: '/up' })).rejects.toThrow(/health check/)
  })

  test('an app has no config blob for a setting to hide in', async () => {
    await expect(env.as(developer).service('apps').patch(web.id, { config: { env: { A: 'b' } } }))
      .rejects.toThrow(/config/)
  })
})

describe('infra.summary counts the fleet Home opens on', () => {
  const tag = () => Math.random().toString(36).slice(2, 8)
  let me: any

  test('counts are this workspace, live rows, and the last day of releases', async () => {
    // A workspace of its own, so every number below is exact rather than
    // "at least" — and the shared one beside it holds rows that must not count.
    const sys  = env.system as any
    const acct = await sys.account.create({ data: { slug: `sum-${tag()}`, displayName: 'Sum' } })
    const u    = await sys.user.create({ data: { email: `sum-${tag()}@x.co`, accountId: acct.id } })
    const w    = await sys.workspace.create({ data: { accountId: acct.id, name: 'Sum', slug: `sum-${tag()}`, ownerId: u.id } })
    await sys.workspaceMember.create({ data: { workspaceId: w.id, userId: u.id, role: 'viewer',
      capabilities: grantsFor('viewer'), acceptedAt: new Date().toISOString() } })
    me = session({ userId: u.id, workspaceId: w.id })

    await serverAt('online',  { workspaceId: w.id, name: 'a', slug: `a-${tag()}` })
    await serverAt('online',  { workspaceId: w.id, name: 'b', slug: `b-${tag()}` })
    const gone = await serverAt('pending', { workspaceId: w.id, name: 'c', slug: `c-${tag()}` })
    await sys.server.transition(gone.id, 'destroy')
    await sys.server.transition(gone.id, 'reportDestroyed')

    const project = await sys.project.create({ data: { workspaceId: w.id, name: 'P', slug: `p-${tag()}` } })
    const e       = await sys.environment.create({ data: { workspaceId: w.id, projectId: project.id, name: 'E', slug: `e-${tag()}` } })
    const mkApp   = (name: string, status: string) => sys.app.create({ data: {
      workspaceId: w.id, environmentId: e.id, name, slug: `${name}-${tag()}`, status } })
    const running = await mkApp('run', 'running')
    await mkApp('err', 'error')
    const deleted = await mkApp('del', 'running')
    await sys.app.remove({ where: { id: deleted.id } })

    // A release is born `pending` and walks its declared moves to the rest.
    const WALK: Record<string, string[]> = { success: ['build', 'succeed'], failed: ['fail'] }
    const release = async (status: string, hoursAgo: number, workspaceId = w.id, a = running) => {
      const d = await sys.deployment.create({ data: {
        workspaceId, appId: a.id, environmentId: a.environmentId, trigger: 'manual',
        queuedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() } })
      for (const move of WALK[status]!) await sys.deployment.transition(d.id, move)
    }
    await release('success', 1)
    await release('failed', 2)
    await release('success', 30)    // outside the day

    const rule = await sys.alertRule.create({ data: { workspaceId: w.id, name: 'r', metricName: 'm',
      severity: 'warning', operator: 'gt', threshold: 1,
      snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() } })
    const ev = (acknowledgedAt: string | null, status = 'firing') => sys.alertEvent.create({ data: {
      ruleId: rule.id, status, severity: 'warning', subjectType: 'series', subjectId: 's',
      message: 'm', acknowledgedAt } })
    await ev(null)
    await ev(new Date().toISOString())
    await ev(null, 'resolved')

    const r = await env.as(me).service('infra').call('summary', null) as any
    expect(r.servers.total).toBe(2)
    expect(r.servers.byStatus.online).toBe(2)
    expect(r.apps.total).toBe(2)
    expect(r.apps.byStatus).toEqual({ running: 1, error: 1 })
    expect(r.releases.total).toBe(2)
    expect(r.releases.byStatus).toEqual({ success: 1, failed: 1 })
    expect(r.alerts).toEqual({ firing: 2, unacknowledged: 1, snoozed: 1 })

    // Paired: a release in the shared workspace, and this one's count holds.
    const op    = await sys.project.create({ data: { workspaceId: ws.id, name: 'OP', slug: `op-${tag()}` } })
    const oe    = await sys.environment.create({ data: { workspaceId: ws.id, projectId: op.id, name: 'OE', slug: `oe-${tag()}` } })
    const other = await sys.app.create({ data: { workspaceId: ws.id, environmentId: oe.id, name: 'x', slug: `x-${tag()}` } })
    await release('failed', 0, ws.id, other)
    const again = await env.as(me).service('infra').call('summary', null) as any
    expect(again.releases.byStatus).toEqual({ success: 1, failed: 1 })
  })
})

// ─── Accepting an invitation ─────────────────────────────────────────────
//
// The whole of `accept` was covered by the browser drive and by nothing else,
// which cost ten minutes to find a one-word scoping bug: the notification added
// for `FJS-967` read `name`, a `const` scoped to the branch that CREATES an
// account — so outside it the identifier resolved to the DOM lib's global
// `name`, `tsc` said nothing because that global is a string, and every accept
// threw at runtime.
//
// These two rows are the two branches. Neither asserts about the notification;
// they assert that accepting still WORKS, which is what a sender added beside a
// transaction can break.
describe('accepting an invitation puts somebody in the workspace', () => {

  // ONE branch here, and the other is the drive's on purpose. Accepting as an
  // ALREADY signed-in person carries a session with no workspace claim, which
  // `tenantClaimGuard` refuses from a service call — the real path arrives over
  // HTTP where the claim is resolved per request, and reproducing that here
  // would be reproducing the transport. The branch below is the one that runs
  // anonymous, and it reaches the same notify call, which is what broke.
  test('an address with no account creates one, and lands signed in', async () => {
    const email = `fresh-${Math.random().toString(36).slice(2, 8)}@x.co`
    const inv   = await env.as(owner).service('invitations')
      .create({ email, role: 'viewer' }) as any

    // Anonymous on purpose: `accept` and `preview` are the only two methods
    // here exempt from authenticate, because the whole population they are for
    // may not have an account yet.
    const res = await env.service('invitations').call('accept', null, {
      token: inv.token, name: 'Fresh Person', password: 'correct-horse',
    }) as any

    expect(res.workspace_id).toBe(ws.id)
    // The session is the half that makes this branch worth a row: a person who
    // has no password memory must land inside the app rather than at a form.
    expect(res.sessionToken).toBeTruthy()
    const made = await env.system.user.findFirst({ where: { email } })
    expect(made.displayName).toBe('Fresh Person')
  })

  // Over the wire, which an in-process call is not: the transport drops every
  // key named for a protected column of the call's model, and `token` is
  // Invitation's. Answered under that name, the session never reached the
  // browser and the new account landed on the invite page signed out.
  test('the session survives the wire', async () => {
    const email = `wire-${Math.random().toString(36).slice(2, 8)}@x.co`
    const inv   = await env.as(owner).service('invitations')
      .create({ email, role: 'viewer' }) as any
    const res = await env.http.post('/invitations').set('x-service-method', 'accept')
      .send({ token: inv.token, name: 'Wire Person', password: 'correct-horse' })
    expect(res.status).toBe(200)
    expect(typeof res.body.sessionToken).toBe('string')
    const me = await env.http.get('/account/me').set('authorization', `Bearer ${res.body.sessionToken}`)
    expect(me.body.email).toBe(email)
  })
})

// ─── A machine's readings, kept ──────────────────────────────────────────
//
// `Server.health` is a snapshot — one Json column overwritten every check-in —
// so *what was this box doing on Tuesday* was gone rather than stale, and three
// widget kinds said so on their own cards (`FJS-956`).
//
// The heartbeat records into the metric store now. What makes that worth its own
// block is the READ: `MetricSeries` is `@@gate("8")` and `@@tenant(none)`,
// because a reading is about a PROCESS — which is right for `process.memoryMb`
// and is exactly what a per-server series is not. Opening the package's read
// slot and asking every app to declare a policy was refused: an app that writes
// none then serves every reading to anyone, fail-open and silent. So the
// confinement is the PARENT READ — `getScoped('server')` at the caller's own
// standing — and the two rows that matter are the pair below.
describe('a server keeps its readings, and only its own workspace may read them', () => {
  let box: any

  beforeAll(async () => {
    const sys = env.system as any
    box = await sys.server.create({
      data: { workspaceId: ws.id, name: 'metric-box', slug: `mbox-${Math.random().toString(36).slice(2, 8)}`,
              status: 'pending' },
    })
  })

  /** A check-in the way an outpost makes one: over HTTP, HMAC-signed. The
   *  method is exempt from `authenticate` and refuses a service call by name,
   *  so driving it any other way would drive something the outpost does not. */
  // Enrolled, because there is no fleet key. Same two steps a real machine takes.
  let SECRET: string
  beforeAll(async () => { SECRET = await enrollMachine(box.id as string) })

  async function checkIn(health: Record<string, unknown>) {
    const body = { outpost_version: '1.0.0', health }
    const path = `/servers/${box.id}`
    const req  = env.http.post(path).set('x-service-method', 'heartbeat')
    for (const [k, v] of Object.entries(await signRequest({
      secret: SECRET, method: 'POST', path, body: JSON.stringify(body),
      timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
    }))) req.set(k, v)
    const res = await req.send(body)
    expect(res.status).toBe(200)
  }

  test('a heartbeat writes a point per reading, labelled with the server', async () => {
    // Over the real service, not by calling the recorder: the seam this asserts
    // is that a check-in reaches the store at all, and a direct call to
    // `recordHealth` agrees with a heartbeat that never invokes it.
    await checkIn({ cpu: 41, memory: 62, disk: 77 })

    const sys  = env.system as any
    const one  = await sys.metricSeries.findFirst({
      where: { labelsKey: seriesKey('server.cpuPercent', { serverId: box.id }) },
    })
    expect(one).toBeTruthy()
    expect(one.labels.serverId).toBe(box.id)
    expect(await sys.metricPoint.count({ where: { seriesId: one.id } })).toBe(1)
  })

  test('a key the outpost sent that this app does not keep is not a series', async () => {
    // `health` is an open Json document and an outpost may send anything. A
    // store that kept every key it was handed grows a series per typo, and every
    // one of them is `@@unique` and permanent.
    await checkIn({ cpu: 41, loadavg: 0.4, swaP: 12 })
    const sys  = env.system as any
    const all  = await sys.metricSeries.findMany({})
    const mine = all.filter((s: any) => s.labels?.serverId === box.id).map((s: any) => s.name).sort()
    expect(mine).toEqual(['server.cpuPercent', 'server.diskPercent', 'server.memoryPercent'])
  })

  test('a missing reading is SILENCE, not a zero', async () => {
    // An outpost that stopped reporting disk and a disk at 0% are different
    // facts, and writing 0 for the first is the store inventing a reading.
    //
    // The assertion is on the VALUE and not on a row COUNT, which is the shape
    // that measures nothing here: a point is keyed on (series, MINUTE), so a
    // second check-in inside one minute updates the point either way and the
    // count is identical whether the guard is there or not. Under the wrong
    // implementation this row's 77 becomes 0.
    const sys  = env.system as any
    const disk = await sys.metricSeries.findFirst({
      where: { labelsKey: seriesKey('server.diskPercent', { serverId: box.id }) },
    })
    const newest = async () => (await sys.metricPoint.findMany({
      where: { seriesId: disk.id }, orderBy: { at: 'desc' }, limit: 1,
    }))[0]

    expect((await newest()).value).toBe(77)
    await checkIn({ cpu: 41 })
    expect((await newest()).value).toBe(77)
  })

  test('…and a reading sent as NULL is the same silence, not a zero', async () => {
    // The other way an absent reading arrives, and the one that coerces. An
    // outpost omits a key it could not read, but `health` is an open Json
    // document written by another process at another version, and `Number(null)`
    // is 0 — so the value that means *I could not take this reading* was the one
    // spelling that wrote a real point at zero. A disk series at 0% is worse
    // than a gap: it draws a graph, and every alert rule watching it reads a
    // machine with room to spare.
    //
    // Paired with `cpu` in the same body, or a rule that dropped the whole
    // check-in would satisfy the assertion above it.
    const sys  = env.system as any
    const disk = await sys.metricSeries.findFirst({
      where: { labelsKey: seriesKey('server.diskPercent', { serverId: box.id }) },
    })
    const cpu  = await sys.metricSeries.findFirst({
      where: { labelsKey: seriesKey('server.cpuPercent', { serverId: box.id }) },
    })
    const newestOf = async (id: string) => (await sys.metricPoint.findMany({
      where: { seriesId: id }, orderBy: { at: 'desc' }, limit: 1,
    }))[0]

    await checkIn({ cpu: 55, disk: null })
    expect((await newestOf(disk.id)).value).toBe(77)
    expect((await newestOf(cpu.id)).value).toBe(55)
  })

  test('the answer declares the readings as well as holding them', async () => {
    // `readings` is the DECLARATION and `series` is what the store has, and a
    // card needs the first whether or not the second exists — a machine that
    // has never reported disk still has a disk bar to draw off `Server.health`.
    // Answering it is also what keeps the card from holding a list of its own,
    // which is where two of the three spellings were wrong (`FJS-1027`).
    const res = await env.as(owner).service('servers').call('metrics', box.id, {}) as any
    expect(res.readings).toEqual(SERVER_READINGS)
    // Every declared reading is answerable: the name it states is a key of
    // `series`, or a card asks for a series this answer never carries.
    for (const r of res.readings) expect(r.name in res.series).toBe(true)
  })

  test('a member reads their own server\'s series', async () => {
    const res = await env.as(owner).service('servers').call('metrics', box.id, {}) as any
    expect(res.serverId).toBe(box.id)
    expect(res.series['server.cpuPercent'].points.length).toBeGreaterThan(0)
    // `null` and not `[]` for a series nothing ever wrote: a machine that has
    // never reported and one whose value is flat draw the same empty chart, and
    // only the first is something a person should be told about.
    expect(res.series['server.memoryPercent']).not.toBe(null)
  })

  test('…AND ANOTHER WORKSPACE\'S SERVER IS 404, from the parent read', async () => {
    // The pair, and the reason the whole read is shaped this way. The refusal
    // comes from the SERVER being unreachable at this caller's standing — a
    // check on the series would be a second access decision over rows the
    // schema says belong to nobody, and the two would then have to be kept in
    // step by hand.
    //
    // A member of this workspace asking for a machine in another one is the
    // sharp case: they are signed in, they hold a real standing, and the only
    // thing between them and another fleet's readings is `getScoped`.
    const sys      = env.system as any
    const elsewhere = await sys.workspace.findFirst({ where: { name: 'Other' } })
    const theirs    = await sys.server.create({
      data: { workspaceId: elsewhere.id, name: 'their-box',
              slug: `their-${Math.random().toString(36).slice(2, 8)}`, status: 'pending' },
    })

    await expect(env.as(owner).service('servers').call('metrics', theirs.id, {}))
      .rejects.toThrow(/not found/i)
  })

  test('and somebody with no membership at all never reaches the method', async () => {
    // A different refusal, one hook earlier, and worth its own row: this one is
    // `sessionScope` and it would still fire if `getScoped` were removed — so
    // without the row above, deleting the parent read would look safe.
    await expect(env.as(outsider).service('servers').call('metrics', box.id, {}))
      .rejects.toThrow(/not a member/i)
  })

  test('a backwards window is refused rather than answered with nothing', async () => {
    await expect(env.as(owner).service('servers').call('metrics', box.id,
      { from: Date.now(), to: Date.now() - 3_600_000 }))
      .rejects.toThrow(/from must be before to/)
  })
})

// ─── the disk picture over time ─────────────────────────────────────────────
//
// `DiskUsage` is `@@unique([serverId])` and stays that way: a second table of
// readings beside the metric store would be a second owner of one idea
// (`FJS-956`). So the trend is a series, written from the same report that
// overwrites the row, and read back off the HOURLY FOLD.
//
// The fold is the half a unit test on either side cannot see. Raw points live
// 48 hours and this graph spans a week, so a reader that took the raw tier
// answers *nothing happened before Tuesday* for every machine in the fleet —
// and looks completely correct on a database seeded a minute ago.

describe('a machine\'s disk is kept over time, folded', () => {
  let box: any

  beforeAll(async () => {
    const sys = env.system as any
    box = await sys.server.create({
      data: { workspaceId: ws.id, name: 'disk-box', slug: `dbox-${Math.random().toString(36).slice(2, 8)}`,
              status: 'pending' },
    })
  })

  let SECRET: string
  beforeAll(async () => { SECRET = await enrollMachine(box.id as string) })

  /** A disk report the way an outpost makes one: over HTTP, HMAC-signed, at the
   *  COLLECTION with the server named in the body. Driving `applyDiskReport`
   *  directly would agree with a report that never reaches it. */
  async function reportDisk(body: Record<string, unknown>) {
    const payload = { server_id: box.id, ...body }
    const path = '/cleanup'
    const req  = env.http.post(path).set('x-service-method', 'report')
    for (const [k, v] of Object.entries(await signRequest({
      secret: SECRET, method: 'POST', path, body: JSON.stringify(payload),
      timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
    }))) req.set(k, v)
    const res = await req.send(payload)
    expect(res.status).toBe(200)
  }

  const REPORT = {
    images:      { total: 12, unused: 4, dangling: 1, size_bytes: 4_000, reclaimable_bytes: 1_500 },
    containers:  { running: 3, stopped: 2, reclaimable_bytes: 700 },
    build_cache: { size_bytes: 900, reclaimable_bytes: 300 },
  }

  const seriesOf = async (name: string) => (env.system as any).metricSeries.findFirst({
    where: { labelsKey: seriesKey(name, { serverId: box.id }) },
  })
  const newestPoint = async (seriesId: string) => ((await (env.system as any).metricPoint.findMany({
    where: { seriesId }, orderBy: { at: 'desc' }, limit: 1,
  }))[0])

  test('one report writes the snapshot AND both series', async () => {
    await reportDisk(REPORT)

    const sys = env.system as any
    // The row is still the snapshot it was — one per machine, overwritten.
    expect(await sys.diskUsage.count({ where: { serverId: box.id } })).toBe(1)

    const held = await seriesOf('server.dockerBytes')
    const free = await seriesOf('server.dockerReclaimableBytes')
    expect(held).toBeTruthy()
    expect(free).toBeTruthy()
    expect(held.unit).toBe('bytes')
  })

  test('each series is a SUM, and it is not the sum somebody writes first', async () => {
    // Both wrong answers are plausible and both read as a number. `dockerBytes`
    // off images alone loses the build cache, which is the figure that grows
    // between deploys and the one a full disk is usually made of; the
    // reclaimable sum off images alone under-promises what a sweep frees.
    const held = await newestPoint((await seriesOf('server.dockerBytes')).id)
    const free = await newestPoint((await seriesOf('server.dockerReclaimableBytes')).id)

    expect(held.value).toBe(4_000 + 900)
    expect(held.value).not.toBe(4_000)
    expect(free.value).toBe(1_500 + 700 + 300)
    expect(free.value).not.toBe(1_500)
  })

  test('a volume\'s bytes are NOT in the reclaimable sum', async () => {
    // The same omission `cleanup.usage` makes for the fleet total: an unused
    // volume's size comes from `Volume`, which owns per-disk sizes, so counting
    // it here too would double it the first time a report was missed.
    const sys = env.system as any
    await sys.volume.create({
      data: { serverId: box.id, name: `vol-${Math.random().toString(36).slice(2, 8)}`,
              driver: 'local', sizeBytes: 5_000, inUse: false },
    })
    await reportDisk(REPORT)
    const free = await newestPoint((await seriesOf('server.dockerReclaimableBytes')).id)
    expect(free.value).toBe(1_500 + 700 + 300)
  })

  test('usage answers the declaration, not just the numbers', async () => {
    const res = await env.as(owner).service('cleanup').call('usage', {}) as any
    expect(res.readings.map((r: any) => r.name))
      .toEqual(['server.dockerBytes', 'server.dockerReclaimableBytes'])
    // `of` computes the sums and must not travel: it is a function, and what it
    // computes is already in the points.
    for (const r of res.readings) expect('of' in r).toBe(false)
  })

  test('the trend is read off the FOLD, so raw points alone draw nothing', async () => {
    // The assertion the whole read is shaped by, and it fails silently the other
    // way: raw is kept 48 hours, this graph spans seven days, and on a database
    // written a minute ago a raw read looks perfect.
    const res = await env.as(owner).service('cleanup').call('usage', {}) as any
    const mine = res.servers.find((s: any) => s.serverId === box.id)
    // Points exist — the reports above wrote them — and nothing has folded yet.
    expect(await (env.system as any).metricPoint.count({
      where: { seriesId: (await seriesOf('server.dockerBytes')).id },
    })).toBeGreaterThan(0)
    expect(mine.trend['server.dockerBytes']).toBeUndefined()
  })

  test('…and an hour that HAS been folded is drawn, oldest first', async () => {
    const sys    = env.system as any
    const series = await seriesOf('server.dockerBytes')
    const hour   = 3_600_000
    const now    = Math.floor(Date.now() / hour) * hour

    // Three hours, written newest first on purpose: the read orders by hour
    // DESC and reverses, because a bound that truncates has to drop the OLDEST
    // hours — ascending with a limit drops the newest, which is a graph that
    // silently stops days ago.
    for (const [ago, max] of [[1, 7_000], [3, 5_000], [2, 6_000]] as [number, number][])
      await sys.metricHour.create({
        data: { seriesId: series.id, hour: now - ago * hour, min: max, max, sum: max, count: 1 },
      })

    const res  = await env.as(owner).service('cleanup').call('usage', {}) as any
    const mine = res.servers.find((s: any) => s.serverId === box.id)
    // `max`, not the mean: a disk graph is read for its high-water mark, and
    // averaging an hour removes exactly the spike somebody is looking for.
    expect(mine.trend['server.dockerBytes']).toEqual([5_000, 6_000, 7_000])
  })

  test('an hour older than the window is not drawn', async () => {
    const sys    = env.system as any
    const series = await seriesOf('server.dockerBytes')
    const hour   = 3_600_000
    const old    = Math.floor((Date.now() - 30 * 24 * hour) / hour) * hour
    await sys.metricHour.create({
      data: { seriesId: series.id, hour: old, min: 1, max: 1, sum: 1, count: 1 },
    })

    const res  = await env.as(owner).service('cleanup').call('usage', {}) as any
    const mine = res.servers.find((s: any) => s.serverId === box.id)
    expect(mine.trend['server.dockerBytes']).toEqual([5_000, 6_000, 7_000])
  })

  test('a machine that has never reported has no trend at all', async () => {
    // Absent rather than empty, the same distinction `reported` makes one line
    // up: a machine whose outpost has never checked in is not a machine with a
    // flat disk.
    const sys   = env.system as any
    const fresh = await sys.server.create({
      data: { workspaceId: ws.id, name: 'quiet-box', slug: `qbox-${Math.random().toString(36).slice(2, 8)}`,
              status: 'pending' },
    })
    const res  = await env.as(owner).service('cleanup').call('usage', {}) as any
    const mine = res.servers.find((s: any) => s.serverId === fresh.id)
    expect(mine.trend).toEqual({})
    expect(mine.reported).toBe(false)
  })
})

// ─── how full the disk actually is ──────────────────────────────────────────
//
// Every other number on the cleanup screen is `docker system df`'s and is about
// DOCKER. None of them is the denominator: *12 GB reclaimable* is not worth a
// sweep on a disk at 40% and is tonight's incident on one at 96%, and until now
// the screen carried the numerator alone.
//
// The reading comes off the HEARTBEAT — the outpost's `statfs('/')` — which is a
// different wire from the disk report on its own slower clock. So a machine can
// have either reading without the other, and the screen has to say which one is
// missing rather than drawing a bar at zero, because on this number zero is not
// a small answer: it reads as *there is room here*, which is the exact opposite
// of what an unheard-from machine means.

describe('the cleanup screen is told how full each disk is', () => {
  let box: any
  const usage = async () => await env.as(owner).service('cleanup').call('usage', {}) as any
  const mine  = async (id: string) => (await usage()).servers.find((s: any) => s.serverId === id)

  beforeAll(async () => {
    box = await serverAt('online',
      { workspaceId: ws.id, name: 'full-box', slug: `fbox-${Math.random().toString(36).slice(2, 8)}`,
        lastHeartbeatAt: new Date().toISOString(), health: { cpu: 12, memory: 40, disk: 94.2 } })
  })

  test('the mount reading reaches the read the screen makes', async () => {
    const row = await mine(box.id)
    expect(row.fullness).toBe(94.2)
    // The instant travels with it. A percentage with nothing beside it is read
    // as current, and this one is as old as the machine's last check-in.
    expect(row.fullnessAt).toBeTruthy()
  })

  test('a machine that has never spoken has NO fullness, and it is not zero', async () => {
    // The pair, and the one that decides the whole shape. Both answers render:
    // `null` is a sentence saying the machine has not reported, and 0 is a green
    // bar saying the disk is empty.
    const sys   = env.system as any
    const quiet = await sys.server.create({
      data: { workspaceId: ws.id, name: 'quiet-disk', slug: `qd-${Math.random().toString(36).slice(2, 8)}`,
              status: 'pending' },
    })
    const row = await mine(quiet.id)
    expect(row.fullness).toBe(null)
    expect(row.fullness).not.toBe(0)
  })

  test('a machine that sent `disk: null` is the same absence', async () => {
    // `Number(null)` is 0, so this is the spelling that turns *I could not read
    // it* into a disk with 100% free. Paired with a sibling key that survives,
    // or dropping the whole health document would pass this row.
    const odd = await serverAt('online',
      { workspaceId: ws.id, name: 'odd-disk', slug: `od-${Math.random().toString(36).slice(2, 8)}`,
        lastHeartbeatAt: new Date().toISOString(), health: { cpu: 30, disk: null } })
    expect((await mine(odd.id)).fullness).toBe(null)
    expect(readingOf({ cpu: 30, disk: null }, 'cpu')).toBe(30)
  })

  test('the two wires are independent — a heartbeat without a disk report', async () => {
    // `box` has never sent a `cleanup.report`, so every Docker figure on its
    // card is absent while the bar draws. A screen that hung the bar off
    // `reported` would show nothing here, which is the arrangement this test
    // exists to refuse.
    const row = await mine(box.id)
    expect(row.reported).toBe(false)
    expect(row.fullness).toBe(94.2)
  })

  test('…and a disk report without a heartbeat', async () => {
    // The other direction, and it is not the same claim: this machine's Docker
    // figures are all real and its bar has nothing to draw. Two absences, two
    // sentences.
    const sys  = env.system as any
    const dark = await sys.server.create({
      data: { workspaceId: ws.id, name: 'dark-disk', slug: `dd-${Math.random().toString(36).slice(2, 8)}`,
              status: 'pending' },
    })
    await sys.diskUsage.create({
      data: { serverId: dark.id, imagesTotal: 3, imagesUnused: 1, imagesDangling: 0,
              imageBytes: 1_000, buildCacheBytes: 100, containersRunning: 1, containersStopped: 0,
              imagesReclaimableBytes: 200, containersReclaimableBytes: 0,
              buildCacheReclaimableBytes: 100, reportedAt: new Date().toISOString() },
    })
    const row = await mine(dark.id)
    expect(row.reported).toBe(true)
    expect(row.fullness).toBe(null)
  })

  test('another workspace\'s machine is not in the answer at all', async () => {
    // `fleetOf` is the tenancy boundary for this whole service, and it now
    // carries a machine's health rather than its name alone — so the widened
    // select is asserted to be still inside the same scope.
    const sys       = env.system as any
    const elsewhere = await sys.workspace.findFirst({ where: { name: 'Other' } })
    const theirs    = await serverAt('online',
      { workspaceId: elsewhere.id, name: 'their-disk',
        slug: `td-${Math.random().toString(36).slice(2, 8)}`, health: { disk: 99 } })
    expect((await usage()).servers.find((s: any) => s.serverId === theirs.id)).toBeUndefined()
  })
})

// ─── a refusal is not a fault, and a bad id is not a miss (FJS-1018) ─────────
//
// `NotFound: Portal service 'null' not found` turned up in the API log during
// ordinary use and every wired caller was driven without producing it. What the
// row actually COST was two conflations, and both are here.
//
// The first is that one sentence answered three different questions — no id at
// all (`$.id` is null), a caller that interpolated an empty value (the STRING
// 'null'), and an appliance genuinely absent from the registry. A reader could
// not tell a bug in this app from a configuration somebody removed.
//
// The second is the app-wide one and is the reason the row was worth filing:
// the `error:` hook logged EVERY thrown service error at ERROR, so an ordinary
// 404 — and every 401 a stranger causes, and every 403 the gate is there to
// give — read as a fault and buried the 500s that are.

// ─── a service over no model is graded by the level it declares ──────────────
// FJS-1342. The hub, the portal and infra carry no @@gate, so a hook was the
// only thing refusing — invisible to an agent's tool list, which offered
// `hub_setSystemAdmin` to a viewer. Each method now declares its level; every
// refusal is paired with the caller one rung up who is let through.

describe('a service over no model is graded by the level it declares (FJS-D408)', () => {

  test('the hub is SYSADMIN: a workspace owner is refused, a sysadmin reads', async () => {
    await expect(env.as(owner).service('hub').call('flags')).rejects.toThrow(/requires level 7, caller has level 6/)
    await expect(env.as(sysadmin).service('hub').call('flags')).resolves.toBeDefined()
  })

  test('portal ping is ADMINISTRATOR: a developer is refused, the owner pings', async () => {
    const id = (await env.as(viewer).service('portal').find()).data[0].id
    await expect(env.as(developer).service('portal').call('ping', id)).rejects.toThrow(/requires level 5, caller has level 4/)
    expect((await env.as(owner).service('portal').call('ping', id)).id).toBe(id)
  })

  test('the portal and infra read at READER: a viewer reads, a signed-in stranger to the workspace does not', async () => {
    expect((await env.as(viewer).service('portal').find()).data.length).toBeGreaterThan(0)
    await expect(env.as(viewer).service('infra').call('graph')).resolves.toBeDefined()
    await expect(env.as(outsider).service('portal').find()).rejects.toThrow()
    await expect(env.as(outsider).service('infra').call('graph')).rejects.toThrow()
  })
})

describe('a bad appliance id names itself, and a refusal is not logged as a fault', () => {
  const portalAs = (who: any) => env.as(who).service('portal')

  test('an id that is not an id is a 400, and a real id nobody serves is a 404', async () => {
    // The pair is the assertion. A guard that refused everything would satisfy
    // either row alone, and refusing *nothing* is where this started.
    const bad = await portalAs(owner).get('null').catch((e: any) => e)
    expect(bad).toBeInstanceOf(Error)
    expect(bad.code ?? bad.status).toBe(400)
    // Named, so the log says which of the two happened.
    expect(String(bad.message)).toContain('needs an appliance id')

    const miss = await portalAs(owner).get('no-such-appliance').catch((e: any) => e)
    expect(miss).toBeInstanceOf(Error)
    expect(miss.code ?? miss.status).toBe(404)
    expect(String(miss.message)).toContain('not found')
  })

  test('the string forms are the ones a template writes, and `!id` misses them', async () => {
    // 'undefined' and '' are the same mistake at two spellings, and only one of
    // them is falsy — which is why the widget's own guard had to widen too.
    for (const id of ['undefined', '']) {
      const e = await portalAs(owner).get(id).catch((err: any) => err)
      expect(e.code ?? e.status).toBe(400)
    }
  })

  test('a real appliance still answers, which is what says the guard is not refusing everything', async () => {
    const rows  = (await portalAs(owner).find()).data
    expect(rows.length).toBeGreaterThan(0)
    const entry = await portalAs(owner).get(rows[0].id)
    expect(entry.id).toBe(rows[0].id)
  })

  test('a 4xx is logged as a refusal and a 5xx as a fault', async () => {
    // Graded against the SHIPPED hook by capturing what the real logger wrote,
    // not against a copy of it retyped here: a copy passes whatever the hook
    // does, which is the failure this whole row is an instance of.
    const lines: any[] = []
    const write = process.stdout.write.bind(process.stdout)
    ;(process.stdout as any).write = (chunk: any, ...rest: any[]) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      for (const line of text.split('\n'))
        if (line.startsWith('{')) { try { lines.push(JSON.parse(line)) } catch {} }
      return write(chunk, ...rest)
    }
    try {
      // A refusal the app exists to give.
      await portalAs(owner).get('no-such-appliance').catch(() => {})
    } finally {
      ;(process.stdout as any).write = write
    }

    const said = lines.filter(l => l.message === 'portal.get failed')
    expect(said.length).toBeGreaterThan(0)
    // The claim: a 404 is a refusal. It used to be written at ERROR, which is
    // what made an ordinary miss read as a fault and buried the real ones.
    expect(said.every(l => l.level === 'warn')).toBe(true)
    // And the status is CARRIED, so the line says which refusal it was — the
    // whole reason 400 and 404 were separated a few rows up.
    expect(said.some(l => l.data?.status === 404)).toBe(true)
  })
})

// ─── FJS-1087: custom methods whose caller the floor did not grade ───────────
//
// `surface.snapshot.md` lists 110 methods here that only check presence. Read
// one by one, three reached past that: a roster read through `asSystem()` for
// any id, conduit's cross-workspace registry behind `authenticate` alone, and
// two writers of a protected environment that skipped the check `patch` makes.
// Every refusal is PAIRED with the caller it must still admit.
describe('a custom method grades its caller before a system read or a guarded write', () => {
  test('members answers a member and refuses anyone else exactly as get does', async () => {
    const roster = await env.as(viewer).service('workspaces').call('members', ws.id)
    expect(roster.total).toBeGreaterThanOrEqual(3)

    await expect(env.as(outsider).service('workspaces').call('members', ws.id)).rejects.toThrow(/not found/)
    await expect(env.as(outsider).service('workspaces').get(ws.id)).rejects.toThrow(/not found/)
  })

  test('the conduit registry is the hub tier: a sysadmin lists it, a workspace owner does not', async () => {
    await (env.app as any).conduit.register({
      id: `outpost:fjs-1087-${Math.random().toString(36).slice(2, 8)}`, kind: 'outpost', protocol: 'http',
      address: 'http://127.0.0.1:9', auth: { type: 'hmac', ref: 'secret:none' }, registered_at: Date.now(), last_seen_at: null,
    })
    const listed = await env.as(sysadmin).service('conduit-targets').find()
    const rows   = Array.isArray(listed) ? listed : listed.data
    expect(rows.some((t: any) => String(t.id).startsWith('outpost:fjs-1087-'))).toBe(true)

    await expect(env.as(owner).service('conduit-targets').find()).rejects.toThrow()
    await expect(env.as(owner).service('conduit-targets').remove(rows[0].id)).rejects.toThrow()
    expect((await (env.app as any).conduit.list()).some((t: any) => t.id === rows[0].id)).toBe(true)
  })

  test('a protected environment refuses a developer on every writer, and an owner still writes it', async () => {
    const sys  = env.system as any
    const proj = await sys.project.create({ data: { workspaceId: ws.id, name: 'Prot', slug: `prot-${Math.random().toString(36).slice(2, 8)}` } })
    const prod = await sys.environment.create({ data: { workspaceId: ws.id, projectId: proj.id, name: 'prod', slug: `prod-${Math.random().toString(36).slice(2, 8)}`, isProtected: true } })
    const vars = async () => (await sys.variable.findMany({ where: { environmentId: prod.id } })).map((v: any) => v.key)
    const set  = (who: any) => env.as(who).service('variables')
      .create({ environmentId: prod.id, key: 'DATABASE_URL', value: 'postgres://real', secret: true })

    await expect(set(developer)).rejects.toThrow(/Protected environments/)
    expect(await vars()).toEqual([])

    const row = await set(owner) as any
    expect(await vars()).toEqual(['DATABASE_URL'])
    for (const call of [
      () => env.as(developer).service('variables').patch(row.id, { value: 'postgres://elsewhere', version: row.version }),
      () => env.as(developer).service('variables').remove(row.id),
    ]) await expect(call()).rejects.toThrow(/Protected environments/)
    expect(await vars()).toEqual(['DATABASE_URL'])
  })

  test('restore is graded as an update: a viewer is refused and a developer restores', async () => {
    const sys  = env.system as any
    const proj = await sys.project.create({ data: { workspaceId: ws.id, name: 'Gone', slug: `gone-${Math.random().toString(36).slice(2, 8)}` } })
    await sys.project.remove({ where: { id: proj.id } })
    const deleted = async () => Boolean((await sys.project.findFirst({ where: { id: proj.id }, withDeleted: true })).deletedAt)

    await expect(env.as(viewer).service('projects').call('restore', proj.id)).rejects.toThrow(/level 4/)
    expect(await deleted()).toBe(true)
    await env.as(developer).service('projects').call('restore', proj.id)
    expect(await deleted()).toBe(false)
  })
})

describe('the trash lists what was deleted, and each service brings its own back', () => {
  const uniq  = () => Math.random().toString(36).slice(2, 8)
  const trash = async (who: any = owner) => {
    const out = await env.as(who).service('trash').find()
    return (out.data ?? out) as any[]
  }
  const live = async (accessor: string, id: string) =>
    !(await (env.system as any)[accessor].findFirst({ where: { id }, withDeleted: true })).deletedAt

  async function projectTree() {
    const sys  = env.system as any
    const proj = await sys.project.create({ data: { workspaceId: ws.id, name: `Tree ${uniq()}`, slug: `tree-${uniq()}` } })
    const e    = await sys.environment.create({ data: { workspaceId: ws.id, projectId: proj.id, name: 'staging', slug: 'staging' } })
    const a    = await sys.app.create({ data: { workspaceId: ws.id, environmentId: e.id, name: 'Web', slug: `web-${uniq()}`, type: 'static' } })
    const b    = await sys.app.create({ data: { workspaceId: ws.id, environmentId: e.id, name: 'Api', slug: `api-${uniq()}`, type: 'static' } })
    return { proj, e, a, b }
  }

  test('a deleted project is ONE item that counts what went with it, and restoring it empties the trash of all of it', async () => {
    const { proj, e, a, b } = await projectTree()
    await env.as(owner).service('projects').remove(proj.id)

    const items = await trash()
    const mine  = items.filter((i: any) => [proj.id, e.id, a.id, b.id].includes(i.ref))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ id: `projects:${proj.id}`, service: 'projects', kind: 'Project', name: proj.name, href: `/projects/${proj.id}/` })
    expect(mine[0].includes).toEqual([{ kind: 'Environment', count: 1 }, { kind: 'App', count: 2 }])

    const back = await env.as(owner).service('projects').restore(proj.id)
    expect(back).toMatchObject({ id: proj.id, deletedAt: null })
    for (const [acc, id] of [['project', proj.id], ['environment', e.id], ['app', a.id], ['app', b.id]])
      expect(await live(acc, id)).toBe(true)
    expect((await trash()).some((i: any) => i.ref === proj.id)).toBe(false)
  })

  test('an app deleted BEFORE its environment stays deleted when the environment comes back, and is listed then', async () => {
    const { e, a, b } = await projectTree()
    await env.as(owner).service('apps').remove(a.id)
    expect((await trash()).find((i: any) => i.ref === a.id)).toMatchObject({ kind: 'App', within: 'staging', note: expect.stringContaining('stopped') })

    await env.as(owner).service('environments').remove(e.id)
    const during = await trash()
    // Folded under the environment, and not counted by it: a different delete.
    expect(during.some((i: any) => i.ref === a.id)).toBe(false)
    expect(during.find((i: any) => i.ref === e.id).includes).toEqual([{ kind: 'App', count: 1 }])

    await env.as(owner).service('environments').restore(e.id)
    expect(await live('app', b.id)).toBe(true)
    expect(await live('app', a.id)).toBe(false)
    expect((await trash()).some((i: any) => i.ref === a.id)).toBe(true)
  })

  test('a viewer sees the trash without the kinds it cannot read, and cannot restore', async () => {
    const sys    = env.system as any
    const secret = await sys.secret.create({ data: { workspaceId: ws.id, name: `GONE_${uniq()}`, kind: 'generic' } })
    const proj   = await sys.project.create({ data: { workspaceId: ws.id, name: `Seen ${uniq()}`, slug: `seen-${uniq()}` } })
    await sys.secret.remove({ where: { id: secret.id } })
    await sys.project.remove({ where: { id: proj.id } })

    const seen = await trash(viewer)
    expect(seen.some((i: any) => i.ref === proj.id)).toBe(true)
    expect(seen.some((i: any) => i.kind === 'Secret')).toBe(false)
    expect((await trash(owner)).some((i: any) => i.ref === secret.id)).toBe(true)

    await expect(env.as(viewer).service('projects').restore(proj.id)).rejects.toThrow(/level 4/)
    await expect(env.as(outsider).service('trash').find()).rejects.toThrow()
  })

  test('a channel comes back WITH the credential its delete took', async () => {
    const sys     = env.system as any
    const secret  = await sys.secret.create({ data: { workspaceId: ws.id, name: `hook-${uniq()}`, kind: 'notification' } })
    const channel = await sys.notificationChannel.create({ data: { workspaceId: ws.id, name: `Pager ${uniq()}`, kind: 'webhook', secretId: secret.id } })
    await env.as(owner).service('channels').remove(channel.id)
    expect(await live('secret', secret.id)).toBe(false)

    await env.as(owner).service('channels').restore(channel.id)
    expect(await live('notificationChannel', channel.id)).toBe(true)
    expect(await live('secret', secret.id)).toBe(true)
  })

  test('recipes, dashboards and secrets answer restore, and a row that is not deleted is a 404', async () => {
    const sys = env.system as any
    const rows = {
      recipes:    ['recipe',    await sys.recipe.create({ data: { workspaceId: ws.id, name: `R ${uniq()}`, slug: `r-${uniq()}`, script: 'true' } })],
      dashboards: ['dashboard', await sys.dashboard.create({ data: { workspaceId: ws.id, name: `D ${uniq()}`, slug: `d-${uniq()}` } })],
      secrets:    ['secret',    await sys.secret.create({ data: { workspaceId: ws.id, name: `S_${uniq()}`, kind: 'generic' } })],
    } as Record<string, [string, any]>
    for (const [service, [accessor, row]] of Object.entries(rows)) {
      await expect(env.as(owner).service(service).restore(row.id)).rejects.toThrow(/not/)
      await env.as(owner).service(service).remove(row.id)
      expect(await env.as(owner).service(service).restore(row.id)).toMatchObject({ id: row.id })
      expect(await live(accessor, row.id)).toBe(true)
    }
  })
})

describe('infra.launch walks to the screen each step happens on', () => {
  test('an empty workspace starts at the machine; a released app on a placed machine is done', async () => {
    const sys  = env.system as any
    const uniq = Math.random().toString(36).slice(2, 8)
    const o    = await sys.user.create({ data: { email: `launch-${uniq}@x.co`, accountId: (await sys.workspace.findFirst({ where: { id: ws.id } })).accountId } })
    const w    = await sys.workspace.create({ data: { accountId: o.accountId, name: 'Launch', slug: `launch-${uniq}`, ownerId: o.id } })
    await sys.workspaceMember.create({ data: {
      workspaceId: w.id, userId: o.id, role: 'owner', capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString(),
    } })
    const me = env.as(session({ userId: o.id, workspaceId: w.id })).service('infra')

    const empty = await me.call('launch')
    expect(empty.done).toBe(0)
    expect(empty.steps[0]).toMatchObject({ id: 'machine', href: '/servers/import/', done: false })

    const srv  = await serverAt('online', { workspaceId: w.id, name: 'box', slug: `box-${uniq}` })
    const proj = await sys.project.create({ data: { workspaceId: w.id, name: 'P', slug: `p-${uniq}` } })
    const e    = await sys.environment.create({ data: { workspaceId: w.id, projectId: proj.id, name: 'prod', slug: 'prod' } })
    const a    = await sys.app.create({ data: { workspaceId: w.id, environmentId: e.id, name: 'Site', slug: 'site', type: 'static' } })

    const half = await me.call('launch')
    expect(half.steps.find((s: any) => s.id === 'app')).toMatchObject({ done: true, href: `/environments/${e.id}/` })
    expect(half.steps.find((s: any) => s.id === 'place')).toMatchObject({ done: false, href: `/apps/${a.id}/` })

    await sys.appServer.create({ data: { appId: a.id, serverId: srv.id } })
    const d = await sys.deployment.create({ data: { workspaceId: w.id, appId: a.id, environmentId: e.id, trigger: 'manual' } })
    await sys.deployment.transition(d.id, 'build')
    await sys.deployment.transition(d.id, 'succeed')

    const all = await me.call('launch')
    expect(all.done).toBe(all.total)
    expect(all.app.id).toBe(a.id)
  })
})

describe('notifications — the inbox reads what the driver writes', () => {
  // Seven kinds wrote rows for weeks and no service read them. The rows below
  // are made the way the inApp driver makes them — `asSystem()`, because the
  // gate says 8 for create — so what is graded is the reading half alone.
  const list = (r: any) => (r.data ?? r) as any[]
  const mine = () => env.as(owner).service('notifications')
  const note = (userId: string, title: string, at: string) =>
    (env.system as any).notification.create({ data: {
      userId, type: 'deploy_failed', data: { title }, createdAt: at,
    } })

  let older: any, newer: any, theirs: any
  beforeAll(async () => {
    older  = await note(owner.userId,     'older', '2026-01-01T00:00:00.000Z')
    newer  = await note(owner.userId,     'newer', '2026-01-02T00:00:00.000Z')
    theirs = await note(developer.userId, 'theirs', '2026-01-03T00:00:00.000Z')
  })

  test('a person lists their own, newest first, and never somebody else\'s', async () => {
    const ids = list(await mine().find()).map(n => n.id)
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id))
    expect(ids).not.toContain(theirs.id)
  })

  test('an empty patch marks one read and a stated null marks it unread again', async () => {
    const read = await mine().patch(older.id, {})
    expect(read.readAt).toBeTruthy()
    const back = await mine().patch(older.id, { readAt: null })
    expect(back.readAt).toBeNull()
  })

  test('a patch rewrites nothing but readAt', async () => {
    const out = await mine().patch(older.id, { data: { title: 'forged' }, type: 'job_failed' })
    expect(out.data.title).toBe('older')
    expect(out.type).toBe('deploy_failed')
  })

  test('nobody marks somebody else\'s', async () => {
    await expect(env.as(developer).service('notifications').patch(newer.id, {})).rejects.toThrow()
    const row = await (env.system as any).notification.findUnique({ where: { id: newer.id } })
    expect(row.readAt).toBeNull()
  })

  test('readAll marks every one of MINE and leaves theirs unread', async () => {
    const unread = list(await mine().find()).filter(n => !n.readAt).length
    expect(unread).toBeGreaterThan(0)
    const { count } = await mine().call('readAll')
    expect(count).toBe(unread)
    expect(list(await mine().find()).every(n => n.readAt)).toBe(true)
    const row = await (env.system as any).notification.findUnique({ where: { id: theirs.id } })
    expect(row.readAt).toBeNull()
  })

  test('a viewer marks their own read — the lowest role still reads its inbox', async () => {
    const n = await note(viewer.userId, 'for the viewer', '2026-01-04T00:00:00.000Z')
    const out = await env.as(viewer).service('notifications').patch(n.id, {})
    expect(out.readAt).toBeTruthy()
    const { count } = await env.as(viewer).service('notifications').call('readAll')
    expect(count).toBe(0)
  })

  test('signed out is refused by name, not answered with an empty inbox', async () => {
    await expect(env.service('notifications').find()).rejects.toThrow(/Sign in to read your notifications/)
  })
})

describe('users — a person edits their own profile, at any standing', () => {
  const sys = () => env.system as any

  test('a viewer reads and edits their own row through me', async () => {
    const users = env.as(viewer).service('users')
    expect((await users.get('me')).id).toBe(viewer.userId)
    const out = await users.patch('me', { displayName: 'Vee', username: 'vee' })
    expect(out.displayName).toBe('Vee')
    const row = await sys().user.findUnique({ where: { id: viewer.userId } })
    expect([row.displayName, row.username]).toEqual(['Vee', 'vee'])
  })

  test('a caller naming no workspace edits theirs too', async () => {
    const bare = session({ userId: viewer.userId })
    const out = await env.as(bare).service('users').patch(viewer.userId, { displayName: 'Vee 2' })
    expect(out.displayName).toBe('Vee 2')
  })

  test('nobody reads or edits somebody else\'s, the owner of the workspace included', async () => {
    await expect(env.as(owner).service('users').get(viewer.userId)).rejects.toThrow(/No user/)
    await expect(env.as(owner).service('users').patch(viewer.userId, { displayName: 'forged' }))
      .rejects.toThrow(/No user/)
    expect((await sys().user.findUnique({ where: { id: viewer.userId } })).displayName).not.toBe('forged')
  })

  // Which columns is the schema's, and the service names none of them. Each of
  // these is one a person must not write about themselves.
  test('the address, the organization and every graded column are dropped', async () => {
    const before = await sys().user.findUnique({ where: { id: developer.userId } })
    await env.as(developer).service('users').patch('me', {
      email: 'taken@x.co', accountId: null, emailVerified: true,
      isSystemAdmin: true, status: 'suspended', kind: 'bot', displayName: 'Dev',
      deletedAt: new Date().toISOString(), id: 'hijack', createdAt: '2000-01-01T00:00:00.000Z',
    })
    const row = await sys().user.findUnique({ where: { id: developer.userId } })
    expect(row.email).toBe(before.email)
    expect(row.accountId).toBe(before.accountId)
    expect(row.emailVerified).toBe(before.emailVerified)
    expect([row.isSystemAdmin, row.status, row.kind]).toEqual([before.isSystemAdmin, before.status, before.kind])
    expect(row.displayName).toBe('Dev')
    expect(row.deletedAt).toBeNull()
    expect(row.createdAt).toBe(before.createdAt)
  })

  test('there is no list of people here', async () => {
    await expect(env.as(owner).service('users').find()).rejects.toThrow()
  })

  // The gate reads at 1, so a stranger is refused before the service runs,
  // unlike notifications, whose read is 0.
  test('signed out is refused, not answered with nobody', async () => {
    await expect(env.service('users').get('me')).rejects.toThrow(/Authentication required/)
  })
})

describe('leaving a workspace, and handing one over', () => {
  const uniq = () => Math.random().toString(36).slice(2, 8)
  const sys  = () => env.system as any

  /** A workspace of its own per test, so a transfer never moves the shared
   *  `ws` owner every other test signs in as. */
  async function crew(...roles: string[]) {
    const acct = await sys().account.create({ data: { slug: `crew-${uniq()}`, displayName: 'Crew' } })
    const people: { id: string; role: string }[] = []
    for (const role of roles) {
      const u = await sys().user.create({ data: { email: `${role}-${uniq()}@x.co`, accountId: acct.id } })
      people.push({ id: u.id, role })
    }
    const w = await sys().workspace.create({
      data: { accountId: acct.id, name: 'Crew', slug: `crew-${uniq()}`, ownerId: people[0].id },
    })
    for (const p of people)
      await sys().workspaceMember.create({ data: {
        workspaceId: w.id, userId: p.id, role: p.role,
        capabilities: grantsFor(p.role), acceptedAt: new Date().toISOString(),
      } })
    const as = (i: number) => env.as(session({ userId: people[i].id, workspaceId: w.id })).service('workspaces')
    const roleOf = async (i: number) =>
      (await sys().workspaceMember.findFirst({ where: { workspaceId: w.id, userId: people[i].id } }))?.role ?? null
    const ownerId = async () => (await sys().workspace.findUnique({ where: { id: w.id } })).ownerId
    return { w, people, as, roleOf, ownerId }
  }

  test('a viewer leaves, and is no longer a member', async () => {
    const c = await crew('owner', 'viewer')
    await c.as(1).call('leave', c.w.id)
    expect(await c.roleOf(1)).toBeNull()
    expect(await c.roleOf(0)).toBe('owner')
  })

  test('the only owner cannot leave, and is told what to do instead', async () => {
    const c = await crew('owner', 'admin')
    await expect(c.as(0).call('leave', c.w.id)).rejects.toThrow(/Hand ownership to another member/)
    expect(await c.roleOf(0)).toBe('owner')
  })

  test('one of two owners leaves, and the workspace names the other', async () => {
    const c = await crew('owner', 'owner')
    await c.as(0).call('leave', c.w.id)
    expect(await c.roleOf(0)).toBeNull()
    expect(await c.ownerId()).toBe(c.people[1].id)
  })

  test('leaving a workspace you are not in is a 404, not a success', async () => {
    const c = await crew('owner')
    await expect(env.as(developer).service('workspaces').call('leave', c.w.id)).rejects.toThrow(/not found/)
  })

  test('an owner hands over and steps down to admin, in one write', async () => {
    const c = await crew('owner', 'developer')
    await c.as(0).call('transferOwnership', c.w.id, { userId: c.people[1].id })
    expect([await c.roleOf(0), await c.roleOf(1)]).toEqual(['admin', 'owner'])
    expect(await c.ownerId()).toBe(c.people[1].id)
    // Stepped down means graded down: the grid moved with the word.
    const row = await sys().workspaceMember.findFirst({ where: { workspaceId: c.w.id, userId: c.people[0].id } })
    expect(row.capabilities).toEqual(grantsFor('admin'))
    // …and the one who stepped down can now leave, since somebody holds it.
    await c.as(0).call('leave', c.w.id)
    expect(await c.roleOf(0)).toBeNull()
  })

  test('an admin cannot hand over what they do not hold', async () => {
    const c = await crew('owner', 'admin', 'developer')
    await expect(c.as(1).call('transferOwnership', c.w.id, { userId: c.people[2].id }))
      .rejects.toThrow(/Requires owner role/)
    expect(await c.roleOf(2)).toBe('developer')
  })

  test('nor to somebody outside the workspace', async () => {
    const c = await crew('owner')
    await expect(c.as(0).call('transferOwnership', c.w.id, { userId: developer.userId }))
      .rejects.toThrow(/Member not found/)
    expect(await c.roleOf(0)).toBe('owner')
  })
})

describe('a list honors every filter it admits', () => {
  // The hand-written finds named two or three filters each and dropped the
  // rest, after autoFilter had already judged the key a column — so a filter
  // on `branch` or `name` answered 200 with every row. Each claim below is
  // paired with a row it must leave out, because a find that ignores its
  // filter passes any test that only looks for the row that should be there.
  const list = (r: any) => (r.data ?? r) as any[]
  const ids  = (r: any) => list(r).map(x => x.id)
  let env1: any, env2: any, placed: any, elsewhere: any, box: any, d1: any, d2: any, job: any

  beforeAll(async () => {
    const sys  = env.system as any
    const uniq = Math.random().toString(36).slice(2, 8)
    const proj = await sys.project.create({ data: { workspaceId: ws.id, name: 'Filters', slug: `filters-${uniq}` } })
    env1 = await sys.environment.create({ data: { workspaceId: ws.id, projectId: proj.id, name: 'one', slug: 'one' } })
    env2 = await sys.environment.create({ data: { workspaceId: ws.id, projectId: proj.id, name: 'two', slug: 'two' } })
    placed    = await sys.app.create({ data: { workspaceId: ws.id, environmentId: env1.id, name: `placed-${uniq}`, slug: 'placed', type: 'static' } })
    elsewhere = await sys.app.create({ data: { workspaceId: ws.id, environmentId: env2.id, name: `elsewhere-${uniq}`, slug: 'elsewhere', type: 'static' } })
    box = await serverAt('online', { workspaceId: ws.id, name: `box-${uniq}`, slug: `box-${uniq}` })
    await sys.appServer.create({ data: { appId: placed.id, serverId: box.id } })
    d1 = await sys.deployment.create({ data: { workspaceId: ws.id, appId: placed.id,    environmentId: env1.id, trigger: 'manual', branch: `main-${uniq}` } })
    d2 = await sys.deployment.create({ data: { workspaceId: ws.id, appId: elsewhere.id, environmentId: env2.id, trigger: 'manual', branch: `feat-${uniq}` } })
    job = await sys.job.create({ data: { workspaceId: ws.id, appId: placed.id, name: `nightly-${uniq}`, kind: 'one_shot', command: 'true' } })
    await sys.job.create({ data: { workspaceId: ws.id, appId: placed.id, name: `weekly-${uniq}`, kind: 'one_shot', command: 'true' } })
  })

  test('apps on one server, and not the app placed nowhere', async () => {
    const got = ids(await env.as(owner).service('apps').find({ serverId: box.id }))
    expect(got).toEqual([placed.id])
  })

  test('apps by a column the find never named', async () => {
    const got = ids(await env.as(owner).service('apps').find({ name: elsewhere.name }))
    expect(got).toEqual([elsewhere.id])
  })

  test('deployments in one environment, and not the other one\'s', async () => {
    const got = ids(await env.as(owner).service('deployments').find({ environmentId: env1.id }))
    expect(got).toEqual([d1.id])
  })

  test('deployments by branch — a filter the /deployments/ bar offers', async () => {
    const got = ids(await env.as(owner).service('deployments').find({ branch: d2.branch }))
    expect(got).toEqual([d2.id])
  })

  test('jobs by name', async () => {
    const got = ids(await env.as(owner).service('jobs').find({ name: job.name }))
    expect(got).toEqual([job.id])
  })

  test('a key that is not a column is still refused by name', async () => {
    await expect(env.as(owner).service('deployments').find({ bogusColumn: 1 })).rejects.toThrow(/bogusColumn/)
    await expect(env.as(owner).service('apps').find({ service_id: placed.id })).rejects.toThrow(/service_id/)
  })
})

// `FJS-1706`: the drive removes a server that is not online and a widget on a
// dashboard points at it. The removal answered 422 where the drive expects a
// soft delete.
describe('removing a server that is not online', () => {
  for (const status of ['pending', 'draining', 'stopped'] as const) {
    test(`a ${status} server is removed, widget and all`, async () => {
      const sys = env.system as any
      const server = await serverAt(status,
        { workspaceId: ws.id, name: `rm-${status}`, slug: `rm-${status}-${Math.random().toString(36).slice(2, 8)}` })
      const board = await sys.dashboard.create({ data: { workspaceId: ws.id, name: `board-${status}`, slug: `board-${status}` } })
      await sys.dashboardWidget.create({ data: { dashboardId: board.id, kind: 'server_health', serverId: server.id, cols: 1 } })

      await env.as(owner).service('servers').remove(server.id)

      expect(await sys.server.findFirst({ where: { id: server.id } })).toBeNull()
    })
  }
})

// ─── The local ssh listing ───────────────────────────────────────────────────
// A development affordance on the servers service (`core/local-ssh.ts`). Off
// unless LOCAL_MACHINE=1, which this process does not set, so the owner hears it
// is not offered — and a developer is refused before that is even asked, by
// the ADMINISTRATOR gate the method declares.

describe('the local ssh listing', () => {
  test('a developer is refused by the declared gate, before anything reads a config', async () => {
    await expect(env.as(developer).service('servers').call('localSshHosts', undefined, {}))
      .rejects.toThrow(/requires level 5/)
  })

  test('an owner is told it is not offered here, rather than handed an empty list', async () => {
    await expect(env.as(owner).service('servers').call('localSshHosts', undefined, {}))
      .rejects.toThrow(/LOCAL_MACHINE=1/)
    await expect(env.as(owner).service('servers').call('localSshProbe', undefined, { alias: 'box' }))
      .rejects.toThrow(/LOCAL_MACHINE=1/)
  })
})

describe('the local repository listing', () => {
  test('a developer is refused by the declared gate, before anything reads a folder', async () => {
    await expect(env.as(developer).service('git').call('localRepos', undefined, { root: '~' }))
      .rejects.toThrow(/requires level 5/)
  })

  test('an owner is told it is not offered here, rather than handed an empty list', async () => {
    await expect(env.as(owner).service('git').call('localRepos', undefined, { root: '~' }))
      .rejects.toThrow(/LOCAL_MACHINE=1/)
  })
})
