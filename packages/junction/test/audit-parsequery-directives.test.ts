// test/audit-parsequery-directives.test.ts — `$`-params are parsed by the bridge alone (Invariant 10).
//
// Fable audit run 2.1. `splitParams()` in `@frontierjs/toolbelt/directives` is
// the one grammar and `transport/bridge.ts` the one place it is applied: past
// the bridge `ctx.query` is filters and `ctx.directives` is shape, and a
// `$`-name the table does not own is refused there by name (`FJS-D237`).
// `parseQuery()` in `src/core/litestone.ts` keeps a second parser — it
// destructures the fourteen `$`-names off `query` as a fallback — so a `$limit`
// placed in `ctx.query` by a hook or an in-process caller is honored past the
// bridge, and a `$bogus` the bridge would refuse is kept as a FILTER key. The
// fourteen names agree with the table today and nothing holds them equal.
//
// `parseQuery` reads shape from `directives` only, and a `$`-key in `query` is
// refused as the bridge refuses it (`FJS-2442`).

import { describe, test, expect } from 'bun:test'
import { parseQuery } from '../src/core/litestone.ts'
import { unknownDirectives } from '@frontierjs/toolbelt/directives'

describe('shape comes from directives, never from a $-key in query', () => {

  test('control: a directive in `directives` is read', () => {
    expect(parseQuery({ status: 'open' }, 20, 100, { limit: 3 }).limit).toBe(3)
  })

  test('control: the bridge refuses a $-name the table does not own, by name', () => {
    expect(unknownDirectives({ $bogus: 1, status: 'open' })).toEqual(['$bogus'])
  })

  // Refused rather than ignored: an ignored $limit is a 200 that pages wrong.
  test('a $limit in query is not a directive past the bridge', () => {
    expect(() => parseQuery({ $limit: 3, status: 'open' } as any, 20, 100, {})).toThrow(/\$limit/)
  })

  test('a $-key the table does not own is refused by name, as the bridge refuses it', () => {
    expect(() => parseQuery({ $bogus: 1, status: 'open' } as any, 20, 100, {})).toThrow(/\$bogus/)
  })

  test('$or / $and / $not are where grammar, not directives', () => {
    expect(parseQuery({ $or: [{ status: 'open' }, { status: 'held' }] }, 20, 100, {}).where)
      .toEqual({ OR: [{ status: 'open' }, { status: 'held' }] })
  })
})
