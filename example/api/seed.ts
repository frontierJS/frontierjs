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
  if (await sys.product.count() > 0) return

  await sys.product.createMany({ data: [
    { name: 'Field Notebook',  sku: 'FN-001', price:  12.5, barcode: '5012345678900' },
    { name: 'Enamel Mug',      sku: 'EM-002', price:   9.0 },
    { name: 'Canvas Tote',     sku: 'CT-003', price:  18.0 },
    { name: 'Discontinued Cap', sku: 'DC-004', price: 22.0, active: false },
  ] })

  await sys.customer.createMany({ data: [
    { name: 'Acme Corp', email: 'ops@acme.test',   notes: 'Net-30. Always disputes shipping.' },
    { name: 'Globex',    email: 'buy@globex.test', notes: 'Prefers pickup.' },
  ] })

  // One order per interesting state, so every transition button has a row that
  // can actually exercise it. `pending` can pay or cancel; `paid` can ship,
  // refund (level 5) or cancel; `shipped` can do nothing at all.
  await sys.order.createMany({ data: [
    { reference: 'ORD-1001', status: 'pending', total:  31.0, customerId: 1 },
    { reference: 'ORD-1002', status: 'paid',    total:  18.0, customerId: 1, note: 'Gift wrap' },
    { reference: 'ORD-1003', status: 'shipped', total:   9.0, customerId: 2 },
  ] })

  // ── Demo users ───────────────────────────────────────────────────────────
  // Both are created email-VERIFIED. Left unverified they grade VISITOR(1) and
  // cannot write anything, which reads as "the app is broken" rather than "you
  // have not clicked the link in your email". See api/gate.ts.
  for (const who of [DEMO.user, DEMO.admin]) {
    await auth.createUser(who)
    await sys.user.updateMany({
      where: { email: who.email },
      data:  { emailVerified: true },
    })
  }
}
