/*
 * test/breadcrumbs.test.ts — what a one-row answer offers next, against the real
 * fixture and the real projection.
 *
 * Every row is graded against `projectTools` at the same level rather than a
 * list typed in here, because the claim is that breadcrumbs NARROW the caller's
 * own tool list by the row and never add to it — a hand-written offered list
 * would pass that claim against a projection that had stopped agreeing.
 * Whether the plugin attaches them to a real call is `plugin.test.ts`; whether
 * a real app's rows produce the right ones is basecamp's `verify:cli`.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'
import { projectTools, schemaViews } from '../src/projection.ts'
import type { ServiceShape, Tool } from '../src/projection.ts'
import { breadcrumbsFor, describeBreadcrumbs, answersOneRow } from '../src/breadcrumbs.ts'

const parsed = parse(readFileSync(new URL('./fixtures/shop.lite', import.meta.url), 'utf8'))
if (parsed.errors?.length) throw new Error(`fixture does not parse: ${JSON.stringify(parsed.errors)}`)
const VIEWS = schemaViews(parsed.schema, generateJsonSchema as never)

const SERVICES: ServiceShape[] = [
  { name: 'orders',    model: 'Order',    methods: ['find', 'get', 'create', 'patch', 'pay', 'ship', 'refund', 'lapse'] },
  { name: 'customers', model: 'Customer', methods: ['find', 'get'] },
]

const at = (level: number) => {
  const offered = projectTools(SERVICES, VIEWS, level).tools
  const tool    = (name: string) => offered.find(t => t.name === name) as Tool
  const crumbs  = (name: string, row: unknown, args: Record<string, unknown> = {}) =>
    breadcrumbsFor(tool(name), row, args, offered, VIEWS.full as never)
  return { offered, tool, crumbs }
}

const ORDER = { id: 7, reference: 'ORD-7', total: 100, note: null, customerId: 3 }
const names = (cs: Array<{ tool: string }>) => cs.map(c => c.tool).sort()

describe('the moves a row allows', () => {

  test('are the moves whose from holds the row\'s value — a pending order is paid or lapsed, never shipped', () => {
    const moves = at(4).crumbs('orders_get', { ...ORDER, status: 'pending' }, { id: 7 }).filter(c => c.kind === 'move')
    expect(names(moves)).toEqual(['orders_lapse', 'orders_pay'])
    expect(moves.find(m => m.tool === 'orders_pay')).toMatchObject({ args: { id: 7 }, field: 'status', to: 'paid' })
  })

  test('and only those the caller is offered — refund needs 5, so a paid order offers it to staff and not to a user', () => {
    const paid = { ...ORDER, status: 'paid' }
    expect(names(at(4).crumbs('orders_get', paid, { id: 7 }).filter(c => c.kind === 'move'))).toEqual(['orders_ship'])
    expect(names(at(5).crumbs('orders_get', paid, { id: 7 }).filter(c => c.kind === 'move'))).toEqual(['orders_refund', 'orders_ship'])
  })

  test('a move answers the moved row, and its breadcrumbs are the moves from where it landed', () => {
    const shipped = at(5).crumbs('orders_pay', { ...ORDER, status: 'shipped' }, { id: 7 })
    expect(shipped.filter(c => c.kind === 'move')).toEqual([])
  })

  test('a create is given no id, so the moves take the row\'s own', () => {
    const made = at(4).crumbs('orders_create', { ...ORDER, id: 9, status: 'pending' })
    expect(made.filter(c => c.kind === 'move').every(c => (c.args as { id: unknown }).id === 9)).toBe(true)
  })
})

describe('the rows it points at, and the rows pointing at it', () => {

  test('a foreign key names the row its get reads', () => {
    const rel = at(4).crumbs('orders_get', { ...ORDER, status: 'shipped' }, { id: 7 }).filter(c => c.kind === 'belongsTo')
    expect(rel).toEqual([{ kind: 'belongsTo', tool: 'customers_get', args: { id: 3 }, relation: 'customer' }])
  })

  test('an unset foreign key names nothing', () => {
    expect(at(4).crumbs('orders_get', { ...ORDER, status: 'shipped', customerId: null }, { id: 7 })
      .filter(c => c.kind === 'belongsTo')).toEqual([])
  })

  test('and a target the caller may not read is not offered — Customer reads at 4', () => {
    const offered = at(1)
    expect(offered.offered.some(t => t.name === 'customers_get')).toBe(false)
    expect(offered.crumbs('orders_get', { ...ORDER, status: 'shipped' }, { id: 7 }).filter(c => c.kind === 'belongsTo')).toEqual([])
  })

  test('the other side\'s foreign key is the find that lists the rows naming this one', () => {
    expect(at(4).crumbs('customers_get', { id: 3, name: 'Ada' }, { id: 3 }))
      .toEqual([{ kind: 'hasMany', tool: 'orders_find', args: { query: { customerId: 3 } }, relation: 'orders' }])
  })

  test('two foreign keys back to this model cannot be told apart, so neither is offered', () => {
    // A buyer and a seller on one order. The generator is not asked for the
    // second key — the rule is what is under test, over the real first one.
    const defs  = structuredClone(VIEWS.full) as Record<string, any>
    const buyer = defs.Order['x-relations'].find((r: { field: string }) => r.field === 'customer')
    defs.Order['x-relations'].push({ ...buyer, field: 'seller', fields: ['sellerId'] })
    const offered = projectTools(SERVICES, VIEWS, 4).tools
    const get     = offered.find(t => t.name === 'customers_get')!
    expect(breadcrumbsFor(get, { id: 3, name: 'Ada' }, { id: 3 }, offered, defs as never)).toEqual([])
  })
})

describe('what gets breadcrumbs at all', () => {

  test('a find, a custom method and a service over no model answer no one row', () => {
    const custom = { name: 'x_y', service: 'x', method: 'y', model: 'Order', kind: 'custom' } as Tool
    expect(answersOneRow(at(4).tool('orders_find'))).toBe(false)
    expect(answersOneRow(custom)).toBe(false)
    expect(answersOneRow({ ...custom, kind: 'crud', method: 'get', model: null })).toBe(false)
    expect(at(4).crumbs('orders_find', { data: [ORDER] })).toEqual([])
  })

  test('every breadcrumb names a tool in the caller\'s own list, at every level', () => {
    for (const level of [0, 1, 4, 5, 8]) {
      const a = at(level)
      if (!a.tool('orders_get')) continue
      for (const status of ['pending', 'paid', 'shipped', 'refunded', 'cancelled']) {
        for (const c of a.crumbs('orders_get', { ...ORDER, status }, { id: 7 }))
          expect(a.offered.map(t => t.name)).toContain(c.tool)
      }
    }
  })

  test('the text an agent reads names each call with its arguments', () => {
    const text = describeBreadcrumbs(at(5).crumbs('orders_get', { ...ORDER, status: 'paid' }, { id: 7 }))
    expect(text).toMatch(/^Next, at your standing:/)
    expect(text).toContain('orders_refund {"id":7} — refund: status → refunded')
    expect(text).toContain('customers_get {"id":3} — the customer this row points at')
  })
})
