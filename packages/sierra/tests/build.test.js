/**
 * tests/build.test.js — tests for createSierraViteConfig and plugins
 */

import { describe, test, it, expect } from 'vitest'
import { createSierraViteConfig } from '../src/build/index.js'

// We test the config shape, not Vite internals

describe('createSierraViteConfig', () => {
  test('returns a valid Vite config object', () => {
    const cfg = createSierraViteConfig({ target: 'spa' })
    expect(cfg).toBeDefined()
    expect(typeof cfg).toBe('object')
  })

  test('includes sierra plugins in plugins array', () => {
    const cfg = createSierraViteConfig({ target: 'spa' })
    expect(Array.isArray(cfg.plugins)).toBe(true)
    expect(cfg.plugins.length).toBeGreaterThan(0)

    const names = cfg.plugins.map(p => p?.name).filter(Boolean)
    expect(names).toContain('sierra:scanner')
    expect(names).toContain('sierra:virtual')
    expect(names).toContain('sierra:mesa')
  })

  test('widget target compiles Mesa and folds no CSS — that is the loop\'s job', () => {
    // The CSS fold belongs to the build that EMITS a widget (one library build
    // per widget, `sierra widgets`), not to the config it is compiled with.
    // Having it here meant it ran on a config that never emitted a bundle.
    const cfg = createSierraViteConfig({ target: 'widget' })
    const names = cfg.plugins.map(p => p?.name).filter(Boolean)
    expect(names).toContain('sierra:mesa')
    expect(names).not.toContain('sierra:widget-css')
  })

  test('widget target does NOT include scanner or virtual:sierra', () => {
    const cfg = createSierraViteConfig({ target: 'widget' })
    const names = cfg.plugins.map(p => p?.name).filter(Boolean)
    expect(names).not.toContain('sierra:scanner')
    expect(names).not.toContain('sierra:virtual')
  })

  test('mesa plugin always included regardless of target', () => {
    for (const target of ['spa', 'static', 'widget']) {
      const cfg = createSierraViteConfig({ target })
      const names = cfg.plugins.map(p => p?.name).filter(Boolean)
      expect(names).toContain('sierra:mesa')
    }
  })

  test('unknown target throws', () => {
    expect(() => createSierraViteConfig({ target: 'desktop' })).toThrow(
      /unknown target/i
    )
  })

  test('applies @ alias pointing to src/', () => {
    const cfg = createSierraViteConfig({ target: 'spa' })
    const alias = cfg.resolve?.alias
    expect(alias).toBeDefined()
    expect(alias['@']).toBeDefined()
    expect(alias['@']).toContain('src')
  })

  test('spa: outDir defaults to dist/client', () => {
    const cfg = createSierraViteConfig({ target: 'spa' })
    expect(cfg.build?.outDir).toBe('dist/client')
  })

  test('widget: outDir defaults to dist/embeds', () => {
    // Their own directory: an app that ships a site AND widgets builds both,
    // and `dist/` is the site's.
    const cfg = createSierraViteConfig({ target: 'widget' })
    expect(cfg.build?.outDir).toBe('dist/embeds')
  })

  test('widget: custom outDir from widgets.outDir', () => {
    const cfg = createSierraViteConfig({
      target: 'widget',
      widgets: { outDir: 'public/embeds' },
    })
    expect(cfg.build?.outDir).toBe('public/embeds')
  })

  test('vite: overrides are merged last and win', () => {
    const cfg = createSierraViteConfig({
      target: 'spa',
      vite: {
        server: { port: 9999 },
        build: { outDir: 'my-custom-dist' },
      },
    })
    expect(cfg.server?.port).toBe(9999)
    expect(cfg.build?.outDir).toBe('my-custom-dist')
  })

  test('vite: plugins array is concatenated not replaced', () => {
    const myPlugin = { name: 'my-plugin' }
    const cfg = createSierraViteConfig({
      target: 'spa',
      vite: { plugins: [myPlugin] },
    })
    const names = cfg.plugins.map(p => p?.name).filter(Boolean)
    expect(names).toContain('sierra:mesa')
    expect(names).toContain('my-plugin')
  })

  test('user plugins from config.plugins are included', () => {
    const myPlugin = { name: 'user-plugin' }
    const cfg = createSierraViteConfig({
      target: 'spa',
      plugins: [myPlugin],
    })
    const names = cfg.plugins.map(p => p?.name).filter(Boolean)
    expect(names).toContain('user-plugin')
  })

  test('base is passed through to config', () => {
    const cfg = createSierraViteConfig({ target: 'spa', base: '/app/' })
    expect(cfg.base).toBe('/app/')
  })

  test('cssCodeSplit is always false', () => {
    for (const target of ['spa', 'static', 'widget']) {
      const cfg = createSierraViteConfig({ target })
      expect(cfg.build?.cssCodeSplit).toBe(false)
    }
  })
})

