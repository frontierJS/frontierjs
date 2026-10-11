// test/around-forgot-next.test.ts — an `around` that ended the call with no answer.
//
// `FJS-946`. An `around` whose body never calls `next()` left `ctx.result` at
// the `null` the context was born with and the call answered 204, the method
// never invoked and nothing said. `null` is also a legitimate answer, so the
// value cannot be the test: what separates the two is whether anything ASSIGNED
// `ctx.result`, which is `@frontierjs/toolbelt/hooks`' `answered`.

import { describe, test, expect } from 'bun:test'
import { createService, callService } from '../src/core/service.ts'
import { bridge }                     from '../src/transport/bridge.ts'

function mkService(around: Array<(ctx: never, next: () => Promise<void>) => Promise<void>>, calls: { n: number }) {
  const svc = createService({
    name: 'items',
    get: async () => { calls.n++; return { id: 1 } },
  })
  svc.hooks({ around: { get: around as never } })
  return svc
}

const call = (svc: ReturnType<typeof mkService>) =>
  callService(svc, bridge.internal('items', 'get', null, { auth: { user: null } } as never))

describe('FJS-946 — an around hook that ended the call without an answer', () => {

  test('forgetting next() is refused by name, and the method never ran', async () => {
    const calls = { n: 0 }
    const svc   = mkService([async () => {}], calls)

    await expect(call(svc)).rejects.toThrow(/around hook returned without calling next\(\)/)
    expect(calls.n).toBe(0)
  })

  test('catching the failure and not rethrowing is the same refusal', async () => {
    const svc = createService({ name: 'items', get: async () => { throw new Error('boom') } })
    svc.hooks({ around: { get: [async (_ctx, next) => { try { await next() } catch { /* swallowed */ } }] } })

    await expect(call(svc as never)).rejects.toThrow(/without an answer/)
  })

  test('an around that answers by assigning ctx.result, null included, is still allowed', async () => {
    const calls = { n: 0 }
    const hit   = mkService([async (ctx: never) => { (ctx as { result: unknown }).result = { kind: 'single', data: { id: 9 } } }], calls)
    const none  = mkService([async (ctx: never) => { (ctx as { result: unknown }).result = null }], calls)

    await call(hit)
    await call(none)
    expect(calls.n).toBe(0)
  })

  test('an around that calls next() is untouched', async () => {
    const calls = { n: 0 }
    const svc   = mkService([async (_ctx, next) => { await next() }], calls)

    await call(svc)
    expect(calls.n).toBe(1)
  })
})
