/**
 * test/virtual-sierra.test.js — what `virtual:sierra` hands the browser of the config.
 *
 * Three keys, by value (`FJS-D552`). It imported `sierra.config.js` whole to read
 * them, so the browser loaded everything the config imports: a post-build plugin
 * reading the disk with `node:fs` blanked every page of `vite dev`, with no
 * overlay (`FJS-1544`).
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

import { virtualSierraPlugin, _generateVirtualSierra } from '../src/virtual/virtual-sierra.js'
import { tmpDir } from './tmp.js'

let root

beforeEach(() => {
  root = tmpDir('sierra-virtual-')
  mkdirSync(join(root, 'src'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('virtual:sierra emits the browser keys by value', () => {
  test('never imports sierra.config.js', () => {
    const src = _generateVirtualSierra({
      target:    'spa',
      plugins:   [{ name: 'post-build' }],
      junction:  { url: 'wss://api.example.com', tokenKey: 'tok' },
      analytics: { provider: 'plausible', domain: 'example.com' },
      theme:     { default: 'system' },
    }, 'config/routes.js')
    expect(src).not.toContain('sierra.config')
    expect(src).not.toContain('sierraConfig')
    expect(src).toContain('initJunction({"url":"wss://api.example.com","tokenKey":"tok"})')
    expect(src).toContain('initAnalytics({"provider":"plausible","domain":"example.com"})')
    expect(src).toContain('initTheme({"default":"system"})')
  })

  test('a custom analytics provider is the one module it imports', () => {
    const src = _generateVirtualSierra({
      target:    'spa',
      analytics: { provider: '/src/analytics.js', trackLocalhost: false },
    }, 'config/routes.js')
    expect(src).toContain(`import * as analyticsProvider from "/src/analytics.js"`)
    expect(src).toContain('initAnalytics({ ...{"provider":"/src/analytics.js","trackLocalhost":false}, provider: analyticsProvider })')
  })
})

describe('virtualSierraPlugin', () => {
  test('refuses a function in a browser key, naming its path', () => {
    expect(() => virtualSierraPlugin({
      target:   'spa',
      junction: { url: '/', onConnect() {} },
    }, {})).toThrow(/junction\.onConnect/)
    expect(() => virtualSierraPlugin({
      target:    'spa',
      analytics: { provider: { init() {}, track() {} } },
    }, {})).toThrow(/analytics\.provider\.init/)
  })

  test('a function outside the three keys is not the browser\'s', () => {
    expect(() => virtualSierraPlugin({
      target:  'spa',
      plugins: [{ name: 'post-build', closeBundle() {} }],
      theme:   { default: 'light' },
    }, {})).not.toThrow()
  })

  test('imports a custom provider from the Vite root', async () => {
    writeFileSync(join(root, 'src/analytics.js'), 'export function track() {}')
    const plugin = virtualSierraPlugin({ target: 'spa', analytics: { provider: '/src/analytics.js' } }, {})
    plugin.configResolved({ root, command: 'serve' })
    const code = await plugin.load('\0virtual:sierra')
    expect(code).toContain(`import * as analyticsProvider from ${JSON.stringify(join(root, 'src/analytics.js'))}`)
  })

  test('refuses a provider module that is not there', () => {
    const plugin = virtualSierraPlugin({ target: 'spa', analytics: { provider: '/src/analytic.js' } }, {})
    expect(() => plugin.configResolved({ root, command: 'serve' })).toThrow(/analytics\.provider '\/src\/analytic\.js'/)
  })

  test('serves no virtual:sierra-config', () => {
    const plugin = virtualSierraPlugin({ target: 'spa' }, {})
    expect(plugin.resolveId('virtual:sierra-config')).toBeUndefined()
  })
})
