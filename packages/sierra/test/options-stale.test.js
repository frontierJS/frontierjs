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

// What the app answers at GET /_services; undefined is an app that answers
// nothing there, which must change nothing.
let OFFERS
let FAILING = new Set()

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    fetch: async (path) => {
      if (path !== '/_services' || OFFERS === undefined) throw Object.assign(new Error('Not Found'), { code: 404 })
      return { json: async () => OFFERS }
    },
    service: (name) => ({
      on: () => {},
      find: async (filter = {}, directives = {}) => {
        CALLS.push({ name, filter, directives })
        if (FAILING.has(name)) throw new Error(`${name} is down`)
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

beforeEach(() => { TABLES = { ledgerAccounts: [], vendors: [] }; CALLS = []; OFFERS = undefined; FAILING = new Set() })

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

// FJS-4666 / FJS-4667: `methods:` is in api/src/services, so the browser
// learns which services exist and what each offers from the app, once.
describe('offers(): what the app says a service offers', () => {
  test('a picker over a service the app does not list asks nothing and warns nothing', async () => {
    OFFERS = [{ name: 'postingRules', methods: ['find', 'get', 'create'] }]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const rules = createResource('postingRules', { model: 'PostingRule' })
      expect(await rules.options('accountId')).toEqual({ options: [], total: 0, truncated: false })
      expect(CALLS).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  test('a picker over a service that offers no find asks nothing either', async () => {
    OFFERS = [{ name: 'postingRules', methods: ['find'] }, { name: 'ledgerAccounts', methods: ['create'] }]
    const rules = createResource('postingRules', { model: 'PostingRule' })
    const answer = await rules.options('accountId')
    expect(answer.error).toBeUndefined()
    expect(CALLS).toEqual([])
  })

  test('a listed service that fails to answer still says so in error (FJS-570)', async () => {
    OFFERS = [{ name: 'ledgerAccounts', methods: ['find'] }]
    FAILING.add('ledgerAccounts')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const answer = await createResource('postingRules', { model: 'PostingRule' }).options('accountId')
      expect(answer.error).toContain('ledgerAccounts is down')
    } finally { warn.mockRestore() }
  })

  test('an app with no answer is asked as before', async () => {
    TABLES.ledgerAccounts = [{ id: 1, name: 'Cash' }]
    const answer = await createResource('postingRules', { model: 'PostingRule' }).options('accountId')
    expect(answer.options).toEqual([{ value: 1, label: 'Cash' }])
  })

  test('offers(op) is true until the app answers, then says what it offers', async () => {
    OFFERS = [{ name: 'postingRules', methods: ['find', 'get', 'create'] }]
    const rules = createResource('postingRules', { model: 'PostingRule' })
    expect(rules.offers('patch')).toBe(true)
    await new Promise(r => setTimeout(r, 0))
    expect(rules.offers('patch')).toBe(false)
    expect(rules.offers('remove')).toBe(false)
    expect(rules.offers('create')).toBe(true)
  })

  test('offers(op) stays permissive when the app cannot answer', async () => {
    const rules = createResource('postingRules', { model: 'PostingRule' })
    await new Promise(r => setTimeout(r, 0))
    expect(rules.offers('remove')).toBe(true)
  })
})
