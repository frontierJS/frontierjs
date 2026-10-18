/**
 * test/options-capped.test.js
 *
 * A picker's list is a PAGE, and a held value missing from the page is not
 * thereby missing from the list (`FJS-2555`). Found by the maidtech stressor:
 * on an account with 5,669 contacts, a property's contact picker read its own
 * first page as the whole list, marked the property's live contact
 * unavailable, and `<Form>` refused to save an edit to any other field.
 *
 * So each case here holds a value the first page does not, and the mock's
 * table decides whether it is a member — reachable through the filter the list
 * was read through — or genuinely out of it. The complete-list case sits beside
 * them: there, absence IS the answer and no second question is asked.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

let CALLS = []

// One table per service. A list read answers the first two rows and a total;
// a lookup by `in` answers the rows that match it AND the narrowing it carries
// — a `scope: ['active']` directive excludes the retired row, which is what makes a
// narrowed lookup different from an unnarrowed one.
const TABLES = {
  contacts: [
    { id: 1, name: 'Ada' }, { id: 2, name: 'Bo' },
    { id: 30, name: 'Marshall Goldstein' },
  ],
  tags: [
    { label: 'bug' }, { label: 'chore' },
    { label: 'far' },
    { label: 'ochre', retired: true },
  ],
}
const TOTAL = { contacts: 5669, tags: 900, crews: 2 }

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: (name) => ({
      on: () => {},
      find: async (filter = {}, directives = {}) => {
        CALLS.push({ name, filter, directives })
        const rows = TABLES[name === 'crews' ? 'contacts' : name] ?? []
        const lookup = Object.entries(filter).find(([, v]) => v && typeof v === 'object' && Array.isArray(v.in))
        if (lookup) {
          const [col, { in: wanted }] = lookup
          const hit = rows.filter(r => wanted.includes(r[col]) && !(directives.scope && r.retired))
          return { data: hit, total: hit.length }
        }
        return { data: rows.slice(0, 2), total: TOTAL[name] }
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
  Property: {
    type: 'object', title: 'Property',
    properties: { zip: str, contactId: { type: 'integer' } },
    'x-relations': [belongsTo('contact', 'Contact', 'contactId')],
  },
  Contact: { type: 'object', title: 'Contact', properties: { name: str }, 'x-label-field': 'name' },
  Tag: { type: 'object', title: 'Tag', properties: { label: str }, 'x-label-field': 'label' },
  Task: {
    type: 'object', title: 'Task',
    properties: {
      tag: { ...str, 'x-values': { set: 'LiveTags', strength: 'required', model: 'Tag', value: 'label', label: 'label', scopes: ['active'] } },
    },
  },
  // A related table whose list fits on one page: total 2, two rows.
  Crew: { type: 'object', title: 'Crew', properties: { name: str }, 'x-label-field': 'name' },
  Shift: {
    type: 'object', title: 'Shift',
    properties: { crewId: { type: 'integer' } },
    'x-relations': [belongsTo('crew', 'Crew', 'crewId')],
  },
}, ['Property', 'Contact', 'Tag', 'Task', 'Crew', 'Shift'])

beforeEach(() => { CALLS = [] })

describe('a relation picker whose list is capped (FJS-2555)', () => {
  test('a held value past the page is a member: pinned as itself, never unavailable', async () => {
    const out = await createResource('properties', { model: 'Property' }).options('contactId', { record: { contactId: 30 } })
    expect(out.options[0]).toEqual({ value: 30, label: 'Marshall Goldstein' })
    expect(out.options.some(o => o.unavailable)).toBe(false)
    expect(out.truncated).toBe(true)
  })

  test('a held value the list does not hold at all is still refused', async () => {
    // A removed contact, or one this reader may not see: the lookup finds nothing.
    const out = await createResource('properties', { model: 'Property' }).options('contactId', { record: { contactId: 404 } })
    expect(out.options[0]).toMatchObject({ value: 404, disabled: true, unavailable: true })
  })
})

describe('a value set whose list is capped (FJS-2555)', () => {
  test('a member past the page is pinned; one the scope retired is refused with its own label', async () => {
    const r = createResource('tasks', { model: 'Task' })
    const far = await r.options('tag', { record: { tag: 'far' } })
    expect(far.options[0]).toEqual({ value: 'far', label: 'far' })

    const retired = await r.options('tag', { record: { tag: 'ochre' } })
    expect(retired.options[0]).toEqual({ value: 'ochre', label: 'ochre (unavailable)', disabled: true, unavailable: true })
  })

  test("the membership question carries the set's own narrowing", async () => {
    await createResource('tasks', { model: 'Task' }).options('tag', { record: { tag: 'far' } })
    const lookup = CALLS.find(c => c.filter.label?.in)
    expect(lookup.filter).toEqual({ label: { in: ['far'] } })
    expect(lookup.directives.scope).toEqual(['active'])
  })
})

describe('a complete list', () => {
  test('absence is the answer, and no membership question is asked', async () => {
    // total 2, two rows: the list is whole, so 30 is out of it.
    const out = await createResource('shifts', { model: 'Shift' }).options('crewId', { record: { crewId: 30 } })
    expect(out.truncated).toBe(false)
    expect(out.options[0]).toMatchObject({ value: 30, unavailable: true })
    // One list read and one label read — nothing asked through the list's filter first.
    expect(CALLS.filter(c => c.name === 'crews')).toHaveLength(2)
  })
})
