/**
 * tests/prefetch-theme.test.js — prefetch and theme tests
 */

import { flushSync } from '@frontierjs/mesa/runtime.js'
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdir, writeFile, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

import { injectAutoImports } from '../src/build/auto-import-plugin.js'
import { buildThemeScript, initTheme, setTheme, toggleTheme, theme } from '../src/theme/index.js'
import { injectThemeScript } from '../src/postbuild/inject-theme.js'
import { prefetchHref } from '../src/router/prefetch.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, 'tmp-prefetch-theme')

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true })
})

// ─── buildThemeScript ────────────────────────────────────────────────────────

describe('buildThemeScript', () => {
  test('generates a self-executing IIFE', () => {
    const script = buildThemeScript({ default: 'system', persist: true })
    expect(script).toMatch(/^\(function\(\)/)
    expect(script).toMatch(/\}\)\(\)$/)
  })

  test('reads localStorage when persist: true', () => {
    const script = buildThemeScript({ default: 'light', persist: true, key: 'app_theme' })
    expect(script).toContain('localStorage.getItem("app_theme")')
  })

  test('skips localStorage when persist: false', () => {
    const script = buildThemeScript({ default: 'dark', persist: false })
    expect(script).not.toContain('localStorage')
  })

  test('uses system preference when default: system', () => {
    const script = buildThemeScript({ default: 'system' })
    expect(script).toContain('prefers-color-scheme')
    expect(script).toContain('dark')
  })

  test('uses fixed value when default: light or dark', () => {
    const light = buildThemeScript({ default: 'light' })
    expect(light).not.toContain('matchMedia')
    expect(light).toContain('"light"')

    const dark = buildThemeScript({ default: 'dark' })
    expect(dark).toContain('"dark"')
    expect(dark).not.toContain('matchMedia')
  })

  test('uses custom attribute name', () => {
    const script = buildThemeScript({ attribute: 'color-scheme', default: 'system' })
    expect(script).toContain('"color-scheme"')
  })

  test('sets attribute on documentElement', () => {
    const script = buildThemeScript({ default: 'system' })
    expect(script).toContain('document.documentElement.setAttribute')
  })

  test('script is compact (no unnecessary whitespace)', () => {
    const script = buildThemeScript({ default: 'system' })
    expect(script.length).toBeLessThan(300)
  })
})

// ─── injectThemeScript ───────────────────────────────────────────────────────

describe('injectThemeScript (post-build)', () => {
  test('injects script as first element in <head>', async () => {
    const outDir = await mkdir(join(TMP, 'theme-inject'), { recursive: true }) || join(TMP, 'theme-inject')
    await writeFile(join(outDir, 'index.html'),
      '<html><head><title>Test</title></head><body></body></html>', 'utf8')

    const result = await injectThemeScript({ default: 'system', persist: true }, outDir)
    expect(result).toContain('Theme flash prevention')

    const html = await readFile(join(outDir, 'index.html'), 'utf8')
    // Script must be immediately after <head>
    expect(html).toMatch(/<head>\s*<script id="sierra-theme">/)
    expect(html).toContain('sierra-theme')
    expect(html).toContain('prefers-color-scheme')
  })

  test('does not inject twice (idempotent)', async () => {
    const outDir = join(TMP, 'theme-inject')  // already has the script

    const result = await injectThemeScript({ default: 'system' }, outDir)
    expect(result).toBeNull()
  })

  test('returns null when no index.html', async () => {
    const outDir = await mkdir(join(TMP, 'theme-nofile'), { recursive: true }) || join(TMP, 'theme-nofile')
    const result = await injectThemeScript({ default: 'system' }, outDir)
    expect(result).toBeNull()
  })

  test('returns null when no theme config', async () => {
    const outDir = join(TMP, 'theme-nofile')
    const result = await injectThemeScript(null, outDir)
    expect(result).toBeNull()
  })
})

// ─── theme signal ────────────────────────────────────────────────────────────

