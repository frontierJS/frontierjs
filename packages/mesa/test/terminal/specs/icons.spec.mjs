/*
 * icons — `fixtures/Icons.mesa`: a control whose only content is an icon
 * (FJS-2282).
 *
 * A green run pins what a screen reader says for a button or link with no text
 * of its own: its `aria-label`, in place of the `[  ]` an `aria-hidden` icon
 * leaves. A control with text paints that text alone, and the label gives way
 * the moment text arrives and returns when it goes.
 */
export const name = 'icons'

export async function run(t) {
  const Icons = await t.compile('Icons')
  await t.mount(Icons, {}, { height: 8 })
  await t.settle()

  let frame = await t.frame()
  t.expectFrame(frame, ['[ Close ]', '[ Save ]', '[ Maybe ]', 'Home'], 'an icon-only button or link paints its aria-label')
  t.ok(!frame.includes('Ignored'), 'a label is not painted over text')

  await t.click('[ Fill ]')
  frame = await t.frame()
  t.expectFrame(frame, ['[ Now ]'], 'a button that gains text paints the text')
  t.ok(!frame.includes('Maybe'), 'and gives up the label')
}
