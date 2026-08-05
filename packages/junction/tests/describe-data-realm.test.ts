// describe-data-realm.test.ts
//
// describeDataRealm() feeds the one line the startup banner says about the Data
// realm. Before it, the banner covered routes and services and was silent about
// whether a schema had loaded at all, so "is Litestone working?" could only be
// answered by issuing a request.
//
// The thing worth pinning is not the happy path — it is that this NEVER breaks
// startup. `createApp({ db })` accepts anything table-shaped, including a raw
// bun:sqlite handle and Proxy-based clients that throw on unknown property
// access (Litestone's own scoped proxy does exactly that: reading an unknown
// `$prop` throws "…is not a table in this schema"). A banner helper that throws
// takes the whole app down at the last startup phase, after the port is open.

import { describe, it, expect } from 'bun:test'
import { describeDataRealm } from '../src/core/litestone.ts'

const litestoneLike = (over: Record<string, unknown> = {}) => ({
  $schema: {
    models: [
      { name: 'Product',  attributes: [{ kind: 'gate', value: '0.4.4.5' }] },
      { name: 'Customer', attributes: [{ kind: 'gate', value: '0.4.4.5' }] },
      { name: 'Audit',    attributes: [] },
    ],
    enums: [{ name: 'OrderStatus' }],
  },
  $databases: {
    main:  { driver: 'sqlite', path: `${process.cwd()}/db/shop.db` },
    audit: { driver: 'logger', path: `${process.cwd()}/db/audit` },
  },
  ...over,
})

describe('describeDataRealm', () => {
  it('reports models, enums, how many are gated, and where they live', () => {
    expect(describeDataRealm(litestoneLike())).toEqual({
      models:    3,
      enums:     1,
      gated:     '2/3',
      databases: 'main → ./db/shop.db (sqlite), audit → ./db/audit (logger)',
    })
  })

  it('prints paths relative to CWD, and absolute ones unchanged', () => {
    const out = describeDataRealm(litestoneLike({
      $databases: { main: { driver: 'sqlite', path: '/var/lib/elsewhere.db' } },
    }))
    expect(out?.databases).toBe('main → /var/lib/elsewhere.db (sqlite)')
  })

  it('says 0/n when nothing declares a gate — the case worth seeing daily', () => {
    const out = describeDataRealm(litestoneLike({
      $schema: { models: [{ name: 'A', attributes: [] }, { name: 'B' }], enums: [] },
    }))
    expect(out?.gated).toBe('0/2')
    expect(out?.enums).toBeUndefined()      // omitted rather than logged as 0
  })

  // ── it must never throw, and never invent a line ────────────────────────
  it('returns null for anything that is not a Litestone client', () => {
    for (const notAClient of [
      undefined, null, {}, { query: () => {} },      // raw bun:sqlite-ish
      { $schema: {} }, { $schema: { models: [] } },  // present but empty
      'nope', 42,
    ]) {
      expect(describeDataRealm(notAClient), String(notAClient)).toBeNull()
    }
  })

  it('returns null instead of throwing when the client throws on property access', () => {
    const hostile = new Proxy({}, {
      get(_t, prop) { throw new Error(`"${String(prop)}" is not a table in this schema`) },
    })
    expect(() => describeDataRealm(hostile)).not.toThrow()
    expect(describeDataRealm(hostile)).toBeNull()
  })

  it('survives a client whose $databases entries are malformed', () => {
    const out = describeDataRealm(litestoneLike({
      $databases: { main: {}, other: null },
    }))
    expect(out?.databases).toBe('main → ? (?), other → ? (?)')
  })
})
