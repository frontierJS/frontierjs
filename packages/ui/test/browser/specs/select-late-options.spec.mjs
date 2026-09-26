/*
 * select-late-options.spec.mjs — a picker shows its value when the list comes second.
 *
 * An edit screen has the row before the lists its pickers offer. The select
 * applied its value when the VALUE changed and never when the OPTIONS did, so
 * the browser selected the first option it was given: measured on an issue
 * page, five pickers read Backlog, none, Nobody, No project and No cycle over
 * a row that was none of those, and a person correcting what they saw
 * overwrote what was stored (`FJS-1320`).
 *
 * The runtime half is mesa's own `select-late-options` spec. This is the kit's:
 * both doors a list reaches a <Select> by — passed in by the caller once it has
 * it, and fetched by a <Form> for the control.
 *
 * The last block is a refused change, and it asserts the PATTERN rather than
 * the kit (`FJS-D380`): a one-way `value` is where the control starts, so the
 * caller that can refuse a pick keeps a draft through `bind:value` and puts it
 * back. Pinned here so the advice in the README cannot stop working unseen.
 */
export const name = 'a select whose options arrive after its value'
export const covers = ['forms/Select']

const value = (root, name) => `document.querySelector('${root} select[name=${name}]')?.value ?? ''`

export async function run(t) {
  await t.mount('select-late-options')

  await t.clickAt('#load')
  await t.eventually(value('#passed', 'state'), 'progress',
    'options passed after mount — the bound value is selected, not the first option')

  await t.eventually(value('#fetched', 'status'), 'bravo',
    'options a form fetched — the value is selected once the request answers, not the placeholder')

  /* ── a refused change, with the caller holding a draft ─────────────── */

  const refused = value('#refused', 'state')
  const pick = (v) => t.evaluate(`
    const el = document.querySelector('#refused select[name=state]');
    el.value = '${v}';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  `)

  await pick('backlog')
  await t.eventually(refused, 'progress', 'a refused pick is put back once the refusal arrives')
  t.is(await t.evaluate(`return document.querySelector('#row').textContent;`), 'progress',
    'and the row it disagreed with never moved')

  // Twice, and to the same refused value: a draft that only went back once, or
  // only when the value differed from the last one pushed, passes the first.
  await pick('backlog')
  await t.eventually(refused, 'progress', 'and again, the same refused value a second time')

  await pick('done')
  await t.eventually(`document.querySelector('#row').textContent`, 'done', 'an allowed pick moves the row')
  t.is(await t.evaluate(`return ${refused};`), 'done', 'and stays on screen')

  // The `$:` half of the pattern: the row moving by some other door reaches
  // the control, which a draft initialized once would not.
  await t.clickAt('#elsewhere')
  await t.eventually(refused, 'backlog', 'a change to the row from elsewhere reaches the control')
}
