// test/start-work.test.ts
//
// A plugin's work() — what it does on its own clock — runs in the `start-work`
// phase, and `_startOnce()` skips that phase.
//
// A one-shot boot (`junction call`, the snapshot tools) used to run every
// plugin's timers because they lived in boot(): four calls against `example`
// queued four `orion.sweep` ticks, and caravan's worker in the call's process
// could claim a job the serving process was owed.
//
// PAIRED: every "nothing started under _startOnce" sits beside the same app
// under _startForTest starting it, because a plugin that started nothing in
// either mode passes the first assertion alone.

import { describe, it, expect } from 'bun:test'
import { createTestApp } from '../src/testing/index.ts'
import { metricsPlugin } from '../src/plugins/metrics/index.ts'
import { createService } from '../src/core/service.ts'
import type { App } from '../src/core/app.ts'

function recorder() {
  const seen: string[] = []
  return {
    seen,
    plugin: {
      name:     'probe',
      register: () => { seen.push('register') },
      boot:     () => { seen.push('boot') },
      work:     () => { seen.push('work') },
      shutdown: () => { seen.push('shutdown') },
    },
  }
}

/** Intervals created while `fn` runs, counted by wrapping the global. */
async function intervalsDuring(fn: () => Promise<void>): Promise<number> {
  const real = globalThis.setInterval
  let n = 0
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    n++
    return real(...args)
  }) as typeof setInterval
  try { await fn() } finally { globalThis.setInterval = real }
  return n
}

// ─── the phase ────────────────────────────────────────────────────────────────

describe('work() is its own start phase', () => {
  it('_startOnce() boots a plugin and never starts its work', async () => {
    const app = await createTestApp()
    const { seen, plugin } = recorder()
    app.configure(plugin)

    await app._startOnce()

    expect(seen).toEqual(['register', 'boot'])
    await app.stop()
  })

  it('_startForTest() runs work() after boot()', async () => {
    const app = await createTestApp()
    const { seen, plugin } = recorder()
    app.configure(plugin)

    await app._startForTest()

    expect(seen).toEqual(['register', 'boot', 'work'])
    await app.stop()
  })

  it('a service route exists by the time work() runs', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'widgets', find: async () => ({ data: [], total: 0 }) })],
    })
    let routed = false
    app.configure({
      name: 'late',
      work: (a: App) => { routed = !!a.service('widgets') },
    })

    await app._startForTest()

    expect(routed).toBe(true)
    await app.stop()
  })

  it('a work() that throws fails the start, naming the plugin, and shuts every plugin down', async () => {
    const app = await createTestApp()
    const { seen, plugin } = recorder()
    app.configure(plugin)
    app.configure({ name: 'broken', work: () => { throw new Error('queue db locked') } })

    await expect(app._startForTest()).rejects.toThrow(/Plugin "broken" work failed: queue db locked/)
    expect(seen).toContain('shutdown')
  })
})

// ─── the app's scheduler ──────────────────────────────────────────────────────

describe('app.scheduler holds its jobs until start-work', () => {
  it('a job registered before start fires under _startForTest(), never under _startOnce()', async () => {
    const once = await createTestApp()
    let onceRuns = 0
    once.scheduler.every('20ms', () => { onceRuns++ })
    await once._startOnce()

    const test = await createTestApp()
    let testRuns = 0
    test.scheduler.every('20ms', () => { testRuns++ })
    await test._startForTest()

    await Bun.sleep(90)
    await once.stop()
    await test.stop()

    expect(onceRuns).toBe(0)
    expect(testRuns).toBeGreaterThan(0)
  })

  it('a held job is still described, so a snapshot tool lists it', async () => {
    const app = await createTestApp()
    app.scheduler.cron('0 3 * * *', () => {})
    await app._startOnce()

    expect(app.scheduler.describe()).toEqual([{ id: 'job_1', type: 'cron', expr: '0 3 * * *' }])
    await app.stop()
  })
})

// ─── a plugin that owns a clock ───────────────────────────────────────────────

describe('the metrics store starts its timers in work()', () => {
  it('none under _startOnce(), two under _startForTest()', async () => {
    const once = await createTestApp()
    once.configure(metricsPlugin())
    const underOnce = await intervalsDuring(() => once._startOnce())
    await once.stop()

    const test = await createTestApp()
    test.configure(metricsPlugin())
    const underTest = await intervalsDuring(() => test._startForTest())
    await test.stop()

    expect(underOnce).toBe(0)
    expect(underTest).toBeGreaterThanOrEqual(2)
  })
})
