/**
 * tests/sierra-config-path.test.js — where `sierra.config.js` is looked for.
 *
 * `virtual:sierra` emits a literal `import` of whatever this resolves to, so a
 * wrong answer is a hard `Module not found` at build time. The old derivation was
 * a string rewrite of the Vite config path and assumed `vite.config.js` sat at the
 * Vite root; the convention is a dedicated `config/` folder, which that rewrite
 * turned into `config/config/sierra.config.js`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { resolveSierraConfigPath, virtualSierraPlugin } from '../src/virtual/virtual-sierra.js'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sierra-cfg-'))
  mkdirSync(join(root, 'config'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const write = (rel, body = 'export default {}') => {
  const abs = join(root, rel)
  writeFileSync(abs, body)
  return abs
}

describe('resolveSierraConfigPath', () => {
  test('finds sierra.config.js beside a vite.config.js in config/', () => {
    write('config/vite.config.js')
    const expected = write('config/sierra.config.js')

    expect(resolveSierraConfigPath({
      configFile: join(root, 'config/vite.config.js'),
      root,
    })).toBe(expected)
  })

  test('finds sierra.config.js in config/ from a root-level vite.config.js', () => {
    write('vite.config.js')
    const expected = write('config/sierra.config.js')

    expect(resolveSierraConfigPath({
      configFile: join(root, 'vite.config.js'),
      root,
    })).toBe(expected)
  })

  test('never derives config/config/ — the old rewrite bug', () => {
    write('config/vite.config.js')
    write('config/sierra.config.js')

    const hit = resolveSierraConfigPath({
      configFile: join(root, 'config/vite.config.js'),
      root,
    })
    expect(hit).not.toContain(join('config', 'config'))
  })

  test('falls back to the Vite root when there is no config/ dir', () => {
    rmSync(join(root, 'config'), { recursive: true })
    write('vite.config.js')
    const expected = write('sierra.config.js')

    expect(resolveSierraConfigPath({
      configFile: join(root, 'vite.config.js'),
      root,
    })).toBe(expected)
  })

  test('accepts .mjs and .ts', () => {
    write('config/vite.config.js')
    const expected = write('config/sierra.config.ts')

    expect(resolveSierraConfigPath({
      configFile: join(root, 'config/vite.config.js'),
      root,
    })).toBe(expected)
  })

  test('_configPath wins outright, without touching the disk', () => {
    write('config/sierra.config.js')
    const explicit = '/somewhere/else/sierra.config.js'

    expect(resolveSierraConfigPath({
      explicit,
      configFile: join(root, 'config/vite.config.js'),
      root,
    })).toBe(explicit)
  })

  test('works with no configFile at all (vite --root, inline config)', () => {
    const expected = write('config/sierra.config.js')
    expect(resolveSierraConfigPath({ root })).toBe(expected)
  })

  test('points at the conventional location when nothing exists', () => {
    expect(resolveSierraConfigPath({
      configFile: join(root, 'config/vite.config.js'),
      root,
    })).toBe(join(root, 'config', 'sierra.config.js'))
  })
})

describe('virtualSierraPlugin', () => {
  test('imports the config it found, from a config/ folder layout', async () => {
    write('config/vite.config.js')
    write('config/sierra.config.js')

    const plugin = virtualSierraPlugin({ target: 'spa' }, {})
    plugin.configResolved({ root, configFile: join(root, 'config/vite.config.js') })

    const code = await plugin.load('\0virtual:sierra')
    expect(code).toContain(`import sierraConfig from '${join(root, 'config/sierra.config.js')}'`)
    expect(code).not.toContain('config/config')
  })
})
