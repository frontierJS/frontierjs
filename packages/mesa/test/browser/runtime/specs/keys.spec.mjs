/*
 * keys — `@frontierjs/mesa/keys` in a real tab: toolbelt's engine on an
 * element's keydown (`IDEAS/keys.md` 2.1).
 *
 * A green run pins: `gg` fires its binding with no wait; `g` alone, both a
 * binding and the start of `gg`, fires once the 720ms timeout passes; an
 * await-char takes the next key as its argument; in a text field a letter
 * types and fires nothing, while a chord with Ctrl fires and types nothing;
 * and a listener after the attachment reads a key it took, pending or fired,
 * as `defaultPrevented`, and one it left alone as not.
 * The keys arrive through CDP's input pipeline, so `e.key`, focus and the
 * field's default action are the browser's own.
 */
export const name = 'keys() — the active keymaps on an element'

const text = (t, id) => t.evaluate(`return document.querySelector('#${id}').textContent;`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CTRL = 2

export async function run(t) {
  await t.mount('keys')
  await t.clickAt('#here')

  await t.press('g')
  t.is(await text(t, 'fired'), '-', 'g is pending: a binding and the start of gg')
  t.is(await text(t, 'last'), 'taken', 'and a pending key is prevented for the listener after it')
  await t.press('g')
  t.is(await text(t, 'fired'), '1 top', 'gg fires without waiting for the timeout')

  await t.press('g')
  await sleep(900)
  t.is(await text(t, 'fired'), '2 go', 'g alone fires once the timeout passes')

  await t.press('G')
  t.is(await text(t, 'fired'), '3 bottom', 'G is its own key')

  await t.press('f')
  await t.press('x')
  t.is(await text(t, 'fired'), '4 find x', 'f takes the next key as its argument')

  await t.clickAt('#field')
  await t.type('gfx')
  t.is(await text(t, 'value'), 'gfx', 'in a text field the letters type')
  t.is(await text(t, 'fired'), '4 find x', 'and fire nothing')
  t.is(await text(t, 'last'), 'free', 'and a typed key is left unprevented')
  await t.press('k', CTRL)
  t.is(await text(t, 'fired'), '5 palette', 'a chord with Ctrl fires inside the field')
  t.is(await text(t, 'value'), 'gfx', 'and types nothing')
  t.is(await text(t, 'last'), 'taken', 'a fired key is prevented too')
}
