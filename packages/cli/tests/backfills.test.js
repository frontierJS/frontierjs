// ─── core/backfills.js ───────────────────────────────────────────────────────
// Which columns this app declares a backfill for, read off its own source.
//
// The extractor is the part worth testing: a `fill` is a function body and holds
// braces and quotes of its own, so the shapes that break a regex are the shapes
// a real declaration has.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { declaredBackfills, backfillReport, formatBackfillReport, stubFor } from '../core/backfills.js'

let root
const write = (rel, text) => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fli-bf-')) })
afterEach(()  => rmSync(root, { recursive: true, force: true }))

// ─── reading a declaration ───────────────────────────────────────────────────

describe('declaredBackfills', () => {
  test('finds one, with where it was found', () => {
    write('api/src/backfills/ship.ts', `
import { defineBackfill } from '@frontierjs/junction'

export default defineBackfill({
  name:  'order-shipped-at',
  model: 'Order',
  field: 'shippedAt',
  fill:  (row) => new Date(row.createdAt),
})
`)
    const [found] = declaredBackfills(root)
    expect(found.name).toBe('order-shipped-at')
    expect(found.model).toBe('Order')
    expect(found.field).toBe('shippedAt')
    expect(found.file).toBe('api/src/backfills/ship.ts')
    expect(found.line).toBe(4)
  })

  // The shape a regex gets wrong. `defineBackfill\({([^}]*)}` stops at the brace
  // inside the arrow function, so everything after `fill` is never read — which
  // is where `field` usually is.
  test('a fill with braces of its own does not truncate the object', () => {
    write('api/x.ts', `defineBackfill({
  name: 'a',
  fill: (row) => { if (row.x) { return 1 } return 2 },
  model: 'Order',
  field: 'shippedAt',
})`)
    expect(declaredBackfills(root)[0]).toMatchObject({ model: 'Order', field: 'shippedAt' })
  })

  test('a brace inside a string does not close the object early', () => {
    write('api/x.ts', `defineBackfill({
  name: 'a', model: 'Order', field: 'shippedAt',
  fill: () => "} not the end {",
})`)
    expect(declaredBackfills(root)[0]).toMatchObject({ model: 'Order', field: 'shippedAt' })
  })

  test('a brace inside a comment does not close it either', () => {
    write('api/x.ts', `defineBackfill({
  name: 'a', model: 'Order',
  // a closing } in prose
  /* and a } in a block */
  field: 'shippedAt',
  fill: () => 1,
})`)
    expect(declaredBackfills(root)[0]).toMatchObject({ model: 'Order', field: 'shippedAt' })
  })

  test('reads several from one file, and several files', () => {
    write('api/a.ts', `defineBackfill({ name: 'a', model: 'Order', field: 'x', fill: () => 1 })
defineBackfill({ name: 'b', model: 'Order', field: 'y', fill: () => 1 })`)
    write('api/sub/c.js', `defineBackfill({ name: 'c', model: 'Ticket', field: 'z', fill: () => 1 })`)
    expect(declaredBackfills(root).map(d => d.name).sort()).toEqual(['a', 'b', 'c'])
  })

  // Keyed on what the classifier can match — a declaration missing either half
  // cannot be paired with a finding, so it is not one.
  test('a call with no model or no field is not a declaration', () => {
    write('api/x.ts', `defineBackfill({ name: 'a', field: 'x', fill: () => 1 })
defineBackfill({ name: 'b', model: 'Order', fill: () => 1 })`)
    expect(declaredBackfills(root)).toEqual([])
  })

  test('node_modules and dist are not the app', () => {
    write('api/node_modules/p/x.js', `defineBackfill({ name: 'v', model: 'Order', field: 'x', fill: () => 1 })`)
    write('api/dist/x.js',           `defineBackfill({ name: 'w', model: 'Order', field: 'x', fill: () => 1 })`)
    expect(declaredBackfills(root)).toEqual([])
  })

  test('an app with no backfills answers none rather than throwing', () => {
    expect(declaredBackfills(root)).toEqual([])
    expect(declaredBackfills(join(root, 'nowhere'))).toEqual([])
  })
})

// ─── grading findings against them ───────────────────────────────────────────

const need = (model, field) => ({ subject: `${model}.${field}`, needsBackfill: { model, field } })

describe('backfillReport', () => {
  test('a finding with no needsBackfill is not a row', () => {
    expect(backfillReport([{ subject: 'Order.total', severity: 'contract' }], [])).toEqual([])
  })

  test('missing where nothing declares that column', () => {
    const [row] = backfillReport([need('Order', 'shippedAt')], [])
    expect(row.status).toBe('missing')
  })

  test('declared where one names the same model and field', () => {
    const declared = [{ name: 'ship', model: 'Order', field: 'shippedAt', file: 'api/x.ts', line: 3 }]
    const [row] = backfillReport([need('Order', 'shippedAt')], declared)
    expect(row).toMatchObject({ status: 'declared', name: 'ship', file: 'api/x.ts', line: 3 })
  })

  // The same column on another model is another column. Matching on the field
  // alone would call a backfill for `Ticket.shippedAt` a plan for `Order`'s.
  test('a backfill for another model does not cover this one', () => {
    const declared = [{ name: 'ship', model: 'Ticket', field: 'shippedAt', file: 'api/x.ts', line: 3 }]
    expect(backfillReport([need('Order', 'shippedAt')], declared)[0].status).toBe('missing')
  })

  // Two findings can name one column — added-as-required and optional→required
  // are separate findings and the operator owes one backfill.
  test('one column is one row however many findings name it', () => {
    expect(backfillReport([need('Order', 'shippedAt'), need('Order', 'shippedAt')], [])).toHaveLength(1)
  })
})

// ─── what it prints ──────────────────────────────────────────────────────────

describe('formatBackfillReport', () => {
  test('nothing owed prints nothing at all', () => {
    expect(formatBackfillReport([])).toEqual([])
  })

  test('a declared one is named with its file, and no stub is offered', () => {
    const declared = [{ name: 'ship', model: 'Order', field: 'shippedAt', file: 'api/x.ts', line: 3 }]
    const text = formatBackfillReport(backfillReport([need('Order', 'shippedAt')], declared)).join('\n')
    expect(text).toContain('✓')
    expect(text).toContain('api/x.ts:3')
    expect(text).not.toContain('defineBackfill({')
  })

  test('a missing one is offered the smallest thing that can be pasted', () => {
    const text = formatBackfillReport(backfillReport([need('Order', 'shippedAt')], [])).join('\n')
    expect(text).toContain('✗')
    expect(text).toContain("model: 'Order'")
    expect(text).toContain("field: 'shippedAt'")
  })

  // What this command cannot see, said rather than implied: it reads source and
  // has no target, so *declared* is not *finished*.
  test('it says where finished is asked, because it cannot answer that', () => {
    const text = formatBackfillReport(backfillReport([need('Order', 'shippedAt')], [])).join('\n')
    expect(text).toContain('app.backfills.status()')
  })
})

describe('stubFor', () => {
  test('the name is kebab and the import is the one that exports it', () => {
    const text = stubFor({ model: 'Order', field: 'shippedAt' }).join('\n')
    expect(text).toContain("name:  'order-shipped-at'")
    expect(text).toContain("from '@frontierjs/junction'")
    expect(text).toContain('backfills([orderShippedAt])')
  })
})
