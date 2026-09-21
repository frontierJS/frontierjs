// core/app-schema.js — `shippedFile(root, pkg, subpath)`.
//
// The question is *is this file installed HERE*, and it is not the same
// question as *can this specifier be resolved from here*. Three install
// commands each answered it, two of them with
// `createRequire(app/package.json).resolve(specifier)` — which bun answers out
// of its GLOBAL install cache for a package the app does not have, so what got
// appended to an app's schema was whatever version happened to be cached
// (FJS-666's shape). These rows are that difference, stated.

import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir }                                                     from 'node:os'
import { join }                                                       from 'node:path'
import { shippedFile }                                                from '../core/app-schema.js'

const roots = []
const app = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'fli-shipped-'))
  roots.push(dir)
  for (const [path, body] of Object.entries(files)) {
    const file = join(dir, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body, 'utf8')
  }
  return dir
}
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }) })

const PKG      = '@acme/kit'
const manifest = (exports) => JSON.stringify({ name: PKG, exports })

describe('shippedFile', () => {
  test('reads the file the package’s own exports map names', () => {
    const root = app({
      'package.json':                                 JSON.stringify({ name: 'app' }),
      'node_modules/@acme/kit/package.json':          manifest({ './schema.lite': './db/kit.lite' }),
      'node_modules/@acme/kit/db/kit.lite':           'model Token {\n  id Int @id\n}\n',
    })
    const found = shippedFile(root, PKG, './schema.lite')
    expect(found.text).toContain('model Token')
    expect(found.file).toContain('db/kit.lite')
  })

  test('a package that is not installed here answers null, whatever a resolver would say', () => {
    // The row the extraction exists for. Nothing is under node_modules, and the
    // answer is null rather than a path into a global cache.
    const root = app({ 'package.json': JSON.stringify({ name: 'app', dependencies: { [PKG]: '*' } }) })
    expect(shippedFile(root, PKG, './schema.lite')).toBeNull()
  })

  test('a subpath the exports map does not declare is not guessed at', () => {
    const root = app({
      'package.json':                        JSON.stringify({ name: 'app' }),
      'node_modules/@acme/kit/package.json': manifest({ '.': './index.ts' }),
      'node_modules/@acme/kit/db/kit.lite':  'model Token {\n  id Int @id\n}\n',
    })
    // The file is right there. It is still not exported, so it is not shipped.
    expect(shippedFile(root, PKG, './schema.lite')).toBeNull()
  })

  test('an exported target that is not on disk is null rather than a path', () => {
    const root = app({
      'package.json':                        JSON.stringify({ name: 'app' }),
      'node_modules/@acme/kit/package.json': manifest({ './schema.lite': './db/kit.lite' }),
    })
    expect(shippedFile(root, PKG, './schema.lite')).toBeNull()
  })

  test('a conditional export is not a schema fragment', () => {
    // `{ import, require }` is how JavaScript is published. A `.lite` is a
    // plain string target, and reading the object form would hand a caller an
    // object where it expects a path.
    const root = app({
      'package.json':                        JSON.stringify({ name: 'app' }),
      'node_modules/@acme/kit/package.json': manifest({ './schema.lite': { import: './db/kit.lite' } }),
      'node_modules/@acme/kit/db/kit.lite':  'model Token {\n  id Int @id\n}\n',
    })
    expect(shippedFile(root, PKG, './schema.lite')).toBeNull()
  })

  test('a link:ed package is read through its symlink — the shape every app in this repo has', () => {
    const real = app({
      'package.json': manifest({ './schema.lite': './db/kit.lite' }),
      'db/kit.lite':  'model Token {\n  id Int @id\n}\n',
    })
    const root = app({ 'package.json': JSON.stringify({ name: 'app' }) })
    mkdirSync(join(root, 'node_modules', '@acme'), { recursive: true })
    symlinkSync(real, join(root, 'node_modules', PKG), 'dir')

    expect(shippedFile(root, PKG, './schema.lite').text).toContain('model Token')
  })

  test('a manifest that will not parse is null, not a throw', () => {
    const root = app({
      'package.json':                        JSON.stringify({ name: 'app' }),
      'node_modules/@acme/kit/package.json': '{ not json',
    })
    expect(shippedFile(root, PKG, './schema.lite')).toBeNull()
  })
})