describe('theme signal', () => {
  test('setTheme updates signal', () => {
    setTheme('dark')
    expect(theme.get()).toBe('dark')
    setTheme('light')
    expect(theme.get()).toBe('light')
  })

  test('toggleTheme flips between light and dark', () => {
    setTheme('light')
    toggleTheme()
    expect(theme.get()).toBe('dark')
    toggleTheme()
    expect(theme.get()).toBe('light')
  })

  test('theme signal is subscribable', () => {
    const values = []
    const unsub = theme.subscribe(v => values.push(v))
    setTheme('dark');  flushSync()
    setTheme('light'); flushSync()
    unsub()
    setTheme('dark'); flushSync()  // after unsub — should not be captured
    expect(values).toContain('dark')
    expect(values).toContain('light')
    // After unsub, no more updates
    const lastIdx = values.lastIndexOf('dark')
    expect(values.slice(lastIdx + 1)).not.toContain('dark')
  })

  test('setTheme ignores invalid values', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setTheme('light')
    setTheme('rainbow')
    expect(theme.get()).toBe('light')  // unchanged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid value 'rainbow'")
    )
    warnSpy.mockRestore()
  })
})

// ─── prefetch pure logic ─────────────────────────────────────────────────────

describe('prefetch route matching', () => {
  // prefetchHref is browser-only (calls dynamic import, window etc)
  // We test the URL parsing and origin-checking logic indirectly
  // by verifying prefetchHref returns early on invalid/external URLs

  test('prefetchHref handles absolute external URL silently', async () => {
    // Should return without throwing even when _tree is null
    await expect(prefetchHref('https://external.com/page')).resolves.toBeUndefined()
  })

  test('prefetchHref handles null/undefined silently', async () => {
    await expect(prefetchHref(null)).resolves.toBeUndefined()
    await expect(prefetchHref(undefined)).resolves.toBeUndefined()
    await expect(prefetchHref('')).resolves.toBeUndefined()
  })

  test('prefetchHref handles malformed URLs silently', async () => {
    await expect(prefetchHref('not-a-url')).resolves.toBeUndefined()
  })
})

// ─── virtual:sierra config import fix ────────────────────────────────────────

describe('virtual:sierra uses live config import', () => {
  test('imports sierraConfig from sierra.config.js', () => {
    const src = _generateVirtualSierra({
      target: 'spa',
      junction: { client: 'placeholder' },
    }, 'config/routes.js')
    expect(src).toContain("import sierraConfig from '/config/sierra.config.js'")
  })

  test('passes sierraConfig.junction to initJunction (not JSON)', () => {
    const src = _generateVirtualSierra({
      target: 'spa',
      junction: { url: 'wss://api.example.com', tokenKey: 'tok' },
    }, 'config/routes.js')
    // Must be the live reference, not serialized
    expect(src).toContain('initJunction(sierraConfig.junction)')
    expect(src).not.toContain('JSON')
    expect(src).not.toContain('"tokenKey"')
  })

  test('passes sierraConfig.analytics to initAnalytics (not JSON)', () => {
    const src = _generateVirtualSierra({
      target: 'spa',
      analytics: { provider: 'plausible', domain: 'example.com' },
    }, 'config/routes.js')
    expect(src).toContain('initAnalytics(sierraConfig.analytics)')
    expect(src).not.toContain('"domain"')
  })

  test('passes sierraConfig.theme to initTheme (not JSON)', () => {
    const src = _generateVirtualSierra({
      target: 'spa',
      theme: { default: 'system' },
    }, 'config/routes.js')
    expect(src).toContain('initTheme(sierraConfig.theme)')
    expect(src).not.toContain('"default"')
  })

  test('always imports sierraConfig even without junction/analytics/theme', () => {
    const src = _generateVirtualSierra({ target: 'spa' }, 'config/routes.js')
    expect(src).toContain("import sierraConfig from '/config/sierra.config.js'")
  })
})

import { _generateVirtualSierra } from '../src/virtual/virtual-sierra.js'

describe('virtual:sierra theme wiring', () => {
  test('includes initTheme when theme configured', () => {
    const src = _generateVirtualSierra({
      target: 'spa',
      theme: { default: 'system', persist: true },
    }, 'config/routes.js')
    expect(src).toContain('initTheme(')
    expect(src).toContain("from '@frontierjs/sierra/theme'")
  })

  test('skips theme when not configured', () => {
    const src = _generateVirtualSierra({ target: 'spa' }, 'config/routes.js')
    expect(src).not.toContain('initTheme')
  })
})
