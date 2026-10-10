/*
 * within — `fixtures/Within.mesa`: `focusin`/`focusout`, and a click-away.
 *
 * A green run pins the browser's order when focus moves, `blur`, `focusout`,
 * `focus`, `focusin`, and that the two `in`/`out` events bubble to a
 * container where `focus` and `blur` do not. Leaving the container sends
 * `focusout` and nothing after it. Then the kit's click-away shape: a
 * `<mesa:window on:click|capture>` asks `box.contains(e.target)`, so a click
 * inside the box leaves it open and one elsewhere closes it, and the window
 * hears the click before the button's own handler runs.
 */
export const name = 'within'

export async function run(t) {
  await t.mount(await t.compile('Within'), {}, { width: 60, height: 14 })
  await t.settle()

  await t.tab()                    // a
  let frame = await t.frame()
  t.expectFrame(frame, ['log focus:a in:a'], 'focus, then focusin heard at the container')

  await t.tab()                    // b
  frame = await t.frame()
  t.expectFrame(frame, ['focus:a in:a blur:a out:a in:b'], 'moving focus: blur, focusout, then focusin at the next field')
  t.ok(!/in:b.*focus:/.test(frame), 'focus does not bubble to the container')

  await t.tab()                    // c, outside the container
  frame = await t.frame()
  t.expectFrame(frame, ['in:a blur:a out:a in:b out:b'], 'leaving the container sends focusout and no focusin')

  await t.click('show')
  t.expectFrame(await t.frame(), ['open true', 'inner'], 'the box opens')

  await t.click('inner')
  frame = await t.frame()
  t.expectFrame(frame, ['out:b inner', 'open true'], 'a click inside the box leaves it open')

  await t.click('outside')
  frame = await t.frame()
  t.expectFrame(frame, ['inner elsewhere', 'open false'], 'a click elsewhere closes it, and still reaches its button')
  t.ok(!frame.includes('[ inner ]'), 'the inner button is gone')
}
