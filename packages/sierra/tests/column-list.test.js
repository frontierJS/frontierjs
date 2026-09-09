/**
 * tests/column-list.test.js
 *
 * Which columns a TABLE shows, and in what order.
 *
 * `formFieldList` cannot be reused and the reason is a rule: a form shows what
 * is WRITABLE, a table shows what is READABLE and IDENTIFYING. The two sets
 * differ at both ends — `@computed` and `@system` are absent from a form BY
 * RULE and are among the columns a table most wants — and a table has a second
 * question a form never had, which is *which few*.
 *
 * The answer this replaces is `crud-templates.js`'s `.slice(0, 5)` over
 * `Object.keys`, described in its own file as the one choice in it that is not
 * a consequence of the schema. That is presentation decided by the order
 * columns happen to sit in a file people reorder for unrelated reasons, and
 * under row tenancy it is worse than arbitrary: the tenant column is declared
 * first on every scoped model, so every generated table in a row-tenant app led
 * with the one column that holds the same value in every row.
 *
 * The schemas here are generated from `.lite` source rather than hand-written,
 * because `x-identify`, `x-label-field` and `x-money` are what litestone emits
 * and a hand-built rule table could carry either spelling of any of them.
 */

import { describe, test, expect } from 'vitest'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'

import { buildFieldRules, columnList } from '../src/junction/field-rules.js'

const SOURCE = `
database main { path ":memory:" }
tenancy { strategy row  column workspaceId  claim workspaceId }

model Workspace {
  id      String @id @default(cuid())
  slug    String @unique(global)
  servers Server[]
}

model Server {
  id          String    @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  hostname    String
  name        String
  notes       String?
  uptimeAvg   Int       @computed
  labels      String[]
  status      Status    @default(pending)
  cost        Int       @money(USD)
  seenAt      DateTime?
  uptimePct   Int       @system
  @@unique([workspaceId, hostname])
}

enum Status { pending online stopped }
`

// READ mode, because that is what a table is handed: `columnList` is fed the
// read rules by `resource.columns()`, and in a write mode a `@computed` column
// is absent from the document entirely rather than present and read-only
// (`FJS-1036`).
const defs   = generateJsonSchema(parse(SOURCE).schema, { mode: 'full' }).$defs
const deref  = (ref) => defs[String(ref).split('/').pop()]
const server = defs.Server
const fields = buildFieldRules(server, deref)

const list = (opts = {}) => columnList(fields, {
  identify: server['x-identify'],
  label:    server['x-label-field'],
  ...opts,
})

const names = (r) => r.columns.map(c => c.name)
const tier  = (r, name) => r.columns.find(c => c.name === name)?.tier

describe('the ranking', () => {
  test('the tenant column is not the first column, and the name is', () => {
    // The whole reason this function exists. `workspaceId` is declared first on
    // every scoped model, so the slice this replaces led with it — a column
    // holding one value for every row on screen.
    const r = list()
    expect(names(r)[0]).toBe('name')
    expect(names(r).indexOf('workspaceId')).toBeGreaterThan(0)
  })

  test('each tier is claimed by the column that has a reason to lead', () => {
    const r = list()
    expect(tier(r, 'name')).toBe('label')       // conventional label column
    expect(tier(r, 'hostname')).toBe('identify')  // the tuple minus its tenant column
    expect(tier(r, 'status')).toBe('state')     // a bound enum
    expect(tier(r, 'cost')).toBe('quantity')    // @money
    expect(tier(r, 'workspaceId')).toBe('rest')
  })

  test('a read-only column is a table column, where a form refuses it', () => {
    // The rule that makes this not `formFieldList`. `uptimePct` is `@system`,
    // so it reaches the client `readOnly` and `controlFor` answers
    // `{ control: null, reason: 'readOnly' }` for it — a server-written value
    // is exactly the kind of column a table most wants.
    expect(fields.uptimePct.readOnly).toBe(true)
    expect(names(list({ limit: 99 }))).toContain('uptimePct')
  })

  test('declaration order breaks a tie WITHIN a tier and never across one', () => {
    // `notes` is declared BEFORE `status` and `cost` and must still come after
    // both, because its tier is worse — the inversion is what separates a
    // ranking from a sort that kept the file's order. Beside it, `cost` and
    // `seenAt` share a tier, so there the file's order is the only ordering
    // anybody stated and it survives.
    const ordered = names(list({ limit: 99 }))
    expect(ordered.indexOf('status')).toBeLessThan(ordered.indexOf('notes'))
    expect(ordered.indexOf('cost')).toBeLessThan(ordered.indexOf('notes'))
    expect(ordered.indexOf('cost')).toBeLessThan(ordered.indexOf('seenAt'))
  })
})