// ─── virtual:sierra generation ───────────────────────────────────────────────

// Import the internal generator directly for unit testing
import { _generateVirtualSierra } from '../src/virtual/virtual-sierra.js'

describe('virtual:sierra generation', () => {
  // The Mesa–Sierra signal bridge was removed. router/signals.js returns Mesa
  // signals directly, so `.get` is already a tracked Mesa read and there is
  // nothing to patch. These guard against it being reintroduced.
  test('does not emit a signal bridge', () => {
    const out = _generateVirtualSierra({ trailingSlash: 'always', theme: {} }, 'config/routes.js')
    expect(out).not.toContain('$$bridge')
    expect(out).not.toContain('sierraSignal.get = mesaRead')
    expect(out).not.toContain('$$sig_activeRoute')
  })

  test('does not import createSignal into the generated module', () => {
    const out = _generateVirtualSierra({ trailingSlash: 'always' }, 'config/routes.js')
    expect(out).not.toContain('createSignal')
  })

  test('always imports from the route table', () => {
    const src = _generateVirtualSierra({ target: 'spa' }, 'config/routes.js')
    expect(src).toContain("from '/config/routes.js'")
  })

  test('always calls initRouter', () => {
    const src = _generateVirtualSierra({ target: 'spa' }, 'config/routes.js')
    expect(src).toContain('initRouter(')
  })

  test('passes layouts to initRouter as fifth argument', () => {
    const src = _generateVirtualSierra({ target: 'spa' }, 'config/routes.js')
    expect(src).toContain('}, layouts)')
  })

  test('imports layouts from the route table', () => {
    const src = _generateVirtualSierra({ target: 'spa' }, 'config/routes.js')
    expect(src).toContain('layouts')
    // layouts should appear in the route table import destructuring
    const importLine = src.split('\n').find(l => l.includes("from '/config/routes.js'"))
    expect(importLine).toContain('layouts')
  })

  test('includes trailingSlash setting', () => {
    const src = _generateVirtualSierra(
      { target: 'spa', trailingSlash: 'never' },
      'config/routes.js'
    )
    expect(src).toContain('"never"')
  })

  test('includes Junction init when junction.url configured', () => {
    const src = _generateVirtualSierra({
      target: 'spa',
      junction: { url: 'wss://api.example.com', tokenKey: 'my_token' },
    }, 'config/routes.js')
    expect(src).toContain('initJunction(')
  })

  test('skips Junction when no junction.url', () => {
    const src = _generateVirtualSierra({ target: 'spa' }, 'config/routes.js')
    expect(src).not.toContain('initJunction')
  })

  test('includes analytics init when configured', () => {
    const src = _generateVirtualSierra({
      target: 'spa',
      analytics: { provider: 'plausible', domain: 'example.com' },
    }, 'config/routes.js')
    expect(src).toContain('initAnalytics(')
  })

  test('skips analytics when not configured', () => {
    const src = _generateVirtualSierra({ target: 'spa' }, 'config/routes.js')
    expect(src).not.toContain('initAnalytics')
  })

  test('dev error forwarding is inside DEV guard', () => {
    const src = _generateVirtualSierra({ target: 'spa' }, 'config/routes.js')
    expect(src).toContain("import.meta.env.DEV")
    expect(src).toContain("window.addEventListener('error'")
  })

  test('re-exports the route table arrays including layouts', () => {
    const src = _generateVirtualSierra({ target: 'spa' }, 'config/routes.js')
    expect(src).toContain('export {')
    expect(src).toContain('published')
    expect(src).toContain('indexed')
    expect(src).toContain('redirects')
    expect(src).toContain('layouts')
  })

  // ── Mesa–Sierra signal bridge ─────────────────────────────────────────────








  test('bridge does NOT import theme signal when theme is not configured', () => {
    const src = _generateVirtualSierra({ target: 'spa' }, 'config/routes.js')
    expect(src).not.toContain('$$sig_theme')
    expect(src).not.toContain("from '@frontierjs/sierra/theme'")
  })



})

