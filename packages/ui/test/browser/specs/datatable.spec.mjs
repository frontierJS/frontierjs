/*
 * datatable.spec.mjs — Table and Pagination.
 *
 * The two display components that hold state. Everything else in that tier
 * draws what it is given; these two compute something — a page window with
 * ellipsis compression, and a sort cycle whose only record is `aria-sort` —
 * and neither had ever been driven.
 *
 * A render test cannot reach any of it: the window is only interesting on the
 * page it is not currently showing, and a sort direction is a third state that
 * exists between two clicks.
 */
export const name = 'Table · Pagination'
export const covers = ['display/Table', 'display/Pagination']

const current = `document.querySelector('#pg [aria-current=page]')?.textContent?.trim()`
const headers = `[...document.querySelectorAll('#tbl thead th')]`

export async function run(t) {

  await t.mount('datatable')

  /* ── the page window ──────────────────────────────────────────────────── */

  // 450 items at 25 a page is 18 pages in a window of 5.
  await t.eventually(current, '1', 'page 1 is the current page')
  t.is(await t.evaluate(`
    return document.querySelector('#pg p')?.textContent?.replace(/\\s+/g, ' ').trim();
  `), 'Showing 1–25 of 450', 'the info line counts the rows, not the pages')

  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#pg .pagination-link, #pg .pagination-gap')]
      .map(el => el.textContent.trim() || el.getAttribute('aria-label'))
      .join(' ');
  `), 'Previous page 1 2 3 4 5 … 18 Next page',
    'the window opens on the first five, then jumps to the last')

  // Prev at the first page and Next at the last are the two controls that must
  // be disabled rather than merely inert: a live-looking control that does
  // nothing is indistinguishable from a page that failed to load.
  t.is(await t.evaluate(`
    return document.querySelector('#pg [aria-label="Previous page"]').disabled;
  `), true, 'Previous is disabled on the first page')
  t.is(await t.evaluate(`
    return document.querySelector('#pg [aria-label="Next page"]').disabled;
  `), false, 'and Next is not')

  /* ── moving ───────────────────────────────────────────────────────────── */

  await t.clickAt('#pg [aria-label="Page 3"]')
  await t.eventually(current, '3', 'clicking a page selects it')
  await t.eventually(`document.querySelector('#page').textContent`, '3',
    'and writes back through the binding')
  await t.eventually(`document.querySelector('#changes').textContent`, '1',
    'onchange fires once')
  await t.eventually(`document.querySelector('#last-page').textContent`, '3',
    'with the page it moved to')

  await t.eventually(`
    document.querySelector('#pg p').textContent.replace(/\\s+/g, ' ').trim()
  `, 'Showing 51–75 of 450', 'the info line follows the page')

  // Clicking the page you are already on is not a change. It reaching
  // onchange would refetch a list that is already on screen.
  await t.clickAt('#pg [aria-current=page]')
  await t.eventually(`document.querySelector('#changes').textContent`, '1',
    'clicking the current page announces nothing')

  /* ── the ellipsis, on both sides at once ──────────────────────────────── */

  // The arrangement that produces TWO markers in one keyed list. Their key is
  // built from the label, so both are '...' at the same page — a duplicate key
  // in a keyed {#each}, which is the shape that drops a node.
  await t.clickAt('#pg [aria-label="Next page"]')   // 4
  await t.clickAt('#pg [aria-label="Next page"]')   // 5
  await t.clickAt('#pg [aria-label="Next page"]')   // 6
  await t.clickAt('#pg [aria-label="Next page"]')   // 7
  await t.clickAt('#pg [aria-label="Next page"]')   // 8
  await t.eventually(current, '8', 'stepping with Next lands mid-range')

  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#pg .pagination-link, #pg .pagination-gap')]
      .map(el => el.textContent.trim() || el.getAttribute('aria-label'))
      .join(' ');
  `), 'Previous page 1 … 6 7 8 9 10 … 18 Next page',
    'mid-range the window is compressed on BOTH sides')

  t.is(await t.evaluate(`return document.querySelectorAll('#pg .pagination-gap').length;`), 2,
    'and both ellipses survive the keyed list')
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#pg .pagination-gap')]
      .every(el => el.getAttribute('aria-hidden') === 'true');
  `), true, 'an ellipsis is not announced — it is not a control')

  /* ── the last page ────────────────────────────────────────────────────── */

  await t.clickAt('#pg [aria-label="Page 18"]')
  await t.eventually(current, '18', 'the last page is reachable in one click')
  await t.eventually(`document.querySelector('#pg [aria-label="Next page"]').disabled`, 'true',
    'Next is disabled there')
  await t.eventually(`
    document.querySelector('#pg p').textContent.replace(/\\s+/g, ' ').trim()
  `, 'Showing 426–450 of 450', 'and the final range stops at the total, not at a full page')

  /* ── compact ──────────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`
    return document.querySelector('#pg-compact .pagination span').textContent.replace(/\\s+/g, ' ').trim();
  `), 'Page 3 of 10', 'compact states the position instead of listing it')
  t.is(await t.evaluate(`
    return document.querySelectorAll('#pg-compact .pagination-link').length;
  `), 2, 'and offers only the two steps')
  t.is(await t.evaluate(`return document.querySelectorAll('#pg-compact p').length;`), 0,
    'showInfo={false} drops the info line')

  /* ── the table ────────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return document.querySelectorAll('#tbl tbody tr').length;`), 3,
    'a row snippet renders one row per record')
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#tbl tbody tr')].map(r => r.dataset.row).join(',');
  `), '0,1,2', 'and is handed the index as well as the record')
  t.ok(await t.evaluate(`
    return ${headers}.every(th => th.getAttribute('scope') === 'col');
  `), 'every header is scoped to its column')

  /* ── sorting ──────────────────────────────────────────────────────────── */

  // aria-sort is the state, not a class — it is what a screen reader
  // announces, so a strip whose arrow and aria-sort disagree is two answers.
  t.is(await t.evaluate(`
    return ${headers}.map(th => th.getAttribute('aria-sort') ?? 'absent').join(',');
  `), 'none,absent,none', 'a sortable column starts at none; a plain one says nothing at all')
  t.is(await t.evaluate(`
    return document.querySelectorAll('#tbl thead button').length;
  `), 2, 'and only a sortable column gets a button — a header is not a click target')

  await t.clickAt('#tbl thead th:first-child button')
  await t.eventually(`document.querySelector('#sort').textContent`, 'name:asc',
    'clicking a sortable header sorts by it, ascending')
  await t.eventually(`${headers}[0].getAttribute('aria-sort')`, 'ascending',
    'and announces the direction')

  await t.clickAt('#tbl thead th:first-child button')
  await t.eventually(`document.querySelector('#sort').textContent`, 'name:desc',
    'clicking it again reverses')
  await t.eventually(`${headers}[0].getAttribute('aria-sort')`, 'descending', 'and says so')

  // Moving to another column starts that one ascending rather than inheriting
  // the direction the previous column happened to be left in.
  await t.clickAt('#tbl thead th:last-child button')
  await t.eventually(`document.querySelector('#sort').textContent`, 'total:asc',
    'a different column starts ascending again')
  t.is(await t.evaluate(`
    return ${headers}.map(th => th.getAttribute('aria-sort') ?? 'absent').join(',');
  `), 'none,absent,ascending', 'and the column that was sorted goes back to none')

  /* ── loading ──────────────────────────────────────────────────────────── */

  // The state that could not render at all until FJS-147 — `{#each { length: n }}`
  // threw, so every table that ever showed a spinner died instead.
  await t.clickAt('#toggle-loading')
  await t.eventually(`document.querySelectorAll('#tbl tbody tr[aria-busy=true]').length`, '5',
    'loading draws skeleton rows')
  t.is(await t.evaluate(`return document.querySelectorAll('#tbl tbody [data-row]').length;`), 0,
    'and no data rows at the same time')
  t.is(await t.evaluate(`
    return document.querySelectorAll('#tbl tbody tr:first-child td').length;
  `), 3, 'a skeleton row spans the same columns')

  await t.clickAt('#toggle-loading')
  await t.eventually(`document.querySelectorAll('#tbl tbody [data-row]').length`, '3',
    'and the rows come back')

  /* ── empty ────────────────────────────────────────────────────────────── */

  await t.clickAt('#empty-rows')
  await t.eventually(`document.querySelector('#tbl .empty-text')?.textContent?.trim()`,
    'No results found', 'no rows is an empty state, not a blank table')
  t.is(await t.evaluate(`
    return document.querySelector('#tbl tbody td').getAttribute('colspan');
  `), '3', 'which spans every column, so it is centred rather than in column one')

  await t.clickAt('#refill-rows')
  await t.eventually(`document.querySelectorAll('#tbl tbody [data-row]').length`, '3',
    'and rows arriving replaces it')
}
