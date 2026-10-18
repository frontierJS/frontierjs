// test/loader-stack.test.ts
//
// `FJS-2115`. A service or route file that threw while loading was reported by
// its message alone, so "Object.entries requires that input parameter not be
// null or undefined" named no frame and finding the line meant calling the
// factory by hand. The finding carries the stack.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceRegistry } from '../src/core/service.ts'
import { autoloadServices, autoloadRoutes } from '../src/core/loader.ts'

const THROWER = `function explodeHere() { throw new Error('boom') }\nexplodeHere()\nexport default {}\n`

describe('a file that threw while loading is reported with its stack', () => {
  test('a service file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-2115-'))
    writeFileSync(join(dir, 'thrower.service.ts'), THROWER)
    const found: string[] = []
    await autoloadServices({ dir, registry: new ServiceRegistry(), report: (_k, f) => found.push(f) })
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('boom')
    expect(found[0]).toContain('explodeHere')
  })

  test('a route file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-2115-'))
    writeFileSync(join(dir, 'thrower.ts'), THROWER)
    const found: string[] = []
    await autoloadRoutes({ dir, app: {} as never, report: (_k, f) => found.push(f) })
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('boom')
    expect(found[0]).toContain('explodeHere')
  })
})
