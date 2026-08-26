/**
 * tests/value-sets.test.js
 *
 * The client half of `@values` — `x-values` off the schema, through the field
 * rules and the control table, to the request a picker actually sends.
 *
 * The three things worth pinning are not "does a picker appear":
 *
 *   1. A bound column is asked BEFORE its foreign key and before the array
 *      branch. A bound FK is both, and the set is the narrower answer — it
 *      carries the scope and the display column, where the relation carries
 *      neither. Answered as a plain relation it would fetch the whole related
 *      table and offer rows the set excludes.
 *   2. The declared `@@scope` TRAVELS, as a filter. `$checkWhere` validates a
 *      `$scope`, so it survives junction's autoFilter and litestone applies it
 *      — which is what makes the offered list the same list the Data boundary
 *      will accept.
 *   3. A declared `where` is SQL, which a browser may never send — so it mints
 *      a `@@scope` of its own at parse and arrives here as one more NAME. Both
 *      narrowings cross the same way, and there is no set the picker cannot ask
 *      for correctly (`FJS-430`).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

let LAST = null

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: (name) => ({
      on: () => {},
      find: async (filter, directives) => {
        LAST = { name, filter, directives }
        return { data: [{ id: 1, label: 'bug' }, { id: 2, label: 'chore' }], total: 2 }
      },
    }),
    resource: () => ({
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { createResource, buildFieldRules, controlFor } = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

const str = { type: 'string' }
const values = (over = {}) => ({
  set: 'TaskTag', strength: 'required', model: 'Tag', value: 'label', label: 'label', ...over,
})

const DEFS = {
  Tag: { type: 'object', title: 'Tag', properties: { label: str }, 'x-label-field': 'label' },
  Task: {
    type: 'object', title: 'Task',
    properties: {
      title:  str,
      tag:    { ...str, 'x-values': values() },
      grow:   { ...str, 'x-values': values({ strength: 'open' }) },
      free:   { ...str, 'x-values': values({ strength: 'suggested' }) },
      scoped: { ...str, 'x-values': values({ set: 'Assignee', scopes: ['active'] }) },
      // A set with both: a declared `@@scope` and a `where` that minted one
      // named after the set. Two names, ANDed by litestone.
      narrow: { ...str, 'x-values': values({ set: 'LiveTag', scopes: ['active', 'LiveTag'] }) },
      tags:   { type: 'array', items: str, 'x-values': values({ strength: 'open' }) },
      // Bound AND a foreign key — the case the ordering is about.
      ownerId: { type: 'integer', 'x-values': values({ set: 'Owners', model: 'Tag', value: 'id' }) },
    },
    'x-relations': [{
      field: 'owner', model: 'Tag', type: 'belongsTo',
      fields: ['ownerId'], references: ['id'], onDelete: null, optional: true,
    }],
  },
}

let warn
beforeEach(() => { LAST = null; registerSchemas(DEFS, ['Tag', 'Task']); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => warn.mockRestore())

const ruleFor = (name) => buildFieldRules(DEFS.Task)[name]

describe('x-values reaches the rule', () => {
  test('as rule.values, whole', () => {
    expect(ruleFor('tag').values).toEqual(values())
  })

  test('and a column that binds to nothing carries none', () => {
    expect('values' in ruleFor('title')).toBe(false)
  })
})

describe('the strength picks the control', () => {
  test('required is a picker — the caller chooses from the list', () => {
    const c = controlFor(ruleFor('tag'))
    expect(c.control).toBe('picker')
    expect(c.allowNew).toBe(false)
    expect(c.set).toBe('TaskTag')
  })

  test('open and suggested are the same control', () => {
    // What separates them is what the SERVER does with a new value, not what
    // the caller may type.
    for (const f of ['grow', 'free']) {
      const c = controlFor(ruleFor(f))
      expect(c.control).toBe('combobox')
      expect(c.allowNew).toBe(true)
    }
  })

  test('a bound array is a multiselect, where an unbound one is json', () => {
    expect(controlFor(ruleFor('tags')).control).toBe('multiselect')
    expect(controlFor({ type: 'array' }).control).toBe('json')
  })

  test('a bound foreign key is asked as the SET, not as the relation', () => {
    // Both facts are on the column. The set is the narrower one — it names the
    // scope and the display column, and the relation names neither.
    const rule = ruleFor('ownerId')
    expect(rule.references).toBeTruthy()
    expect(controlFor(rule).set).toBe('Owners')
  })
})

describe('what the picker asks for', () => {
  test('the set’s own model, keyed by its value and label columns', async () => {
    const out = await createResource('tasks').options('tag')
    expect(LAST.name).toBe('tags')                 // the Tag service
    expect(out.options).toEqual([
      { value: 'bug',   label: 'bug' },
      { value: 'chore', label: 'chore' },
    ])
    expect(out.total).toBe(2)
  })

  test('a declared @@scope travels as a filter', () => {
    // The half that makes the offered list the same list the server accepts.
    return createResource('tasks').options('scoped').then(() => {
      expect(LAST.filter).toEqual({ $scope: ['active'] })
    })
  })

  test('a `where` travels too, as the scope it minted', async () => {
    // `FJS-430`. SQL cannot cross and a name can, so the narrowing that used to
    // be invisible here is now just another entry in the list.
    await createResource('tasks').options('narrow')
    expect(LAST.filter).toEqual({ $scope: ['active', 'LiveTag'] })
  })

  test('search matches the display column, and the list is ordered by it', async () => {
    await createResource('tasks').options('tag', { search: 'bu' })
    expect(LAST.filter).toEqual({ label: { contains: 'bu' } })
    expect(LAST.directives.orderBy).toBe('label')
  })

  test('an unsearched answer is cached, a searched one is not', async () => {
    const r = createResource('tasks')
    await r.options('tag'); LAST = null
    await r.options('tag')
    expect(LAST).toBeNull()                        // served from cache

    await r.options('tag', { search: 'bu' }); LAST = null
    await r.options('tag', { search: 'bu' })
    expect(LAST).not.toBeNull()                    // asked again
  })
})

describe('there is no set the picker has to over-offer', () => {
  const said = () => warn.mock.calls.map(c => String(c[0])).join('\n')

  test('a set narrowed by SQL is asked for by name, and says nothing', async () => {
    // It used to warn, because the predicate could not cross and the picker
    // knowingly offered rows the save would refuse. There is nothing left to
    // report: the scope crosses, so the offered list IS the accepted list.
    await createResource('tasks').options('narrow')
    expect(said()).not.toContain('narrowed by a declared')
    expect(LAST.filter.$scope).toContain('LiveTag')
  })

  test('a set with no narrowing sends no scope at all', async () => {
    await createResource('tasks').options('tag')
    expect(LAST.filter).toEqual({})
  })
})
