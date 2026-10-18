/*
 * html-frame.spec.mjs — HtmlFrame, somebody else's HTML, drawn isolated.
 *
 * A render test sees the attribute. What only a browser can say is that the
 * attribute does its work: the document draws, nothing in it runs, and its
 * origin is not this page's. A sandboxed frame can still postMessage its
 * parent, so the fixture's hostile document reports through that channel — a
 * script that ran is a message heard.
 */
export const name = 'HtmlFrame'
export const covers = ['display/HtmlFrame']

export async function run(t) {
  await t.mount('html-frame')

  // A script and a handler run on the next task; give them one.
  await t.evaluate(`return new Promise(r => setTimeout(r, 300))`)

  /* ── nothing the document says runs ───────────────────────────────────── */

  t.is(await t.evaluate(`return window.__heard.length`), 0, 'no script or handler in the document ran')

  const frame = await t.evaluate(`
    const f = document.querySelector('#hostile');
    let reach = 'reached';
    try { reach = f.contentWindow.document ? 'reached' : 'blocked' } catch { reach = 'blocked' }
    return {
      tag:     f.tagName,
      sandbox: f.getAttribute('sandbox'),
      title:   f.getAttribute('title'),
      reach,
      doc:     f.contentDocument === null,
    };
  `)
  t.is(frame.tag, 'IFRAME', 'it is a frame, not a shadow root')
  t.is(frame.sandbox, '', 'sandbox grants no token')
  t.is(frame.title, 'Hostile', 'the title is the frame\'s accessible name')
  t.is(frame.reach, 'blocked', 'this page cannot read the document: its origin is opaque')
  t.ok(frame.doc, 'contentDocument is null across the opaque origin')

  /* ── a plain document draws, with a default name ──────────────────────── */

  t.is(await t.evaluate(`return document.querySelector('#plain').getAttribute('title')`), 'Preview',
    'title defaults to Preview')
  t.ok(await t.evaluate(`return document.querySelector('#plain').getAttribute('srcdoc') === '<h1>Hello</h1>'`),
    'the html is the srcdoc')

  /* ── the box is fixed ─────────────────────────────────────────────────── */

  const tall = await t.evaluate(`
    const f = document.querySelector('#tall');
    return { h: f.getBoundingClientRect().height, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) };
  `)
  t.ok(Math.abs(tall.h - 10 * tall.rem) <= 4, `height="10rem" holds the box at 10rem however tall the document (${tall.h}px)`)
}