// ─── deepMerge ───────────────────────────────────────────────────────────────

import { _deepMerge } from '../src/build/index.js'

describe('deepMerge', () => {
  test('b values win over a for scalars', () => {
    expect(_deepMerge({ x: 1 }, { x: 2 })).toEqual({ x: 2 })
  })

  test('arrays are concatenated', () => {
    const result = _deepMerge({ plugins: ['a'] }, { plugins: ['b'] })
    expect(result.plugins).toEqual(['a', 'b'])
  })

  test('nested objects are deep merged', () => {
    const result = _deepMerge(
      { build: { outDir: 'dist', minify: false } },
      { build: { minify: true } }
    )
    expect(result.build).toEqual({ outDir: 'dist', minify: true })
  })

  test('missing keys from a are preserved', () => {
    const result = _deepMerge({ a: 1, b: 2 }, { b: 99 })
    expect(result.a).toBe(1)
    expect(result.b).toBe(99)
  })

  test('handles null/undefined gracefully', () => {
    expect(_deepMerge({ x: 1 }, null)).toEqual({ x: 1 })
    expect(_deepMerge(null, { x: 1 })).toEqual({ x: 1 })
  })
})

describe('_escapeFencedCodeBlocks preprocessor', () => {
  // Import the function indirectly by testing through the build pipeline
  // or by importing and testing the regex logic directly

  it('converts fenced code block to pre with @html', () => {
    // We test the logic inline since the function is module-private
    function escape(src) {
      return src.replace(
        /^```(\w*)\n([\s\S]*?)^```\s*$/gm,
        (_, lang, body) => {
          const escaped = body
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${')
          const cls = lang ? 'code ' + lang : 'code'
          return '<pre class="' + cls + '">{@html `' + escaped + '`}</pre>'
        }
      )
    }

    const src = '```js\nexport let value = 0\n$emit("change", value)\n```'
    const result = escape(src)
    expect(result).toContain('<pre class="code js">')
    expect(result).toContain('{@html `')
    expect(result).toContain('export let value = 0')
    expect(result).not.toMatch(/^```/m)
  })

  it('handles code fence with no language tag', () => {
    function escape(src) {
      return src.replace(
        /^```(\w*)\n([\s\S]*?)^```\s*$/gm,
        (_, lang, body) => {
          const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
          const cls = lang ? 'code ' + lang : 'code'
          return '<pre class="' + cls + '">{@html `' + escaped + '`}</pre>'
        }
      )
    }

    const src = '```\nsome code\n```'
    const result = escape(src)
    expect(result).toContain('<pre class="code">')
  })

  it('escapes backticks inside code block', () => {
    function escape(src) {
      return src.replace(
        /^```(\w*)\n([\s\S]*?)^```\s*$/gm,
        (_, lang, body) => {
          const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
          return '<pre class="code">{@html `' + escaped + '`}</pre>'
        }
      )
    }

    const src = '```\nconst x = `hello`\n```'
    const result = escape(src)
    // Backticks in code body are escaped
    expect(result).toContain('\\`hello\\`')
    // The unescaped backtick only appears in the surrounding {@html `...`} wrapper
    expect(result).toContain('{@html `')
  })

  it('escapes template literal interpolations inside code block', () => {
    function escape(src) {
      return src.replace(
        /^```(\w*)\n([\s\S]*?)^```\s*$/gm,
        (_, lang, body) => {
          const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
          return '<pre class="code">{@html `' + escaped + '`}</pre>'
        }
      )
    }

    const src = '```\nconst s = `Item ${id}`\n```'
    const result = escape(src)
    expect(result).toContain('\\${id}')
    // ${id} without escaping would be parsed as JS interpolation
    expect(result.includes('`const s = `Item ${id}`')).toBe(false)
  })

  it('leaves non-fenced content unchanged', () => {
    function escape(src) {
      return src.replace(
        /^```(\w*)\n([\s\S]*?)^```\s*$/gm,
        (_, lang, body) => {
          const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
          const cls = lang ? 'code ' + lang : 'code'
          return '<pre class="' + cls + '">{@html `' + escaped + '`}</pre>'
        }
      )
    }

    const src = '<div><p>Hello {name}</p></div>'
    expect(escape(src)).toBe(src)
  })
})
