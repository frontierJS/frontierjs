/*
 * A control is turned OFF by the property, never by the attribute alone.
 *
 * `el.checked` and `el.value` stop reflecting their attribute the moment
 * either is written to — the DOM's own dirty flag — so a runtime that answers
 * a falsy value with `removeAttribute` can switch a control on and never off
 * again. The state says one thing, the screen says the other, and nothing
 * reports the disagreement.
 *
 * Nothing but a real browser can see it: happy-dom keeps no dirty flag, so the
 * whole class is invisible to the vitest suites — which is why `<Switch
 * bind:checked>` was one-way for as long as it existed.
 */
export const name = 'dirty DOM props'
export const covers = ['set_attribute', 'bindAttribute']

export async function run(t) {
  await t.mount('dirty-props')

  const box = `document.querySelector('#box')`
  const st  = `document.querySelector('#state').textContent`

  t.is(await t.evaluate(`return ${box}.checked;`), false, 'the box starts unchecked')

  await t.clickAt('#on')
  await t.eventually(`${box}.checked`, true, 'the app can switch it on')
  t.is(await t.evaluate(`return ${st};`), 'true', 'and the state agrees')

  // The assertion this file exists for. Going ON writes the property, which
  // sets the dirty flag; going OFF used to only remove the attribute, which a
  // dirty control ignores.
  await t.clickAt('#off')
  await t.eventually(`${box}.checked`, false, 'and can switch it off again — the property is reset, not just the attribute')
  t.is(await t.evaluate(`return ${st};`), 'false', 'with the state and the control still agreeing')

  // Twice, because a one-shot reset would pass the round trip above.
  await t.clickAt('#on')
  await t.eventually(`${box}.checked`, true, 'on')
  await t.clickAt('#off')
  await t.eventually(`${box}.checked`, false, 'off — and it is not a one-time recovery')

  /* ── an ARIA false is a statement, not an absence ─────────────────────── */

  // `aria-expanded={false}` removing the attribute announces the control as a
  // different KIND of thing — absent means *not expandable*, "false" means
  // *expandable and closed*. Same for aria-selected, aria-pressed,
  // aria-checked. It is silent, and the page looks correct.
  const aria = `document.querySelector('#aria')`
  t.is(await t.evaluate(`return ${aria}.getAttribute('aria-expanded');`), 'false',
    'a false ARIA attribute is written, not removed')
  t.is(await t.evaluate(`return ${aria}.getAttribute('aria-selected');`), 'false',
    'and so is the one beside it')
  t.is(await t.evaluate(`return ${aria}.hasAttribute('aria-hidden');`), false,
    'null still removes — which is what the `x || null` idiom is for')
  // And the rule is those four states, not every aria-*: a string-valued one
  // must lose its attribute, because "false" would NAME the element false.
  t.is(await t.evaluate(`return ${aria}.hasAttribute('aria-label');`), false,
    'a false string-valued ARIA attribute is removed, not written')

  await t.clickAt('#on')
  await t.eventually(`${aria}.getAttribute('aria-expanded')`, 'true', 'and it still says true')
  await t.clickAt('#off')
  await t.eventually(`${aria}.getAttribute('aria-expanded')`, 'false', 'and false again, both directions')

  // The same rule for a text control, and it must be `null` rather than `''`:
  // an empty string is a value and takes the ordinary property path, so a
  // spec written against `''` passes with the reset deleted.
  t.is(await t.evaluate(`return document.querySelector('#field').value;`), 'seeded',
    'the text box starts on its seeded value')
  await t.clickAt('#clear')
  await t.eventually(`document.querySelector('#field').value`, '',
    'a binding that goes null clears what is on screen, not just the attribute')
}
