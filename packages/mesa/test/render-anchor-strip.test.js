/**
 * @vitest-environment node
 *
 * render-anchor-strip.test.js — what a server render deletes on its way out
 * (FJS-859).
 *
 * Anchor stripping used to be three regexes run over the serialized HTML after
 * the DOM was gone, and a pattern cannot tell a Mesa anchor from those same
 * characters inside an attribute VALUE — which legitimately carries raw `<` and
 * `>`, since happy-dom escapes only `&` and `"` there, correctly per HTML5. An
 * alt text holding a comment lost it; a match spanning the closing quote
 * deleted the attribute BETWEEN two such values whole. Text nodes escape, so
 * they were safe, and the server and the client disagreed about the same data.
 *
 * Every assertion here is paired: a value that must survive beside an anchor
 * that must still go. A strip that stopped stripping passes any test that only
 * asks about the value.
 */
import { describe, it, expect } from 'vitest'
import { renderComponent } from '../src/render-component.js'

async function render(src, data = {}) {
  const r = await renderComponent(src, { cwd: '/tmp', filename: '/tmp/Anchor.mesa', target: 'html', data })
  return r.html
}

describe('an attribute value that looks like an anchor', () => {
  it('keeps a comment inside an attribute value', async () => {
    const html = await render(`<script>\n  const alt = 'a <!-- b --> c'\n</script>\n<img alt={alt} src="/x.png">\n`)
    expect(html).toContain('alt="a <!-- b --> c"')
  })

  // The regex could span the closing quote of one value and the opening quote
  // of the next, taking the attribute between them with it.
  it('keeps the attribute between two such values', async () => {
    const html = await render(
      `<script>\n  const a = 'x <!-- y'\n  const b = 'z --> w'\n</script>\n<img alt={a} data-keep="KEEPME" title={b}>\n`
    )
    expect(html).toContain('data-keep="KEEPME"')
    expect(html).toContain('alt="x <!-- y"')
    expect(html).toContain('title="z --> w"')
  })

  it('keeps an empty comment inside an attribute value', async () => {
    const html = await render(`<script>\n  const v = 'a<!---->b'\n</script>\n<img alt={v}>\n`)
    expect(html).toContain('alt="a<!---->b"')
  })

  // The client escapes nothing into a comment here, so this is the value the
  // browser would hold for the same data.
  it('agrees with the text-node path, which was never at risk', async () => {
    const html = await render(`<script>\n  const t = 'a <!-- b --> c'\n</script>\n<p>{t}</p>\n`)
    expect(html).toContain('a &lt;!-- b --&gt; c')
  })
})

describe('the anchors themselves still go', () => {
  it('strips the root anchor', async () => {
    expect(await render('<p>ok</p>\n')).not.toContain('mesa-root')
  })

  it('strips a block directive placeholder', async () => {
    const html = await render(`<script>\n  let x = true\n</script>\n{#if x}<p>y</p>{/if}\n`)
    expect(html).toContain('<p>y</p>')
    expect(html).not.toContain('<!---->')
  })

  it('strips an anchor nested inside an element', async () => {
    const html = await render(`<script>\n  const h = '<b>hi</b>'\n</script>\n<div>{@html h}</div>\n`)
    expect(html).toBe('<div><b>hi</b></div>')
  })

  it('strips a block anchor while an attribute value beside it survives', async () => {
    const html = await render(
      `<script>\n  let x = true\n  const alt = '<!-- keep -->'\n</script>\n{#if x}<img alt={alt}>{/if}\n`
    )
    expect(html).toBe('<img alt="<!-- keep -->">')
  })
})

describe('what an email template emits on purpose', () => {
  // No space after `<!--`, so a conditional is not an anchor shape — the case
  // the old patterns were narrowed for, and it has to keep working.
  it('an mso conditional survives {@html}', async () => {
    const html = await render(
      `<script>\n  const h = '<!--[if mso]><i>x</i><![endif]-->'\n</script>\n<div>{@html h}</div>\n`
    )
    expect(html).toContain('[if mso]')
  })
})

describe('keepAnchors is untouched', () => {
  it('the anchors are still there when asked for', async () => {
    const { renderToHTML, initRenderer } = await import('../src/render.js')
    initRenderer()
    const html = await renderToHTML(() => {}, {}, { keepAnchors: true })
    expect(html).toContain('mesa-root')
  })
})
