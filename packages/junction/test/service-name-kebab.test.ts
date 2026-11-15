// test/service-name-kebab.test.ts
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
// singularizes to `product-variant`, which is not the accessor — which is why
// all six multi-word services in `example` hand-write `model:` — and Sierra's
// `serviceNameFor('ProductVariant')` answers `productVariants`, which matched
// nothing. So every relation picker onto a multi-word model rendered, opened,
// and offered NOTHING, which a person reads as *there are no variants*.
//
// The file keeps its name and the service gets one spelling. The filename's
// own spelling is not mounted (`FJS-D1317`): a service answers to one name.

import { describe, test, expect } from 'bun:test'
import { deriveName }             from '../src/core/loader.ts'
import { deriveModelName }        from '../src/core/litestone.ts'
import { ServiceRegistry, buildService } from '../src/core/service.ts'

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

describe('a service answers to one name (FJS-D1317)', () => {
  const registry = new ServiceRegistry()
  const svc = registry.register({ name: 'productVariants', model: 'ProductVariant',
    find: async () => [] })

  test('the canonical name is the one it HAS', () => {
    expect(registry.get('productVariants')).toBe(svc)
    expect(registry.list()).toEqual(['productVariants'])
  })

  test('the kebab spelling is refused — a URL, an app.service() and a WS frame all go through get()', () => {
    expect(registry.get('product-variants')).toBeUndefined()
    expect(registry.has('product-variants')).toBe(false)
  })

  test('a name nobody registered is still nothing', () => {
    expect(registry.get('productVariant')).toBeUndefined()
    expect(registry.has('nope')).toBe(false)
  })
})

describe('the loader mounts the folded name only', () => {
  const load = async (file: string, name?: string) => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir }                     = await import('node:os')
    const { join }                       = await import('node:path')
    const { autoloadServices }           = await import('../src/core/loader.ts')
    const dir = mkdtempSync(join(tmpdir(), 'fjs-2960-'))
    writeFileSync(join(dir, file),
      `export default { ${name ? `name: '${name}', ` : ''}find: async () => [] }\n`)
    const registry = new ServiceRegistry()
    await autoloadServices({ dir, registry })
    return registry
  }

  test('a kebab file with no name: answers to the camelCase name and not to its stem', async () => {
    const r = await load('product-variants.service.ts')
    expect(r.list()).toEqual(['productVariants'])
    expect(r.has('product-variants')).toBe(false)
  })

  test('a file declaring a different word does not answer to its stem', async () => {
    const r = await load('metrics.service.ts', 'metrics-store')
    expect(r.list()).toEqual(['metricsStore'])
    expect(r.has('metrics')).toBe(false)
  })

  // `FJS-3477`: a stated kebab name kept its spelling, so sierra's
  // `serviceNameFor('BackupDestination')` found nothing and the picker was empty.
  test('a STATED kebab name folds like a filename, and its kebab spelling is refused', async () => {
    const r = await load('backup-destinations.service.ts', 'backup-destinations')
    expect(r.list()).toEqual(['backupDestinations'])
    expect(r.has('backup-destinations')).toBe(false)
  })
})

describe('a definition registered by hand folds the same way', () => {
  test('its canonical name is camelCase, and the stated spelling is refused', () => {
    const r   = new ServiceRegistry()
    const svc = r.register({ name: 'backup-destinations', find: async () => [] })
    expect(svc.name).toBe('backupDestinations')
    expect(r.get('backupDestinations')).toBe(svc)
    expect(r.get('backup-destinations')).toBeUndefined()
  })
})
