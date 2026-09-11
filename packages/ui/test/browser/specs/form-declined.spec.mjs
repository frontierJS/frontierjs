/*
 * form-declined.spec.mjs — a save that succeeded and kept a column.
 *
 * A field `@allow('write', …)` is a predicate over the caller AND the row. The
 * Data boundary answers it by keeping the stored value: the write succeeds,
 * every other column lands, and nothing throws. That is deliberate — the same
 * payload is legitimate for another caller, so a refusal by name would be wrong
 * — and it is why `<Form>`'s error path cannot cover it. There is no error.
 *
 * So the column reached the browser indistinguishable from an unpoliced one, a
 * generated form offered a box, a person ticked it, and the save button went
 * green over a write that never happened (`FJS-1071`).
 *
 * EVERY assertion here is a PAIR against the SAME form and the same payload,
 * with only the caller changed. Three ways this could be wrong and each is
 * asked from both sides:
 *
 *   • a message that never appears  — the admin half is the control
 *   • a message that ALWAYS appears — the admin half is again the control, and
 *     it is the one a naive `sent !== saved` comparison fails
 *   • a message on the wrong field  — `note` travels in both payloads and must
 *     never be reported, since a form that flagged the whole record would
 *     satisfy any assertion that only asks whether something is shown
 *
 * And the last one is the point of the feature rather than of the fix: the box
 * is NOT disabled, on either half. A control switched off by the flag is
 * switched off for every caller the predicate admits.
 */
export const name = 'Form — a write the boundary kept'
export const covers = ['forms/Form']

const isDisabled = (sel) =>
  `!!document.querySelector(${JSON.stringify(sel)})?.disabled`

// The message under a control, whatever the kit wraps it in. A checkbox is not
// in a `.field-group` — it is a `.field-check` label inside a `.stack` — so the
// anchor is whichever of the two this control actually sits in. Getting that
// wrong reads as *no message* against a form that is showing one.
const messageNear = (name) => `
  const box = document.querySelector('#form [name=${name}]');
  const group = box?.closest('.field-group, .stack') ?? box?.parentElement;
  return (group?.textContent ?? '').trim();
`

// The kit marks an invalid control on the control itself, which is what
// assistive tech announces — asked beside the text, because a message rendered
// with no `aria-invalid` is a sentence a screen reader never reaches.
const invalid = (name) =>
  `!!document.querySelector('#form [name=${name}]')?.matches('[aria-invalid="true"]')`

async function tick(t, sel, on) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    el.checked = ${on ? 'true' : 'false'};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    return true;
  `)
}

async function typeInto(t, sel, value) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
}

const submit = () => `
  document.querySelector('#form form').requestSubmit();
  return true;
`

export async function run(t) {
  await t.mount('form-declined')

  /* ── the affordance that is deliberately absent ───────────────────────── */

  // The flag is not the predicate, so nothing here knows whether THIS caller
  // may write the column — and a box switched off by it is switched off for
  // every caller who may. This assertion is the ruling, not an oversight.
  t.ok(!await t.evaluate(`return ${isDisabled('#form [name=isStaff]')};`),
    'a write-policied column is NOT disabled — the flag is not the predicate')
  t.ok(!await t.evaluate(`return ${isDisabled('#form [name=note]')};`),
    'and neither is the ordinary column beside it')

  /* ── the caller the predicate refuses ─────────────────────────────────── */

  await t.evaluate(`window.kitActAs('shopper'); return true;`)
  await tick(t, '#form [name=isStaff]', true)
  await typeInto(t, '#form [name=note]', 'shopper edit')
  await t.evaluate(submit())
  await t.eventually(`window.kitSent().length`, 1, 'the form saves')

  // The write went out — this is not a client-side strip, and must not become
  // one: the boundary is the thing that decides, and it decides per row.
  t.ok(await t.evaluate(`return window.kitSent()[0].keys.includes('isStaff');`),
    'the policed column is still SENT — the boundary decides, not the form')

  const kept = await t.evaluate(messageNear('isStaff'))
  t.ok(/permission/i.test(kept),
    'and the form says the column was not changed')

  t.ok(await t.evaluate(`return ${invalid('isStaff')};`),
    'and marks the control invalid, which is what assistive tech announces')

  const beside = await t.evaluate(messageNear('note'))
  t.ok(!/permission/i.test(beside),
    'while the column that DID land says nothing')
  t.ok(!await t.evaluate(`return ${invalid('note')};`),
    'and is not marked invalid either')

  /* ── the pair: the same payload, from a caller who may ────────────────── */

  await t.evaluate(`window.kitActAs('admin'); return true;`)
  await tick(t, '#form [name=isStaff]', true)
  await typeInto(t, '#form [name=note]', 'admin edit')
  await t.evaluate(submit())
  await t.eventually(`window.kitSent().length`, 2, 'the second save goes out')

  const admin = await t.evaluate(messageNear('isStaff'))
  t.ok(!/permission/i.test(admin),
    'an identical payload from a caller who may write it reports nothing')
  t.ok(!await t.evaluate(`return ${invalid('isStaff')};`),
    'and the control is not left marked from the save before it')
}
