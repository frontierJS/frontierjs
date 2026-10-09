/*
 * select — `fixtures/Pick.mesa`: `<select>`, `<option>`, `<optgroup>`,
 * `<datalist>` and `bind:value` on a control.
 *
 * A green run pins a browser's closed select on the terminal. One row shows
 * the chosen option, padded to the widest so the row keeps its width, its
 * live text read with the whitespace collapsed. Up and Down move past a
 * disabled option, into an `<optgroup>`, never wrap, and fire `input` then
 * `change` with `e.target.value` already moved. Options that arrive after a
 * bound value are matched to it (`FJS-1320`), an object value binds back as
 * the object, a bound string matches a number value as `el.value` does, a
 * bound `null` chooses nothing while a one-way `value={null}` chooses the
 * empty option (the DOM path's two rules), and a program write moves the
 * choice. A `<datalist>` paints nothing, options or fallback text.
 * `bind:value` on a number input reads back a number, and `undefined` for an
 * empty box. A live `multiple` that turns on throws by name.
 */
export const name = 'select'

const row = (frame, start) => frame.split('\n').find((l) => l.startsWith(start)) ?? ''
const caret = (frame, start) => row(frame, start).indexOf('▾')

export async function run(t) {
  const Pick = await t.compile('Pick')
  await t.mount(Pick, {}, { width: 60, height: 20 })
  await t.settle()
  let frame = await t.frame()
  t.expectFrame(frame, ['Large       ▾', 'Beta  ▾', 'bound null:', '         ▾', 'Pick two ▾'],
    'each select shows its chosen option padded to the widest; a bound null shows none, a one-way null the empty option')
  t.ok(!/Suggested|Paris|Rome|Small|Odd/.test(frame), 'no option paints on its own, nor a datalist or its fallback text, nor a group label')
  t.ok(/^wide gap \u25BE/m.test(frame), 'an option\'s live text reads with its whitespace collapsed and trimmed')
  t.expectFrame(frame, ['N2 \u25BE'], 'a bound string chooses the option whose value is that number, as el.value does')
  const at = caret(frame, 'Large')

  await t.tab()                    // city
  await t.type('Ro')
  frame = await t.frame()
  t.expectFrame(frame, ['city Ro'], 'bind:value on a text input writes back per key')

  await t.tab()                    // size
  await t.press('ARROW_UP')
  frame = await t.frame()
  t.expectFrame(frame, ['heard s changed s inputs 1', 'Small       ▾'], 'Up skips the disabled option and fires input and change')
  t.is(caret(frame, 'Small'), at, 'the row keeps its width as the choice moves')
  await t.press('ARROW_UP')
  t.expectFrame(await t.frame(), ['inputs 1'], 'Up at the first option does not wrap and fires nothing')
  await t.press('ARROW_DOWN')
  await t.press('ARROW_DOWN')
  frame = await t.frame()
  t.expectFrame(frame, ['heard xl changed xl inputs 3', 'Extra large ▾'], 'Down reaches an option inside an optgroup')

  await t.tab()                    // state, no options yet
  await t.tab()                    // Load
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['state progress', 'In Progress ▾'], 'options that land after the bound value are matched to it')

  await t.tab({ shift: true })     // state
  await t.press('ARROW_DOWN')
  frame = await t.frame()
  t.expectFrame(frame, ['state done', 'Done        ▾'], 'a pick writes back through bind:value')

  await t.tab()                    // Load
  await t.tab()                    // Reset
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['state backlog', 'Backlog     ▾'], 'a program write to the bound value moves the choice')

  await t.tab()                    // obj
  await t.press('ARROW_UP')
  frame = await t.frame()
  t.expectFrame(frame, ['obj a1', 'Alpha ▾'], 'an object value binds back as the object')

  await t.tab()                    // bound null
  await t.press('ARROW_DOWN')
  t.expectFrame(await t.frame(), ['Pick one ▾'], 'Down from no choice takes the first option')

  await t.tab()                    // one-way null
  await t.press('ARROW_DOWN')
  t.expectFrame(await t.frame(), ['Why      ▾'], 'a select with a one-way value moves on Down')

  await t.tab()                    // qty
  await t.type('5')
  t.expectFrame(await t.frame(), ['kind number qty 25'], 'a number input binds back a number')
  await t.press('BACKSPACE')
  await t.press('BACKSPACE')
  t.expectFrame(await t.frame(), ['kind undefined qty  city'], 'an empty number input binds back undefined')

  const Multi = await t.compile('Multi')
  await t.mount(Multi, {})
  t.ok(/^a\s+▾/m.test(await t.frame()), 'a live multiple that stays false is a select')
  let threw = null
  try { await t.mount(Multi, { multiple: true }) } catch (e) { threw = e.message }
  t.is(threw, '[Mesa] <select multiple> has no terminal lowering', 'a live multiple that is on throws by name')
}
