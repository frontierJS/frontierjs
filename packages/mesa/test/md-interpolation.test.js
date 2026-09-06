/**
 * FJS-D213 — in a `.md` file, `{…}` interpolates a bare path and nothing else.
 *
 * Markdown prose is Mesa template source, so a brace an author never meant as
 * an expression was compiled as one. `A set {1, 2, 3} of numbers.` rendered
 * "A set 3 of numbers." — a comma operator, valid JS, no error, wrong prose —
 * and FJS-D208's `?? ''` made a free identifier render empty rather than throw.
 *
 * `.mesa` is unchanged: full expressions stay there. The assertions are on
 * RENDERED output, because what the reader sees is the whole claim.
 */

import { describe, it, expect } from 'vitest'
import { compileMd } from '../src/compiler-md.js'
import { renderComponent } from '../src/render-component.js'
import { compile } from '../src/compiler.js'

const md = async body => {
  const ctx = await compileMd(body, { filename: 'Page.md' })
  expect((ctx.analysis?.errors ?? []).join('\n')).toBe('')
  return ctx
}

// Renders the .md through the real server renderer, so the answer is the text
// a reader gets rather than the shape of an emitted template literal.
const renderMd = async body => {
  const { html } = await renderComponent(body, { filename: 'Page.md', target: 'html' })
  return html
}

// ─── prose stays prose ───────────────────────────────────────────────────────

describe('a brace that is not a path is text (FJS-D213)', () => {
  it('a set literal keeps its numbers', async () => {
    expect(await renderMd('A set {1, 2, 3} of numbers.\n'))
      .toContain('A set {1, 2, 3} of numbers.')
  })

  it('a braced word with spaces around it is prose', async () => {
    expect(await renderMd('if x { y } then z\n')).toContain('if x { y } then z')
  })

  it('a call is prose', async () => {
    expect(await renderMd('Run {build()} to start.\n')).toContain('Run {build()} to start.')
  })

  it('an index is prose — a path is an identifier or a member chain', async () => {
    expect(await renderMd('Take {items[0]} first.\n')).toContain('Take {items[0]} first.')
  })

  // An UNCLOSED brace is still a compile error, in .md as in .mesa. It is
  // caught by the tokenizer before parseText sees it, and it is loud — which is
  // not the failure FJS-D213 is about.
  it('an unclosed brace is still refused, loudly', async () => {
    await expect(renderMd('Open { and never close.\n')).rejects.toThrow(/Unterminated/)
  })
})

// ─── a path still interpolates ───────────────────────────────────────────────

describe('a bare path still interpolates (FJS-D213)', () => {
  it('an identifier does', async () => {
    expect(await renderMd('---\ntitle: Catalog\n---\n\nWelcome to {title}.\n'))
      .toContain('Welcome to Catalog.')
  })

  it('a member chain does', async () => {
    expect(await renderMd(
      '<script>\n  const post = { author: { name: "Ada" } }\n</script>\n\nBy {post.author.name}.\n'
    )).toContain('By Ada.')
  })

  it('an optional chain does', async () => {
    expect(await renderMd(
      '<script>\n  const post = { author: null }\n</script>\n\nBy {post.author?.name}!\n'
    )).toContain('By !')
  })
})

// ─── the escape ──────────────────────────────────────────────────────────────

describe('\\{ escapes a brace that would otherwise open one (FJS-D213)', () => {
  // CommonMark strips the backslash itself, so `\{title}` reached Mesa as a
  // live `{title}` and interpolated. Carried across the Markdown step instead.
  it('renders the braces and does not interpolate', async () => {
    const html = await renderMd('---\ntitle: Catalog\n---\n\nEscaped: \\{title} stays.\n')
    expect(html).toContain('{title}')
    expect(html).not.toContain('Catalog stays')
  })
})

// ─── an attribute is markup, not prose ───────────────────────────────────────

describe('an attribute in a .md still takes any expression (FJS-D213)', () => {
  // The same split FJS-D208's coerceNullish makes: a brace in an attribute an
  // author hand-wrote can only have been meant as an expression, where a brace
  // in prose usually was not.
  it('a component prop is compiled', async () => {
    const ctx = await md('<Counter initialCount={2 + 3} />\n')
    expect(ctx.result).toContain('2 + 3')
  })

  it('an element attribute is compiled', async () => {
    const ctx = await md('<span data-n="n={1 + 1}">x</span>\n')
    expect(ctx.result).toContain('1 + 1')
  })
})

// ─── .mesa is unchanged ──────────────────────────────────────────────────────

describe('a .mesa file still takes any expression (FJS-D213)', () => {
  const out = src => compile(src, { debug: false, css: false }).then(c => c.result)

  it('an arithmetic expression is still compiled', async () => {
    const src = '<script>\n  let a = 1\n  let b = 2\n</script>\n<p>{a + b}</p>'
    expect(await out(src)).toContain('$$runtime.get($$sig_a) + $$runtime.get($$sig_b)')
  })

  it('a call is still compiled', async () => {
    const src = '<script>\n  let n = 1\n</script>\n<p>{String(n)}</p>'
    expect(await out(src)).toContain('String(')
  })
})
