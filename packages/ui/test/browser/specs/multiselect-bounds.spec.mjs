/*
 * multiselect-bounds.spec.mjs — min, max, and what single mode commits.
 *
 * `FJS-398`: three functions mutated the selection and two of them checked the
 * bounds. `clearAll` did not, so one click on the × emptied a control declared
 * `min={2}` and committed it — a form holding a selection its own declaration
 * forbids, with nothing noticing until the write. Per-action guards are how
 * that happens: nothing makes the third mutator declare itself.
 *
 * The guard now lives at `commitValue`, the one place the selection changes,
 * and it is asked about the DIRECTION of a change rather than the state it
 * lands in — which is the half a naive fix gets wrong. A control declared
 * `min={2}` starts empty and must reach two somehow, so refusing every state
 * below the floor refuses the first add and the field can never be filled.
 * Both directions are asserted here; only asserting the refusal would pass
 * against a component nobody can type into.
 *
 * Asserted through the committed VALUE rather than the token count, because a
 * value written back that the view does not show is exactly the shape of the
 * single-mode defect fixed alongside it.
 */
export const name = 'MultiSelect — selection bounds'
export const covers = ['forms/MultiSelect']

const state = `
  const el = document.querySelector('#state');
  return JSON.parse(el.textContent);
`

// The × inside one control. Scoped, because three MultiSelects are mounted,
// and matched on the label the component actually writes — a selector that
// misses would leave the value unchanged and the refusal assertion would pass
// for the wrong reason.
const clearIn = (id) => `${id} button[aria-label="Clear all"]`

export async function run(t) {
  await t.mount('multiselect-bounds')

  /* ── the floor refuses a removal, in every spelling ───────────────────── */

  const before = await t.evaluate(state)
  t.is(before.atFloor.length, 2, 'the min-satisfied control starts at its floor')

  // Clear-all is the one that was unguarded. It has to refuse exactly as a
  // single removal does.
  const clear = await t.evaluate(`
    const el = document.querySelector('${clearIn('#at-floor')}');
    if (!el) return 'no-clear-control';
    el.click();
    await waitSettled('body');
    return 'clicked';
  `)

  // Asserted BEFORE the value, because "the button was not there" and "the
  // button was refused" leave the same value behind.
  t.is(clear, 'clicked', 'the clear-all control is present and was clicked')

  const afterClear = await t.evaluate(state)
  t.is(afterClear.atFloor.length, 2, 'clear-all is refused at min')

  /* ── …and the same floor still lets an empty control be filled ────────── */

  t.is(afterClear.belowFloor.length, 0, 'the below-floor control starts empty')

  await t.evaluate(`
    const box = document.querySelector('#below-floor input');
    box.focus();
    await waitSettled('body');
  `)
  await t.evaluate(`
    const opt = document.querySelector('#below-floor .fjs-multiselect-option');
    if (opt) opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    if (opt) opt.click();
    await waitSettled('body');
  `)

  const afterAdd = await t.evaluate(state)
  t.ok(afterAdd.belowFloor.length >= 1,
    'an add below the floor is allowed — min is a floor on the finished value, not on every state')

  /* ── single mode replaces rather than accumulating ────────────────────── */

  // The set kept every pick and `value` read index 0, so choosing a second
  // option changed the set, changed nothing visible, and wrote back the first.
  t.is(afterAdd.single, 'email', 'single starts at its bound value')

  await t.evaluate(`
    const box = document.querySelector('#single input');
    box.focus();
    await waitSettled('body');
  `)
  const picked = await t.evaluate(`
    const opts = [...document.querySelectorAll('#single .fjs-multiselect-option')];
    const target = opts.find(o => !/email/i.test(o.textContent));
    if (!target) return null;
    const label = target.textContent.trim();
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.click();
    await waitSettled('body');
    return label;
  `)

  const afterSingle = await t.evaluate(state)
  if (picked) {
    t.ok(afterSingle.single !== 'email',
      `single mode replaces rather than keeping the first pick (chose ${picked}, value ${JSON.stringify(afterSingle.single)})`)
    t.ok(!Array.isArray(afterSingle.single),
      'and single mode commits a scalar, not an array')
  } else {
    t.ok(false, 'no second option was reachable in the single-mode dropdown')
  }
}
