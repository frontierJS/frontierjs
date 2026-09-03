// tests/publish-grading.test.ts
//
// `FJS-631`. A channel is a named set of connections, and joining one was an
// ungraded GRANT: every row published there reached every member, whatever the
// schema said about who may read it. `@@allow` compiles into a SELECT's WHERE
// and a broadcast is not a SELECT, so a row that reaches a caller through a
// query was filtered by construction and one that reaches them through a frame
// was filtered by nothing.
//
// Measured on `example` before the fix: a socket opened with no token received
// a whole `Order` row — reference, status, subtotal, tax, total, customerId,
// trackingCode — while the same caller was answered **401** on
// `GET /api/orders`.
//
// **Every refusal here is paired with the acceptance of the identical frame by
// somebody entitled to it.** A fix that delivers to nobody is indistinguishable
// from a fix that works, and this file exists because that is exactly the shape
// the first working version had: it refused the anonymous socket AND handed the
// wrong row to a signed-in one (see `the principal has to be translated` below).
//
// The manager and the grading are the REAL ones. The Data boundary is stubbed
// to a `$readAs` that records what it was asked, because the rule itself is
// litestone's and is tested there — what is under test here is the fan-out: who
// gets asked about, how many times, and what goes on the wire.

import { describe, test, expect } from 'bun:test'
import { createChannelManager } from '../src/transport/channels.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

type Manager = ReturnType<typeof createChannelManager>

// A connection whose socket keeps every frame it is sent.
function subscriber(manager: Manager, channelName: string, user: unknown = null, id = Math.random().toString(36).slice(2)) {
  const frames: string[] = []
  const conn = {
    id,
    user,
    socket: { send: (d: string) => { frames.push(d); return 1 }, close: () => {}, readyState: 1 },
    data:   {},
  }
  manager.channel(channelName).join(conn as never)
  // The presence tracker puts a `presence:sync` on any connection carrying a
  // userId, so a bare frame count answers a different question from the one
  // every assertion here is asking. Both views are kept: `sent` is the
  // published event alone, `frames` is everything.
  const published = () => frames
    .map(f => JSON.parse(f) as { event?: string; data?: unknown })
    .filter(f => (f.event ?? '').startsWith('orders ') || (f.event ?? '').startsWith('products '))
  return {
    conn,
    frames,
    sent: published,
    rows: () => published().map(f => f.data),
  }
}

/**
 * A stand-in Data boundary. `decide` is the schema's answer for one principal
 * and one row; `asked` records every question, which is how the cohort
 * assertions are made — a per-connection implementation and a per-principal one
 * deliver identically and ask a different number of times.
 */
function boundary(decide: (principal: any, row: any) => any, grading: 'open' | 'graded' = 'graded') {
  const asked: any[] = []
  return {
    asked,
    db: {
      $schema:      { models: [{ name: 'Order' }] },
      $readGrading: () => grading,
      $readAs:      async (_accessor: string, row: any, principal: any) => {
        asked.push(principal)
        return decide(principal, row)
      },
    },
  }
}

const ctxFor = (db: unknown, service = 'orders'): ServiceContext =>
  ({ service, locals: { db }, app: {} } as unknown as ServiceContext)

const ROW = { id: 1, reference: 'ORD-1001', total: 4194, userId: 'u-owner' }

async function publishOnce(manager: Manager, db: unknown, row: unknown = ROW, service = 'orders') {
  await manager.publish('orders patched', row, ctxFor(db, service), () => manager.channel('orders'))
}

describe('a broadcast is graded per recipient', () => {
  test('a connection the schema refuses receives nothing at all', async () => {
    const manager = createChannelManager()
    const anon    = subscriber(manager, 'orders', null)
    const { db }  = boundary((p) => (p ? ROW : null))

    await publishOnce(manager, db)

    expect(anon.sent()).toEqual([])
  })

  test('and the control — a connection it admits receives the row', async () => {
    const manager = createChannelManager()
    const staff   = subscriber(manager, 'orders', { userId: 'u-staff', isStaff: true })
    const { db }  = boundary((p) => (p ? ROW : null))

    await publishOnce(manager, db)

    expect(staff.rows()).toEqual([ROW])
  })

  test('the two travel on ONE publish, which is the case a single-audience test cannot see',
    async () => {
      const manager = createChannelManager()
      const anon    = subscriber(manager, 'orders', null)
      const staff   = subscriber(manager, 'orders', { userId: 'u-staff' })
      const { db }  = boundary((p) => (p ? ROW : null))

      await publishOnce(manager, db)

      expect(anon.sent()).toEqual([])
      expect(staff.rows()).toEqual([ROW])
    })

  test('each recipient receives the row SHAPED for them, not the writer’s copy', async () => {
    // The writer was staff, so the announced row carries a column a shopper may
    // not read. Field policies are per caller, so the frame has to be too.
    const manager = createChannelManager()
    const staff   = subscriber(manager, 'orders', { userId: 'u-staff', isStaff: true })
    const shopper = subscriber(manager, 'orders', { userId: 'u-owner' })
    const withNote = { ...ROW, secretNote: 'margin 40%' }
    const { db } = boundary((p, row) =>
      p?.isStaff ? row : { ...row, secretNote: undefined })

    await publishOnce(manager, db, withNote)

    expect((staff.rows()[0] as any).secretNote).toBe('margin 40%')
    expect((shopper.rows()[0] as any).secretNote).toBeUndefined()
  })
})

