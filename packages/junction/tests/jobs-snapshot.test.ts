// tests/jobs-snapshot.test.ts
//
// `junction jobs` — what this app runs when nobody asked.
//
// The reason this file is committed is that its subject fails silently by
// construction. A route that stops working is a 404 somebody sees; a schedule
// that stops being registered is nothing happening, which looks exactly like
// nothing needing to happen (`FJS-327`, `FJS-328`). So what is guarded here is
// the two properties that make a committed artefact worth anything: it must
// hold STILL between two boots of the same code, and it must distinguish the
// states a reader would otherwise conflate.

import { describe, expect, it } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'
import { describeJobs, renderJobsSnapshot } from '../tools/jobs-snapshot.ts'
import { quietly } from '../tools/app-module.ts'

function bareApp() {
  return createApp({
    config: {
      port:     3398,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http:     { ...defaultConfig.http, drainTimeout: 200 },
    },
  })
}

describe('the two registries are kept apart', () => {
  it('no queue installed is a different fact from a queue with no jobs', () => {
    const app = bareApp()
    const none = describeJobs(app)
    expect(none.hasQueue).toBe(false)
    expect(none.durable).toEqual([])

    // An app that DID install a queue and registered nothing. Reading this off
    // `durable.length` would make the two identical, and they are opposite
    // problems: one app does no background work, the other will dispatch into
    // a queue with nothing to run it.
    ;(app as unknown as { jobs: unknown }).jobs = { registrations: () => [] }
    const empty = describeJobs(app)
    expect(empty.hasQueue).toBe(true)
    expect(empty.durable).toEqual([])

    expect(renderJobsSnapshot(none,  { source: 'a.ts', command: 'junction jobs' }))
      .toContain('No queue is installed')
    expect(renderJobsSnapshot(empty, { source: 'a.ts', command: 'junction jobs' }))
      .toContain('no handlers are registered')
  })

  it('reads a queue duck-typed, because caravan is an optional peer', () => {
    const app = bareApp()
    ;(app as unknown as { jobs: unknown }).jobs = {
      registrations: () => [
        { name: 'sweep', queue: 'default', cron: '0 3 * * *', timeZone: null, maxAttempts: 3, retryDelay: [], timeout: 30_000 },
        { name: 'stuck', queue: 'default', cron: null,        timeZone: null, maxAttempts: 3, retryDelay: [], timeout: null },
      ],
    }
    const body = renderJobsSnapshot(describeJobs(app), { source: 'a.ts', command: 'junction jobs' })
    expect(body).toContain('`sweep`')
    expect(body).toContain('`0 3 * * *`')
    expect(body).toContain('2 handler(s), 1 of them on a clock.')
    expect(body).toContain('30000ms')
    // An unbounded handler is called out by name rather than rendered as a
    // blank cell: it is the one that can stall the whole queue (`FJS-295`).
    expect(body).toContain('**none**')
    expect(body).toContain('**1 with no timeout.**')
  })
})

describe('the in-process timers are legible at all', () => {
  // `every()` parses its interval to milliseconds and `cron()` compiles its
  // expression to a matcher, so before `expr` was retained the only record of
  // WHEN a timer fires was a closure. `list()` answered `job_1`, `job_2`.
  it('records the expression as written, not as compiled', () => {
    const app = bareApp()
    app.scheduler.every('30 seconds', async () => {})
    app.scheduler.cron('0 3 * * *', async () => {})
    app.scheduler.once('1 hour', async () => {})

    const { timers } = describeJobs(app)
    expect(timers.map(t => [t.type, t.expr])).toEqual([
      ['cron',     '0 3 * * *'],
      ['once',     '1 hour'],
      ['interval', '30 seconds'],
    ])
    app.scheduler.destroy()
  })

  it('is stable across two identical boots — otherwise it could not be committed', () => {
    const render = () => {
      const app = bareApp()
      app.scheduler.every('30 seconds', async () => {})
      app.scheduler.cron('0 3 * * *', async () => {})
      const body = renderJobsSnapshot(describeJobs(app), { source: 'a.ts', command: 'junction jobs' })
      app.scheduler.destroy()
      return body
    }
    expect(render()).toBe(render())
  })

  // Live state would move between two boots and take the file's whole value
  // with it. The snapshot answers what was DECLARED.
  it('carries no clock and no live state', () => {
    const app = bareApp()
    app.scheduler.every('30 seconds', async () => {})
    const body = renderJobsSnapshot(describeJobs(app), { source: 'a.ts', command: 'junction jobs' })

    // Asserted on the TABLE rather than the body: the prose above it explains
    // what is left out and therefore contains the very words a naive search
    // would trip on. The columns are the contract.
    const columns = body.split('\n').filter(l => l.startsWith('| Id |'))
    expect(columns).toEqual(['| Id | Kind | Declared |'])

    // And nothing in the rows is a timestamp or a live flag.
    const rows = body.split('\n').filter(l => /^\| `job_/.test(l))
    expect(rows.length).toBe(1)
    expect(rows[0]).not.toMatch(/\d{4}-\d{2}-\d{2}|true|false/)
    app.scheduler.destroy()
  })
})

// A snapshot written by redirecting stdout must contain the snapshot and
// nothing else. `quietly` reassigns `process.stdout.write`, which does NOT
// reach `console.log` in Bun — console holds its own binding — so Caravan's
// autoload line landed as the first line of a redirected file, above the
// heading. Measured before the fix.
describe('building the app cannot write into the artefact', () => {
  it('routes console output away from stdout for the duration', async () => {
    const seen: unknown[] = []
    const realErr = console.error
    console.error = (...a: unknown[]) => { seen.push(a[0]) }
    let wroteToStdout = false
    const realWrite = process.stdout.write.bind(process.stdout)

    try {
      await quietly(async () => {
        process.stdout.write = (() => { wroteToStdout = true; return true }) as never
        console.log('[Caravan] Loaded 3 job handlers')
      })
    } finally {
      console.error = realErr
      process.stdout.write = realWrite
    }

    expect(seen).toContain('[Caravan] Loaded 3 job handlers')
    expect(wroteToStdout).toBe(false)
  })
})
