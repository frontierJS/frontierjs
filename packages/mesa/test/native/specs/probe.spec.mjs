/*
 * probe — the DOM habits a phone changes. A synchronous rect read finds
 * nothing, `measure()` and `focus()` answer by callback, and typing reaches
 * `bind:value`. The runtime defers the answer even where Lynx for Web could
 * give it at once, so this fails here where it would fail on a phone.
 */
export async function run(t) {
  await t.open('Probe')
  await t.eventually(t.shows('measure: pending', 'focus: pending'), true, 'it paints')
  await t.tap('Measure')
  await t.eventually(t.shows('sync: none'), true, 'a synchronous read finds no rect')
  await t.eventually(t.shows('measure: 120x40'), true, 'measure() answers the box')
  await t.tap('Focus')
  await t.eventually(t.shows('focus: 0'), true, 'focus() answers by callback')
  await t.typeInto(0, 'hi')
  await t.eventually(t.shows('typed: hi'), true, 'typing reaches bind:value')
}
