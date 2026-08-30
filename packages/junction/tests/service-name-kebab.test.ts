// tests/service-name-kebab.test.ts
//
// `FJS-570`. A FrontierJS app names one model three ways and Invariant 2 says
// three resolvers depend on them agreeing. A kebab FILENAME was a fourth
// spelling nobody reconciled:
//
//   model ProductVariant             db/schema.lite
//   product-variants.service.ts   →  service 'product-variants'   (before)
//   db.productVariant                the Litestone accessor
//
// It broke two resolutions, not one. `deriveModelName('product-variants')`
// singularises to `product-variant`, which is not the accessor — which is why
// all six multi-word services in `example` hand-write `model:` — and Sierra's
// `serviceNameFor('ProductVariant')` answers `productVariants`, which matched
// nothing. So every relation picker onto a multi-word model rendered, opened,
// and offered NOTHING, which a person reads as *there are no variants*.
//
// The file keeps its name; the service gets one spelling, and the filename's
// own spelling stays reachable as an alias so no URL moves.

import { describe, test, expect } from 'bun:test'
import { deriveName }             from '../src/core/loader.ts'
import { deriveModelName }        from '../src/core/litestone.ts'
import { createService, ServiceRegistry } from '../src/core/service.ts'

describe('deriveName', () => {
  test('a single-word filename is unchanged — every app that worked still does', () => {
    expect(deriveName('accounts.service.ts')).toBe('accounts')
    expect(deriveName('orders.service.js')).toBe('orders')
  })

  test('kebab and snake fold into the one spelling the other resolvers use', () => {
    expect(deriveName('product-variants.service.ts')).toBe('productVariants')
    expect(deriveName('notification-preferences.service.ts')).toBe('notificationPreferences')
    expect(deriveName('order_lines.service.ts')).toBe('orderLines')
    expect(deriveName('a-b-c.service.ts')).toBe('aBC')
  })

  test('and the derived name now resolves the model, which is the half nobody could see', () => {
    // Before: 'product-variants' → 'product-variant', not an accessor, so the
    // service had to state `model:` by hand. Six files in `example` do.
    expect(deriveModelName('product-variants')).not.toBe('productVariant')
    expect(deriveModelName(deriveName('product-variants.service.ts'))).toBe('productVariant')
  })
})

describe('the registry answers to the older spelling', () => {
  const registry = new ServiceRegistry()
  const svc = createService({ name: 'productVariants', model: 'ProductVariant',
    find: async () => [] })
  registry.register(svc, ['product-variants'])

  test('the canonical name is the one it HAS', () => {
    expect(registry.get('productVariants')).toBe(svc)
    expect(registry.list()).toEqual(['productVariants'])
    expect(registry.aliasesOf('productVariants')).toEqual(['product-variants'])
  })

  test('the alias resolves — a URL, an app.service() and a WS frame all go through get()', () => {
    expect(registry.get('product-variants')).toBe(svc)
    expect(registry.has('product-variants')).toBe(true)
  })

  test('a name nobody registered is still nothing', () => {
    expect(registry.get('productVariant')).toBeUndefined()
    expect(registry.has('nope')).toBe(false)
  })

  test('an alias never shadows a real service', () => {
    const r = new ServiceRegistry()
    const real  = createService({ name: 'product-variants', find: async () => [] })
    const other = createService({ name: 'productVariants',  find: async () => [] })
    r.register(real)
    r.register(other, ['product-variants'])   // would collide — refused
    expect(r.get('product-variants')).toBe(real)
    expect(r.get('productVariants')).toBe(other)
  })

  test('list() is canonical names only, so a surface does not double-count', () => {
    expect(registry.list()).not.toContain('product-variants')
  })
})
