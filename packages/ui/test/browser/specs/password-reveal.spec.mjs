/*
 * The show/hide toggle on a password field.
 *
 * A password box with no way to read back what was typed is the commonest
 * cause of a sign-in that fails looking like a wrong credential, so the kit
 * draws the affordance rather than every app drawing its own. What has to
 * hold: only the ELEMENT's type flips (the field still IS a password to
 * everything above it), the caret survives a mouse click on the toggle, and
 * the three ways of not wanting one all produce no button.
 */
export const name = 'password reveal toggle'
export const covers = ['forms/Input']

const btn = (scope) => `document.querySelector('#${scope} button[aria-pressed]')`

export async function run(t) {
  await t.mount('password-reveal')

  const counts = await t.evaluate(`
    const n = (id) => document.querySelectorAll('#' + id + ' button[aria-pressed]').length;
    return { auto: n('auto'), off: n('off'), text: n('text'), withicon: n('withicon') };
  `)
  t.is(counts.auto, 1, 'a password field draws exactly one toggle')
  t.is(counts.off, 0, 'reveal={false} turns it off')
  t.is(counts.text, 0, 'a text field has nothing to reveal')
  t.is(counts.withicon, 1, 'a caller icon and the toggle share the row')

  t.ok(await t.evaluate(`return !!document.querySelector('#withicon #caller-icon');`),
    'and the caller icon is still rendered beside it')

  const start = await t.evaluate(`
    const el = document.querySelector('#auto input');
    const b  = ${btn('auto')};
    return { type: el.type, pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), controls: b.getAttribute('aria-controls') === el.id };
  `)
  t.is(start.type, 'password', 'it starts hidden')
  t.is(start.pressed, 'false', 'and the toggle says so')
  t.is(start.label, 'Show password', 'the button is named for the action, not the state')
  t.ok(start.controls, 'and points at the input it governs')

  // Focus the input first: a mousedown on the toggle would otherwise blur it
  // and take the caret with it, which costs a typist their place mid-password.
  await t.evaluate(`document.querySelector('#auto input').focus(); return true;`)
  await t.clickAt('#auto button[aria-pressed]')

  await t.eventually(`document.querySelector('#auto input').type`, 'text', 'a click reveals the value')
  t.is(await t.evaluate(`return ${btn('auto')}.getAttribute('aria-pressed');`), 'true',
    'and the toggle reports itself pressed')
  t.is(await t.evaluate(`return document.activeElement === document.querySelector('#auto input');`), true,
    'the caret never left the input')
  t.is(await t.evaluate(`return document.querySelector('#auto input').value;`), 'hunter2',
    'and the value survived the type change')

  // The FIELD is still a password — only the element flipped. Field forwards
  // the declared type to Label, so a revealed password must not start
  // reporting itself as a text box to anything above the control.
  t.is(await t.evaluate(`return document.querySelector('#auto input').autocomplete;`), 'current-password',
    'the password autocomplete hint is untouched')

  await t.clickAt('#auto button[aria-pressed]')
  await t.eventually(`document.querySelector('#auto input').type`, 'password', 'clicking again hides it')
}