describe('a header offers a sort only where the boundary takes one', () => {
  test('sortability travels WITH the column, and the refusal is its reason', () => {
    // The exception-only emit is the trap: `x-sortable` is absent on an
    // ordinary column and a STRING on one that cannot be ordered by, so a
    // consumer reading it truthily is wrong about every ordinary column.
    // Carried onto the entry so a page never re-reads the rule and gets that
    // backwards — a header offering a sort the Data boundary refuses is a
    // click that throws.
    const r = list({ limit: 99 })
    const by = (n) => r.columns.find(c => c.name === n)

    expect(by('name').sortable).toBe(true)
    expect(by('name').sortRefusal).toBeNull()

    // Paired, because a rule answering `false` for everything satisfies half of
    // this and a rule answering `true` for everything satisfies the other.
    expect(by('uptimeAvg').sortable).toBe(false)
    expect(by('uptimeAvg').sortRefusal).toBe('computed')
    expect(by('labels').sortable).toBe(false)
    expect(by('labels').sortRefusal).toBe('array')
  })

  test('the queryability keys reach the rule at all, or the row above is vacuous', () => {
    // `_CARRIED` decides what `buildFieldRules` keeps. Without these two the
    // assertion above passes with every column sortable, because absent reads
    // as permitted — which is exactly what it did before this test existed.
    expect(fields.uptimeAvg['x-sortable']).toBe('computed')
    expect(fields.labels['x-filterable']).toBeUndefined()
  })
})

describe('nothing is dropped silently', () => {
  test('a column beyond the limit is reported with its rank, not discarded', () => {
    const r = list({ limit: 3 })
    expect(names(r)).toHaveLength(3)
    const cut = r.omitted.find(o => o.name === 'notes')
    expect(cut.reason).toMatch(/beyond the 3-column limit/)
    // Every field is accounted for in one list or the other, which is the
    // property that makes a column added to `.lite` impossible to lose.
    expect(names(r).length + r.omitted.length).toBe(Object.keys(fields).length)
  })

  test('an except is reported as excluded rather than vanishing', () => {
    const r = list({ except: ['notes'], limit: 99 })
    expect(names(r)).not.toContain('notes')
    expect(r.omitted).toContainEqual({ name: 'notes', reason: 'excluded by the caller' })
  })

  test('a name the model does not have is reported, in either argument', () => {
    // Usually a rename that left the table behind — the same mistake
    // `formFieldList` reports rather than ignores.
    expect(list({ except: ['gone'] }).omitted)
      .toContainEqual({ name: 'gone', reason: 'excluded, but no such field on this model' })
    expect(list({ only: ['name', 'gone'] }).omitted)
      .toContainEqual({ name: 'gone', reason: 'no such field on this model' })
  })
})

describe('only is the escape hatch and is not a silent one', () => {
  test('its order wins over the ranking', () => {
    // Naming the columns is also naming the order you want them in, so the
    // ranking is bypassed rather than applied to the subset.
    const r = list({ only: ['status', 'name'] })
    expect(names(r)).toEqual(['status', 'name'])
    expect(r.columns.every(c => c.tier === 'named')).toBe(true)
  })

  test('what only left out is still named', () => {
    const r = list({ only: ['name'] })
    expect(r.omitted).toContainEqual({ name: 'status', reason: 'not named by only' })
  })
})

describe('the label tier refuses a guess', () => {
  test('a model with no declared or conventional label leads with its identity instead', () => {
    // `labelFieldInfo`'s `scan` answer is the first plain string column, which
    // is the arbitrariness this function replaces — so it is not taken, and the
    // tier is simply empty.
    const src = `
      database main { path ":memory:" }
      model Ticket {
        id     String @id @default(cuid())
        ref    String @unique
        body   String
      }
    `
    const d = generateJsonSchema(parse(src).schema, { mode: 'full' }).$defs.Ticket
    const r = columnList(buildFieldRules(d, () => null), { identify: d['x-identify'] })
    expect(r.columns[0]).toMatchObject({ name: 'ref', tier: 'identify' })
    expect(r.columns.some(c => c.tier === 'label')).toBe(false)
  })
})
