/*
 * widget — `fixtures/Widget.mesa`: a focusable ARIA widget built from a
 * `<div>` (FJS-2505).
 *
 * A green run pins what a browser gives one on a terminal: `tabindex="0"` is
 * a Tab stop that hears `keydown`, and `-1` is not one. A widget role with an
 * `aria-label` and no content of its own paints what a screen reader
 * announces, the label then `aria-valuetext`, else `aria-valuenow`, and
 * repaints as they change. A widget with content of its own paints that
 * content alone, and a role that is no widget paints nothing it was not given.
 */
import { TextAttributes } from '@opentui/core'

export const name = 'widget'

export async function run(t) {
  const Widget = await t.compile('Widget')
  await t.mount(Widget, {}, { height: 12 })
  await t.settle()

  let frame = await t.frame()
  t.expectFrame(frame, ['Minimum 5 px', 'Skipped 3', 'Tab text', 'Not a widget'], 'a widget with no content paints its label and value')
  t.ok(!frame.includes('Ignored name') && !frame.includes('Quiet'), 'a label is not painted over content, nor for a role that is no widget')

  await t.tab()
  await t.tab()
  t.is((await t.attributesAt('Minimum')) & TextAttributes.INVERSE, TextAttributes.INVERSE, 'a tabindex of 0 is a Tab stop, inverted while focused')
  await t.press('ARROW_RIGHT')
  t.expectFrame(await t.frame(), ['value 6', 'Minimum 6 px'], 'an arrow key reaches its keydown listener, and the announcement follows')

  await t.tab()
  t.is((await t.attributesAt('Skipped')) & TextAttributes.INVERSE, 0, 'a tabindex of -1 is no Tab stop')
  t.is((await t.attributesAt('Tab text')) & TextAttributes.INVERSE, TextAttributes.INVERSE, 'so Tab goes on to the next widget')
  await t.press('x')
  t.expectFrame(await t.frame(), ['heard x'], 'which hears its keys')
}
