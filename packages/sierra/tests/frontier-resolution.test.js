/**
 * tests/frontier-resolution.test.js
 *
 * Sierra's source lives outside the consuming app, so when Vite follows the
 * symlink it transforms Sierra's *real* path — which has no node_modules of its
 * own. Node's resolution can't help from there, so virtual-sierra.js resolves
 * `@frontierjs/*` imports against sibling packages instead.
 *
 * That fallback used to guess file paths:
 *
 *   <pkg>/client.ts   <pkg>/client.js   <pkg>/client/index.ts   <pkg>/client/index.js
 *
 * none of which match Junction, whose real file is `<pkg>/src/client/index.ts`
 * declared in its exports map as `"./client": "./src/client/index.ts"`. The miss
 * was invisible whenever the app happened to have its own node_modules entry for
 * the package — Vite would pick it up after Sierra's hook returned undefined —
 * and surfaced as
 *
 *   Failed to resolve import "@frontierjs/junction/client"
 *     from ".../packages/sierra/src/junction/index.js"
 *
 * under `bun link`, or in a `repo/packages/*` monorepo.
 *
 * The resolver now reads the target package's exports map. These tests cover the
 * export shapes the four framework packages actually use.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _resolveFrontierSubpathForTest as resolveSub } from '../src/virtual/virtual-sierra.js'

// ─── Fixture packages ─────────────────────────────────────────────────────────
// Laid out as siblings of the sierra package, which is what _monoRoot points at.

let root

function pkg(name, manifest, files) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const f of files) {
    const abs = join(dir, f)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, '// fixture\n')
  }
  return dir
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'frontier-res-'))

  // Junction's real shape: subpath exports pointing into src/
  pkg('junction', {
    name: '@frontierjs/junction',
    exports: {
      '.': './index.ts',
      './client': './src/client/index.ts',
      './errors': './src/core/errors.ts',
    },
  }, ['index.ts', 'src/client/index.ts', 'src/core/errors.ts'])

  // Mesa's shape: conditions objects, import-only
  pkg('mesa', {
    name: '@frontierjs/mesa',
    main: './compiler.js',
    exports: {
      '.':            { import: './compiler.js' },
      './runtime':    { import: './runtime.js' },
      './runtime.js': { import: './runtime.js' },
    },
  }, ['compiler.js', 'runtime.js'])

  // A package with no exports map at all — path guessing must still work
  pkg('legacy', { name: '@frontierjs/legacy', main: './src/index.js' },
      ['src/index.js', 'src/thing.js'])

  // Wildcard subpaths
  pkg('wild', {
    name: '@frontierjs/wild',
    exports: { './*': './src/*.js' },
  }, ['src/alpha.js', 'src/beta.js'])
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const resolve_ = (id) => resolveSub(id, [root])

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('exports-map resolution', () => {
  test('resolves a subpath that points into src/ — the case that was failing', () => {
    expect(resolve_('@frontierjs/junction/client'))
      .toBe(join(root, 'junction/src/client/index.ts'))
  })

  test('resolves other declared subpaths', () => {
    expect(resolve_('@frontierjs/junction/errors'))
      .toBe(join(root, 'junction/src/core/errors.ts'))
  })

  test('resolves the bare package specifier', () => {
    expect(resolve_('@frontierjs/junction')).toBe(join(root, 'junction/index.ts'))
  })

  test('unwraps a conditions object', () => {
    expect(resolve_('@frontierjs/mesa/runtime')).toBe(join(root, 'mesa/runtime.js'))
    expect(resolve_('@frontierjs/mesa')).toBe(join(root, 'mesa/compiler.js'))
  })

  test('handles a subpath spelled with its extension', () => {
    expect(resolve_('@frontierjs/mesa/runtime.js')).toBe(join(root, 'mesa/runtime.js'))
  })

  test('expands wildcard subpaths', () => {
    expect(resolve_('@frontierjs/wild/alpha')).toBe(join(root, 'wild/src/alpha.js'))
    expect(resolve_('@frontierjs/wild/beta')).toBe(join(root, 'wild/src/beta.js'))
  })
})

describe('fallbacks', () => {
  test('falls back to main when there is no exports map', () => {
    expect(resolve_('@frontierjs/legacy')).toBe(join(root, 'legacy/src/index.js'))
  })

  test('falls back to path guessing, including under src/', () => {
    expect(resolve_('@frontierjs/legacy/thing')).toBe(join(root, 'legacy/src/thing.js'))
  })

  test('returns null for an unknown package', () => {
    expect(resolve_('@frontierjs/nope/client')).toBeNull()
  })

  test('returns null for a subpath the package does not declare or contain', () => {
    expect(resolve_('@frontierjs/junction/not-a-thing')).toBeNull()
  })

  test('does not resolve a declared export whose file is missing', () => {
    pkg('broken', {
      name: '@frontierjs/broken',
      exports: { './gone': './src/gone.ts' },
    }, [])
    expect(resolve_('@frontierjs/broken/gone')).toBeNull()
  })
})
