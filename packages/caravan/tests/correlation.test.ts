// tests/correlation.test.ts
//
// A job knows which request asked for it.
//
// `actor_id` records WHO and `tenant_id` records WHICH TENANT, both resolved at
// dispatch and read back when the job runs. There was no third: a job queued
// inside a request carried no id the request also had, so the two halves of one
// unit of work appeared in a log with nothing in common and could not be
// joined — which is the whole of what a correlation id is for.
//
// `correlation_id` is that sibling and takes the same rules, including the one
// that matters: **absent is not null**. `'correlationId' in opts` rather than
// `??`, so `correlationId: null` is a caller SAYING this work belongs to no
// request — a cron fire, a boot enqueue — and saying nothing takes whatever the
// host reports.

import { describe, it, expect, afterEach } from 'bun:test'
import { createCaravan } from '../src/index.ts'
import type { CaravanInstance } from '../src/types.ts'

const queues: CaravanInstance[] = []
afterEach(async () => { for (const q of queues.splice(0)) await q.stop() })

/** A queue whose host reports `id` as the request in scope. */
function queueWith(id: string | null | undefined) {
  const q = createCaravan({ db: ':memory:', pollInterval: 20 })
  queues.push(q)
  // The host is the app, given at register() — the same seam Junction uses.
  q.register({ correlationId: () => id ?? null } as never)
  return q
}

describe('a dispatch records the request it came from', () => {

  it('takes the id in scope with nobody saying so', async () => {
    const q: any = queueWith('req-1')
    const id = await q.dispatch('work', { a: 1 })
    expect(q.find(id)!.correlation_id).toBe('req-1')
  })

  it('a stated id beats the one in scope', async () => {
    const q: any = queueWith('req-1')
    const id = await q.dispatch('work', {}, { correlationId: 'stated' })
    expect(q.find(id)!.correlation_id).toBe('stated')
  })

  it('a stated null is a statement, not an absence', async () => {
    // The rule `actor` and `tenant` already follow. Under `??` this would read
    // as "nothing said" and stamp the request in scope onto work the caller has
    // just declared belongs to none.
    const q: any = queueWith('req-1')
    const id = await q.dispatch('work', {}, { correlationId: null } as never)
    expect(q.find(id)!.correlation_id).toBe(null)
  })

  it('records nothing when there is no request — standalone Caravan', async () => {
    const q: any = createCaravan({ db: ':memory:', pollInterval: 20 })
    queues.push(q)
    const id = await q.dispatch('work', {})
    expect(q.find(id)!.correlation_id).toBe(null)
  })
})

describe('the handler is told', () => {

  it('ctx.correlationId is what the dispatch recorded', async () => {
    const q: any = queueWith('req-42')
    let seen: unknown = 'unset'
    q.handle('work', async (ctx: any) => { seen = ctx.correlationId })
    await q.start()
    const id = await q.dispatch('work', {})
    const deadline = Date.now() + 5000
    while (q.find(id)?.status !== 'done' && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    expect(seen).toBe('req-42')
  })

  it('…and is null for a job nobody requested — the control', async () => {
    const q: any = createCaravan({ db: ':memory:', pollInterval: 20 })
    queues.push(q)
    let seen: unknown = 'unset'
    q.handle('work', async (ctx: any) => { seen = ctx.correlationId })
    await q.start()
    const id = await q.dispatch('work', {})
    const deadline = Date.now() + 5000
    while (q.find(id)?.status !== 'done' && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    expect(seen).toBe(null)
  })
})
