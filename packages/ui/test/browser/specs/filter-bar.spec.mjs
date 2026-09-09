/*
 * filter-bar.spec.mjs — the bar writes, and the search box is the model's call.
 *
 * The bug this is built around shipped green: every built-in branch passed
 * `onvalue` straight to its control, and no kit control has that prop. The
 * components rendered, the compile test compiled, the render test rendered, the
 * resource tests graded `resource.filters()` — and nothing anywhere pressed a
 * key, so the whole bar was inert (`FJS-1046`). `FormField.mesa` had had the
 * adapter table for the same three controls all along.
 *
 * So every branch is driven SEPARATELY. The three controls disagree about their
 * callback — `Input` and `Select` fire `oninput` with the event, `MultiSelect`
 * fires `onchange` with the value — and one adapter being right says nothing
 * about the others, which is exactly how a spec that drove only the text box
 * would have passed against three dead controls.
 *
 * The search box is the other half. `$search` reaches `table.search()`, which a
 * Litestone client serves only under `@@fts` and refuses by name below it, so
 * the box is drawn from what the SCHEMA said (`FJS-1040`). Asserted as a PAIR
 * over two bars on one page: a box that appeared for everybody and a box that
 * appeared for nobody are both satisfied by a one-sided assertion.
 */
export const name = 'FilterBar — every branch writes'
export const covers = ['display/FilterBar']

const BAR = '#searchable'
const out = `document.getElementById('out').textContent`
/** The last query the bar handed back, parsed. */
const held = (path) => `(() => { const q = JSON.parse(${out} || '{}'); return ${path} })()`

export async function run(t) {
  await t.mount('filter-bar')

  /* ── the box is offered only where the model answers ──────────────────── */

  const boxes = await t.evaluate(`return ({
    searchable:   !!document.querySelector('#searchable input[type="search"]'),
    unsearchable: !!document.querySelector('#unsearchable input[type="search"]'),
    placeholder:  document.querySelector('#searchable input[type="search"]')?.placeholder,
    filters:      document.querySelectorAll('#unsearchable input, #unsearchable select').length > 0,
  })`)

  t.is(boxes.searchable, true, 'a model declaring @@fts is offered a search box')
  t.is(boxes.unsearchable, false, 'the model beside it, on the same page, is not')
  // The negative control for the row above: the second bar rendered its column
  // filters, so the missing box is the search answer and not a dead component.
  t.is(boxes.filters, true, 'and that bar still rendered its column filters')

  // The labels are what a person reads to know why a word did not match, so a
  // placeholder saying only "Search" is the failure this key exists to fix.
  t.is(boxes.placeholder, 'Search Body, Title', 'the box names the indexed columns')

  /* ── $search writes, and takes the paging with it ─────────────────────── */

  await t.clickAt(`${BAR} input[type="search"]`)
  await t.type('wid')
  await t.eventually(held(`q.$search`), 'wid', 'typing in the box writes $search')

  const paging = await t.evaluate('return ' + held(`({ off: q.$offset ?? null, after: q.$after ?? null, order: q.$orderBy ?? null, limit: q.$limit ?? null })`))
  t.is(paging.off, null, 'and drops $offset — page 3 of a different question is not page 3')
  t.is(paging.order, 'title', 'while the sort survives, because it is how you are reading')
  t.is(paging.limit, 20, 'and so does the page size')

  /* ── each control branch, separately ──────────────────────────────────── */
  //
  // Four kinds, three components, three different callback shapes. A branch
  // that forwards the wrong prop renders identically to one that works.

  await t.clickAt(`${BAR} input[placeholder="Title"]`)
  await t.type('ab')
  await t.eventually(held(`q.title?.contains ?? null`), 'ab',
    'a text column writes through Input')

  await t.clickAt(`${BAR} input[placeholder="Total from"]`)
  await t.type('5')
  await t.eventually(held(`q.total?.gte ?? null`), '5',
    'a range column writes through the low Input')

  await t.clickAt(`${BAR} input[placeholder="Total to"]`)
  await t.type('9')
  await t.eventually(held(`q.total?.lte ?? null`), '9',
    'and the high one, which is a second binding on the same branch')

  // A `<select>` cannot be typed into, so this one is set and told to report —
  // the value has to move through the element's own change path or the adapter
  // is not what is under test.
  await t.evaluate(`
    const sel = document.querySelector('${BAR} select');
    sel.value = 'true';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await t.eventually(held(`String(q.active?.equals ?? null)`), 'true',
    'a boolean column writes through Select')

  /* ── Clear ───────────────────────────────────────────────────────────── */
  //
  // `$search` goes with the filters: it is WHAT is being asked for. The sort
  // and the page size are HOW it is being read, and they stay.

  await t.clickAt(`${BAR} button.btn`)
  await t.eventually(held(`[q.$search ?? '-', q.title ?? '-', q.$orderBy ?? '-', q.$limit ?? '-'].join('|')`),
    '-|-|title|20', 'Clear drops the search and the filters, and keeps the reading')
}
