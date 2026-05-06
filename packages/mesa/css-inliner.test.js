/**
 * css-inliner.test.js — test suite for @frontierjs/mesa css-inliner
 *
 * Run: npx vitest run css-inliner.test.js
 */

import { describe, it, expect } from 'vitest'
import { inlineCSS, extractStyles, resolveCSSVars } from './css-inliner.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Extract the value of a style property from an inline style string
function styleVal(html, selector, prop) {
  // Very simple extraction — find style="" on element matching the selector pattern
  // Pull style attr from the first element that has data-test matching selector
  const match = html.match(new RegExp(`data-t="${selector}"[^>]*style="([^"]*)"`, 'i'))
    ?? html.match(new RegExp(`style="([^"]*)"[^>]*data-t="${selector}"`, 'i'))
  if (!match) return null
  const styleStr = match[1]
  const propMatch = styleStr.match(new RegExp(`(?:^|;)\\s*${prop.replace(/-/g,'\\-')}\\s*:\\s*([^;]+)`, 'i'))
  return propMatch ? propMatch[1].trim() : null
}

function hasStyle(html, prop, value) {
  return html.includes(`${prop}:${value}`) || html.includes(`${prop}: ${value}`)
}

// ── Basic inlining ─────────────────────────────────────────────────────────────

describe('inlineCSS — basic inlining', () => {
  it('inlines a simple class rule', () => {
    const html = `<p class="greeting">Hello</p>`
    const css  = `.greeting { color: red; font-size: 16px; }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('color:red')
    expect(out).toContain('font-size:16px')
  })

  it('inlines a type selector', () => {
    const html = `<p>Hello</p>`
    const css  = `p { margin: 0; }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('margin:0')
  })

  it('inlines an id selector', () => {
    const html = `<div id="main">content</div>`
    const css  = `#main { width: 600px; }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('width:600px')
  })

  it('inlines descendant selector', () => {
    const html = `<div class="wrap"><p>text</p></div>`
    const css  = `.wrap p { line-height: 1.5; }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('line-height:1.5')
  })

  it('handles comma-separated selectors', () => {
    const html = `<h1>Title</h1><h2>Sub</h2>`
    const css  = `h1, h2 { font-family: sans-serif; }`
    const out  = inlineCSS(html, css)
    expect(out.match(/font-family:sans-serif/g)?.length).toBe(2)
  })

  it('does not inline rules for non-matching elements', () => {
    const html = `<p>text</p>`
    const css  = `.missing { color: blue; }`
    const out  = inlineCSS(html, css)
    expect(out).not.toContain('color:blue')
    expect(out).not.toContain('style=')
  })
})

// ── Specificity ───────────────────────────────────────────────────────────────

describe('inlineCSS — specificity', () => {
  it('higher specificity wins over lower', () => {
    const html = `<p class="note">text</p>`
    const css  = `p { color: red; } .note { color: blue; }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('color:blue')
    expect(out).not.toContain('color:red')
  })

  it('id selector beats class selector', () => {
    const html = `<p id="hero" class="note">text</p>`
    const css  = `.note { color: blue; } #hero { color: green; }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('color:green')
    expect(out).not.toContain('color:blue')
  })

  it('!important overrides higher specificity', () => {
    const html = `<p id="x">text</p>`
    const css  = `#x { color: green; } p { color: red !important; }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('color:red')
    expect(out).not.toContain('color:green')
  })

  it('existing inline style beats any rule', () => {
    const html = `<p style="color:purple" class="note">text</p>`
    const css  = `.note { color: blue; } p { color: red !important; }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('color:purple')
  })
})

// ── CSS custom properties ─────────────────────────────────────────────────────

