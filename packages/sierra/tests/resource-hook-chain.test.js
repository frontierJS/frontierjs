/**
 * tests/resource-hook-chain.test.js
 *
 * What a resource answers when a hook breaks the chain.
 *
 * Three ordinary mistakes end `_call` with nothing having produced a result —
 * an `around` that returns without calling `next()`, an `around` that catches
 * the failure and does not rethrow, and an `error` hook that clears `ctx.error`
 * and sets nothing in its place. All three used to resolve the call to the
 * `null` the context was born with, which a screen reads as an answer:
 * `(await r.service.find()).data` then throws a TypeError in the app's own
 * code, one hop from the mistake and naming nothing that is wrong.
 *
 * Every refusal below is PAIRED with the legitimate version of the same hook —
 * one that DOES short-circuit with an answer, or DOES recover with one. A guard
 * that refused both would satisfy any test asking only about the refusal
 * (`FJS-351`), and would make the `around` phase useless for the thing it is
 * for.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

let _proxy

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => _proxy,
    resource: () => ({
      service: _proxy,
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { createResource, ResourceHookError } = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

const DEFS = {
  Lead: {
    type: 'object',
    title: 'Lead',
    properties: { name: { type: 'string' } },
    required: [],
  },
}

// What the server would have answered, so "the call was skipped" is decidable
// from the value rather than from a spy.
const SERVER = { kind: 'list', data: [{ id: 'from-server' }], total: 1 }

let _reached

beforeEach(() => {
  registerSchemas(DEFS, ['Lead'])
  _reached = 0
  _proxy = {
    find:    async () => { _reached++; return SERVER },
    get:     async (id) => { _reached++; return { id } },
    create:  async (data) => { _reached++; return { id: '1', ...data } },
    patch:   async (id, data) => { _reached++; return { id, ...data } },
    remove:  async (id) => { _reached++; return { id } },
    restore: async (id) => { _reached++; return { id } },
    on: () => {},
    call: async () => ({}),
  }
})

const leads = (hooks) => createResource('leads', { model: 'Lead', hooks })

describe('an around hook that never calls next()', () => {
  test('is refused by name, rather than resolving to null', async () => {
    const r = leads({ around: { find: [async () => { /* forgot next() */ }] } })
    await expect(r.service.find()).rejects.toThrow(ResourceHookError)
    // The server was never asked, which is the hook doing what it said. The
    // defect was never the short-circuit — it was answering `null` for it.
    expect(_reached).toBe(0)
  })

  test('the message names the service, the method and the way out', async () => {
    const r = leads({ around: { find: [async () => {}] } })
    const err = await r.service.find().catch(e => e)
    expect(err.message).toContain('leads.find')
    expect(err.message).toContain('next()')
    expect(err.phase).toBe('around')
  })

  test('…but one that short-circuits WITH an answer is honored', async () => {
    // The negative control, and the reason this is a check on the result rather
    // than on next(): skipping the call is the entire point of the phase. A
    // cache hit is this hook.
    const cached = { kind: 'list', data: [{ id: 'from-cache' }], total: 1 }
    const r = leads({ around: { find: [async (ctx) => { ctx.result = cached }] } })
    await expect(r.service.find()).resolves.toEqual(cached)
    expect(_reached).toBe(0)
  })

  test('…and short-circuiting with null is an answer, not a broken chain', async () => {
    // `null` is what a `get` for a missing row answers, so the VALUE cannot be
    // the test. Assigning it is.
    const r = leads({ around: { get: [async (ctx) => { ctx.result = null }] } })
    await expect(r.service.get('nope')).resolves.toBe(null)
  })

  test('…and one that calls next() is untouched', async () => {
    const r = leads({ around: { find: [async (ctx, next) => next()] } })
    await expect(r.service.find()).resolves.toEqual(SERVER)
    expect(_reached).toBe(1)
  })
})

describe('an around hook that swallows the failure', () => {
  test('is refused, rather than reporting success for a call that failed', async () => {
    _proxy.find = async () => { throw new Error('server said no') }
    const r = leads({
      around: { find: [async (ctx, next) => { try { await next() } catch { /* swallowed */ } }] },
    })
    await expect(r.service.find()).rejects.toThrow(ResourceHookError)
  })

  test('…but one that catches and SUPPLIES a fallback is honored', async () => {
    const fallback = { kind: 'list', data: [], total: 0 }
    _proxy.find = async () => { throw new Error('server said no') }
    const r = leads({
      around: {
        find: [async (ctx, next) => {
          try { await next() } catch { ctx.result = fallback }
        }],
      },
    })
    await expect(r.service.find()).resolves.toEqual(fallback)
  })
})

describe('an error hook that clears ctx.error', () => {
  test('with no result is refused, and carries the failure it discarded', async () => {
    _proxy.create = async () => { throw new Error('server said no') }
    const r = leads({ error: { create: [async (ctx) => { ctx.error = null }] } })
    const err = await r.service.create({ name: 'Ada' }).catch(e => e)
    expect(err).toBeInstanceOf(ResourceHookError)
    expect(err.phase).toBe('error')
    // The original is gone by the time this throws, so it rides on `cause`.
    // Without it the report is "your hook is wrong" and the outage is invisible.
    expect(err.cause?.message).toBe('server said no')
  })

  test('…but one that clears it AND sets a result recovers, as documented', async () => {
    const recovered = { id: 'recovered' }
    _proxy.create = async () => { throw new Error('server said no') }
    const r = leads({
      error: { create: [async (ctx) => { ctx.result = recovered; ctx.error = null }] },
    })
    await expect(r.service.create({ name: 'Ada' })).resolves.toEqual(recovered)
  })

  test('…and one that leaves ctx.error alone still throws the original', async () => {
    _proxy.create = async () => { throw new Error('server said no') }
    const r = leads({ error: { create: [async () => { /* observes only */ }] } })
    await expect(r.service.create({ name: 'Ada' })).rejects.toThrow('server said no')
  })
})

describe('the ordinary path', () => {
  test('a resource with no hooks at all is unaffected', async () => {
    const r = leads()
    await expect(r.service.find()).resolves.toEqual(SERVER)
    expect(_reached).toBe(1)
  })

  test('a server answering null is an answer, not a broken chain', async () => {
    // The shape the whole design turns on: `get` for a row that is not there.
    _proxy.get = async () => { _reached++; return null }
    const r = leads()
    await expect(r.service.get('missing')).resolves.toBe(null)
    expect(_reached).toBe(1)
  })
})
