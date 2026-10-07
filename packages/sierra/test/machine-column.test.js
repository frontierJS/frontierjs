/**
 * test/machine-column.test.js
 *
 * A `@@transitions` column changes by a MOVE, never by a value a person picks.
 * The enum still lists every state, so a generated form used to offer a select
 * of all of them: on a create every choice but the @default is refused
 * (`FJS-D470`), and on an edit a pick skips the move's name, gate and audit
 * (`FJS-1433`, `FJS-1543`). The form leaves the column out, and the detail page
 * shows it with the other columns a form does not offer.
 */

import { describe, test, expect, vi } from 'vitest'

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => ({ on: () => {} }),
    resource: () => ({
      service: {},
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: () => Promise.resolve([]),
    }),
  }),
}))

const { buildFieldRules, formFieldList, stripReadOnly, validateAgainstFields } =
  await import('../src/junction/field-rules.js')
const { createResource }  = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

const TODO = {
  type: 'object',
  title: 'Todo',
  properties: {
    id:     { type: 'integer', readOnly: true },
    title:  { type: 'string', minLength: 1, maxLength: 200 },
    status: { type: 'string', enum: ['open', 'done'], default: 'open' },
  },
  required: ['title'],
  'x-transitions': {
    status: {
      complete: { from: ['open'], to: 'done', gate: null, system: false },
      reopen:   { from: ['done'], to: 'open', gate: null, system: false },
    },
  },
}

describe('buildFieldRules', () => {
  test('marks the column a machine drives with its moves', () => {
    const rules = buildFieldRules(TODO)
    expect(Object.keys(rules.status.transitions)).toEqual(['complete', 'reopen'])
    expect(rules.title.transitions).toBeUndefined()
  })

  test('the column is not readOnly, so a hand-written save still sends it', () => {
    const rules = buildFieldRules(TODO)
    expect(rules.status.readOnly).toBeUndefined()
    expect(stripReadOnly(rules, { title: 'a', status: 'done' })).toEqual({ title: 'a', status: 'done' })
  })

  test('a create with no status passes validation — it is born at the default', () => {
    expect(validateAgainstFields(buildFieldRules(TODO), { title: 'Buy milk' }, 'create')).toEqual([])
  })
})

describe('formFieldList', () => {
  test('leaves the machine column out of the generated set', () => {
    const names = formFieldList(buildFieldRules(TODO)).map(f => f.name)
    expect(names).toEqual(['id', 'title'])
  })

  test('`only` naming it is the person saying they will draw it', () => {
    const fields = formFieldList(buildFieldRules(TODO), { only: ['status'] })
    expect(fields.map(f => f.name)).toEqual(['status'])
    expect(fields[0].control).toBe('select')
  })

  test('a model with no machine is unchanged', () => {
    const { 'x-transitions': _, ...plain } = TODO
    const names = formFieldList(buildFieldRules(plain)).map(f => f.name)
    expect(names).toContain('status')
  })
})

describe('the resource', () => {
  test('summary() shows the state the form no longer offers', () => {
    registerSchemas({ Todo: TODO }, ['Todo'])
    const todos = createResource('todos', 'id', { model: 'Todo' })
    expect(todos.formFields().map(f => f.name)).not.toContain('status')
    expect(todos.summary().columns.map(c => c.name)).toContain('status')
  })
})
