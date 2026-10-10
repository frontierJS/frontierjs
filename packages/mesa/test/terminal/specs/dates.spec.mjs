/*
 * dates — `fixtures/Dates.mesa`: the date family of `<input>` (`FJS-2506`).
 *
 * A green run pins `date`, `time`, `datetime-local`, `month` and `week` as a
 * text field typed in the value's own format. The format is the placeholder,
 * whatever the author wrote. `value` reads `''` until the text is a whole
 * valid value, to a handler and to a bind alike, and that `''` written back
 * leaves the half-typed text in the box. A malformed static value is stored
 * as `''`, by HTML's rules: no February 30th, no month 13, no hour 25, and a
 * 53rd week only in a year that has one. A `datetime-local` reads back with a
 * `T` and its zero seconds dropped. A live `type` from `text` to `date`
 * clears text that is no date.
 */
export const name = 'dates'

export async function run(t) {
  const Dates = await t.compile('Dates')
  await t.mount(Dates, {}, { width: 60, height: 20 })
  await t.settle()
  let frame = await t.frame()
  t.expectFrame(frame, ['d [] reads [-] dt [2026-10-10 09:30:00]'], 'nothing is read before anything is typed')
  t.ok(!frame.includes('ignored'), 'an author placeholder on a date is not drawn')
  t.expectFrame(frame, ['yyyy-mm-dd', '2026-10-10T09:30', 'yyyy-mm', 'yyyy-Www', '2020-W53', 'hh:mm', '09:30:15.5', 'soon'],
    'a date shows its format; a valid value shows, normalized for datetime-local; a malformed one is empty')
  t.ok(!frame.includes('2026-02-30') && !frame.includes('2026-13') && !frame.includes('2025-W53') && !frame.includes('25:00'),
    'no February 30th, no month 13, no 53rd week of 2025, no hour 25')

  await t.tab()                    // the bound date
  await t.type('2026-10-1')
  frame = await t.frame()
  t.expectFrame(frame, ['d [] reads [empty]', '2026-10-1'], 'half a date reads empty to a handler and a bind, and the text stays')

  await t.type('0')
  t.expectFrame(await t.frame(), ['d [2026-10-10] reads [2026-10-10]'], 'a whole date reads as itself')

  await t.press('BACKSPACE')
  frame = await t.frame()
  t.expectFrame(frame, ['d [] reads [empty]', '2026-10-1'], 'editing a date back to half of one keeps the text the bind wrote empty')

  await t.type('3')
  t.expectFrame(await t.frame(), ['d [2026-10-13]'], 'the text kept is the text edited')

  await t.tab()                    // datetime-local
  await t.press('BACKSPACE')
  await t.type('5')
  t.expectFrame(await t.frame(), ['dt [2026-10-10T09:35]'], 'a datetime-local binds its normalized value')

  await t.click('Date')
  frame = await t.frame()
  t.ok(!frame.includes('soon'), 'a live type to date clears text that is no date')
}
