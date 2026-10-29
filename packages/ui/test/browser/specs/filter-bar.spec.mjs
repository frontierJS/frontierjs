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
/**
 * The last thing the bar handed back, parsed — `{ query, directives }`.
 *
 * TWO halves, because that is the contract: the router splits a URL into
 * filters and directives (Invariant 10) and the bar is what puts them back
 * together for display and takes them apart again on the way out. A spec that
 * read one merged bag could not tell a bar that split correctly from one that
 * handed everything back under `$` names.
 *
 * `q` is the filters and `d` the directives, unprefixed.
 */
const held = (path) => `(() => { const both = JSON.parse(${out} || '{}'); const q = both.query ?? {}; const d = both.directives ?? {}; return ${path} })()`

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

  /* ── search writes, and takes the paging with it ──────────────────────── */

  await t.clickAt(`${BAR} input[type="search"]`)
  await t.type('wid')
  // A DIRECTIVE, not a filter. `$search` is on Invariant 10's table — it is
  // served by `table.search()` under `@@fts`, not by a WHERE — so the split
  // puts it with the reading options even though it reads like a filter.
  await t.eventually(held(`d.search`), 'wid', 'typing in the box writes the search directive')
  await t.eventually(held(`q.$search ?? q.search ?? null`), null,
    'and it is NOT left among the filters, under either spelling')

  const paging = await t.evaluate('return ' + held(`({ off: d.offset ?? null, after: d.after ?? null, order: d.orderBy ?? null, limit: d.limit ?? null })`))
  t.is(paging.off, null, 'and drops the offset — page 3 of a different question is not page 3')
  t.is(paging.order, 'title', 'while the sort survives, because it is how you are reading')
  t.is(paging.limit, 20, 'and so does the page size')

  /* ── each control branch, separately ──────────────────────────────────── */
  //
  // Four kinds, three components, three different callback shapes. A branch
  // that forwards the wrong prop renders identically to one that works.
  //
  // The bar draws three inline and holds the rest behind `+ Filter`, so every
  // other branch is added first and driven as a chip.
  const addFilter = `[...document.querySelectorAll('${BAR} button')].find(b => b.textContent.trim() === '+ Filter')`
  t.is(await t.evaluate(`return document.querySelectorAll('${BAR} .filter-chip').length`), 0,
    'nothing is a chip before it is added or held')
  for (let i = 0; i < 8; i++) {
    await t.evaluate(`${addFilter}.click(); return true`)
    await t.evaluate(`return await waitVisible('[role=menu] [role=menuitem]');`)
    await t.clickAt('[role=menu] [role=menuitem]')
    await t.eventually(`document.querySelectorAll('${BAR} .filter-chip').length`, i + 1, `+ Filter adds filter ${4 + i} as a chip`)
  }
  t.is(await t.evaluate(`return !!${addFilter}`), false, 'and is gone once nothing is left to add')

  await t.clickAt(`${BAR} input[placeholder="Title"]`)
  await t.type('ab')
  await t.eventually(held(`q.title?.contains ?? null`), 'ab',
    'a text column writes through Input')

  // `total` is a `money` column: typed in dollars, filtered in cents, and
  // committed when the box is left rather than on each keystroke.
  await t.clickAt(`${BAR} input[aria-label="Total from"]`)
  await t.type('5')
  await t.press('Tab')
  await t.eventually(held(`q.total?.gte ?? null`), '500',
    'a money range writes through the low Input, in minor units')

  await t.clickAt(`${BAR} input[aria-label="Total to"]`)
  await t.type('9.5')
  await t.press('Tab')
  await t.eventually(held(`q.total?.lte ?? null`), '950',
    'and the high one, which is a second binding on the same branch')
  t.is(await t.evaluate(`return document.querySelector('${BAR} input[aria-label="Total to"]').value;`),
    '9.50', 'and the box shows the bound back in dollars')

  // Three decimals of a dollar is not an amount, and the filter already held
  // stays rather than being replaced by a guess.
  await t.evaluate(`
    const el = document.querySelector('${BAR} input[aria-label="Total from"]');
    el.value = '5.125';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
  await t.eventually(held(`q.total?.gte ?? null`), '500',
    'a bound with more decimals than the currency has is not written')

  // A to-many is filtered through its join: the operator sits under `some` and
  // the join's key, which is the shape the Data boundary takes.
  await t.evaluate(`
    document.querySelector('${BAR} input[placeholder="Tags"]').focus();
    await waitSettled('body');
  `)
  await t.evaluate(`
    const opt = document.querySelector('${BAR} .fjs-multiselect-panel .fjs-multiselect-option');
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    opt.click();
    await waitSettled('body');
  `)
  await t.eventually(held(`JSON.stringify(q.tags ?? null)`), '{"some":{"tagId":{"in":[1]}}}',
    'a to-many writes its set under some and the join key')

  // A relation past the cap is searched: row 250 is on no page the seed holds,
  // so only the server's answer to what was typed can offer it.
  const ownerRows = `[...document.querySelectorAll('${BAR} .fjs-multiselect-panel .fjs-multiselect-option')].map(o => o.textContent.trim()).join()`
  await t.clickAt(`${BAR} input[placeholder="Owner"]`)
  await t.eventually(ownerRows, 'Ada,Bo', 'a relation opens on the first page its entry fetched')
  await t.type('ze')
  await t.eventually(`JSON.stringify(window.ownerAsks.at(-1))`, '{"search":"ze","held":null}',
    'typing asks the entry\'s optionsFor with the term')
  await t.eventually(ownerRows, 'Zed', 'and offers the row only the search found')
  await t.evaluate(`
    const opt = document.querySelector('${BAR} .fjs-multiselect-panel .fjs-multiselect-option');
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    opt.click();
    await waitSettled('body');
  `)
  await t.eventually(held(`JSON.stringify(q.ownerId ?? null)`), '{"in":[250]}',
    'a searched pick is written as the value the column holds, not as text')
  await t.eventually(`document.querySelector('#held .pill')?.textContent.trim() ?? null`, 'Zed',
    'a pick held in the query is labeled by the seed, not shown as its id')

  // A plain number commits on change too, so a bound typed is one navigation.
  await t.clickAt(`${BAR} input[aria-label="Rate from"]`)
  await t.type('5')
  t.is(await t.evaluate(`return String(${held(`q.rate?.gte ?? null`)})`), 'null',
    'a number bound is not written while it is being typed')
  await t.press('Tab')
  await t.eventually(held(`q.rate?.gte ?? null`), '5',
    'a plain number range writes when the box is left')
  t.is(await t.evaluate(`return document.querySelector('${BAR} input[aria-label="Rate from"]').closest('.field-row')?.querySelectorAll('input').length ?? 0`),
    2, 'a range is one control: both bounds sit in a single field-row')

  // FJS-2610: clearing the last bound removes the key. It wrote an empty range,
  // {rate: {}}, a filter on nothing that kept Clear lit.
  await t.evaluate(`
    const el = document.querySelector('${BAR} input[aria-label="Rate from"]');
    el.value = '';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
  await t.eventually(held(`'rate' in q`), 'false',
    'clearing a range\'s last bound deletes the key rather than writing an empty range')

  // FJS-2610: the choice, once made, is shown. The query holds the boolean and
  // the segment holds its text, so a strict compare found none checked.
  const BOOL = `${BAR} [role="radiogroup"][aria-label="Active"]`
  const checked = `document.querySelector('${BOOL} input:checked')?.closest('label')?.textContent?.trim() ?? null`
  t.is(await t.evaluate(`return document.querySelectorAll('${BOOL} input[type="radio"]').length`), 3,
    'a boolean is one segmented control of three: Any, Yes, No')
  await t.eventually(checked, 'Any', 'and reads Any while the column is unfiltered')
  await t.clickAt(`${BOOL} label:nth-child(2)`)
  await t.eventually(held(`String(q.active?.equals ?? null)`), 'true', 'one click on Yes writes true')
  await t.eventually(checked, 'Yes', 'and Yes shows checked once it is chosen')
  await t.clickAt(`${BOOL} label:nth-child(3)`)
  await t.eventually(held(`String(q.active?.equals ?? null)`), 'false', 'No writes false, not a cleared key')
  await t.clickAt(`${BOOL} label:nth-child(1)`)
  await t.eventually(held(`'active' in q`), 'false', 'and Any deletes the key')

  // A declared enum this short is a row of toggles, several on at once; one
  // with seven members is still a MultiSelect (FJS-D1583).
  const CHIPS = `${BAR} [role="group"][aria-label="Status"]`
  const pressed = `[...document.querySelectorAll('${CHIPS} button[aria-pressed="true"]')].map(b => b.textContent.trim()).join()`
  t.is(await t.evaluate(`return document.querySelectorAll('${CHIPS} button[aria-pressed]').length`), 2,
    'a two-member enum is one toggle per member')
  t.is(await t.evaluate(`return !!document.querySelector('${BAR} input[placeholder="Stage"]') && !document.querySelector('${BAR} [role="group"][aria-label="Stage"]')`),
    true, 'and a seven-member enum stays a MultiSelect')
  await t.clickAt(`${CHIPS} button:nth-of-type(1)`)
  await t.eventually(held(`JSON.stringify(q.status ?? null)`), '{"in":["open"]}', 'one click on a toggle writes its member')
  await t.eventually(pressed, 'open', 'and shows it pressed')
  await t.clickAt(`${CHIPS} button:nth-of-type(2)`)
  await t.eventually(held(`JSON.stringify(q.status ?? null)`), '{"in":["open","paid"]}', 'a second toggle adds to the set')
  await t.clickAt(`${CHIPS} button:nth-of-type(1)`)
  await t.eventually(held(`JSON.stringify(q.status ?? null)`), '{"in":["paid"]}', 'clicking a pressed toggle removes its member')
  await t.clickAt(`${CHIPS} button:nth-of-type(2)`)
  await t.eventually(held(`'status' in q`), 'false', 'and releasing the last one deletes the key')

  /* ── a day range over an instant ──────────────────────────────────────── */
  //
  // The picker holds a day and the column an instant. Written through bare, *to
  // the 7th* was midnight at the START of the 7th and excluded all of it. The
  // spec's page runs in whatever zone the host is in, so the expected bounds
  // are built in the page the same way: the day's first and last local moment.
  //
  // Days are clicked in the month the picker opens on, the current one, so the
  // expected bounds are built from the current month too.
  const daysOf = (label) => `[...document.querySelectorAll('${BAR} .filter-days')]
    .find(s => s.querySelector('select')?.getAttribute('aria-label')?.startsWith('${label}:'))`
  const pickOp = (label, op) => t.evaluate(`
    const sel = ${daysOf(label)}.querySelector('select');
    sel.value = '${op}';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  const pickDay = (label, n) => t.evaluate(`
    const box = ${daysOf(label)};
    box.querySelector('button.filter-day').click();
    [...box.querySelectorAll('button.fjs-dp-day')]
      .find(b => b.querySelector('.fjs-dp-square')?.textContent.trim() === '${n}').click();
    return true;
  `)
  const onDay = (n, end) => t.evaluate(`
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), ${n} + (${end} ? 1 : 0));
    return ${end} ? new Date(d.getTime() - 1).toISOString() : d.toISOString();
  `)

  await pickDay('Seen', 7)
  await pickDay('Seen', 9)
  await t.eventually(held(`q.seenAt?.gte ?? null`), await onDay(7, false),
    'a day\'s lower bound over an instant is that day\'s first local moment')
  await t.eventually(held(`q.seenAt?.lte ?? null`), await onDay(9, true),
    'and its upper bound is the day\'s LAST moment, so the day is included')
  await t.eventually(`${daysOf('Seen')}.querySelector('button.filter-day').textContent.includes('–')`, true,
    'and the trigger shows the span picked, not the instants')

  // FJS-D1576: the open end is an operator. Switching keeps the day picked.
  await pickOp('Seen', 'after')
  await t.eventually(held(`[q.seenAt?.gte ?? '-', q.seenAt?.lte ?? '-'].join('|')`), `${await onDay(7, false)}|-`,
    'after keeps the lower bound and drops the upper one')

  await pickOp('Due', 'before')
  await pickDay('Due', 7)
  await t.eventually(held(`[q.dueOn?.gte ?? '-', q.dueOn?.lte ?? '-'].join('|')`),
    '-|' + await t.evaluate(`const n = new Date(); return [n.getFullYear(), String(n.getMonth() + 1).padStart(2, '0'), '07'].join('-')`),
    'before is an upper bound alone, and a Date column is a day that goes across as it is')

  // FJS-D1601: a preset writes relative days, even over an instant, and a query
  // holding them reads back as the preset rather than two dates.
  await pickOp('Seen', 'last7')
  await t.eventually(held(`[q.seenAt?.gte ?? '-', q.seenAt?.lte ?? '-'].join('|')`), '@today-6|@today',
    'a preset writes tokens, left for tethered() to resolve')
  t.match(await t.evaluate(`const s = ${daysOf('Seen')}.querySelector('select'); return s.options[s.selectedIndex].text`),
    /^Seen in the last 7 days$/, 'and reads back as its name')
  t.is(await t.evaluate(`return !!${daysOf('Seen')}.querySelector('button.filter-day')`), false,
    'and draws no picker')
  await pickOp('Seen', 'between')
  await t.eventually(held(`'seenAt' in q`), 'false', 'leaving a preset drops its tokens')

  // FJS-1978: an app whose day belongs to an account reads a bound in its zone.
  t.match(await t.evaluate(`return document.querySelector('#zoned .filter-days button.filter-day').textContent`),
    /Oct 22, 2026/, 'a bound over an instant shows its day in the timeZone prop, not the host\'s')

  t.is(await t.evaluate(`return document.querySelector('${BAR} input[aria-label="Opens from"]').type`), 'time',
    'an @time column is a wall clock and gets a time box, not a date')

  // The picker's trigger shows a day or "Any day", so the column's name is on
  // screen in the operator's option.
  t.match(await t.evaluate(`const s = ${daysOf('Seen')}.querySelector('select'); return s.options[s.selectedIndex].text`),
    /^Seen /, 'a day range shows its column name beside the picker')

  // Clear is lit only by a filter it can drop.
  await t.clickAt(`${BOOL} label:nth-child(2)`)
  await t.eventually(held(`String(q.active?.equals ?? null)`), 'true', 'Yes again, for Clear to drop')

  /* ── Clear ───────────────────────────────────────────────────────────── */
  //
  // Clear drops what is being ASKED — the filters and the search term — and
  // keeps how it is being READ. The two live on opposite sides of the split now,
  // which is why this row reads across both halves: a Clear that emptied the
  // directives too would take the sort and the page size with it.

  await t.clickAt(`${BAR} .filter-bar > button.btn`)
  await t.eventually(held(`[d.search ?? '-', q.title ?? '-', d.orderBy ?? '-', d.limit ?? '-'].join('|')`),
    '-|-|title|20', 'Clear drops the search and the filters, and keeps the reading')
  // Every directive but the search and the paging is part of the reading, not
  // only the two a hand-written list would name: a Clear that dropped
  // `onlyDeleted` turned a Trash view into the live rows (`FJS-2598`).
  t.is(await t.evaluate('return ' + held(`[d.onlyDeleted, d.select, d.populate, [].concat(d.scope).join(), d.asOf, d.offset ?? '-'].join('|')`)),
    'true|title|author|mine|2026-10-01|-', 'and keeps every other directive the list was read with')

  /* ── Every control has a NAME ─────────────────────────────────────────── */
  //
  // A placeholder is a hint and not an accessible name — it is not announced as
  // a label by every reader and it disappears as soon as somebody types. A bar
  // named by placeholder alone is a row of controls a screen reader calls
  // *edit text*, which is what an app's a11y sweep found the first time this
  // component reached a screen that runs one.
  //
  // Counted rather than spot-checked, and asserted as a PAIR: the number of
  // named controls against the number of controls. A probe that asked only
  // *does the first one have a label* passes with every other branch unnamed,
  // and there are five branches here.
  const named = await t.evaluate(`
    const all = [...document.querySelectorAll('${BAR} input, ${BAR} select')];
    const withName = all.filter(el =>
      el.getAttribute('aria-label')
      || el.getAttribute('aria-labelledby')
      || (el.id && document.querySelector('label[for="' + el.id + '"]'))
      || el.closest('label'));
    return all.length + '/' + withName.length;
  `)
  // The backreference is the assertion: the two counts must be EQUAL and the
  // first must be non-zero, so a bar that rendered nothing fails here rather
  // than passing vacuously.
  t.match(named, /^([1-9]\d*)\/\1$/,
    'every control the bar renders carries an accessible name')
}
