// FJS-2548 — in an `after` hook `$.result` is the reply's envelope, not the row,
// so `$.result.id` is undefined and an `$.enqueue('job', { id: $.result.id })`
// enqueues a job that throws on its first run. AGENTS.md lists `result` only as
// assignable, so the guide has to say what it holds there.

import { describe, test, expect } from 'bun:test'
import { readFileSync }           from 'node:fs'
import { createClient }           from '../../litestone/src/index.js'
import { buildService, callService } from '../src/core/service.ts'
import { bridge }                 from '../src/transport/bridge.ts'

const SCHEMA = `
  model Order {
    id    Int    @id
    total Float
    @@gate(4.4.4.5)
  }
`

describe('an after hook reads the envelope', () => {
  test('$.result carries kind and data; the row is $.result.data', async () => {
    const db  = await createClient({ db: ':memory:', schema: SCHEMA }) as never
    const seen: Record<string, unknown>[] = []

    const svc = buildService({
      name: 'orders', model: 'Order', db: () => db,
      hooks: { after: { create: [(ctx) => { seen.push(ctx.result as Record<string, unknown>) }] } },
    })

    const ctx = bridge.internal('orders', 'create' as never, { id: 7, total: 12.5 } as never, {
      auth:   { user: { userId: 1, id: 1, isAdmin: true } },
      locals: { db },
    } as never)
    await callService(svc, ctx)

    expect(seen[0]!.id).toBeUndefined()
    expect(seen[0]!.kind).toBe('single')
    expect(typeof (seen[0]!.data as { id: number }).id).toBe('number')
  })
})

describe('AGENTS.md says what $.result is in an after hook', () => {
  test('§ The context you are inside names the envelope', () => {
    const md      = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8')
    const section = md.slice(md.indexOf('## The context you are inside'), md.indexOf('\n## Services'))
    expect(section).toMatch(/\$\.result[^\n]*\n?[^\n]*envelope/i)
    expect(section).toMatch(/\$\.result\.data/)
  })
})
