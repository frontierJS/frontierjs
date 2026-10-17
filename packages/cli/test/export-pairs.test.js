// export-pairs.test.js — `fli ws:exports` refuses a subpath spelled twice (FJS-2964).

import { describe, test, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { exportPairs, redundantOf } from '../core/export-pairs.js'

const PACKAGES = join(import.meta.dir, '../..')

describe('redundantOf', () => {
  test('a .mesa subpath keeps its extension and every other is bare', () => {
    expect(redundantOf(['./components/*.mesa', './components/*'])).toBe('./components/*')
    expect(redundantOf(['./runtime', './runtime.js'])).toBe('./runtime.js')
  })
})

describe('exportPairs', () => {
  test('names a subpath spelled with and without its extension', () => {
    const map = { './runtime': { import: './src/runtime.js' }, './runtime.js': { import: './src/runtime.js' } }
    expect(exportPairs(map)).toEqual([['./runtime', './runtime.js']])
  })

  test('names a wildcard pair', () => {
    expect(exportPairs({ './stores/*.js': './stores/*.js', './stores/*': './stores/*.js' }))
      .toEqual([['./stores/*.js', './stores/*']])
  })

  test('two keys reaching different files are not a pair', () => {
    expect(exportPairs({ './vocabulary.js': './vocabulary.js', './vocabulary.json': './vocabulary.json' })).toEqual([])
  })

  test('no package in the workspace declares a pair', () => {
    for (const name of readdirSync(PACKAGES)) {
      const file = join(PACKAGES, name, 'package.json')
      if (!existsSync(file)) continue
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      expect({ name, pairs: exportPairs(pkg.exports) }).toEqual({ name, pairs: [] })
    }
  })
})
