/*
 * number-input.spec.mjs — NumberInput under real keystrokes (FJS-2596).
 *
 * Every number a person types passes through prefixes of itself, and a
 * prefix is rarely in range: `25` is `2` first, under a floor of 10. A box
 * that clamps each keystroke turns that `2` into `10`, and the `5` that
 * follows makes `105`, which clamps to `99` — the person typed 25 and the
 * form holds 99. Rounding to the step's precision per keystroke does the same
 * to `2.5` under a step of 1. The bounds and the step are applied when the
 * person is done — on blur, and on the ± buttons and arrow keys.
 */
export const name = 'NumberInput'
export const covers = ['forms/NumberInput']

const box  = (id) => `document.querySelector('#${id}')`
const text = (id) => `${box(id)}.value`
const held = (id) => `document.querySelector('#${id}-value').textContent`

/** Empty the box, focus it, and type into it a key at a time. */
async function typeInto(t, id, keys) {
  await t.evaluate(`const el = ${box(id)}; el.value = ''; el.focus(); return true;`)
  await t.type(keys)
}

export async function run(t) {
  await t.mount('number-input')

  /* ── a prefix below the floor is not clamped while typing ─────────────── */

  await typeInto(t, 'bounded', '25')
  t.is(await t.evaluate(`return ${text('bounded')};`), '25', 'typing 25 under min 10 shows 25')
  await t.eventually(held('bounded'), '25', 'and the bound value is 25, not 99')

  /* ── a decimal finer than the step is not rounded while typing ────────── */

  await typeInto(t, 'stepped', '2.5')
  t.is(await t.evaluate(`return ${text('stepped')};`), '2.5', 'typing 2.5 under step 1 shows 2.5')
  await t.eventually(held('stepped'), '2.5', 'and the bound value is 2.5, not 3')

  /* ── the bounds apply when the person is done ─────────────────────────── */

  await typeInto(t, 'bounded', '5')
  await t.evaluate(`${box('bounded')}.blur(); return true;`)
  await t.eventually(text('bounded'), '10', 'a value under the floor is clamped on blur')
  await t.eventually(held('bounded'), '10', 'and the bound value follows the box')

  await typeInto(t, 'bounded', '150')
  await t.evaluate(`${box('bounded')}.blur(); return true;`)
  await t.eventually(held('bounded'), '99', 'a value over the ceiling is clamped on blur')

  /* ── and on the stepper, from wherever typing left it ─────────────────── */

  await typeInto(t, 'bounded', '5')
  await t.press('ArrowUp')
  await t.eventually(held('bounded'), '10', 'ArrowUp from under the floor lands on the floor')
  await t.eventually(text('bounded'), '10', 'and the box shows it')

  /* ── oninput per value, onchange at the end of the edit (FJS-2471) ────── */

  const tally = async () => JSON.stringify(await t.evaluate(`return { ...window.tally };`))
  const reset = () => t.evaluate(`window.tally = { input: 0, change: 0 }; return true;`)

  await reset()
  await typeInto(t, 'stepped', '123')
  await t.eventually(held('stepped'), '123', 'three keystrokes land')
  const typed = JSON.parse(await tally())
  t.ok(typed.input >= 3, 'every keystroke is an input (' + typed.input + ')')
  t.is(typed.change, 0, 'and none is a change while the person is still typing')

  await t.press('Enter')
  t.is(JSON.parse(await tally()).change, 1, 'Enter ends the edit')
  await t.evaluate(`${box('stepped')}.blur(); return true;`)
  t.is(JSON.parse(await tally()).change, 1, 'and a blur with nothing new typed adds no second one')

  await reset()
  await typeInto(t, 'stepped', '7')
  await t.evaluate(`${box('stepped')}.blur(); return true;`)
  t.is(JSON.parse(await tally()).change, 1, 'blur after typing ends the edit')

  await reset()
  await t.evaluate(`${box('stepped')}.focus(); return true;`)
  await t.press('ArrowUp')
  t.is(await tally(), '{"input":1,"change":1}', 'an arrow key is one input and one change')
}
