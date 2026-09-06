// tests/channel-claims.test.ts
//
// `FJS-749`. A claim is resolved per REQUEST — junction's `principal:` resolver,
// off a header — and a broadcast has no request. The principal on a connection
// was built at the upgrade, where there is no workspace, no tenant and no header
// to read one from, so under `strategy row` a graded broadcast asked the Data
// boundary about a principal carrying no tenant claim at all.
//
// An `@@deny` fires on UNKNOWN as well as on TRUE, so that is not a narrower
// answer, it is a total one: **every subscriber refused, on every tenanted
// model, for ever**. Measured on basecamp — a signed heartbeat, a real socket,
// and an instrumented `$readAs` — the gate passed at 7 against a required 2 and
// the row policy answered false; the same row and the same principal with one
// `workspaceId` added were delivered. Eighteen live services, and the only sign
// was a once-per-service warning whose own wording reads as *the model is
// genuinely private*.
//
// **Every refusal below is paired with the acceptance of the identical frame by
// somebody entitled to it** (`FJS-351`). A resolver that answers nothing and a
// resolver that answers wrongly both deliver to nobody, which is the shape the
// defect already had.
//
// The manager and the grading are the REAL ones; the Data boundary is stubbed
// to a `$readAs` that applies the rule row tenancy desugars into — the rule
// itself is litestone's and is tested there.

import { describe, test, expect } from 'bun:test'
import { createChannelManager } from '../src/transport/channels.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

type Manager = ReturnType<typeof createChannelManager>

function subscriber(manager: Manager, channels: string[], user: unknown = null) {
  const frames: string[] = []
  const conn = {
    id:     Math.random().toString(36).slice(2),
    user,
    socket: { send: (d: string) => { frames.push(d); return 1 }, close: () => {}, readyState: 1 },
    data:   {},
  }
  for (const c of channels) manager.channel(c).join(conn as never)
  const published = () => frames
    .map(f => JSON.parse(f) as { event?: string; data?: unknown })
    .filter(f => (f.event ?? '').startsWith('servers '))
  return { conn, sent: published, rows: () => published().map(f => f.data) }
}

/**
 * The Data boundary a `strategy row` schema compiles to: the tenancy rule is an
 * `@@deny` over `auth().workspaceId`, and an absent claim is UNKNOWN, which
 * denies. Written as the three-valued comparison rather than as `!==` because
 * that is the whole of what the defect turned on — `undefined` refusing is
 * correct behavior, not a bug in the boundary.
 */
function tenantBoundary(strategy: 'row' | 'database' = 'row') {
  const asked: unknown[] = []
  return {
    asked,
    db: {
      $schema:      { models: [{ name: 'Server' }] },
      $tenancy:     { strategy, column: 'workspaceId', claim: 'workspaceId' },
      $readGrading: () => 'graded' as const,
      $readAs:      async (_a: string, row: any, principal: any) => {
        asked.push(principal)
        const claim = principal?.workspaceId
        if (claim == null) return null                      // UNKNOWN denies
        return claim === row.workspaceId ? row : null
      },
    },
  }
}

const ctxFor = (db: unknown, service = 'servers'): ServiceContext =>
  ({ service, locals: { db }, app: {} } as unknown as ServiceContext)

const WS_A = 'ws-acme'
const WS_B = 'ws-skunkworks'
const ROW_A = { id: 's1', workspaceId: WS_A, name: 'gateway-01', status: 'online' }
const ROW_B = { id: 's2', workspaceId: WS_B, name: 'edge-01',    status: 'online' }

const workspaceClaims = (name: string) =>
  name.startsWith('workspace:') ? { workspaceId: name.slice('workspace:'.length) } : null

async function publish(manager: Manager, db: unknown, row: any, channels: string[]) {
  await manager.publish('servers heartbeat', row, ctxFor(db), () => channels.map(c => manager.channel(c)))
}

// ─── the defect ────────────────────────────────────────────────────────────

describe('a connection carries no per-request claim', () => {
  test('without a resolver a member of the row’s own workspace receives nothing', async () => {
    const manager  = createChannelManager()
    const member   = subscriber(manager, [`workspace:${WS_A}`], { userId: 'u-1', isSystemAdmin: true })
    const { db }   = tenantBoundary()

    await publish(manager, db, ROW_A, [`workspace:${WS_A}`])

    expect(member.sent()).toEqual([])
  })

  test('and the control — the same frame, the same principal, one claim added', async () => {
    const manager = createChannelManager(undefined, workspaceClaims)
    const member  = subscriber(manager, [`workspace:${WS_A}`], { userId: 'u-1', isSystemAdmin: true })
    const { db }  = tenantBoundary()

    await publish(manager, db, ROW_A, [`workspace:${WS_A}`])

    expect(member.rows()).toEqual([ROW_A])
  })

  test('the claim reaches the boundary merged onto the principal, not beside it', async () => {
    const manager      = createChannelManager(undefined, workspaceClaims)
    subscriber(manager, [`workspace:${WS_A}`], { userId: 'u-1' })
    const { db, asked } = tenantBoundary()

    await publish(manager, db, ROW_A, [`workspace:${WS_A}`])

    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ userId: 'u-1', workspaceId: WS_A })
  })
})

