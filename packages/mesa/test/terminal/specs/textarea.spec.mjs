/*
 * textarea — `fixtures/Area.mesa`: a `<textarea>` is a field of many lines.
 *
 * A green run pins the browser's textarea on the terminal: Enter types a new
 * line rather than submitting the form, even beside a submit button and
 * with a \`click\` listener that makes the field activatable, and
 * `e.target.value` reads the lines back joined by the newline, in `input` as
 * each key lands and in `change` on leaving. The text written between the
 * tags is the starting value less the one newline after the open tag, and a
 * live `value=` holding a newline paints two lines and fires no `input`,
 * since a program's write never does. A handler writing the value back on
 * each key, as the kit's does, leaves the cursor where the person was typing.
 * A one-line field here joins the lines
 * (`FJS-2266`), which fails the first assertion after typing.
 */
export const name = 'textarea'

export async function run(t) {
  const Area = await t.compile('Area')
  await t.mount(Area, {}, { width: 60, height: 20 })
  await t.settle()
  let frame = await t.frame()
  t.expectFrame(frame, ['first', 'second', 'x'], 'the text between the tags paints as its lines')

  await t.tab()                    // t
  await t.type('one')
  await t.enter()
  await t.type('two')
  frame = await t.frame()
  t.expectFrame(frame, ['heard "one\\ntwo" inputs 7', 'submits 0'], 'Enter types a new line, input fires per key, and the form is not submitted')
  t.ok(/^one\s*$/m.test(frame) && /^two\s*$/m.test(frame), 'the two lines paint on two rows')

  await t.tab()                    // Save
  frame = await t.frame()
  t.expectFrame(frame, ['changed "one\\ntwo" submits 0'], 'change fires on leaving, with the newline in the value')

  await t.tab()                    // s
  frame = await t.frame()
  t.expectFrame(frame, ['start "first\\nsecond"'], 'the newline after the open tag is dropped, the one between the lines kept')

  await t.tab()                    // Set
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['writes 0'], 'a program write fires no input')
  t.ok(/^p\s*$/m.test(frame) && /^q\s*$/m.test(frame), 'a live value= with a newline paints two lines')

  await t.tab()                    // n
  await t.type('r')
  frame = await t.frame()
  t.expectFrame(frame, ['writes 1 typed "p\\nqr"'], 'typing after a program write lands at its end, and the value keeps the line')

  await t.press('ARROW_LEFT')
  await t.type('s')
  await t.type('t')
  frame = await t.frame()
  t.expectFrame(frame, ['writes 3 typed "p\\nqstr"'], 'a value written back from input leaves the cursor where the person was typing')
}
