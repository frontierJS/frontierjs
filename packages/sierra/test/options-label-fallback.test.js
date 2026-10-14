/**
 * test/options-label-fallback.test.js
 *
 * What a relation picker shows for a row whose display column is empty
 * (`FJS-1976`). Found by the ela stressor: a User with no `name` was offered as
 * `17`, with an `email` on the row the picker already held.
 *
 * Only a CONVENTIONAL label is a guess between sibling columns; a declared
 * `@@label` is the author's word and falls back to the id alone.
 */

import { describe, test, expect, vi } from 'vitest'

const ROWS = {
  people: [
    { id: 1, name: 'Ada',  email: 'ada@x.test' },
    { id: 2, name: '',     email: 'bo@x.test' },
    { id: 3, name: null,   email: null },
  ],
  ledgers: [
    { id: 4, name: '', email: 'kept@x.test' },
  ],
}

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: (name) => ({
      on: () => {},
      find: async () => ({ data: ROWS[name] ?? [], total: (ROWS[name] ?? []).length }),
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
const belongsTo = (field, model, fk) => ({ field, model, type: 'belongsTo', fields: [fk], references: ['id'], onDelete: null, optional: false })

registerSchemas({
  Person: { type: 'object', title: 'Person', properties: { name: str, email: str } },
  Ledger: { type: 'object', title: 'Ledger', properties: { name: str, email: str }, 'x-label-field': 'name' },
  Task: {
    type: 'object', title: 'Task',
    properties: { assigneeId: { type: 'integer' }, ledgerId: { type: 'integer' } },
    'x-relations': [belongsTo('assignee', 'Person', 'assigneeId'), belongsTo('ledger', 'Ledger', 'ledgerId')],
  },
}, ['Person', 'Ledger', 'Task'])

describe('an option whose label column is empty (FJS-1976)', () => {
  test('a conventional label falls to the next conventional column, then the id', async () => {
    const out = await createResource('tasks', { model: 'Task' }).options('assigneeId')
    expect(out.options.map(o => o.label)).toEqual(['Ada', 'bo@x.test', '3'])
  })

  test('a declared label falls to the id and nothing else', async () => {
    const out = await createResource('tasks', { model: 'Task' }).options('ledgerId')
    expect(out.options.map(o => o.label)).toEqual(['4'])
  })
})
