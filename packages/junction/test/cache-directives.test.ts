// A cache key names everything that shapes the answer. The bridge moves every
// `$`-param out of `ctx.query` into `ctx.directives` before the key is built,
// so a key read from the query alone answered page 2 with page 1 and a
// `$select` read with the columns of the last full read (FJS-1399).

import { describe, it, expect } from 'bun:test'
import { createService, testCtx, callService } from '../index.ts'
import type { ServiceContext } from '../index.ts'

const ROWS = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]

function pagedService(name: string) {
  let calls = 0
  const svc = createService({
    name,
    cache: true,
    async find(ctx: ServiceContext) {
      calls++
      const { limit = ROWS.length, offset = 0 } = ctx.directives
      return ROWS.slice(offset, offset + limit)
    },
    async get(ctx: ServiceContext) {
      calls++
      const row = ROWS.find(r => String(r.id) === String(ctx.id))!
      const select = ctx.directives.select as string[] | undefined
      return select ? Object.fromEntries(select.map(k => [k, row[k as keyof typeof row]])) : row
    },
  })
  return { svc, calls: () => calls }
}

async function run(svc: ReturnType<typeof createService>, ctx: ServiceContext) {
  await callService(svc, ctx)
  return (ctx.result as { data: unknown }).data
}

function findCtx(service: string, directives: ServiceContext['directives']) {
  const ctx = testCtx(service, 'find', null, { user: { userId: 'u1' }, query: { q: 'page' } })
  ctx.directives = directives
  return ctx
}

describe('service cache keys on directives as well as the query', () => {
  it('a wider $limit on one filter is not answered from the narrower entry', async () => {
    const { svc } = pagedService('cache-limit')
    const one   = await run(svc, findCtx('cache-limit', { limit: 1 }))
    const three = await run(svc, findCtx('cache-limit', { limit: 3 }))
    expect((one as unknown[]).length).toBe(1)
    expect((three as unknown[]).length).toBe(3)
  })

  it('page 2 is not page 1', async () => {
    const { svc } = pagedService('cache-offset')
    const p1 = await run(svc, findCtx('cache-offset', { limit: 1, offset: 0 })) as { id: number }[]
    const p2 = await run(svc, findCtx('cache-offset', { limit: 1, offset: 1 })) as { id: number }[]
    expect(p1[0].id).toBe(1)
    expect(p2[0].id).toBe(2)
  })

  it('a get with $select is not answered with the full row, nor the reverse', async () => {
    const { svc } = pagedService('cache-select')
    const get = (select?: string[]) => {
      const ctx = testCtx('cache-select', 'get', null, { user: { userId: 'u1' }, id: '1' })
      if (select) ctx.directives = { select }
      return run(svc, ctx) as Promise<Record<string, unknown>>
    }
    expect(await get()).toEqual({ id: 1, name: 'a' })
    expect(await get(['id'])).toEqual({ id: 1 })
  })

  it('the same directives in another key order are still one entry', async () => {
    const { svc, calls } = pagedService('cache-order')
    await run(svc, findCtx('cache-order', { limit: 1, offset: 1 }))
    await run(svc, findCtx('cache-order', { offset: 1, limit: 1 }))
    expect(calls()).toBe(1)
  })
})
