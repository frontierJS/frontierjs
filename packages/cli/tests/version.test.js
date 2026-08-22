// version.test.js — fli must report the version it actually IS.
//
// The banner used to carry a literal, so every published build after 0.1.0
// told a stranger it was 0.1.0 — and `fli --version` fell through to the usage
// screen, which is the one place someone filing a bug looks.

import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')
const PKG   = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

const fli = (...args) =>
  spawnSync(process.execPath, [resolve(ROOT, 'bin/fli.js'), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
  }).stdout

describe('fliVersion', () => {

  test('reads the installed package.json', async () => {
    global.fliRoot = ROOT
    const { fliVersion } = await import('../core/utils.js')
    expect(fliVersion()).toBe(PKG.version)
  })

  test('answers null rather than a literal when there is no package.json', async () => {
    const { fliVersion } = await import('../core/utils.js')
    expect(fliVersion(resolve(ROOT, 'tests/fixtures/__nope__'))).toBe(null)
  })

})

describe('--version', () => {

  test('prints the version and nothing else', () => {
    expect(fli('--version').trim()).toBe(PKG.version)
  })

  test('-v is the same', () => {
    expect(fli('-v').trim()).toBe(PKG.version)
  })

  test('the usage screen carries the real version', () => {
    expect(fli()).toContain(`v${PKG.version}`)
  })

  test('the list banner carries the real version', () => {
    expect(fli('list')).toContain(`v${PKG.version}`)
  })

})
