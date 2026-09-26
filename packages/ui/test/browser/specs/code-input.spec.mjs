/*
 * code-input.spec.mjs — CodeInput, a textarea over its own highlighted paint.
 *
 * Every failure of the overlay is a caret sitting beside the character it is
 * on, and none of them is visible in the markup: a layer with a different
 * padding, a gutter the textarea does not know about, a paint that dropped a
 * character glow reads as a marker, a trailing newline the <pre> draws no line
 * for. So the spec compares the two layers' GEOMETRY — the computed metrics,
 * where the paint's first glyph lands against where the textarea's content box
 * starts — rather than asking whether the component rendered.
 */
export const name = 'CodeInput'
export const covers = ['forms/CodeInput']

const layers = (id) => `
  const text  = document.getElementById('${id}');
  const paint = text.parentElement.querySelector('pre');
`

export async function run(t) {
  await t.mount('code-input')

  /* ── the two layers lay text out the same way ─────────────────────────── */

  const METRICS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize',
    'whiteSpace', 'paddingTop', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'boxSizing']

  const differs = await t.evaluate(`${layers('plain')}
    const a = getComputedStyle(text), b = getComputedStyle(paint);
    return ${JSON.stringify(METRICS)}.filter(p => a[p] !== b[p]).map(p => p + ': ' + a[p] + ' vs ' + b[p]);
  `)
  t.is(differs.join('; '), '', 'the textarea and the paint compute the same text metrics')

  const boxes = await t.evaluate(`${layers('plain')}
    const a = text.getBoundingClientRect(), b = paint.getBoundingClientRect();
    return [a.left - b.left, a.top - b.top, a.width - b.width, a.height - b.height].map(n => Math.round(n));
  `)
  t.is(boxes.join(','), '0,0,0,0', 'and occupy the same box')

  // Where the textarea's first character goes is its content box's origin;
  // where the paint's actually went is a Range over the first glyph. Equal
  // metrics with an extra wrapper or margin in the paint would still move it.
  const origin = (id) => t.evaluate(`${layers(id)}
    const cs    = getComputedStyle(text);
    const r     = text.getBoundingClientRect();
    const walk  = document.createTreeWalker(paint.querySelector('code'), NodeFilter.SHOW_TEXT);
    let node; while ((node = walk.nextNode()) && !node.textContent.trim());
    const range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 1);
    const g = range.getBoundingClientRect();
    return {
      dx: Math.round(g.left - (r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft))),
      dy: Math.round(g.top  - (r.top  + parseFloat(cs.borderTopWidth)  + parseFloat(cs.paddingTop))),
    };
  `)
  const o = await origin('plain')
  t.ok(o.dx === 0 && Math.abs(o.dy) <= 3, `the first painted glyph starts where the textarea's text does (dx ${o.dx}, dy ${o.dy})`)

  const n = await origin('numbered')
  t.ok(n.dx === 0, `with line numbers the textarea is inset by exactly the gutter the paint draws (dx ${n.dx})`)

  /* ── the paint holds exactly the characters typed ─────────────────────── */

  t.is(await t.evaluate(`${layers('plain')} return paint.textContent === text.value;`), true,
    'a leading +, > and \\ and a •mark• all reach the paint — glow’s line passes are off')

  t.is(await t.evaluate(`${layers('trailing')} return paint.textContent;`), 'one\ntwo\n ',
    'a trailing newline is painted as a line of its own')

  t.is(await t.evaluate(`${layers('trailing')} return text.scrollHeight <= text.clientHeight;`), true,
    'so the box grows to hold it and never scrolls under the paint, even at rows={1}')

  t.is(await t.evaluate(`${layers('hostile')} return [paint.querySelectorAll('img').length, window.__xss ?? 0].join(',');`),
    '0,0', 'markup typed into the box is painted as characters')

  /* ── highlighted, and the box is what is hit ──────────────────────────── */

  const look = await t.evaluate(`${layers('plain')}
    const c = (sel) => getComputedStyle(paint.querySelector(sel)).color;
    const r = text.getBoundingClientRect();
    return {
      tokens:  new Set([c('b'), c('em'), c('i')]).size,
      glyphs:  getComputedStyle(text).color,
      hit:     document.elementFromPoint(r.left + r.width / 2, r.top + 20) === text,
      hidden:  paint.getAttribute('aria-hidden'),
    };
  `)
  t.is(look.tokens, 3, 'names, values and punctuation are painted in three colors from the theme')
  t.is(look.glyphs, 'rgba(0, 0, 0, 0)', 'while the textarea draws its own glyphs transparent')
  t.ok(look.hit, 'a click lands on the textarea, not the paint')
  t.is(look.hidden, 'true', 'and the paint is hidden from assistive technology')

  /* ── typing ───────────────────────────────────────────────────────────── */

  await t.evaluate(`${layers('plain')}
    text.focus();
    text.setSelectionRange(text.value.indexOf('\\n'), text.value.indexOf('\\n'));
    return true;
  `)
  await t.press('Enter')
  await t.type('+ok')
  await t.eventually(`window.__value?.split('\\n')[1]`, '+ok', 'typing goes through the textarea and oninput reports it')
  await t.eventually(`(() => { ${layers('plain')} return paint.textContent === text.value; })()`, true,
    'and the paint follows, keeping the + it would lose as a diff marker')

  const grew = await t.evaluate(`${layers('plain')} return text.scrollHeight <= text.clientHeight;`)
  t.ok(grew, 'a new line grows the box rather than scrolling it')

  /* ── scrolling sideways moves the paint with it ───────────────────────── */

  const widths = await t.evaluate(`${layers('plain')} return [text.scrollWidth, paint.scrollWidth];`)
  t.ok(widths[0] > 480 && Math.abs(widths[0] - widths[1]) <= 2,
    `a long line scrolls both layers over the same width (${widths.join(' vs ')})`)

  // A scrollbar takes block size from its box, so a bar on one layer and not
  // the other puts the last line of each at a different height. Both must be
  // scrollable at all, too: `hidden` on both keeps parity and leaves a person
  // with no way to reach the end of a long line but the caret.
  const bars = await t.evaluate(`${layers('plain')}
    const bar = (e) => e.offsetHeight - e.clientHeight - parseFloat(getComputedStyle(e).borderTopWidth) - parseFloat(getComputedStyle(e).borderBottomWidth);
    return { text: bar(text), paint: bar(paint), overflow: getComputedStyle(text).overflowX };
  `)
  t.is(bars.overflow, 'auto', 'the textarea offers its own horizontal scrollbar')
  t.is(bars.text, bars.paint, `and the paint carries one of the same height (${bars.text}px)`)

  await t.evaluate(`${layers('plain')} text.scrollLeft = 300; return true;`)
  await t.eventually(`(() => { ${layers('plain')} return paint.scrollLeft === text.scrollLeft && text.scrollLeft > 0; })()`, true,
    'and the paint scrolls to where the textarea did')

  /* ── a Field around it ────────────────────────────────────────────────── */

  const field = await t.evaluate(`
    const label = [...document.querySelectorAll('label')].find(l => l.textContent.trim().startsWith('Body'));
    const target = label && document.getElementById(label.htmlFor);
    return target ? target.tagName + ':' + target.name : null;
  `)
  t.is(field, 'TEXTAREA:body', 'a label names the textarea, so clicking it focuses the box')
}
