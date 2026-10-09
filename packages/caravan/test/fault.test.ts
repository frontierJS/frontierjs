// test/fault.test.ts
//
// `FJS-2046` — conduit answers `retryable: false` for an unkeyed POST that got
// a 5xx, because the charge may already have landed (`FJS-D194`). A job that
// rethrows it was run again on the ladder: the double charge D194 exists to
// stop, one layer up. `FJS-D655` rules that caravan reads the fault.

import { describe, it, expect, afterEach } from 'bun:test'
import { createCaravan } from '../src/index.ts'
import type { CaravanInstance } from '../src/types.ts'

const made: CaravanInstance[] = []
afterEach(async () => {
  for (const q of made.splice(0)) await q.stop().catch(() => {})
})

// `start()` jitters the first poll by up to 200ms.
const SETTLE = 500

describe('a fault that is not retryable', () => {
  it('stops the job after one attempt', async () => {
    const q = createCaravan({ db: ':memory:', pollInterval: 10, drainTimeout: 100 })
    made.push(q)
    q.handle('charge', async () => {
      throw Object.assign(new Error('upstream 500 on an unkeyed POST'), { retryable: false })
    }, { maxAttempts: 3, retryDelay: [10] })

    await q.start()
    const id = await q.dispatch('charge', {})
    await Bun.sleep(SETTLE)

    expect(q.find(id)!.attempts).toBe(1)
  })

  // The pair `FJS-D201` asks for: a retryable fault still climbs the ladder.
  it('a retryable one still retries', async () => {
    const q = createCaravan({ db: ':memory:', pollInterval: 10, drainTimeout: 100 })
    made.push(q)
    q.handle('fetch', async () => {
      throw Object.assign(new Error('upstream 503'), { retryable: true })
    }, { maxAttempts: 3, retryDelay: [10] })

    await q.start()
    const id = await q.dispatch('fetch', {})
    await Bun.sleep(SETTLE)

    expect(q.find(id)!.attempts).toBe(3)
  })
})