// ─── per channel, which is why it cannot live on the connection ────────────

describe('one principal, two workspaces, one socket', () => {
  test('each channel grades with its own claim', async () => {
    const manager = createChannelManager(undefined, workspaceClaims)
    const both    = subscriber(manager, [`workspace:${WS_A}`, `workspace:${WS_B}`], { userId: 'u-1' })
    const { db }  = tenantBoundary()

    await publish(manager, db, ROW_A, [`workspace:${WS_A}`])
    await publish(manager, db, ROW_B, [`workspace:${WS_B}`])

    expect(both.rows()).toEqual([ROW_A, ROW_B])
  })

  test('a claim put on the CONNECTION instead would be wrong for one of them — the negative control',
    async () => {
      // What a single claim per connection buys: the workspace resolved at the
      // upgrade wins in both channels, so one of the two rows is refused. This
      // is the shape the fix deliberately does not have.
      const manager = createChannelManager(undefined, () => ({ workspaceId: WS_A }))
      const both    = subscriber(manager, [`workspace:${WS_A}`, `workspace:${WS_B}`], { userId: 'u-1' })
      const { db }  = tenantBoundary()

      await publish(manager, db, ROW_A, [`workspace:${WS_A}`])
      await publish(manager, db, ROW_B, [`workspace:${WS_B}`])

      expect(both.rows()).toEqual([ROW_A])
    })

  test('two SOCKETS of one person, in different channels, on one publish', async () => {
    // The case the claim signature exists for, and the only one that needs it:
    // `seen` dedupes a CONNECTION, so a single socket is never in two groups —
    // but two sockets of one person are one principal, and keying the cohort on
    // the principal alone grades them both under whichever channel was reached
    // first. The row belongs to A, so the socket watching B must not receive it.
    const manager = createChannelManager(undefined, workspaceClaims)
    const user    = { userId: 'u-1' }
    const inA     = subscriber(manager, [`workspace:${WS_A}`], user)
    const inB     = subscriber(manager, [`workspace:${WS_B}`], user)
    const { db, asked } = tenantBoundary()

    await publish(manager, db, ROW_A, [`workspace:${WS_A}`, `workspace:${WS_B}`])

    expect(asked).toHaveLength(2)
    expect(inA.rows()).toEqual([ROW_A])
    expect(inB.sent()).toEqual([])
  })

  test('a row published to both channels reaches the connection ONCE', async () => {
    // The dedupe the cohort map already had has to survive being split by
    // claim: `seen` is per connection, so a connection in two target channels
    // is graded and sent once, under the first channel that held it.
    const manager = createChannelManager(undefined, workspaceClaims)
    const both    = subscriber(manager, [`workspace:${WS_A}`, `workspace:${WS_B}`], { userId: 'u-1' })
    const { db, asked } = tenantBoundary()

    await publish(manager, db, ROW_A, [`workspace:${WS_A}`, `workspace:${WS_B}`])

    expect(asked).toHaveLength(1)
    expect(both.rows()).toEqual([ROW_A])
  })
})

// ─── the cohort, which is what the claim split could have broken ───────────

describe('cohorts', () => {
  test('two tabs of one person in one channel are one verdict and one frame each', async () => {
    const manager = createChannelManager(undefined, workspaceClaims)
    const user    = { userId: 'u-1' }
    const tab1    = subscriber(manager, [`workspace:${WS_A}`], user)
    const tab2    = subscriber(manager, [`workspace:${WS_A}`], user)
    const { db, asked } = tenantBoundary()

    await publish(manager, db, ROW_A, [`workspace:${WS_A}`])

    expect(asked).toHaveLength(1)
    expect(tab1.rows()).toEqual([ROW_A])
    expect(tab2.rows()).toEqual([ROW_A])
  })

  test('two people in one channel are two verdicts', async () => {
    const manager = createChannelManager(undefined, workspaceClaims)
    subscriber(manager, [`workspace:${WS_A}`], { userId: 'u-1' })
    subscriber(manager, [`workspace:${WS_A}`], { userId: 'u-2' })
    const { db, asked } = tenantBoundary()

    await publish(manager, db, ROW_A, [`workspace:${WS_A}`])

    expect(asked).toHaveLength(2)
  })

  test('with no resolver installed the grading is exactly what it was', async () => {
    // The whole feature is opt-in: an app that declares no claims must reach
    // `$readAs` with the untouched principal, once per principal.
    const manager = createChannelManager()
    // One object, because a cohort is keyed on the principal's IDENTITY — two
    // equal literals are two people to this map and always were.
    const user = { userId: 'u-1' }
    subscriber(manager, ['servers'], user)
    subscriber(manager, ['servers'], user)
    const { db, asked } = tenantBoundary('database')

    await publish(manager, db, ROW_A, ['servers'])

    expect(asked).toEqual([{ userId: 'u-1', id: 'u-1' }])
  })
})

