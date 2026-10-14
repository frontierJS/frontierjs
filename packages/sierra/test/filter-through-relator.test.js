/**
 * test/filter-through-relator.test.js
 *
 * `resource.filters()` over a to-many (`FJS-2557`): contacts carrying a tag,
 * across a join model that points back here and at the model being picked.
 * The Data boundary already takes `{ tags: { some: { tagId: { in } } } }`; what
 * was missing is the OFFER, so a screen wrote its own filter beside the bar.
 *
 * Each claim is a pair with a to-many that is not a join, because an offer made
 * for every `hasMany` would put a filter on a child list nobody picks from.
 */

import { describe, test, expect, vi } from 'vitest'

const OPTIONS = []

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: (name) => ({
      on: () => {},
      invoke: async () => OPTIONS,
      find: async () => OPTIONS,
      getOptions: async () => OPTIONS,
    }),
    resource: () => ({
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { createResource } = await import('../src/resource/resource.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')

const str = { type: 'string' }
const int = { type: 'integer' }

const DEFS = {
  Contact: {
    type: 'object', title: 'Contact',
    properties: { id: int, name: str },
    'x-label-field': 'name',
    'x-relations': [
      { field: 'tags',  model: 'ContactTag',  type: 'hasMany', fields: [], references: [] },
      { field: 'notes', model: 'ContactNote', type: 'hasMany', fields: [], references: [] },
    ],
  },
  Tag: {
    type: 'object', title: 'Tag',
    properties: { id: int, name: str },
    'x-label-field': 'name',
  },
  ContactTag: {
    type: 'object', title: 'ContactTag',
    properties: {
      id: int, contactId: int,
      tagId: { ...int, 'x-values': { set: 'ContactTags', model: 'Tag', value: 'id', label: 'name' } },
    },
    'x-relations': [
      { field: 'contact', model: 'Contact', type: 'belongsTo', fields: ['contactId'], references: ['id'] },
      { field: 'tag',     model: 'Tag',     type: 'belongsTo', fields: ['tagId'],     references: ['id'] },
    ],
  },
  ContactNote: {
    type: 'object', title: 'ContactNote',
    properties: { id: int, contactId: int, body: str },
    'x-relations': [
      { field: 'contact', model: 'Contact', type: 'belongsTo', fields: ['contactId'], references: ['id'] },
    ],
  },
}

registerSchemas(DEFS, ['Contact', 'Tag', 'ContactTag', 'ContactNote'])

describe('filters() through a to-many', () => {
  test('offers the join\'s other end as a set filter named for the relation', () => {
    const contacts = createResource('contacts', { model: 'Contact' })
    const f = contacts.filters({ limit: 99 }).filters.find(x => x.name === 'tags')

    expect(f).toBeTruthy()
    expect(f.op).toBe('in')
    expect(f.kind).toBe('set')
    expect(f.label).toBe('Tags')
    expect(f.through).toEqual({ field: 'tagId', model: 'ContactTag' })
    expect(f.rule.values.set).toBe('ContactTags')
  })

  test('offers nothing for a to-many that is not a join', () => {
    const contacts = createResource('contacts', { model: 'Contact' })
    const names = contacts.filters({ limit: 99 }).filters.map(x => x.name)

    expect(names).not.toContain('notes')
  })

  test('options() answers the other end\'s declared set', async () => {
    OPTIONS.length = 0
    OPTIONS.push({ id: 1, name: 'vip' }, { id: 2, name: 'lapsed' })

    const contacts = createResource('contacts', { model: 'Contact' })
    const { options } = await contacts.options('tags')

    expect(options).toEqual([{ value: 1, label: 'vip' }, { value: 2, label: 'lapsed' }])
  })
})
