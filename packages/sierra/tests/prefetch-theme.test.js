/**
 * tests/prefetch-theme.test.js — prefetch and theme tests
 */

import {
  flushSync, watchPath, createEffect, setRenderEnvironment,
} from '@frontierjs/mesa/runtime.js'
import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdir, writeFile, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

import { injectAutoImports } from '../src/build/auto-import-plugin.js'
import { buildThemeScript, initTheme, setTheme, toggleTheme, themes, theme } from '../src/theme/index.js'
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
    const script = buildThemeScript({ default: 'theme-default', persist: true, key: 'app_theme' })
    expect(script).toContain('localStorage.getItem("app_theme")')
  })

  test('skips localStorage when persist: false', () => {
    const script = buildThemeScript({ default: 'theme-dark', persist: false })
    expect(script).not.toContain('localStorage')
  })

  test('uses system preference when default: system', () => {
    const script = buildThemeScript({ default: 'system' })
    expect(script).toContain('prefers-color-scheme')
    expect(script).toContain('"theme-dark"')
  })

  test('uses a fixed value when default names a theme', () => {
    const light = buildThemeScript({ default: 'theme-default' })
    expect(light).not.toContain('matchMedia')
    expect(light).toContain('"theme-default"')

    const dark = buildThemeScript({ default: 'theme-dark' })
    expect(dark).toContain('"theme-dark"')
    expect(dark).not.toContain('matchMedia')
  })

  // The class is what `@frontierjs/css` reads; the attribute is what this
  // module used to write and what nothing read. Both spellings are asserted
  // because the default changing back would be silent — an app would keep
  // building, keep serving, and stop being themed.
  test('applies a CLASS on documentElement by default', () => {
    const script = buildThemeScript({ default: 'system' })
    expect(script).toContain('document.documentElement')
    expect(script).toContain('classList.add')
    expect(script).not.toContain('setAttribute')
  })

  test('applies an attribute when asked, with a custom name', () => {
    const script = buildThemeScript({ apply: 'attribute', attribute: 'color-scheme', default: 'system' })
    expect(script).toContain('setAttribute("color-scheme"')
    expect(script).not.toContain('classList.add')
  })

  // The class it adds is the class it removes. Without the removal every
  // switch would stack a second theme onto the first, and which one wins is
  // then a question about stylesheet order rather than about the setting.
  test('removes the app\'s other themes before adding one', () => {
    const script = buildThemeScript({ themes: ['a', 'b', 'c'], default: 'a' })
    expect(script).toContain('classList.remove')
    expect(script).toContain('["a","b","c"]')
  })

  // A theme dropped from the config but still in somebody's localStorage is a
  // class with no stylesheet behind it, applied before paint, for ever.
  test('ignores a persisted theme the app no longer offers', () => {
    const script = buildThemeScript({ themes: ['theme-default', 'theme-dark'], default: 'theme-default' })
    expect(script).toContain('indexOf(s)>-1')
  })

  test('script is compact (no unnecessary whitespace)', () => {
    const script = buildThemeScript({ default: 'system' })
    expect(script.length).toBeLessThan(400)
  })

  // Two copies of a default is the shape that drifts, and script.js may not
  // import index.js — so the copies are compared here instead.
  test('its defaults are the module\'s defaults', () => {
    initTheme({})
    expect(buildThemeScript({})).toContain(JSON.stringify(themes()))
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

// ─── theme state ─────────────────────────────────────────────────────────────

describe('theme state', () => {
  // Every test here boots the module first: `initTheme` is what turns the
  // config into the list `setTheme` validates against, and a suite that skips
  // it is asserting against whatever the previous test left behind.
  beforeEach(() => initTheme({ themes: ['theme-default', 'theme-dark'], default: 'theme-default' }))

  test('setTheme updates the value', () => {
    setTheme('theme-dark')
    expect(theme.value).toBe('theme-dark')
    setTheme('theme-default')
    expect(theme.value).toBe('theme-default')
  })

  test('toggleTheme advances through the configured themes', () => {
    setTheme('theme-default')
    toggleTheme()
    expect(theme.value).toBe('theme-dark')
    toggleTheme()
    expect(theme.value).toBe('theme-default')
  })

  // With more than two, "the other one" is not a question the list can answer,
  // so it is a cycle — and it must wrap rather than stop at the end.
  test('and wraps, with more than two', () => {
    initTheme({ themes: ['a', 'b', 'c'], default: 'a' })
    // Set the start explicitly: `initTheme` resolves nothing without a window
    // (it is SSR-safe by design), so the value here is whatever ran last.
    setTheme('a')
    toggleTheme(); expect(theme.value).toBe('b')
    toggleTheme(); expect(theme.value).toBe('c')
    toggleTheme(); expect(theme.value).toBe('a')
  })

  // Which is the case above: with no theme resolved yet, "the next one" can
  // only be the first one. Stated so it is a decision rather than an
  // indexOf(-1) that happens to land somewhere sensible.
  test('toggleTheme from an unresolved value starts at the first', () => {
    initTheme({ themes: ['a', 'b', 'c'], default: 'a' })
    theme.value = 'not-a-theme'
    toggleTheme()
    expect(theme.value).toBe('a')
  })

  test('setTheme fires a theme.value path watch', () => {
    // `theme` is a plain object — there is no .subscribe(). A consumer declares
    // `$: theme.value`, which the compiler turns into watchPath plus a proxy
    // read. This is that, by hand. Path watching is a no-op with no DOM
    // (RULE 19), so the environment has to say browser first.
    setRenderEnvironment(true)
    const [watch] = watchPath(theme, 'value')
    let runs = 0
    const dispose = createEffect(() => { watch(); runs++ })
    flushSync()
    const before = runs

    setTheme(theme.value === 'theme-dark' ? 'theme-default' : 'theme-dark')
    flushSync()

    expect(runs).toBeGreaterThan(before)
    dispose()
  })

  // A name nobody declared has to be refused BY NAME. Returning quietly is the
  // failure that reads as a broken stylesheet rather than as a typo, and the
  // warning names the list so the fix is in the message.
  test('setTheme refuses a theme the app does not declare', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setTheme('theme-default')
    setTheme('rainbow')
    expect(theme.value).toBe('theme-default')  // unchanged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'rainbow'"))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('theme-default, theme-dark'))
    warnSpy.mockRestore()
  })

  // The old contract wrote an attribute and nothing else, and the two are
  // indistinguishable from inside the app — the symptom is a stylesheet that
  // silently stops matching.
  test('warns when a config names an attribute but not apply', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initTheme({ attribute: 'data-theme' })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("apply: 'attribute'"))
    warnSpy.mockRestore()
  })

  test('and does not warn when apply is stated', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initTheme({ attribute: 'data-theme', apply: 'attribute' })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test('themes() answers what the app declared, in order', () => {
    initTheme({ themes: ['theme-forest', 'theme-midnight'] })
    expect(themes()).toEqual(['theme-forest', 'theme-midnight'])
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
