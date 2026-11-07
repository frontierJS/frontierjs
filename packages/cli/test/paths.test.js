/*
 * test/paths.test.js
 *
 * `core/paths.js` is the one owner of a per-user root (FJS-D1990). Each root
 * reads its XDG variable per call, so a test points it at a temp dir; a suite
 * that read it at import would write into the developer's own home.
 */

import { describe, expect, test, afterEach } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { configDir, dataDir, cacheDir, stateDir, roots } from '../core/paths.js'

const VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
const saved = Object.fromEntries(VARS.map(v => [v, process.env[v]]))
afterEach(() => { for (const v of VARS) saved[v] === undefined ? delete process.env[v] : (process.env[v] = saved[v]) })

describe('paths', () => {
  test('each class follows its XDG variable, read per call', () => {
    process.env.XDG_CONFIG_HOME = '/x/c'; process.env.XDG_DATA_HOME = '/x/d'; process.env.XDG_CACHE_HOME = '/x/k'
    expect(roots()).toEqual({ config: '/x/c/fli', data: '/x/d/fli', cache: '/x/k/fli', state: join(homedir(), '.fli') })
    process.env.XDG_CACHE_HOME = '/y/k'
    expect(cacheDir()).toBe('/y/k/fli')
  })

  test('no variable falls back under the home, and state is always ~/.fli', () => {
    for (const v of VARS) delete process.env[v]
    expect(configDir()).toBe(join(homedir(), '.config', 'fli'))
    expect(dataDir()).toBe(join(homedir(), '.local', 'share', 'fli'))
    expect(cacheDir()).toBe(join(homedir(), '.cache', 'fli'))
    expect(stateDir()).toBe(join(homedir(), '.fli'))
  })

  test('a given home pins every root under it and ignores the variable', () => {
    process.env.XDG_CONFIG_HOME = '/x/c'
    expect(configDir({ home: '/h' })).toBe('/h/.config/fli')
    expect(stateDir({ home: '/h' })).toBe('/h/.fli')
  })
})
