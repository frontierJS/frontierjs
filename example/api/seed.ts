// api/seed.ts — enough rows to have something to click, plus two demo users.
//
// Everything here goes through asSystem(): seeding is not a request and has no
// session, so it is not something the gate should be asked about.

import type { IAuth } from '@frontierjs/junction'
import { sys }        from './db.ts'

export const DEMO = {
  user:  { email: 'sam@shop.test',  password: 'correct-horse-battery', name: 'Sam',  role: 'user'  },
  admin: { email: 'alex@shop.test', password: 'correct-horse-battery', name: 'Alex', role: 'admin' },
}

export async function seed(auth: IAuth) {
  // Guarded PER TABLE, not once on products.
  //
  // A single `if (await sys.product.count() > 0) return` at the top made this
  // whole file a no-op forever after the first boot — and `web/test/verify.mjs`
  // deletes an order and drives the seeded ones through their transitions. So
  // the orders ran out, no restart ever brought them back, and the second run
  // of a drive that asserts 37 facts failed in ways that read as a regression
  // in whatever you had just changed. `ISSUES.md` FJS-080.
  //
  // Per-table is also the honest shape: this function's job is "the rows this
  // app needs in order to be clickable exist", and products existing says
  // nothing about orders.

  if (await sys.product.count() === 0) {
    await sys.product.createMany({ data: [
      { name: 'Field Notebook',  sku: 'FN-001', price:  12.5, barcode: '5012345678900' },
      { name: 'Enamel Mug',      sku: 'EM-002', price:   9.0 },
      { name: 'Canvas Tote',     sku: 'CT-003', price:  18.0 },
      { name: 'Discontinued Cap', sku: 'DC-004', price: 22.0, active: false },
    ] })
  }

  if (await sys.customer.count() === 0) {
    await sys.customer.createMany({ data: [
      { name: 'Acme Corp', email: 'ops@acme.test',   notes: 'Net-30. Always disputes shipping.' },
      { name: 'Globex',    email: 'buy@globex.test', notes: 'Prefers pickup.' },
    ] })
  }

  // One order per interesting state, so every transition button has a row that
  // can actually exercise it. `pending` can pay or cancel; `paid` can ship,
  // refund (level 5) or cancel; `shipped` can do nothing at all.
  //
  // Restored by REFERENCE rather than by count: the drive creates its own
  // ORD-CDP-1, so "there are some orders" is not the same question as "the
  // three the screens were built around are present".
  const customers = await sys.customer.findMany({ orderBy: { id: 'asc' } })
  const wanted = [
    { reference: 'ORD-1001', status: 'pending', total:  31.0, customerId: customers[0]?.id },
    { reference: 'ORD-1002', status: 'paid',    total:  18.0, customerId: customers[0]?.id, note: 'Gift wrap' },
    { reference: 'ORD-1003', status: 'shipped', total:   9.0, customerId: customers[1]?.id },
  ]
  for (const row of wanted) {
    const existing = await sys.order.findFirst({ where: { reference: row.reference } })
    if (existing) {
      // Present but moved on — the drive pays and ships these. Put the state
      // back so the next run finds the same buttons.
      if (existing.status !== row.status) {
        await sys.order.update({ where: { id: existing.id }, data: { status: row.status } })
      }
      continue
    }
    await sys.order.create({ data: row })
  }

  // ── Demo users ───────────────────────────────────────────────────────────
  // Both are created email-VERIFIED. Left unverified they grade VISITOR(1) and
  // cannot write anything, which reads as "the app is broken" rather than "you
  // have not clicked the link in your email". See api/gate.ts.
  //
  // Guarded per user for the same reason as the tables above. This one bites
  // harder: `createUser` throws EmailTakenError (409), so without the check a
  // second boot does not merely skip the users — it kills the whole process
  // before the server ever listens.
  for (const who of [DEMO.user, DEMO.admin]) {
    if (await sys.user.findFirst({ where: { email: who.email } })) continue
    await auth.createUser(who)
    await sys.user.updateMany({
      where: { email: who.email },
      data:  { emailVerified: true },
    })
  }
}