describe('cohorts', () => {
  test('two connections of ONE person are graded once and both receive it', async () => {
    // Phoenix names the cost this avoids: intercepting a broadcast means "the
    // broadcast will be encoded N times instead of a single shared encoding".
    // Hasura's answer is a cohort, and the principal is the key.
    const manager = createChannelManager()
    const user    = { userId: 'u-owner' }
    const tabA    = subscriber(manager, 'orders', user, 'a')
    const tabB    = subscriber(manager, 'orders', user, 'b')
    const { asked, db } = boundary(() => ROW)

    await publishOnce(manager, db)

    expect(asked.length).toBe(1)
    expect(tabA.rows()).toEqual([ROW])
    expect(tabB.rows()).toEqual([ROW])
  })

  test('every anonymous connection is one cohort — they grade identically', async () => {
    const manager = createChannelManager()
    subscriber(manager, 'orders', null, 'x')
    subscriber(manager, 'orders', null, 'y')
    subscriber(manager, 'orders', undefined, 'z')
    const { asked, db } = boundary(() => null)

    await publishOnce(manager, db)

    expect(asked.length).toBe(1)
    expect(asked[0]).toBeNull()
  })

  test('two DIFFERENT people are two cohorts', async () => {
    const manager = createChannelManager()
    subscriber(manager, 'orders', { userId: 'u1' }, 'a')
    subscriber(manager, 'orders', { userId: 'u2' }, 'b')
    const { asked, db } = boundary(() => ROW)

    await publishOnce(manager, db)

    expect(asked.length).toBe(2)
  })

  test('a connection in TWO target channels is graded once and sent once', async () => {
    // Feathers documents the opposite hazard — "it will get the data from the
    // FIRST channel that it is in" — and a set keyed by connection removes the
    // ordering question rather than answering it.
    const manager = createChannelManager()
    const user = { userId: 'u1' }
    const s = subscriber(manager, 'orders', user, 'dual')
    manager.channel('everything').join(s.conn as never)
    const { asked, db } = boundary(() => ROW)

    await manager.publish('orders patched', ROW, ctxFor(db),
      () => [manager.channel('orders'), manager.channel('everything')])

    expect(asked.length).toBe(1)
    expect(s.sent().length).toBe(1)
  })
})

describe('what is not graded, and why that is not a hole', () => {
  test('a model that can only ever say yes is skipped entirely', async () => {
    // `$readGrading` answers `open` for a model whose read gate is 0 and which
    // declares no read policy and no field policy — a catalogue, which is also
    // the busiest channel an app has. Asked of the SCHEMA, so a policy added
    // later turns the channel from open to graded with nothing to remember.
    const manager = createChannelManager()
    const anon    = subscriber(manager, 'products', null)
    const { asked, db } = boundary(() => null, 'open')

    await manager.publish('products patched', ROW, ctxFor(db, 'products'),
      () => manager.channel('products'))

    expect(asked.length).toBe(0)
    expect(anon.rows()).toEqual([ROW])
  })

  test('a LIST payload is not graded — it names no row, so it leaks none', async () => {
    // A bulk write announces a COUNT (`FJS-D34`). There is nothing to grade and
    // nothing to hide.
    const manager = createChannelManager()
    const anon    = subscriber(manager, 'orders', null)
    const { asked, db } = boundary(() => null)

    await manager.publish('orders changed', [{ id: 1 }, { id: 2 }], ctxFor(db),
      () => manager.channel('orders'))

    expect(asked.length).toBe(0)
    expect(anon.sent().length).toBe(1)
  })

  test('no Data boundary on the call is ungraded rather than refused', async () => {
    // An app broadcasting from a raw route, or a test harness: there is nothing
    // to grade against, so nothing is claimed. Distinct from a boundary that
    // WAS asked and could not answer — see the row below.
    const manager = createChannelManager()
    const anon    = subscriber(manager, 'orders', null)

    await manager.publish('orders patched', ROW,
      { service: 'orders', locals: {}, app: {} } as unknown as ServiceContext,
      () => manager.channel('orders'))

    expect(anon.rows()).toEqual([ROW])
  })

  test('but a boundary that THROWS refuses the recipient', async () => {
    // `policyVerdict` throws on an undecidable policy — a `check()` over a
    // relation that is not to-one — and at a boundary an undecidable policy
    // must refuse. Refusing costs a subscriber an update; passing hands them a
    // row the schema says is not theirs.
    const manager = createChannelManager()
    const admitted = subscriber(manager, 'orders', { userId: 'ok' }, 'ok')
    const thrower  = subscriber(manager, 'orders', { userId: 'bad' }, 'bad')
    const db = {
      $schema:      { models: [{ name: 'Order' }] },
      $readGrading: () => 'graded',
      $readAs:      async (_a: string, row: any, p: any) => {
        if (p?.id === 'bad' || p?.userId === 'bad') throw new Error('undecidable')
        return row
      },
    }

    await publishOnce(manager, db)

    expect(thrower.sent()).toEqual([])
    expect(admitted.rows()).toEqual([ROW])
  })
})

describe('the principal has to be translated', () => {
  test('the session’s id reaches the policy as `id`, not `userId`', async () => {
    // A `SessionContext` puts the id at `userId` and litestone's `auth()` reads
    // `.id`. Handing the session straight over compares every row policy
    // against `undefined` — and it does not merely refuse: measured on
    // `example`, `userId == auth().id` was FALSE for the buyer's own order and
    // TRUE for a guest order whose `userId` is null, so the first working
    // version delivered the one row the recipient may not read and withheld the
    // one they own. `toDataPrincipal` is the one owner of the translation.
    const manager = createChannelManager()
    subscriber(manager, 'orders', { userId: 'u-owner', email: 'a@b.test' })
    const { asked, db } = boundary(() => ROW)

    await publishOnce(manager, db)

    expect(asked.length).toBe(1)
    expect((asked[0] as any).id).toBe('u-owner')
  })
})
