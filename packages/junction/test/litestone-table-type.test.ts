import { test, expect } from 'bun:test'
import type { ServiceContextLocals } from '../src/core/context.ts'
import '../src/core/litestone.ts'

// Compile-time: the paved write verbs a service reaches for through
// ctx.locals.db must exist on the table type, or `bun run check` goes red.
type Db = NonNullable<ServiceContextLocals['db']>
async function paved(db: Db) {
  await db.order.transition(1, 'ship')
  await db.order.upsert({ where: { id: 1 }, create: {}, update: {} })
}

test('LitestoneTable declares transition and upsert', () => {
  expect(typeof paved).toBe('function')
})
