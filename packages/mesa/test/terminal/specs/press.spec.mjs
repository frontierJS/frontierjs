/*
 * press — `fixtures/Press.mesa`: `mousedown`, and `scroll` heard but never sent.
 *
 * A green run pins the browser's order for a press: `mousedown` at the
 * element under the pointer, bubbling once to an ancestor that listens, then
 * `click`. Preventing the `mousedown` keeps focus where it was, which is what
 * the kit's show-password button relies on, and the `click` still fires;
 * without the prevention the engine moves focus to the pressed button. A node
 * with no `click` hears a press of its own. `on:scroll` compiles, and a wheel
 * over the field sends nothing, since no terminal node scrolls. The four
 * drop-target events compile, and a mouse drag onto their node sends none.
 *
 * Then a `<textarea>`'s text, which is its value and never its children: the
 * engine aborts the process on a child added to a field. Static text is
 * the starting value, and a field holding a `value=` and the same text
 * shows it once.
 */
export const name = 'press'

export async function run(t) {
  const Press = await t.compile('Press')
  await t.mount(Press, {}, { height: 16 })
  await t.settle()
  let frame = await t.frame()
  t.expectFrame(frame, ['Row', 'one', 'kept'], 'a field\'s text is its value, not a child painted beside it')
  t.ok(!/kept.*kept/s.test(frame), 'the value beside its text shows once')

  await t.tab()                    // a
  await t.type('ab')
  await t.click('Hold')
  await t.type('c')
  frame = await t.frame()
  t.expectFrame(frame, ['value abc held 1', 'around 1 target button'], 'a prevented mousedown keeps focus in the field, and the click still fires')

  await t.click('Move')
  await t.type('d')
  frame = await t.frame()
  t.expectFrame(frame, ['value abc held 1 moved 1', 'around 2'], 'an unprevented press moves focus to the button, and the ancestor hears it once')

  await t.click('Row')
  frame = await t.frame()
  t.expectFrame(frame, ['around 2 target button row 1'], 'a node with no click hears a press of its own, outside the div')

  await t.wheel('one')
  frame = await t.frame()
  t.expectFrame(frame, ['scrolls 0'], 'a wheel over the field sends no scroll')

  await t.drag('Row', 'Drop')
  frame = await t.frame()
  t.expectFrame(frame, ['row 2', 'drops 0'], 'a drag from Row onto a drop target presses Row and sends no drag event')

  await t.click('one')
  frame = await t.frame()
  t.expectFrame(frame, ['start "one"'], 'the field holds its text as its value')
}
