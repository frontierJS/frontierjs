import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { writeFileSync, rmSync, mkdirSync } from 'fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')

// Use a fresh tmp dir for each test so tests don't share .fli.json state
const TMP = resolve(ROOT, '.tmp-config-test')

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  global.projectRoot = TMP
  // Reset global config between tests
  delete global.fliConfig
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  global.projectRoot = ROOT
  delete global.fliConfig
})

import { loadConfig, getConfig } from '../core/config.js'

// ─── loadConfig ───────────────────────────────────────────────────────────────

describe('loadConfig', () => {

  test('returns defaults when no .fli.json exists', () => {
    const cfg = loadConfig()
    expect(cfg.routesDir).toBe('cli/src/routes')
    expect(cfg.defaultNamespace).toBe('hello')
    expect(cfg.editor).toBe('')
  })

  test('merges user values with defaults', () => {
    writeFileSync(resolve(TMP, '.fli.json'), JSON.stringify({
      routesDir: 'src/commands',
      editor:    'code',
    }))
    const cfg = loadConfig()
    expect(cfg.routesDir).toBe('src/commands')
    expect(cfg.editor).toBe('code')
    // defaultNamespace not overridden — should still be default
    expect(cfg.defaultNamespace).toBe('hello')
  })

  test('partial config — unspecified keys stay as defaults', () => {
    writeFileSync(resolve(TMP, '.fli.json'), JSON.stringify({
      defaultNamespace: 'myapp',
    }))
    const cfg = loadConfig()
    expect(cfg.defaultNamespace).toBe('myapp')
    expect(cfg.routesDir).toBe('cli/src/routes')
    expect(cfg.editor).toBe('')
  })

  test('malformed .fli.json — warns and uses defaults (does not throw)', () => {
    writeFileSync(resolve(TMP, '.fli.json'), '{ not valid json !!!')
    expect(() => loadConfig()).not.toThrow()
    const cfg = loadConfig()
    expect(cfg.routesDir).toBe('cli/src/routes')
  })

  test('sets global.fliConfig', () => {
    delete global.fliConfig
    loadConfig()
    expect(global.fliConfig).toBeDefined()
    expect(global.fliConfig.routesDir).toBe('cli/src/routes')
  })

  test('returns the config object', () => {
    const result = loadConfig()
    expect(typeof result).toBe('object')
    expect(result).toBe(global.fliConfig)
  })

})

// ─── getConfig ────────────────────────────────────────────────────────────────

describe('getConfig', () => {

  test('returns global.fliConfig when available', () => {
    global.fliConfig = { routesDir: 'custom/path', defaultNamespace: 'ns', editor: 'vim' }
    expect(getConfig().routesDir).toBe('custom/path')
  })

  test('falls back to defaults when global.fliConfig is not set', () => {
    delete global.fliConfig
    const cfg = getConfig()
    expect(cfg.routesDir).toBe('cli/src/routes')
    expect(cfg.defaultNamespace).toBe('hello')
  })

})
