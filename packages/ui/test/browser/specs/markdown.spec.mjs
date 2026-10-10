/*
 * markdown.spec.mjs — Markdown, somebody else's text, read.
 *
 * toolbelt's spec proves the string the renderer returns has no tag the text
 * wrote. What only a browser can say is that the string, handed to `{@html}`,
 * still runs nothing — the parser a page uses is the browser's, not a regex —
 * and that a model's reply, table and all, stays inside a column as narrow as
 * a phone's chat pane rather than pushing the page sideways.
 */
export const name = 'Markdown'
export const covers = ['display/Markdown']

export async function run(t) {
  await t.mount('markdown')

  /* ── nothing the text says runs ───────────────────────────────────────── */

  // onerror and onload fire on the next task; give them one.
  await t.evaluate(`return new Promise(r => setTimeout(r, 200))`)
  t.is(await t.evaluate(`return window.__pwned ?? null`), null, 'no hostile text ran')
  t.is(await t.evaluate(`return document.querySelectorAll('#hostile img, #hostile script, #hostile svg, #hostile iframe').length`), 0,
    'and none of it became an element')
  t.is(await t.evaluate(`return [...document.querySelectorAll('#hostile a')].map(a => a.getAttribute('href')).filter(h => !/^(https?:|mailto:|\\/|#)/.test(h)).length`), 0,
    'no anchor goes anywhere but the web, mail or this site')
  t.ok((await t.evaluate(`return document.querySelector('#hostile').textContent`)).includes('<img src=x'),
    'the markup is drawn as the text it was')

  /* ── a reply, in a narrow column ──────────────────────────────────────── */

  const reply = await t.evaluate(`
    const root = document.querySelector('#narrow .fjs-markdown');
    const table = root.querySelector('table');
    return {
      h: root.firstElementChild.tagName,
      strong: root.querySelector('h3 strong')?.textContent,
      boxes: [...root.querySelectorAll('input[type=checkbox]')].map(b => b.checked),
      nested: !!root.querySelector('li > ul'),
      quote: !!root.querySelector('blockquote'),
      painted: root.querySelector('pre code[language="js"]') != null,
      rootOver: root.scrollWidth - root.clientWidth,
      pageOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tableScrolls: table.scrollWidth > table.clientWidth,
      tableFits: table.getBoundingClientRect().right <= root.getBoundingClientRect().right + 0.5,
      cls: table.className,
    };
  `)
  t.is(reply.h, 'H3', 'headingBase={3} draws a `#` as an <h3>')
  t.is(reply.strong, 'Lead', 'and the heading keeps its emphasis')
  t.is(JSON.stringify(reply.boxes), '[true,false]', 'task items draw as boxes, ticked as written')
  t.ok(reply.nested && reply.quote, 'a nested list and a block quote')
  t.ok(reply.painted, 'a fence that names its language is painted by glow')
  t.is(reply.cls, 'table compact', 'the table is the css package’s table')
  t.ok(reply.tableScrolls, 'a table wider than the column scrolls in its own box')
  t.ok(reply.tableFits, 'and stays inside the column')
  t.ok(reply.pageOver <= 0, `the page does not scroll sideways (${reply.pageOver}px over)`)
}
