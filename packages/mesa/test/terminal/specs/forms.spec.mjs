/*
 * forms — `fixtures/Forms.mesa`: three `<form>`s whose listeners sit on the
 * form, not on the fields, which is how `@frontierjs/ui`'s `Form.mesa` tracks
 * every control under it.
 *
 * A green run pins the DOM's dispatch on the terminal: `input` and `change`
 * bubble from a field to its form, `blur` reaches the form only through
 * `|capture`, and a handler reads `e.target.name` / `e.target.value` as it
 * does in a browser. Then the default actions: Enter in a field clicks the
 * form's first submit button (HTML's implicit submission), a `<button>` with
 * no `type` submits and `type="button"` does not, a form with one field and
 * no button submits on Enter and a form with two does not. `|once` fires
 * once and leaves the default action in place. `bind:this` hands over the
 * node, `$.onMount` runs, and a local watch fires — the last two are no-ops
 * in a process the runtime takes for a server render.
 */
export const name = 'forms'

export async function run(t) {
  const Forms = await t.compile('Forms')
  await t.mount(Forms, {}, { height: 20 })
  await t.settle()

  let frame = await t.frame()
  t.expectFrame(frame, ['mounted yes'], '$.onMount ran, after bind:this handed over the form')

  await t.tab()                    // a
  await t.type('hi')
  frame = await t.frame()
  t.expectFrame(frame, ['watched hi', 'heard a=hi'], 'input bubbles to the form, which reads e.target; the watch fires')

  await t.tab()                    // b
  frame = await t.frame()
  t.expectFrame(frame, ['left a changed a=hi'], 'blur reaches the form by capture, and change fires on leaving an edited field')

  await t.type('x')
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['changed b=x', 'submits 1 by button', 'once 1'], 'Enter in a field clicks the first submit button, which submits')

  await t.tab()                    // Cancel
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['submits 1 by button cancels 1'], 'a type="button" fires its click and submits nothing')

  await t.tab()                    // Save
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['submits 2 by button cancels 1 once 1'], '|once fires once, and the button still submits')

  await t.tab()                    // q
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['quick 1 pair 0'], 'Enter in the one field of a form with no button submits it')

  await t.tab()                    // x
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['quick 1 pair 0'], 'Enter in a form with two fields and no button submits nothing')
}
