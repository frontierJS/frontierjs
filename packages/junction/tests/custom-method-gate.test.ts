// tests/custom-method-gate.test.ts
//
// A custom method's standing (`FJS-826`).
//
// `OP_FOR_METHOD` names the six CRUD verbs, and a method it does not name was
// gated by nothing here. That is not the same as unguarded — a body that writes
// is still refused at the Data boundary by the model's own `@@gate` — but the
// refusal arrived AFTER the body had run. Measured against a `@@gate("5.5.5.5")`
// model: an anonymous `POST` with `X-Service-Method: refund` executed the
// handler, charged the card, and only then took a 403 from the first write,
// while every CRUD verb on the same service answered 401 having run nothing.
//
// So the assertion that matters here is not the status code. It is WHETHER THE
// BODY RAN — `ran` below — because everything a method does before its first
// write (an outbound call, an email, a job dispatch) is what a late refusal
// cannot take back.
//
// Two halves, and only one is derivable:
//
//   THE FLOOR     the model's READ gate. To call anything on a service you must
//                 at least be able to see the model, which is what `find`
//                 already requires. Needs no declaration and covers the
//                 anonymous case.
//
//   ABOVE IT      declared — `methods: [{ method: 'settle', gate: 5 }]`.
//                 Nothing about a custom method's authority is derivable:
//                 `availability` and `refund` sit on one service over one
//                 model and the schema does not separate them.
//
// Every refusal is PAIRED with the same call by somebody entitled to make it
// (`FJS-351`). The pairing is load-bearing twice over here: a floor that
// refused everyone would pass any test that only checks the refusal, AND it
// would shut the two things this repo's own apps need open — the public
// storefront's `availability` and every verb of the guest basket, both on
// read-gate-0 models on purpose. Those are the `open` rows below.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createService } from '../src/core/service.ts'
import { collectMethodGates } from '../src/core/service.ts'
import type { App } from '../src/core/app.ts'

const SCHEMA = `
database main { path "./a.db" }

model Order {
  id     Int    @id @default(autoincrement())
  status String @default("draft")
  @@gate("1.4.4.5")
  @@db(main)
}

// Read at 0 on purpose: the storefront is public and the basket is a
// stranger's own. The floor must not close either.
model Variant {
  id  Int    @id @default(autoincrement())
  sku String @default("s")
  @@gate("0.4.4.5")
  @@db(main)
}
`

/** Who is calling. `sessionGateLevel` grades a plain user 4 and this admin 5. */
const AS: Record<string, unknown> = {
  nobody:  null,
  shopper: { userId: 'u1', userType: 'user',  role: 'user' },
  staff:   { userId: 'u2', userType: 'admin', role: 'admin', isStaff: true, isAdmin: true },
}

async function shop() {
  const db: any = await createClient({ databases: ':memory:', schema: SCHEMA })
  await db.asSystem().order.create({ data: {} })
  await db.asSystem().variant.create({ data: {} })

  const ran: string[] = []
  const { createApp, defaultConfig } = await import('../index.ts')
  const app: any = createApp({
    db,
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' },
              http: { ...defaultConfig.http, drainTimeout: 50 } },
  } as never)

  app.services.register(createService({
    name: 'orders', model: 'Order',
    methods: ['find', 'get', 'refund', { method: 'settle', gate: 5 }],
    // The side effect that cannot be taken back. It runs BEFORE any write, so
    // a Data-boundary refusal is too late for it — which is the whole finding.
    async refund() { ran.push('refund'); return { ok: true } },
    async settle() { ran.push('settle'); return { ok: true } },
  }))
  app.services.register(createService({
    name: 'variants', model: 'Variant',
    methods: ['find', 'availability'],
    async availability() { ran.push('availability'); return { ok: true } },
  }))

  app.setAuth({ verifySession: async (t: string) => AS[t] ?? null })
  await app.start()

  const call = async (who: string, svc: string, method: string) => {
    ran.length = 0
    const headers: Record<string, string> = {
      'x-service-method': method, 'content-type': 'application/json',
    }
    if (AS[who]) headers.authorization = `Bearer ${who}`
    const res = await app.http.fetch(new Request(`http://localhost/${svc}/1`,
      { method: 'POST', headers, body: '{}' }))
    return { status: res.status, ran: [...ran] }
  }

  return { app: app as App, db, call, close: async () => { await app.stop(); db.$close() } }
}

