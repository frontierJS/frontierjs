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
  // the option holds its text, so a strict compare found no option selected.
  await t.evaluate(`
    const el = document.querySelector('${BAR} select[aria-label="Active"]');
    el.value = 'true';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await t.eventually(held(`q.active?.equals ?? null`), 'true', 'a boolean filter writes true')
  await t.eventually(`document.querySelector('${BAR} select[aria-label="Active"]').selectedIndex`, '1',
    'and the select shows Yes once it is chosen')

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

  t.is(await t.evaluate(`return document.querySelector('${BAR} input[aria-label="Opens from"]').type`), 'time',
    'an @time column is a wall clock and gets a time box, not a date')

  // The picker's trigger shows a day or "Any day", so the column's name is on
  // screen in the operator's option.
  t.match(await t.evaluate(`const s = ${daysOf('Seen')}.querySelector('select'); return s.options[s.selectedIndex].text`),
    /^Seen /, 'a day range shows its column name beside the picker')

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