// ─── what a resolver may not do ────────────────────────────────────────────

describe('an empty answer is not a claim', () => {
  test('`{}` leaves an anonymous connection anonymous', async () => {
    // A resolver answering `{}` would otherwise turn a `null` principal into an
    // object, which every `getLevel` in the field grades a rung above a
    // stranger — a widening bought by a resolver that said nothing.
    const manager = createChannelManager(undefined, () => ({}))
    subscriber(manager, [`workspace:${WS_A}`], null)
    const { db, asked } = tenantBoundary()

    await publish(manager, db, ROW_A, [`workspace:${WS_A}`])

    expect(asked).toEqual([null])
  })

  test('and the control — a non-empty answer does reach an anonymous connection', async () => {
    // The pairing matters: refusing to merge `{}` must not also refuse a real
    // claim, which is what a caller with no session legitimately carries — a
    // guest basket's token is exactly this shape.
    const manager = createChannelManager(undefined, () => ({ workspaceId: WS_A }))
    const guest   = subscriber(manager, [`workspace:${WS_A}`], null)
    const { db }  = tenantBoundary()

    await publish(manager, db, ROW_A, [`workspace:${WS_A}`])

    expect(guest.rows()).toEqual([ROW_A])
  })

  test('a resolver that THROWS refuses rather than widening, and says so', async () => {
    // Application code on the fan-out path: without the guard one throw takes
    // down the announcement for every recipient of every channel.
    const manager = createChannelManager(undefined, () => { throw new Error('lookup failed') })
    const member  = subscriber(manager, [`workspace:${WS_A}`], { userId: 'u-1' })
    const { db, asked } = tenantBoundary()

    const lines: string[] = []
    const original = console.warn
    console.warn = (...a: unknown[]) => { lines.push(a.join(' ')) }
    try { await publish(manager, db, ROW_A, [`workspace:${WS_A}`]) }
    finally { console.warn = original }

    expect(asked).toEqual([{ userId: 'u-1', id: 'u-1' }])
    expect(member.sent()).toEqual([])
    expect(lines.join('\n')).toContain('resolver threw')
  })

  test('a stated claim beats a stale one on the session', async () => {
    // The principal was built at the upgrade and the resolver is answering
    // about this channel, so the resolver wins. A session that had somehow
    // carried a workspace would otherwise pin every channel to it.
    const manager = createChannelManager(undefined, workspaceClaims)
    const member  = subscriber(manager, [`workspace:${WS_B}`], { userId: 'u-1', workspaceId: WS_A })
    const { db }  = tenantBoundary()

    await publish(manager, db, ROW_B, [`workspace:${WS_B}`])

    expect(member.rows()).toEqual([ROW_B])
  })
})

// ─── the sentence that would have made this a 30-second diagnosis ──────────

describe('the refuse-all warning names the cause', () => {
  const captureWarn = async (fn: () => Promise<void>) => {
    const lines: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { lines.push(args.join(' ')) }
    try { await fn() } finally { console.warn = original }
    return lines.join('\n')
  }

  test('a `strategy row` schema with no resolver is told which claim is missing', async () => {
    const manager = createChannelManager()
    subscriber(manager, [`workspace:${WS_A}`], { userId: 'u-1' })
    const { db } = tenantBoundary()

    // A distinct service label per test: the warning is deduped per label for
    // the life of the process, so a shared one makes the second test silent.
    const said = await captureWarn(() =>
      manager.publish('servers heartbeat', ROW_A, ctxFor(db, 'servers-hint-a'),
        () => manager.channel(`workspace:${WS_A}`)))

    expect(said).toContain('strategy row')
    expect(said).toContain('workspaceId')
  })

  test('and the control — with a resolver installed the hint is absent', async () => {
    // The hint is about a MISSING resolver. An app that installed one and is
    // still refusing everybody has a different problem, and being told about
    // tenancy would send them the wrong way.
    const manager = createChannelManager(undefined, () => ({ workspaceId: 'ws-other' }))
    subscriber(manager, [`workspace:${WS_A}`], { userId: 'u-1' })
    const { db } = tenantBoundary()

    const said = await captureWarn(() =>
      manager.publish('servers heartbeat', ROW_A, ctxFor(db, 'servers-hint-b'),
        () => manager.channel(`workspace:${WS_A}`)))

    expect(said).toContain('was refused')
    expect(said).not.toContain('strategy row')
  })

  test('and a schema that is not row-tenanted is not told about tenancy either', async () => {
    const manager = createChannelManager()
    subscriber(manager, ['servers'], { userId: 'u-1' })
    const { db } = tenantBoundary('database')

    const said = await captureWarn(() =>
      manager.publish('servers heartbeat', ROW_A, ctxFor(db, 'servers-hint-c'),
        () => manager.channel('servers')))

    expect(said).toContain('was refused')
    expect(said).not.toContain('strategy row')
  })
})
