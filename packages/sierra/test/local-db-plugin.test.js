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

async function build(root) {
  const plugin = localDbPlugin({ offline: { db: true } }, {})
  plugin.configResolved({ root })
  const out = join(root, 'dist')
  await plugin.writeBundle({ dir: out })
  return join(out, WASM_DIR)
}

describe('the device database copy', () => {
  test('the loader is minified and still finds its wasm by import.meta.url', async () => {
    const dir = await build(appWith(LOADER))
    const copied = readFileSync(join(dir, 'index.js'), 'utf8')

    expect(copied.length).toBeLessThan(LOADER.length / 2)
    expect(copied).toContain('import.meta.url')
    expect(copied).toContain('sqlite3.wasm')
    expect(copied).toContain('LICENSE for the sqlite3')
    expect(readdirSync(dir).sort()).toEqual(['index.js', 'sqlite3.wasm'])
  })

  test('the wasm travels byte for byte', async () => {
    const root = appWith(LOADER)
    const dir = await build(root)
    expect(readFileSync(join(dir, 'sqlite3.wasm')))
      .toEqual(readFileSync(join(root, 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist', 'sqlite3.wasm')))
  })
})

// FJS-3439 — Haven's installed client has no vite; the terminal shell reaches
// this file through schema-plugin.js, so importing it must not need vite.
describe('a machine with no vite', () => {
  test('the plugin module imports, and the minify is the build that needs vite', async () => {
    const { spawnSync } = await import('child_process')
    const { pathToFileURL } = await import('url')
    const hooks = 'data:text/javascript,' + encodeURIComponent(
      `export async function resolve(s, c, next) {` +
      ` if (s === 'vite') throw new Error('Cannot find package vite'); return next(s, c) }`)
    const boot = 'data:text/javascript,' + encodeURIComponent(
      `import { register } from 'node:module'; register(${JSON.stringify(hooks)})`)
    const file = pathToFileURL(join(import.meta.dirname, '../src/build/schema-plugin.js')).href
    const r = spawnSync(process.execPath, ['--import', boot, '-e', `await import(${JSON.stringify(file)})`],
      { encoding: 'utf8', timeout: 30000 })
    expect(r.stderr).not.toContain('Cannot find package vite')
    expect(r.status).toBe(0)
  })
})
