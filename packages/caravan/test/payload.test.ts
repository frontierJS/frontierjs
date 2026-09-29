// ============================================================
// What a job payload may be (FJS-D480).
//
// A payload is stored as JSON and handed back parsed, so anything JSON would
// turn into something else reached the handler as a different value than the
// dispatcher sent: a Date became a string its type said was a Date, a Map
// became {}, NaN became null, and a BigInt threw a bare TypeError naming no
// job. Each is refused at dispatch now, naming the job and the key path, and
// so is a payload over the byte bound.
// ============================================================

import { describe, it, expect, afterEach } from 'bun:test'
import { createCaravan, PAYLOAD_MAX_BYTES } from '../src/index.ts'
import type { CaravanInstance } from '../src/types.ts'

const queues: CaravanInstance[] = []

function makeQueue(): CaravanInstance {
  const q = createCaravan({ db: ':memory:', pollInterval: 20 })
  queues.push(q)
  return q
}

afterEach(async () => {
  while (queues.length) await queues.pop()!.stop()
})

describe('a payload JSON cannot carry honestly is refused at dispatch', () => {
  const cases: Array<[string, unknown, string]> = [
    ['a Date',   { order: { when: new Date() } },  'data.order.when'],
    ['a Map',    { m: new Map() },                  'data.m'],
    ['a Set',    { tags: [1, new Set()] },          'data.tags[1]'],
    ['a RegExp', { r: /x/ },                        'data.r'],
    ['NaN',      { n: NaN },                        'data.n'],
    ['Infinity', { n: Infinity },                   'data.n'],
    ['a BigInt', { id: 1n },                        'data.id'],
  ]

  for (const [kind, data, path] of cases) {
    it(`${kind} names the job and the key path`, async () => {
      const q = makeQueue()
      const err = await q.dispatch('send-receipt', data).catch(e => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain('send-receipt')
      expect(err.message).toContain(path)
      expect(err.message).toContain(kind)
      expect(q.list({})).toHaveLength(0)
    })
  }

  it('a payload over the bound is refused with the bound in the message', async () => {
    const q = makeQueue()
    const err = await q.dispatch('import', { blob: 'x'.repeat(PAYLOAD_MAX_BYTES) }).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('import')
    expect(err.message).toContain(String(PAYLOAD_MAX_BYTES))
    expect(q.list({})).toHaveLength(0)
  })

  it('a plain payload still round-trips, null included', async () => {
    const q = makeQueue()
    const data = { id: 'a', n: 1, ok: true, none: null, list: [1, 'two', { three: 3 }] }
    const id = await q.dispatch('fine', data)
    expect(JSON.parse(q.find(id)!.data as string)).toEqual(data)
  })
})