// ─── the derived floor ────────────────────────────────────────────────────────

describe('a custom method takes the model’s read gate as its floor', () => {

  test('a stranger is refused BEFORE the body runs, and told what CRUD tells them', async () => {
    const s = await shop()

    const custom = await s.call('nobody', 'orders', 'refund')
    expect(custom.status).toBe(401)
    // The assertion this file exists for. A 403 from the Data boundary would
    // also be a refusal, and the card would already have been charged.
    expect(custom.ran).toEqual([])

    // The same answer every CRUD verb on this service gives — one service, one
    // story for a stranger, which is what a client can act on.
    const res = await s.app.http.fetch(new Request('http://localhost/orders'))
    expect(res.status).toBe(401)

    await s.close()
  })

  test('…and somebody who can read the model still calls it — the pair', async () => {
    const s = await shop()
    for (const who of ['shopper', 'staff']) {
      const out = await s.call(who, 'orders', 'refund')
      expect(`${who}: ${out.status}`).toBe(`${who}: 200`)
      expect(out.ran).toEqual(['refund'])
    }
    await s.close()
  })

  test('a read-gate-0 model stays open to a stranger — the storefront and the basket', async () => {
    // Not an exception to the rule, it IS the rule: the floor is *can you read
    // this model*, and a public catalogue answers yes to everyone. Defaulting
    // to the strictest WRITE gate instead — the first shape tried — closed
    // this, which is how it was caught.
    const s = await shop()
    for (const who of ['nobody', 'shopper', 'staff']) {
      const out = await s.call(who, 'variants', 'availability')
      expect(`${who}: ${out.status}`).toBe(`${who}: 200`)
      expect(out.ran).toEqual(['availability'])
    }
    await s.close()
  })
})

// ─── the declared level ───────────────────────────────────────────────────────

describe('a method may declare a level above the floor', () => {

  test('a stranger 401, a caller too junior 403, the entitled one through', async () => {
    const s = await shop()

    // Three answers, not two. A 401 is what a browser client responds to by
    // discarding its token, so telling a signed-in caller 401 signs them out
    // of a session that is working.
    const stranger = await s.call('nobody', 'orders', 'settle')
    expect(stranger.status).toBe(401)
    expect(stranger.ran).toEqual([])

    const junior = await s.call('shopper', 'orders', 'settle')
    expect(junior.status).toBe(403)
    expect(junior.ran).toEqual([])

    const entitled = await s.call('staff', 'orders', 'settle')
    expect(entitled.status).toBe(200)
    expect(entitled.ran).toEqual(['settle'])

    await s.close()
  })

  test('the shopper passes the FLOOR and fails the declaration, on one service', async () => {
    // The two rules told apart. Same caller, same service, same model: through
    // on the method that takes the floor, refused on the one that declares 5.
    // Either rule alone agrees with a mechanism that has the other missing.
    const s = await shop()
    expect((await s.call('shopper', 'orders', 'refund')).status).toBe(200)
    expect((await s.call('shopper', 'orders', 'settle')).status).toBe(403)
    await s.close()
  })
})

// ─── what a declaration may say ───────────────────────────────────────────────

describe('a declared gate is a level, and is refused otherwise', () => {

  test('reads the levels off a methods list', () => {
    expect(collectMethodGates(
      ['find', 'refund', { method: 'settle', gate: 5 }, { method: 'void', gate: 0 }], 'orders'))
      .toEqual({ settle: 5, void: 0 })
  })

  test('a method with no gate is absent, not zero', () => {
    // `0` is a real declaration — *anyone, including a stranger* — so it cannot
    // be the value that means *nothing was said*. Absent takes the floor.
    const gates = collectMethodGates([{ method: 'settle', gate: 0 }, 'refund'], 'orders')
    expect('refund' in gates).toBe(false)
    expect(gates.settle).toBe(0)
  })

  for (const bad of [5.5, -1, 10, '5', null, true]) {
    test(`gate ${JSON.stringify(bad)} is refused by name`, () => {
      expect(() => collectMethodGates([{ method: 'settle', gate: bad as never }], 'orders'))
        .toThrow(/not a level/)
    })
  }
})
