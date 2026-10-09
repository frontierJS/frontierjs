/*
 * keys — `fixtures/Keys.mesa`: `keypress`, and a handler prop forwarded unset.
 *
 * A green run pins the DOM's order: `keypress` follows a `keydown` nobody
 * prevented, for a key that types a character or Enter and with no Ctrl
 * held, and bubbles to the form. Preventing it keeps the character out of the
 * field, and preventing it on Enter keeps the form from submitting, as both
 * are a keypress's default in a browser. Then the kit's shape: `<Input>`
 * forwards `on:keydown={onkeydown}` and four more whose props its caller
 * mostly leaves unset, and an unset handler is skipped, as `addEvent` skips
 * it on the DOM path, rather than stored and called.
 */
export const name = 'keys'

export async function run(t) {
  const Keys = await t.compile('Keys')
  await t.mount(Keys, {}, { height: 16 })
  await t.settle()

  await t.tab()                    // a
  await t.type('axb')
  let frame = await t.frame()
  t.expectFrame(frame, ['downs 3 presses 3 heard 3 last b', 'value ab'], 'keypress follows each keydown, bubbles, and a prevented one types nothing')

  await t.press('a', { ctrl: true })
  frame = await t.frame()
  t.expectFrame(frame, ['downs 4 presses 3'], 'a key held with Ctrl fires keydown and no keypress')

  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['presses 4 heard 4 last Enter', 'submits 1'], 'Enter fires keypress, then submits the one-field form')

  await t.tab()                    // h
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['submits 1 held 0'], 'a prevented keypress on Enter submits nothing')

  await t.tab()                    // o
  await t.type('ok')
  await t.tab()
  frame = await t.frame()
  t.expectFrame(frame, ['other ok'], 'unset handlers are skipped: focus, keys, change and blur go through')
}
