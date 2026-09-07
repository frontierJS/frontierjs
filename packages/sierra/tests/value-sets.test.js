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
        // A lookup of specific values — what a pinned unavailable entry asks —
        // is answered from a table that HAS the retired row, so the fetched
        // label is exercised rather than assumed.
        const lookup = Object.values(filter ?? {}).find(v => v && typeof v === 'object' && Array.isArray(v.in))
        if (lookup) {
          const rows = [{ id: 9, label: 'ochre' }, { id: 1, label: 'bug' }]
            .filter(r => lookup.in.includes(r.label) || lookup.in.includes(r.id))
          return { data: rows, total: rows.length }
        }
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
      // A DEPENDENT set: the list is that country's states, so the picker
      // cannot ask for it before a country is chosen.
      countryId: str,
      stateId:   { ...str, 'x-values': values({
        set: 'States', model: 'Tag', value: 'label',
        dependsOn: { field: 'countryId', match: 'countryId' },
      }) },
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

describe('a dependent set is narrowed by the row being edited', () => {
  test('the controlling value travels as an ordinary column filter', async () => {
    // Not a new directive and not a scope: an ordinary filter, which
    // `$checkWhere` already validates. The Data boundary grades the PAIR, so
    // the list offered is the list accepted (`FJS-D122`).
    await createResource('tasks').options('stateId', { record: { countryId: 'US' } })
    expect(LAST.filter.countryId).toBe('US')
  })

  test('with no controlling value it answers EMPTY and says what it waits for', async () => {
    // The unnarrowed list would offer values the boundary refuses — the break
    // this closes, one screen earlier. `awaiting` is what lets a control say
    // *choose a country first* without knowing the schema.
    const out = await createResource('tasks').options('stateId', { record: {} })
    expect(out.options).toEqual([])
    expect(out.awaiting).toBe('countryId')
    expect(LAST).toBe(null)                    // and it asked nobody
  })

  test('no record at all is the same answer, not the whole list', async () => {
    const out = await createResource('tasks').options('stateId')
    expect(out.options).toEqual([])
    expect(LAST).toBe(null)
  })

  test('changing the controlling field re-asks rather than serving the cache', async () => {
    // The narrowing goes into `query` BEFORE the cache key is built, so this
    // needs no cache invalidation of its own.
    const r = createResource('tasks')
    await r.options('stateId', { record: { countryId: 'US' } })
    expect(LAST.filter.countryId).toBe('US')
    LAST = null
    await r.options('stateId', { record: { countryId: 'FR' } })
    expect(LAST.filter.countryId).toBe('FR')
  })

  test('an undependent set is unaffected by a record', async () => {
    // The control beside every row above: a plain set still answers without one.
    const out = await createResource('tasks').options('tag')
    expect(out.options.length).toBe(2)
  })
})

describe('a stored value the list no longer offers', () => {
  test('is pinned to the front, disabled and marked', async () => {
    // A native <select> bound to a value it does not contain shows the FIRST
    // option instead — the wrong value, silently, and saving writes it.
    const out = await createResource('tasks').options('tag', { record: { tag: 'ochre' } })
    expect(out.options[0]).toEqual({
      value: 'ochre', label: 'ochre (unavailable)', disabled: true, unavailable: true,
    })
    expect(out.options.map(o => o.value)).toEqual(['ochre', 'bug', 'chore'])
  })

  test('the label comes from the row, not from the code', async () => {
    // The row is read once, unnarrowed — the whole point is that the set's own
    // scope excludes it.
    const out = await createResource('tasks').options('ownerId', { record: { ownerId: 9 } })
    expect(out.options[0].label).toBe('ochre (unavailable)')
  })

  test('falls back to a humanized code when the row cannot be read', async () => {
    // A policy that refuses the row, or a row that is genuinely gone. The value
    // is still shown — `dark_blue` reads as English beside the other options.
    const out = await createResource('tasks').options('tag', { record: { tag: 'dark_blue' } })
    expect(out.options[0].label).toBe('Dark Blue (unavailable)')
  })

  test('a value that IS in the list changes nothing', async () => {
    // The control beside every row above: this is every render but the one the
    // feature exists for, and it must cost nothing.
    const out = await createResource('tasks').options('tag', { record: { tag: 'bug' } })
    expect(out.options.length).toBe(2)
    expect(out.options.some(o => o.unavailable)).toBe(false)
  })

  test('an empty record is untouched, and so is a null value', async () => {
    for (const record of [{}, { tag: null }, undefined]) {
      const out = await createResource('tasks').options('tag', record ? { record } : {})
      expect(out.options.map(o => o.value)).toEqual(['bug', 'chore'])
    }
  })

  test('a bound array marks per element', async () => {
    const out = await createResource('tasks').options('tags', { record: { tags: ['bug', 'ochre'] } })
    expect(out.options.filter(o => o.unavailable).map(o => o.value)).toEqual(['ochre'])
  })

  test('two records asking about one field are two questions', async () => {
    // The held value is part of the cache key, or the second record reads the
    // first one's pinned entry.
    const r = createResource('tasks')
    const a = await r.options('tag', { record: { tag: 'ochre' } })
    const b = await r.options('tag', { record: { tag: 'bug' } })
    expect(a.options[0].unavailable).toBe(true)
    expect(b.options.some(o => o.unavailable)).toBe(false)
  })
})

describe('resource.aggregate — the verb, from the client', () => {
  test('goes out as a collection-level invoke, uncached', async () => {
    // `invoke` and not `call`: the socket when there is one, HTTP when there is
    // not, which is what every other service call does. Collection-level, so no
    // id — the bridge reads the header before it looks for one.
    const seen = []
    const svc = { invoke: (...a) => { seen.push(a); return Promise.resolve({ _count: 3 }) } }
    const res = createResource('tasks')
    res.service.invoke = svc.invoke

    const a = await res.aggregate({ by: ['status'], _count: true })
    const b = await res.aggregate({ by: ['status'], _count: true })

    expect(a).toEqual({ _count: 3 })
    expect(seen.length).toBe(2)                       // asked twice — a total is not cacheable
    expect(seen[0][0]).toBe('aggregate')
    expect(seen[0][1]).toBe(null)                     // no id
    expect(seen[0][2]).toEqual({ by: ['status'], _count: true })
  })

  test('an empty spec is still a call', async () => {
    const seen = []
    const res = createResource('tasks')
    res.service.invoke = (...a) => { seen.push(a); return Promise.resolve({ _count: 0 }) }
    await res.aggregate()
    expect(seen[0][2]).toEqual({})
  })
})
