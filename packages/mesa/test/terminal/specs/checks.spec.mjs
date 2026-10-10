/*
 * checks — `fixtures/Checks.mesa`: `<input>` by its `type` (`FJS-2506`).
 *
 * A green run pins the controls a browser draws for a checkbox, a radio, a
 * password and a hidden input. A checkbox paints `[x]`/`[ ]` and a radio
 * `(•)`/`( )`; Space or a press toggles one, Enter does not, and `click`
 * sees the new state before `input` and `change` follow. A prevented click
 * puts the state back and sends neither; a disabled box takes no focus.
 * Checking a radio unchecks its group, by `name`, and checking it again sends
 * nothing. `bind:checked` and `bind:group` move both ways. A password draws
 * every typed character as `•` and a live `type` back to `text` shows them; a
 * hidden input paints nothing. A live `type` the terminal has no control for,
 * or one that would change the control, throws by name.
 */
export const name = 'checks'

export async function run(t) {
  const Checks = await t.compile('Checks')
  await t.mount(Checks, {}, { width: 60, height: 20 })
  await t.settle()
  let frame = await t.frame()
  t.expectFrame(frame, ['agree false picks a size m theme light', '[ ] Agree', 'picks [x] [ ]', 'size ( ) (•)', 'theme (•) ( )', 'plain ( ) (•)', 'held [ ] off [ ]'],
    'each box paints its state, a bound group and a one-way checked alike')
  t.ok(!frame.includes('secret-token'), 'a hidden input paints nothing')

  await t.tab()                    // Agree
  await t.press(' ')
  frame = await t.frame()
  t.expectFrame(frame, ['agree true', 'log ctrue', '[x] Agree'], 'Space toggles a checkbox; change reads the new checked; bind:checked writes back')
  await t.enter()
  t.expectFrame(await t.frame(), ['agree true', '[x] Agree'], 'Enter does not toggle a checkbox')

  await t.tab()                    // picks a
  await t.press(' ')
  await t.tab()                    // picks b
  await t.press(' ')
  frame = await t.frame()
  t.expectFrame(frame, ['picks b size', 'picks [ ] [x]'], 'bind:group on checkboxes removes and adds each value')

  await t.tab()                    // size s
  await t.press(' ')
  frame = await t.frame()
  t.expectFrame(frame, ['size s', 'size (•) ( )'], 'a radio checked unchecks the rest of its name; bind:group takes its value')

  await t.tab()                    // size m
  await t.tab()                    // theme light
  await t.tab()                    // theme dark
  await t.press(' ')
  frame = await t.frame()
  t.expectFrame(frame, ['theme dark', 'theme ( ) (•)'], 'a one-way radio group moves through its change handler')

  await t.tab()                    // plain, unchecked
  await t.tab()                    // plain, checked
  await t.press(' ')
  t.expectFrame(await t.frame(), ['changes 0', 'plain ( ) (•)'], 'checking a checked radio sends nothing')
  await t.tab({ shift: true })
  await t.press(' ')
  t.expectFrame(await t.frame(), ['changes 1', 'plain (•) ( )'], 'a radio no state holds unchecks the rest of its name itself')

  await t.tab()                    // plain, checked
  await t.tab()                    // held
  await t.press(' ')
  frame = await t.frame()
  t.expectFrame(frame, ['clicks 1', 'held [ ]'], 'a prevented click puts the box back and sends no change')

  await t.tab()                    // the disabled box is skipped: the password
  await t.type('hunter2')
  frame = await t.frame()
  t.expectFrame(frame, ['pw 7', '•••••••'], 'a password binds what is typed and draws it masked')
  t.ok(!frame.includes('hunter2'), 'a password never paints what is typed')

  await t.tab()                    // Show
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['hunter2'], 'a live type back to text shows the value')

  await t.click('[x] Agree')
  frame = await t.frame()
  t.expectFrame(frame, ['agree false', 'log cfalse', '[ ] Agree'], 'a press toggles a checkbox')
  await t.click('off [ ]')
  t.ok((await t.frame()).includes('off [ ]'), 'a press on a disabled box toggles nothing')

  for (const [kind, message] of [
    ['range', '[Mesa] <input type="range"> has no terminal lowering'],
    ['checkbox', '[Mesa] <input type="checkbox"> cannot replace a type="text" on a terminal, which builds one control per <input>'],
  ]) {
    let threw = null
    try { await t.mount(Checks, { kind }) } catch (e) { threw = e.message }
    t.is(threw, message, `a live type="${kind}" throws by name`)
  }
}
