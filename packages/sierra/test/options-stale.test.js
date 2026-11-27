/**
 * test/options-stale.test.js
 *
 * A picker's cached list is a copy of another model's rows, so a write to that
 * model makes it stale. Found in thod: the owner opened a new PostingRule, saw
 * no LedgerAccount to pick, made two accounts, came back to the rule, and the
 * account picker was still empty until a reload — the empty list read on the
 * first visit was held for the life of the tab.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

let TABLES
let CALLS = []

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: (name) => ({
      on: () => {},
      find: async (filter = {}, directives = {}) => {
        CALLS.push({ name, filter, directives })
        const rows = TABLES[name] ?? []
        return { data: rows, total: rows.length }
      },
      create: async (data) => {
        const row = { id: (TABLES[name]?.length ?? 0) + 1, ...data }
        TABLES[name] = [...(TABLES[name] ?? []), row]
        return row
      },
    }),
    resource: () => ({
      tether: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { createResource } = await import('../src/resource/resource.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')

const str = { type: 'string' }
const belongsTo = (field, model, fk) => ({ field, model, type: 'belongsTo', fields: [fk], references: ['id'], onDelete: null, optional: false })

registerSchemas({
  LedgerAccount: { type: 'object', title: 'LedgerAccount', properties: { name: str }, 'x-label-field': 'name' },
  PostingRule: {
    type: 'object', title: 'PostingRule',
    properties: { accountId: { type: 'integer' } },
    'x-relations': [belongsTo('account', 'LedgerAccount', 'accountId')],
  },
  Vendor: { type: 'object', title: 'Vendor', properties: { name: str }, 'x-label-field': 'name' },
}, ['LedgerAccount', 'PostingRule', 'Vendor'])

beforeEach(() => { TABLES = { ledgerAccounts: [], vendors: [] }; CALLS = [] })

describe('a cached picker list and a write to the model it lists', () => {
  test('an account made after the picker was read is offered on the next read', async () => {
    const rules = createResource('postingRules', { model: 'PostingRule' })
    const accounts = createResource('ledgerAccounts', { model: 'LedgerAccount' })

    expect((await rules.options('accountId')).options).toEqual([])
    await accounts.service.create({ name: 'Sales' })
    expect((await rules.options('accountId')).options).toEqual([{ value: 1, label: 'Sales' }])
  })

  test('within a session with no write, the list is still a cache hit', async () => {
    const rules = createResource('postingRules', { model: 'PostingRule' })
    await rules.options('accountId')
    await rules.options('accountId')
    expect(CALLS.filter(c => c.name === 'ledgerAccounts')).toHaveLength(1)
  })

  test("a write to another model leaves the list's cache alone", async () => {
    const rules = createResource('postingRules', { model: 'PostingRule' })
    await rules.options('accountId')
    await createResource('vendors', { model: 'Vendor' }).service.create({ name: 'Brass Works' })
    await rules.options('accountId')
    expect(CALLS.filter(c => c.name === 'ledgerAccounts')).toHaveLength(1)
  })
})
