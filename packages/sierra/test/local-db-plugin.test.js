/**
 * test/local-db-plugin.test.js — what the build copies out of the app's
 * `@sqlite.org/sqlite-wasm`.
 *
 * The package's loader is 643 kB with its comments, and the shell precaches
 * every byte the build emits, so the copy minifies it (`FJS-2323`). What it may
 * not lose is `import.meta.url` — the loader finds its `.wasm` sibling by it.
 */

import { describe, test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { localDbPlugin, WASM_DIR } = await import('../src/build/local-db-plugin.js')

const LOADER = [
  '/* @preserve LICENSE for the sqlite3 WebAssembly/JavaScript APIs. */',
  'export async function initSqlite(options = {}) {',
  '  // a comment the minifier drops, repeated so the source is visibly larger',
  ...Array.from({ length: 200 }, (_, i) => `  const someLongVariableName${i} = options.value${i} ?? ${i}`),
  '  const wasmUrl = new URL("sqlite3.wasm", import.meta.url)',
  '  return fetch(wasmUrl)',
  '}',
].join('\n')

function appWith(loader) {
  const root = mkdtempSync(join(tmpdir(), 'local-db-plugin-'))
  const dist = join(root, 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.mjs'), loader)
  writeFileSync(join(dist, 'sqlite3.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))
  return root
}

function build(root) {
  const plugin = localDbPlugin({ offline: { db: true } }, {})
  plugin.configResolved({ root })
  const out = join(root, 'dist')
  plugin.writeBundle({ dir: out })
  return join(out, WASM_DIR)
}

describe('the device database copy', () => {
  test('the loader is minified and still finds its wasm by import.meta.url', () => {
    const dir = build(appWith(LOADER))
    const copied = readFileSync(join(dir, 'index.js'), 'utf8')

    expect(copied.length).toBeLessThan(LOADER.length / 2)
    expect(copied).toContain('import.meta.url')
    expect(copied).toContain('sqlite3.wasm')
    expect(copied).toContain('LICENSE for the sqlite3')
    expect(readdirSync(dir).sort()).toEqual(['index.js', 'sqlite3.wasm'])
  })

  test('the wasm travels byte for byte', () => {
    const root = appWith(LOADER)
    const dir = build(root)
    expect(readFileSync(join(dir, 'sqlite3.wasm')))
      .toEqual(readFileSync(join(root, 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist', 'sqlite3.wasm')))
  })
})
