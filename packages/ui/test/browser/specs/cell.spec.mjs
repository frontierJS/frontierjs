/*
 * cell.spec.mjs — the read renderer, and the bug its own ruling names.
 *
 * `FJS-D242` was minted because a generated list stringified values by their JS
 * TYPE, and its sentence for why is this: `@money` holds MINOR UNITS, so a
 * price came out as `1299` — wrong in the way that looks right, which is the
 * only way a number goes wrong quietly.
 *
 * `Cell` replaced those five lines and shipped with the same defect one order
 * of magnitude along. `formatMoney` takes MAJOR units, so 1299 cents rendered
 * as `$1,299.00`: still a hundred times wrong, now wearing a currency symbol,
 * which reads as correct where the raw integer at least read as raw. The form
 * control one surface along had used `fromMinor` from the day it was written.
 *
 * Nothing caught it, and the reason is this file's whole justification: this
 * was the ONE component the kit's drive had never opened (71 of 72). The other
 * uncovered one was `FilterBar`, and it shipped completely dead (`FJS-1046`).
 * Two components, one gap, two defects.
 *
 * Every money row here is a PAIR with a plain `number` column holding the SAME
 * integer. One value, two declarations, two answers — a claim neither cell can
 * make alone, and the one an implementation reading the JS type cannot satisfy.
 */
export const name = 'Cell — the read renderer'
export const covers = ['display/Cell']

const text = (id) => `document.getElementById(${JSON.stringify(id)}).textContent.trim()`

export async function run(t) {
  await t.mount('cell')

  /* ── money, and the pair that decides it ──────────────────────────────── */

  t.is(await t.evaluate(`return ${text('money')}`), '$12.99',
    'a @money column renders MINOR units in the currency scale')
  t.is(await t.evaluate(`return ${text('count')}`), '1299',
    'and the same integer as a plain number renders unchanged — the pair')

  // JPY has no minor unit, so an implementation that divided by 100 always is
  // right about dollars and wrong here. The scale comes from the CURRENCY.
  t.is(await t.evaluate(`return ${text('yen')}`), '¥1,299',
    'a currency with no minor unit is not divided')

  // `x-money` has three shapes and only the stated-currency one was carried:
  // `field:` reached the cell as `currency: undefined` and the column holding
  // the answer was never named, so every row of a multi-currency table rendered
  // in the app default.
  t.is(await t.evaluate(`return ${text('perrow')}`), '¥1,299',
    'a currency held per ROW is read off the record')
  t.is(await t.evaluate(`return ${text('noccy')}`), '$12.99',
    'and with neither, the default still converts')

  // A per-row currency is a value out of the data, so it can be anything a row
  // holds. `fromMinor` refuses a non-ISO code by THROWING, and an exception in
  // one cell takes the whole table down.
  t.is(await t.evaluate(`return ${text('badccy')}`), '—',
    'a currency code the row got wrong is one empty cell, not a dead table')
  t.is(await t.evaluate(`return ${text('nanmoney')}`), '—',
    'and an amount that is not a number is the dash, never an empty cell')

  /* ── nothing, and the thing that is not nothing ───────────────────────── */
  //
  // The component's own rule: an empty cell and a cell holding an empty string
  // look identical and mean different things. Asserted as a PAIR, or a renderer
  // that dashed everything falsy satisfies the first row alone.

  t.is(await t.evaluate(`return ${text('null')}`), '—', 'null renders the em dash')
  t.is(await t.evaluate(`return ${text('blank')}`), '',
    'an empty STRING is a value and is not the dash')
  t.is(await t.evaluate(`return ${text('zero')}`), '0',
    'and zero is a number, not nothing')

  /* ── what the DECLARATION answers and a JS type cannot ────────────────── */

  t.is(await t.evaluate(`return ${text('enum')}`), 'Awaiting payment',
    "an enum renders its @label, not awaiting_payment")
  t.is(await t.evaluate(`return ${text('enumbare')}`), 'paid',
    'and a member with no label falls back to its name — the pair')
  t.is(await t.evaluate(`return ${text('bool')}`), 'no',
    'false is "no" and not an empty cell, which is what a falsy test would give')

  // An instant is a moment everyone shares; a wall clock is a reading on
  // somebody's wall, and localizing the second moves an appointment. So only a
  // resolved instant is localized — asserted as *the wall value is verbatim*,
  // which is the half that is wrong in a way nobody in the authoring timezone
  // would ever see.
  t.is(await t.evaluate(`return ${text('wall')}`), '2026-01-02',
    'a wall-clock date is rendered verbatim, in nobody’s zone')
  const inst = await t.evaluate(`return ${text('instant')}`)
  t.ok(inst && inst !== '2026-01-02T03:04:05Z',
    'an instant IS localized, so it is not the string it arrived as')

  /* ── a column the table could not place ───────────────────────────────── */
  //
  // `displayFor` answers `display: null` WITH a reason rather than dropping the
  // column, which is the rule `controlFor` already followed. The cell shows the
  // nothing it has and carries the reason for whoever generated the table.

  const unplaced = await t.evaluate(`
    const el = document.querySelector('#unplaced [title]');
    return { text: document.getElementById('unplaced').textContent.trim(), title: el?.title ?? null };
  `)
  t.is(unplaced.text, '—', 'an unplaceable column renders the dash')
  t.is(unplaced.title, 'a Json document matches as text',
    'and carries displayFor’s own reason, rather than pretending')

  /* ── a registration beats the built-in branch ─────────────────────────── */

  t.ok(await t.evaluate(`return !!document.querySelector('#registered .badge')`),
    'a registered display claims the name, exactly as a control does')

  /* ── the attribute contract ───────────────────────────────────────────── */
  //
  // A branch contributes the CONTENT and never the box, so a table putting
  // `class="right"` on a money cell reaches the same element whatever the
  // column turned out to be — including one an app's own display claimed.

  const attrs = await t.evaluate(`
    const el = document.querySelector('#attrs > *');
    return {
      tag: el?.tagName, right: el?.classList.contains('right'),
      cell: el?.classList.contains('cell'), kind: el?.classList.contains('cell-money'),
      tabular: el?.classList.contains('tabular'), probe: el?.dataset.probe ?? null,
      children: document.getElementById('attrs').children.length,
    };
  `)
  t.is(attrs.children, 1, 'one element per cell')
  t.is(attrs.tag, 'SPAN', 'and it is the wrapper')
  t.ok(attrs.right && attrs.probe === 'yes', 'the caller’s class and data-* land on it')
  t.ok(attrs.cell && attrs.kind, 'beside the component’s own, rather than replacing them')
  t.ok(attrs.tabular, 'and a numeric column lines its digits up')

  const plain = await t.evaluate(`
    return document.querySelector('#null > *')?.classList.contains('tabular') ?? null;
  `)
  t.is(plain, false, 'a name does not — tabular is a property of the KIND, not the cell')
}
