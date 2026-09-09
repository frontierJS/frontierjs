/**
 * tests/display-for.test.js
 *
 * How a value is rendered for READING, which is not how it is rendered for
 * editing.
 *
 * `controlFor` named this surface from the inside before it existed, refusing a
 * read-only column with *a read-only value shown on a form is a detail renderer
 * wearing a control's clothes, and it wants the surface that does not exist
 * yet*. This is that surface.
 *
 * ── Why it is a second table and not a mode on the first ────────────────────
 *
 * The two disagree at their FIRST branch. `controlFor` answers
 * `{ control: null, reason: 'readOnly' }` for `@system`, `@computed`,
 * `@generated`, `@from` and `@version`, and never offers those columns to a
 * registry at all, because a control is a thing that WRITES and the Data
 * boundary refuses them by name. Every one of them is a column a table wants.
 *
 * ── What the assertions are actually about ──────────────────────────────────
 *
 * Every answer here comes from the DECLARATION rather than from the value's JS
 * type, and each row below is a case where the JS type gives a plausible wrong
 * answer rather than an obviously wrong one. `@money` and a plain count are
 * both integers, and the five-line renderer this replaces returned `1299` for
 * a price — wrong in the way that looks right.
 *
 * The schemas are generated from `.lite` source for `field-control-scaled`'s
 * reason: `x-money`, `x-time` and `x-litestone-file` are what litestone emits
 * and a hand-written rule table could carry either spelling.
 */

import { describe, test, expect, afterEach } from 'vitest'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'

import {
  buildFieldRules, displayFor, defaultDisplayFor, controlFor,
  registerDisplay, unregisterDisplay, registeredDisplays,
} from '../src/junction/field-rules.js'

const SOURCE = `
database main { path ":memory:" }

enum Status { pending  awaiting_payment @label("Awaiting payment") }

model Shop {
  id     Int    @id @default(autoincrement())
  name   String
}

model Order {
  id        Int      @id @default(autoincrement())
  shopId    Int
  shop      Shop     @relation(fields: [shopId], references: [id])
  reference String
  status    Status   @default(pending)
  total     Int      @money(USD)
  rate      Int      @scale(2)
  count     Int
  paid      Boolean  @default(false)
  placedAt  DateTime @default(now())
  meta      Json?
  tags      String[]
  lines     Int      @computed
  @@gate("0.0.0.0")
}
`

const defs   = generateJsonSchema(parse(SOURCE).schema, { mode: 'full' }).$defs
const deref  = (ref) => defs[String(ref).split('/').pop()]
const fields = buildFieldRules(defs.Order, deref)
const show   = (name) => displayFor(fields[name], { field: name, model: 'Order' })

afterEach(() => { unregisterDisplay('audit') })

describe('the declaration decides, not the JS type', () => {
  test('money and a plain count are both integers and are not the same cell', () => {
    // The row this whole surface exists for. `total` holds MINOR units, so the
    // renderer this replaces printed 1299 for a price and looked correct.
    expect(show('total')).toEqual({ display: 'money', currency: 'USD' })
    expect(show('count')).toEqual({ display: 'number' })
  })

  test('a scaled integer is neither of those', () => {
    expect(show('rate')).toEqual({ display: 'scale', scale: 2 })
  })

  test('an enum carries its @label, because the member name is what it was written to avoid', () => {
    const answer = show('status')
    expect(answer.display).toBe('enum')
    expect(answer.options).toContainEqual({ value: 'awaiting_payment', label: 'Awaiting payment' })
  })

  test('a foreign key names the model whose label resolves it, not a number', () => {
    // `shopId` is emitted as a plain integer, so a JS-type renderer prints an
    // id nobody recognizes.
    expect(show('shopId')).toMatchObject({ display: 'relation', model: 'Shop' })
    expect(show('shopId').display).not.toBe('number')
  })

  test('a DateTime says which kind of time it is, since the string cannot', () => {
    expect(show('placedAt').display).toBe('time')
  })

  test('a Json column and an array are not one another, and neither is text', () => {
    expect(show('meta')).toEqual({ display: 'json' })
    expect(show('tags')).toEqual({ display: 'list' })
  })

  test('a boolean is a boolean and a string is text', () => {
    expect(show('paid')).toEqual({ display: 'boolean' })
    expect(show('reference')).toEqual({ display: 'text' })
  })
})

describe('what separates it from controlFor', () => {
  test('a @computed column has no control and DOES have a display', () => {
    // The pair. One is refused by rule and the other is the column a table most
    // wants — asserted together, because either alone is satisfied by a table
    // that answers the same thing for everything.
    expect(fields.lines.readOnly).toBe(true)
    expect(controlFor(fields.lines)).toEqual({ control: null, reason: 'readOnly' })
    expect(show('lines')).toEqual({ display: 'number' })
  })

  test('an unplaceable column keeps its place and says why', () => {
    // `controlFor`'s rule carried over unchanged: null is an ANSWER. Dropping
    // it would reproduce, inside the generator, the bug the generator exists to
    // end.
    const answer = displayFor({ type: 'geography' })
    expect(answer.display).toBeNull()
    expect(answer.reason).toMatch(/no display for type geography/)
  })

  test('a $ref nothing resolved is not silently a document', () => {
    const answer = displayFor({ unresolvedRef: '#/$defs/Missing' })
    expect(answer.display).toBeNull()
    expect(answer.reason).toMatch(/unresolved \$ref/)
  })
})

describe('the registry, on registerControl\'s terms exactly', () => {
  test('a registration beats the built-in table and is named on the answer', () => {
    registerDisplay('audit', (rule, ctx) => ctx.field === 'reference' ? 'audit' : null)
    expect(show('reference')).toEqual({ display: 'audit', by: 'audit' })
    // The column it declined is untouched, which is what keeps a registration
    // narrow enough to be safe.
    expect(show('total').display).toBe('money')
  })

  test('the built-in answer stays reachable, so a resolver can add rather than restate', () => {
    registerDisplay('audit', () => ({ ...defaultDisplayFor(fields.total), tone: 'danger' }))
    expect(show('total')).toMatchObject({ display: 'money', currency: 'USD', tone: 'danger' })
  })

  test('a resolver that throws is skipped and the column still renders', () => {
    // One bad registration must not take every table in the app down with it.
    registerDisplay('audit', () => { throw new Error('boom') })
    expect(show('total').display).toBe('money')
  })

  test('unregistering restores the built-in answer', () => {
    registerDisplay('audit', () => 'audit')
    expect(show('total').display).toBe('audit')
    unregisterDisplay('audit')
    expect(show('total').display).toBe('money')
    expect(registeredDisplays()).not.toContain('audit')
  })
})
