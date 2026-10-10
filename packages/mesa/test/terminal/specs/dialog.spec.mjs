/*
 * dialog — `fixtures/Dialogs.mesa`: a `<dialog>`, and `<mesa:window>`.
 *
 * A green run pins what a browser does with a dialog, on a terminal. Closed,
 * it takes no room. `showModal()` draws it in a border over the screen, the
 * page behind it dimmed, focus on its first control and Tab kept inside; a
 * press on the dimmed page is a `click` at the dialog itself; Escape sends
 * `cancel` and closes it unless that is prevented, and is stopped there, so a
 * renderer listener after mesa's — the shell going back — never hears it;
 * `close()` hands focus back and sends `close`, with `returnValue` set.
 * `show()` opens it in place, the page undimmed and Tab free to leave. A
 * modal dialog whose block is torn down takes its backdrop with it. A
 * `<mesa:window>` listener hears every key, focused or not, and one inside a
 * torn-down block hears no more.
 */
import { TextAttributes } from '@opentui/core'

export const name = 'dialog'

const { DIM, INVERSE } = TextAttributes

export async function run(t) {
  const Dialogs = await t.compile('Dialogs')
  const handle = await t.mount(Dialogs, {}, { width: 50, height: 18 })
  let heard = 0
  handle.renderer.keyInput.on('keypress', (k) => { if (k.name === 'escape') heard++ })
  const focused = async (label) => ((await t.attributesAt(`[ ${label}`)) & INVERSE) === INVERSE

  let f = await t.frame()
  t.ok(!f.includes('Modal body') && !f.includes('Side body') && !f.includes('Doomed body'), 'a closed dialog is not drawn')
  t.expectFrame(f, ['[ Open ]', 'Behind the dialogs'], 'and takes no room')

  await t.tab()
  await t.enter()
  f = await t.frame()
  t.expectFrame(f, ['┌', 'Modal body', '[ Lock ]', '└'], 'showModal draws it in a border')
  t.ok(/\.│ Modal body │\./.test(f), 'over the page, its own cells blank')
  t.is((await t.attributesAt('Behind')) & DIM, DIM, 'the page behind a modal is dimmed')
  t.is((await t.attributesAt('Modal body')) & DIM, 0, 'and the dialog is not')
  t.ok(await focused('Lock'), 'focus moves to its first control')
  await t.tab()
  await t.tab()
  t.ok(await focused('Lock'), 'Tab stays inside a modal dialog')

  await t.click('Behind')
  f = await t.frame()
  t.ok(!f.includes('Modal body'), 'a press on the dimmed page closes it, through its own click listener')
  t.expectFrame(f, ['closes 1 cancels 0 rv backdrop'], 'close fires, returnValue set')
  t.is((await t.attributesAt('Behind')) & DIM, 0, 'the page is undimmed')
  t.ok(await focused('Open'), 'focus goes back to what held it')

  await t.enter()
  await t.escape()
  f = await t.frame()
  t.ok(!f.includes('Modal body'), 'Escape closes a modal dialog')
  t.expectFrame(f, ['closes 2 cancels 1'], 'after cancel')
  t.is(heard, 0, 'and a renderer listener after mesa does not hear that Escape')

  await t.enter()
  await t.enter()
  await t.escape()
  f = await t.frame()
  t.expectFrame(f, ['cancels 2', 'Modal body'], 'a prevented cancel keeps it open')
  await t.tab()
  await t.enter()
  f = await t.frame()
  t.expectFrame(f, ['closes 3 cancels 2 rv done'], 'close(value) sets returnValue')
  await t.escape()
  t.is(heard, 1, 'with no modal open, Escape goes on to the next listener')

  await t.tab()
  await t.enter()
  f = await t.frame()
  t.expectFrame(f, ['[ Mute ]', 'Side body', '[ Hide ]', 'Behind'], 'show() opens it where it sits')
  t.is((await t.attributesAt('Behind')) & DIM, 0, 'with nothing dimmed')
  t.ok(await focused('Side'), 'and focus left where it was')
  await t.tab()
  await t.tab()
  await t.tab()
  t.ok(await focused('Hide'), 'Tab reaches its control and leaves no trap')
  await t.enter()
  f = await t.frame()
  t.ok(!f.includes('Side body'), 'close() hides it')
  await t.type('z')
  t.expectFrame(await t.frame(), ['keys E', 'z'], 'a key with nothing focused reaches the window')

  await t.click('Doom')
  t.expectFrame(await t.frame(), ['Doomed body'], 'a modal in a block opens')
  await t.enter()
  f = await t.frame()
  t.ok(!f.includes('Doomed body'), 'its block torn down takes it off the screen')
  t.is((await t.attributesAt('Behind')) & DIM, 0, 'and its backdrop with it')
  await t.click('Open')
  t.ok((await t.frame()).includes('Modal body'), 'and the page beneath takes presses again')
  await t.click('Done')
  t.ok(!(await t.frame()).includes('Modal body'), 'a press inside a modal reaches its controls')

  const before = (await t.frame()).match(/extra (\d+)/)[1]
  await t.click('Mute')
  await t.type('q')
  const after = (await t.frame()).match(/extra (\d+)/)[1]
  t.is(after, before, 'a window listener in a torn-down block hears no more')
}
