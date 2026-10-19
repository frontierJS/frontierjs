// test/exports-map.test.ts
//
// FJS-2958. package.json exported fifteen internal modules the root already
// re-exports, so one import had two spellings, and index.ts named an `/email`
// subpath that never existed. A subpath is for what the root does not carry.

import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const index = readFileSync(join(ROOT, 'index.ts'), 'utf8')

// Modules the root re-exports AND whose subpath carries names the root does not
// — a consumer outside this package reaches those through the subpath alone.
const KEPT = new Set(['./litestone', './envelope', './testing'])

const reexported = new Set(
  [...index.matchAll(/from '\.\/([^']+)'/g)].map(m => m[1]),
)

describe('junction exports map', () => {
  test('no subpath mirrors a module the root already re-exports', () => {
    const mirrors = Object.entries<string>(pkg.exports)
      .filter(([key, file]) => key !== '.' && reexported.has(file.replace(/^\.\//, '')) && !KEPT.has(key))
      .map(([key]) => key)
    expect(mirrors).toEqual([])
  })

  test('every subpath index.ts names in prose exists', () => {
    const named = [...index.matchAll(/`(\/[a-z-]+)`/g)].map(m => '.' + m[1])
    expect(named.filter(key => !(key in pkg.exports))).toEqual([])
  })

  test('every export target is a file', () => {
    const missing = Object.values<string>(pkg.exports).filter(file => !existsSync(join(ROOT, file)))
    expect(missing).toEqual([])
  })
})
