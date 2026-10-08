// test/custom-method-gate.test.ts
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
import { createClient, GatePlugin } from '../../litestone/src/index.js'
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
  // For the app-mapping block below: a standing the shipped grader cannot see.
  // `role` is read for PRESENCE there, so this is USER(4) to it and whatever
  // the app's own `getLevel` says to the app.
  manager: { userId: 'u3', userType: 'user',  role: 'manager' },
}

async function shop(getLevel?: (u: unknown) => number) {
  const db: any = await createClient({
    databases: ':memory:', schema: SCHEMA,
    ...(getLevel ? { plugins: [new GatePlugin({ getLevel })] } : {}),
  })
  await db.asSystem().order.create({ data: {} })
  await db.asSystem().variant.create({ data: {} })

  const ran: string[] = []
  const { createApp, defaultConfig } = await import('../index.ts')
  const app: any = createApp({
    db,
    config: { port: 0, services: { dir: '/nonexistent' },
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
  // Over no model at all — `revenue`, `shopfront` — so there is no gate to take
  // a floor from, and a declaration is the only thing that can grade a caller.
  app.services.register(createService({
    name: 'reports',
    methods: [{ method: 'payroll', gate: 5 }, 'ping'],
    async payroll() { ran.push('payroll'); return { ok: true } },
    async ping()    { ran.push('ping');    return { ok: true } },
  }))
  // CRUD verbs over no model — conduit's management service, basecamp's
  // portal. Nothing but a declaration can grade them (`FJS-D408`).
  app.services.register(createService({
    name: 'targets',
    methods: [{ method: 'find', gate: 5 }, { method: 'remove', gate: 5 }, 'get'],
    async find()   { ran.push('find');   return [] },
    async get()    { ran.push('get');    return { id: 1 } },
    async remove() { ran.push('remove'); return { id: 1 } },
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

  const rest = async (who: string, method: string, path: string) => {
    ran.length = 0
    const headers: Record<string, string> = {}
    if (AS[who]) headers.authorization = `Bearer ${who}`
    const res = await app.http.fetch(new Request(`http://localhost${path}`, { method, headers }))
    return { status: res.status, ran: [...ran] }
  }

  return { app: app as App, db, ran, call, rest, close: async () => { await app.stop(); db.$close() } }
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
    // this model*, and a public catalog answers yes to everyone. Defaulting
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

  test('a declaration is graded on a service over no model, where there is no floor', async () => {
    // The declaration used to be read only once a model had answered with a
    // gate, so `gate: 5` here parsed, reached the surface, and a stranger ran
    // the body (`FJS-1087`). The undeclared `ping` beside it is the control:
    // with no model there is still no floor, so it stays open to everyone.
    const s = await shop()

    const stranger = await s.call('nobody', 'reports', 'payroll')
    expect(stranger.status).toBe(401)
    expect(stranger.ran).toEqual([])

    const junior = await s.call('shopper', 'reports', 'payroll')
    expect(junior.status).toBe(403)
    expect(junior.ran).toEqual([])

    const entitled = await s.call('staff', 'reports', 'payroll')
    expect(entitled.status).toBe(200)
    expect(entitled.ran).toEqual(['payroll'])

    for (const who of ['nobody', 'shopper', 'staff']) {
      const out = await s.call(who, 'reports', 'ping')
      expect(`${who}: ${out.status}`).toBe(`${who}: 200`)
      expect(out.ran).toEqual(['ping'])
    }

    await s.close()
  })
})

// ─── whose number is it ───────────────────────────────────────────────────────
//
// The level a declaration is graded against comes from the APP's own mapping —
// `GatePlugin({ getLevel })`, asked through `db.$levelOf` — and not from
// `sessionGateLevel` (`FJS-1161`). The two disagree exactly where a standing is
// not a column on the session: basecamp's level comes from a `WorkspaceMember`
// row, so an `admin` of a workspace is ADMINISTRATOR(5) to every model in the
// schema and CREATOR(3) here, and `flows.save` refused a caller the Data
// boundary admits.
//
// Both directions are asserted, because only one of them is a refusal. A
// mapping that grades a caller HIGHER than the shipped grader was a false 403;
// one that grades them LOWER was a method open to somebody the app does not
// consider an administrator, which no test that only checks the entitled caller
// can see.

describe('the level is the app’s own, not a second reading of the session', () => {

  /** A shop where the word is `manager` and nothing on the session says admin. */
  const byRole = (u: any) => !u ? 0 : u.role === 'manager' ? 5 : u.role ? 4 : 0

  test('a caller the app calls a manager passes a gate of 5 — sessionGateLevel says 4', async () => {
    const s = await shop(byRole)
    // The control: the shipped grader reads `role` for presence, so this
    // principal is USER(4) to it and the call was a 403 for its whole life.
    const { sessionGateLevel } = await import('../src/core/litestone.ts')
    expect(sessionGateLevel(AS.manager as never)).toBe(4)

    const out = await s.call('manager', 'orders', 'settle')
    expect(out.status).toBe(200)
    expect(out.ran).toEqual(['settle'])

    // The pair: a caller the same mapping grades 4 is still refused, so the
    // gate is being applied rather than skipped.
    const junior = await s.call('shopper', 'orders', 'settle')
    expect(junior.status).toBe(403)
    expect(junior.ran).toEqual([])
    await s.close()
  })

  test('…and one the app does NOT, whatever the session says about them', async () => {
    // `staff` carries `isAdmin`, which the shipped grader reads as 5. This app
    // grades on `role` alone, so the method stays shut — a mapping that only
    // ever widened would pass the test above and leave this open.
    const s = await shop(byRole)
    const { sessionGateLevel } = await import('../src/core/litestone.ts')
    expect(sessionGateLevel(AS.staff as never)).toBe(5)

    const out = await s.call('staff', 'orders', 'settle')
    expect(out.status).toBe(403)
    expect(out.ran).toEqual([])
    expect((await s.call('staff', 'orders', 'refund')).status).toBe(200)   // the floor is presence
    await s.close()
  })

  test('the refusal names the number the Data boundary would have used', async () => {
    const s = await shop(byRole)
    const res = await s.app.http.fetch(new Request('http://localhost/orders/1', {
      method:  'POST',
      headers: { 'x-service-method': 'settle', 'content-type': 'application/json',
                 authorization: 'Bearer staff' },
      body:    '{}',
    }))
    expect(res.status).toBe(403)
    // 4, not the 5 `sessionGateLevel` grades this session at. An operator reads
    // this sentence to find the mapping, so the two must be the same number.
    expect(JSON.stringify(await res.json())).toContain('caller has level 4')
    await s.close()
  })

  test('a service over no model is graded by the same mapping', async () => {
    // There is no floor to fall back on here, so the declaration is the whole
    // rule and the mapping is the whole of the number.
    const s = await shop(byRole)
    expect((await s.call('manager', 'reports', 'payroll')).status).toBe(200)
    expect((await s.call('staff',   'reports', 'payroll')).status).toBe(403)
    await s.close()
  })

  test('an app that maps nothing of its own is unchanged', async () => {
    // The fallback, stated: with no mapping to ask, the shipped grader answers
    // — which is the resolver such a schema auto-installs anyway.
    const s = await shop()
    expect((await s.call('staff',   'orders', 'settle')).status).toBe(200)
    expect((await s.call('shopper', 'orders', 'settle')).status).toBe(403)
    await s.close()
  })
})

// ─── what a declaration may say ───────────────────────────────────────────────

// ─── a CRUD verb over no model ────────────────────────────────────────────────

describe('a CRUD verb over no model is graded by its declared gate (FJS-D408)', () => {

  test('below the level is refused before the body runs; at it the body runs — the pair', async () => {
    const s = await shop()
    expect(await s.rest('nobody',  'GET',    '/targets')).toEqual({ status: 401, ran: [] })
    expect(await s.rest('shopper', 'GET',    '/targets')).toEqual({ status: 403, ran: [] })
    expect(await s.rest('shopper', 'DELETE', '/targets/1')).toEqual({ status: 403, ran: [] })
    expect(await s.rest('staff',   'GET',    '/targets')).toEqual({ status: 200, ran: ['find'] })
    expect(await s.rest('staff',   'DELETE', '/targets/1')).toEqual({ status: 200, ran: ['remove'] })
    await s.close()
  })

  test('a verb declaring nothing is unchanged beside it', async () => {
    const s = await shop()
    expect(await s.rest('shopper', 'GET', '/targets/1')).toEqual({ status: 200, ran: ['get'] })
    await s.close()
  })

  test('over a stated model the declaration is refused where it is written', () => {
    expect(() => createService({ name: 'orders', model: 'Order', methods: [{ method: 'find', gate: 5 }] }))
      .toThrow(/model 'Order', whose @@gate grades every CRUD verb/)
  })

  test('over a model reached by name alone it is refused at the call, and nothing runs', async () => {
    // No `model:`, so construction cannot see it — the name resolves Order.
    const s = await shop()
    s.app.services.register(createService({
      name: 'order', methods: [{ method: 'find', gate: 5 }],
      async find() { s.ran.push('order'); return [] },
    }))
    const out = await s.rest('staff', 'GET', '/order')
    expect(out.status).toBe(500)
    expect(out.ran).toEqual([])
    await s.close()
  })
})

// `model: null` — a service whose NAME reaches a model it is not over. Auth's
// `sessions` reaches its own `model Session`, and its `account` reaches any
// row-tenanted app's `model Account` (`FJS-1795`). The rows are the one above,
// with the name resolving `Order` and the declaration graded anyway.
describe('a service declared over no model is never resolved by its name', () => {

  const overNone = (s: Awaited<ReturnType<typeof shop>>) => s.app.services.register(createService({
    name: 'order', model: null,
    methods: [{ method: 'find', gate: 5 }, 'get'],
    async find() { s.ran.push('find'); return [] },
  }))

  test('the declared gate grades the verb: below it refused before the body, at it the body runs', async () => {
    const s = await shop()
    overNone(s)
    expect(await s.rest('nobody',  'GET', '/order')).toEqual({ status: 401, ran: [] })
    expect(await s.rest('shopper', 'GET', '/order')).toEqual({ status: 403, ran: [] })
    expect(await s.rest('staff',   'GET', '/order')).toEqual({ status: 200, ran: ['find'] })
    await s.close()
  })

  test('a verb it did not write is a 405 naming why, not a read of the model its name reaches', async () => {
    const s = await shop()
    overNone(s)
    expect(await s.rest('staff', 'GET', '/order/1')).toEqual({ status: 405, ran: [] })
    await s.close()
  })

  test('describe() reports no model, where an omitted one reports the name', () => {
    expect(createService({ name: 'order', model: null, methods: ['find'] }).describe().model).toBeNull()
    expect(createService({ name: 'order', methods: ['find'] }).describe().model).toBe('order')
  })
})

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

// ─── what the register says about it ──────────────────────────────────────────
//
// `surface.snapshot.md` prints who may call each custom method, and a reader
// acts on that line — it is how `invoices.settle` was found reachable by every
// signed-in shopper while writing through `asSystem()`. So the grade is asserted
// against the GATE'S OWN ANSWER for the same caller, method by method. A test
// on the rendering alone passes with the two drifted apart, which is the one
// failure a register cannot afford.

describe('the surface reports the grade the gate enforces', () => {

  test('each grade agrees with what a caller is actually answered', async () => {
    const s = await shop()
    const { describeSurface } = await import('../src/core/app-model.ts')
    const grades = Object.fromEntries(describeSurface(s.app).services
      .map(svc => [svc.name, svc.methodGrades]))

    // A floor above 0 is presence alone: the shopper reaches the body.
    expect(grades.orders.refund).toEqual({ source: 'floor', level: 1, graded: false })
    expect((await s.call('nobody',  'orders', 'refund')).status).toBe(401)
    expect((await s.call('shopper', 'orders', 'refund')).status).toBe(200)

    // A declared level is graded: the shopper stops, staff pass.
    expect(grades.orders.settle).toEqual({ source: 'declared', level: 5, graded: true })
    expect((await s.call('shopper', 'orders', 'settle')).status).toBe(403)
    expect((await s.call('staff',   'orders', 'settle')).status).toBe(200)

    // A floor of 0 is open, a stranger included.
    expect(grades.variants.availability).toEqual({ source: 'floor', level: 0, graded: false })
    expect((await s.call('nobody', 'variants', 'availability')).status).toBe(200)

    // No model: a declaration is graded, and the undeclared method beside it is
    // checked by nothing.
    expect(grades.reports.payroll).toEqual({ source: 'declared', level: 5, graded: true })
    expect((await s.call('shopper', 'reports', 'payroll')).status).toBe(403)
    expect(grades.reports.ping).toEqual({ source: 'unchecked', level: null, graded: false })
    expect((await s.call('nobody', 'reports', 'ping')).status).toBe(200)

    // CRUD verbs are graded by operation and are not a custom method's row.
    expect('find' in grades.orders).toBe(false)

    await s.close()
  })
})

describe('customMethodGrade', () => {
  const levels = { read: 1, create: 4, update: 4, delete: 5 }

  test('a declared level is graded; an undeclared one takes the read gate as a presence check', async () => {
    const { customMethodGrade } = await import('../src/core/litestone.ts')
    expect(customMethodGrade('settle', { settle: 5 }, levels)).toEqual({ source: 'declared', level: 5, graded: true })
    expect(customMethodGrade('settle', { settle: 0 }, levels)).toEqual({ source: 'declared', level: 0, graded: true })
    expect(customMethodGrade('refund', {},            levels)).toEqual({ source: 'floor',    level: 1, graded: false })
  })

  test('no @@gate leaves no floor, and a declared level is still graded', async () => {
    const { customMethodGrade } = await import('../src/core/litestone.ts')
    expect(customMethodGrade('graph', { graph: 5 }, null)).toEqual({ source: 'declared',  level: 5,    graded: true })
    expect(customMethodGrade('graph', {},           null)).toEqual({ source: 'unchecked', level: null, graded: false })
  })

  test('a describer holding no schema reports the declaration and does not guess the floor', async () => {
    const { customMethodGrade } = await import('../src/core/litestone.ts')
    expect(customMethodGrade('settle', { settle: 5 }, undefined)).toEqual({ source: 'declared', level: 5, graded: true })
    expect(customMethodGrade('refund', {},            undefined)).toEqual({ source: 'floor', level: null, graded: false })
  })
})
