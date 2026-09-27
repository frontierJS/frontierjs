// A fixed ladder returned every job that failed at one instant at one instant
// again -- the thundering herd a queue exists to prevent (FJS-711, caravan-11).
import { describe, it, expect } from 'bun:test'
import { retryDelayFor } from '../src/worker.ts'

describe('retry ladder', () => {
  it('spreads jobs failing at one instant, never below the declared delay', () => {
    const waits = Array.from({ length: 500 }, () => retryDelayFor([60_000], 1))
    expect(new Set(waits).size).toBeGreaterThan(400)
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(60_000)
    expect(Math.max(...waits)).toBeLessThan(75_000)
  })

  it('plateaus at the last rung and falls back to the default ladder', () => {
    expect(retryDelayFor([10, 20], 5)).toBeGreaterThanOrEqual(20)
    expect(retryDelayFor([], 2)).toBeGreaterThanOrEqual(300_000)
  })
})
