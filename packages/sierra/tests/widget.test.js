/**
 * tests/widget.test.js — what a widget IS, before a browser is involved.
 *
 * The claims that need a real page — custom element upgrade, shadow isolation,
 * a click reaching a delegated handler, a second copy of the script — are in
 * `tests/fixtures/widget-site/verify.mjs`, because none of them can be settled
 * here. What CAN be settled here is the part that decides what gets built at
 * all: which files are widgets, and what the generated entry says about them.
 *
 * Discovery is the one worth pinning. A flat glob over `src/Embeds/` would emit
 * a script per file, so a widget with parts — a directory holding an index and
 * its own components — would ship as five widgets, four of them half a form
 * with no host page and no way to notice.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { discoverWidgets, widgetEntrySource, CSS_PLACEHOLDER, widgetCssPlugin } from '../src/build/widget-build.js'
import { kebab, CSS_MARK } from '../src/widget/index.js'
import { tmpDir } from './tmp.js'

let dir

beforeAll(() => {
  dir = tmpDir('fjs-widgets-')
  const file = (p, body = '') => {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), body)
  }
  file('Counter.mesa')
  file('Banner.js')
  file('LeadForm/index.mesa')
  file('LeadForm/Field.mesa')        // a part, not a widget
  file('Shared/Button.mesa')         // a directory with no index — not a widget
  file('_Draft.mesa')                // underscore-prefixed — skipped
  file('README.md')                  // not a component
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('discovery', () => {
  test('a file is a widget, a directory is a widget when it has an index', () => {
    expect(discoverWidgets(dir).map(w => w.name)).toEqual(['Banner', 'Counter', 'LeadForm'])
  })

  test('a widget\'s own components do not become widgets', () => {
    // The failure this prevents: `LeadForm/Field.mesa` shipped as its own
    // embeddable script — half a form, on no host page, noticed by nobody.
    const names = discoverWidgets(dir).map(w => w.name)
    expect(names).not.toContain('Field')
    expect(names).not.toContain('Button')
  })

  test('the directory form resolves to its index', () => {
    const lead = discoverWidgets(dir).find(w => w.name === 'LeadForm')
    expect(lead.entry.endsWith('LeadForm/index.mesa')).toBe(true)
  })

  test('a missing directory is empty, not a throw', () => {
    // A widget target in a project that has not written one yet.
    expect(discoverWidgets(join(dir, 'nope'))).toEqual([])
  })
})

describe('the generated entry', () => {
  const src = widgetEntrySource({ name: 'Counter', entry: '/abs/Counter.mesa' }, { prefix: 'mt-' })

  test('imports the component and the runtime, and embeds it', () => {
    expect(src).toContain('import Component, * as mod from "/abs/Counter.mesa"')
    expect(src).toContain("import { embed } from \"@frontierjs/sierra/widget\"")
    expect(src).toContain('name:   "Counter"')
    expect(src).toContain('prefix: "mt-"')
  })

  test('the component\'s own declaration wins over the config', () => {
    // The tag a host page writes belongs with the widget, not with whatever
    // app happens to build it — so `...declared` comes last.
    expect(src.indexOf('...declared')).toBeGreaterThan(src.indexOf('prefix:'))
  })

  test('the CSS placeholder is a bare literal', () => {
    // Anything the bundler can evaluate, it evaluates. A `css === MARK ? …`
    // guard here folds to an empty string before generateBundle can swap the
    // stylesheet in, and the widget ships unstyled with every part reading
    // correctly. The runtime does that check instead.
    expect(src).toContain(`css:    "${CSS_PLACEHOLDER}"`)
    expect(src).not.toContain('===')
  })
})

describe('the placeholder is a prefix on the runtime side', () => {
  test('the runtime does not hold the whole marker', () => {
    // The runtime is bundled INTO the widget. If it held the full marker, the
    // build's own replacement would hit it too, and the widget would compare
    // its stylesheet against itself and drop it — measured, and the reason
    // this is asserted rather than assumed.
    expect(CSS_PLACEHOLDER.startsWith(CSS_MARK)).toBe(true)
    expect(CSS_MARK).not.toBe(CSS_PLACEHOLDER)
  })
})

describe('kebab', () => {
  test('a PascalCase widget name reaches HTML as a legal tag', () => {
    expect(kebab('LeadForm')).toBe('lead-form')
    expect(kebab('Counter')).toBe('counter')
    expect(kebab('MapView3')).toBe('map-view3')
    expect(kebab('lead_form')).toBe('lead-form')
  })
})

// ─── the CSS swap ─────────────────────────────────────────────────────────
//
// `generateBundle` runs AFTER minification, so what it has to find is not what
// `widgetEntrySource` wrote — the bundler has requoted it. Every quote a
// bundler may choose is asserted here, because the failure this covers was
// total and silent: esbuild writes BACKTICKS when minifying (the default, and
// what every app ships), the matcher knew about `"` and `'`, and the CSS asset
// is deleted whether or not the swap lands. So an imported stylesheet vanished
// from the bundle and the literal `@sierra-widget-css` was handed to the shadow
// root as its stylesheet.
//
// It survived because the fixture that proves widgets in a browser builds with
// `minify: false` — for a good reason (a minified bundle says nothing about why
// it is inert) — so the one case that works was the only case under test.

describe('the CSS swap', () => {
  const entry = (quote) => ({
    type: 'chunk', isEntry: true, fileName: 'W.js',
    code: `mount(C,{name:"W",css:${quote}${CSS_PLACEHOLDER}${quote}})`,
  })
  const asset = (source) => ({ type: 'asset', fileName: 'style.css', source })

  const run = (bundle) => {
    widgetCssPlugin().generateBundle({}, bundle)
    return bundle
  }

  for (const [label, quote] of [['double', '"'], ['single', "'"], ['backtick', '`']]) {
    test(`a ${label}-quoted placeholder is replaced`, () => {
      const bundle = { 'W.js': entry(quote), 'style.css': asset('.a{color:red}') }
      run(bundle)
      expect(bundle['W.js'].code).toContain('.a{color:red}')
      expect(bundle['W.js'].code).not.toContain(CSS_PLACEHOLDER)
    })
  }

  test('the CSS asset is removed, so the host page makes no second request', () => {
    const bundle = { 'W.js': entry('`'), 'style.css': asset('.a{color:red}') }
    run(bundle)
    expect(bundle['style.css']).toBeUndefined()
  })

  // The asset is deleted before the swap, so a swap that does not land ships a
  // widget with no stylesheet and a placeholder where one should be. Louder is
  // the only correct answer.
  test('a placeholder the matcher cannot find fails the build', () => {
    const bundle = {
      'W.js': { type: 'chunk', isEntry: true, fileName: 'W.js', code: 'mount(C,{css:"nothing here"})' },
      'style.css': asset('.a{color:red}'),
    }
    expect(() => run(bundle)).toThrow(/placeholder was not found/)
  })

  test('a widget with no imported CSS still swaps, to an empty string', () => {
    const bundle = { 'W.js': entry('`') }
    run(bundle)
    expect(bundle['W.js'].code).toContain('css:""')
  })
})
