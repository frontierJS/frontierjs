/*
 * keymap — `fixtures/Keymap.mesa`: `@frontierjs/mesa/keys` on a terminal, the
 * same attachment and table the browser drive's `keys` spec runs
 * (`IDEAS/keys.md` 2.1, `FJS-D1388`).
 *
 * A green run pins what the browser spec pins: `gg` fires with no wait, `g`
 * alone fires once the 720ms timeout passes, an await-char takes the next key
 * and a key that ends it unfinished fires nothing,
 * and in a field a letter types while a Ctrl chord fires and types nothing.
 * It also pins the terminal half: the runtime steps the attachment before it
 * makes the keydown, so a key it took is no keydown at all and a listener
 * around it never hears one, where a browser's reads it prevented.
 */
export const name = 'keymap'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(t) {
  const Keymap = await t.compile('Keymap')
  await t.mount(Keymap, {}, { height: 16 })
  await t.settle()
  await t.tab()                    // Here

  await t.press('g')
  t.expectFrame(await t.frame(), ['fired -', 'last -'], 'g is pending, and no keydown reaches the listener around it')
  await t.press('g')
  t.expectFrame(await t.frame(), ['fired 1 top'], 'gg fires without waiting for the timeout')

  await t.press('g')
  await sleep(900)
  await t.settle()
  t.expectFrame(await t.frame(), ['fired 2 go'], 'g alone fires once the timeout passes')

  await t.press('G')
  t.expectFrame(await t.frame(), ['fired 3 bottom'], 'G is its own key')

  await t.press('f')
  await t.press('x')
  t.expectFrame(await t.frame(), ['fired 4 find x'], 'f takes the next key as its argument')

  await t.press('f')
  await t.escape()
  t.expectFrame(await t.frame(), ['fired 4 find x', 'last -'], 'Esc ending an await-char is swallowed: it fires nothing and makes no keydown')

  await t.tab()                    // the field
  await t.type('gfx')
  let frame = await t.frame()
  t.expectFrame(frame, ['fired 4 find x', 'value gfx', 'last free'], 'in a field the letters type, fire nothing and are left unprevented')
  await t.press('k', { ctrl: true })
  frame = await t.frame()
  t.expectFrame(frame, ['fired 5 palette', 'value gfx', 'last free'], 'a chord with Ctrl fires inside the field, types nothing and makes no keydown')
}