describe('inlineCSS — CSS custom properties', () => {
  it('resolves var() from :root', () => {
    const html = `<p class="btn">Click</p>`
    const css  = `:root { --brand: #ee380d; } .btn { background: var(--brand); }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('background:#ee380d')
  })

  it('uses fallback when var is not defined', () => {
    const html = `<p class="btn">Click</p>`
    const css  = `.btn { color: var(--missing, black); }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('color:black')
  })

  it('resolves chained var() references', () => {
    const html = `<p class="x">text</p>`
    const css  = `:root { --a: #fff; --b: var(--a); } .x { color: var(--b); }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('color:#fff')
  })

  it('accepts seeded customProps option', () => {
    const html = `<p class="x">text</p>`
    const css  = `.x { color: var(--theme); }`
    const out  = inlineCSS(html, css, { customProps: { '--theme': 'navy' } })
    expect(out).toContain('color:navy')
  })

  it('does not inline :root declarations as style=""', () => {
    const html = `<p>text</p>`
    const css  = `:root { --x: 10px; }`
    const out  = inlineCSS(html, css)
    expect(out).not.toContain('style=')
    expect(out).not.toContain('--x')
  })
})

// ── @media preservation ───────────────────────────────────────────────────────

describe('inlineCSS — @media preservation', () => {
  it('preserves @media in a <style> block when preserveMediaQueries:true', () => {
    const html = `<p class="x">text</p>`
    const css  = `@media (max-width:600px) { .x { display:none; } } .x { color:red; }`
    const out  = inlineCSS(html, css, { preserveMediaQueries: true })
    expect(out).toContain('<style>')
    expect(out).toContain('@media')
    expect(out).toContain('color:red')
  })

  it('drops @media when preserveMediaQueries:false', () => {
    const html = `<p>text</p>`
    const css  = `@media (max-width:600px) { p { display:none; } }`
    const out  = inlineCSS(html, css, { preserveMediaQueries: false })
    expect(out).not.toContain('<style>')
    expect(out).not.toContain('@media')
  })

  it('does not inline @media rules into style attributes', () => {
    const html = `<p class="x">text</p>`
    const css  = `@media (max-width:600px) { .x { display:none; } }`
    const out  = inlineCSS(html, css)
    expect(out).not.toContain('style=')
  })

  it('does not inline @keyframes', () => {
    const html = `<p>text</p>`
    const css  = `@keyframes spin { from { opacity:0; } to { opacity:1; } }`
    const out  = inlineCSS(html, css)
    expect(out).not.toContain('style=')
    expect(out).not.toContain('opacity')
  })
})

// ── <style> tag handling ──────────────────────────────────────────────────────

describe('inlineCSS — style tag extraction', () => {
  it('inlines CSS from <style> blocks in the HTML', () => {
    const html = `<style>.x { color: teal; }</style><p class="x">text</p>`
    const out  = inlineCSS(html, '', { removeStyleTags: true })
    expect(out).toContain('color:teal')
    expect(out).not.toContain('<style>')
  })

  it('removes <style> blocks after inlining', () => {
    const html = `<style>p { margin: 0; }</style><p>text</p>`
    const out  = inlineCSS(html, '')
    expect(out).not.toContain('<style>')
    expect(out).toContain('margin:0')
  })

  it('merges extraCSS with style block CSS', () => {
    const html = `<style>.a { color: red; }</style><p class="a b">text</p>`
    const css  = `.b { font-size: 14px; }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('color:red')
    expect(out).toContain('font-size:14px')
  })

  it('does not remove style tags when inlineStyleTags:false', () => {
    const html = `<style>.x { color:red; }</style><p class="x">text</p>`
    const out  = inlineCSS(html, '', { inlineStyleTags: false })
    expect(out).toContain('<style>')
    expect(out).not.toContain('style=')
  })
})

// ── Edge cases ─────────────────────────────────────────────────────────────────

describe('inlineCSS — edge cases', () => {
  it('handles empty CSS gracefully', () => {
    const html = `<p class="x">text</p>`
    const out  = inlineCSS(html, '')
    expect(out).toBe(html)
  })

  it('handles empty HTML gracefully', () => {
    const out = inlineCSS('', 'p { color: red; }')
    expect(out).toBe('')
  })

  it('handles malformed CSS without throwing', () => {
    const html = `<p>text</p>`
    expect(() => inlineCSS(html, 'p { color: ')).not.toThrow()
  })

  it('handles unsupported selectors without throwing', () => {
    const html = `<p>text</p>`
    expect(() => inlineCSS(html, ':has(p) { color: red; }')).not.toThrow()
  })

  it('multiple elements of same type each get styles', () => {
    const html = `<p>one</p><p>two</p><p>three</p>`
    const css  = `p { color: red; }`
    const out  = inlineCSS(html, css)
    expect(out.match(/color:red/g)?.length).toBe(3)
  })

  it('preserves existing attributes on elements', () => {
    const html = `<p class="x" data-id="42">text</p>`
    const css  = `.x { color: red; }`
    const out  = inlineCSS(html, css)
    expect(out).toContain('data-id="42"')
    expect(out).toContain('color:red')
  })
})

// ── extractStyles ─────────────────────────────────────────────────────────────

describe('extractStyles', () => {
  it('extracts content of <style> blocks', () => {
    const html = `<style>p { color: red; }</style><p>text</p>`
    const css  = extractStyles(html)
    expect(css).toContain('p { color: red; }')
  })

  it('concatenates multiple style blocks', () => {
    const html = `<style>.a { color:red }</style><style>.b { color:blue }</style>`
    const css  = extractStyles(html)
    expect(css).toContain('.a')
    expect(css).toContain('.b')
  })

  it('returns empty string for HTML with no style tags', () => {
    expect(extractStyles('<p>text</p>')).toBe('')
  })
})

// ── resolveCSSVars ────────────────────────────────────────────────────────────

describe('resolveCSSVars', () => {
  it('resolves a single var', () => {
    expect(resolveCSSVars('var(--color)', { '--color': 'red' })).toBe('red')
  })

  it('uses fallback when var is missing', () => {
    expect(resolveCSSVars('var(--missing, blue)', {})).toBe('blue')
  })

  it('returns empty string for missing var with no fallback', () => {
    expect(resolveCSSVars('var(--missing)', {})).toBe('')
  })

  it('handles non-var values passthrough', () => {
    expect(resolveCSSVars('16px', {})).toBe('16px')
  })
})
