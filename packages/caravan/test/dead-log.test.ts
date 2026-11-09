// test/dead-log.test.ts
//
// `FJS-4087` — a job that ended dead wrote its error to jobs.db only, so a
// container log showed a healthy app while the queue held a dead job.

import { describe, it, expect, afterEach } from 'bun:test'
import { caravan } from '../src/index.ts'
import type { CaravanInstance } from '../src/types.ts'

const made: CaravanInstance[] = []
afterEach(async () => {
  for (const q of made.splice(0)) await q.stop().catch(() => {})
})

// start() staggers the first poll by up to 200ms of jitter.
const SETTLE = 500

async function capture(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const real = { warn: console.warn, error: console.error }
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
  try { await run() } finally { Object.assign(console, real) }
  return lines
}

describe('a job that ends dead is said in the process log', () => {
  it('names the job, the attempts and the error', async () => {
    const lines = await capture(async () => {
      const q = caravan({ db: ':memory:', pollInterval: 10 })
      made.push(q)
      q.handle('sa-poll', async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443') },
        { maxAttempts: 1 })
      await q.start()
      const id = await q.dispatch('sa-poll', {})
      await Bun.sleep(SETTLE)
      expect(q.find(id)!.status).toBe('dead')
    })
    const line = lines.find(l => l.includes('sa-poll') && l.includes('ECONNREFUSED'))
    expect(line).toBeDefined()
    expect(line).toContain('dead')
  })

  it('a retry that will run again is not a log line', async () => {
    const lines = await capture(async () => {
      const q = caravan({ db: ':memory:', pollInterval: 10 })
      made.push(q)
      q.handle('flaky', async () => { throw new Error('boom') },
        { maxAttempts: 3, retryDelay: [60_000] })
      await q.start()
      const id = await q.dispatch('flaky', {})
      await Bun.sleep(SETTLE)
      expect(q.find(id)!.status).toBe('pending')
    })
    expect(lines.filter(l => l.includes('flaky'))).toEqual([])
  })
})
