/*
 * details — `fixtures/Disclose.mesa`: `<details>` and `<summary>`.
 *
 * A green run pins what a browser does with one, on a terminal: the
 * summary shows with its disclosure triangle and the rest only while
 * `open`, static or live; Tab reaches the summary, inverts it, and passes
 * a control the closed body holds; Enter, Space and a press toggle it, and
 * a prevented `click` does not. `toggle` arrives a task later with its old
 * and new state, and two changes that cancel out send none.
 */
import { TextAttributes } from '@opentui/core'

export const name = 'details'

const wait = () => new Promise((r) => setTimeout(r, 20))

export async function run(t) {
  const handle = await t.mount(await t.compile('Disclose'), {}, { width: 120, height: 20 })
  await t.settle()
  let frame = await t.frame()
  t.expectFrame(frame, ['toggles none', '▸ More here', '▾ Already', 'Shown text', '▸ Held false', 'Flip'],
    'a closed one shows its summary alone, an open one its content too')
  t.ok(!frame.includes('Inside one') && !frame.includes('Deep'), 'a closed body takes no room')

  const { INVERSE } = TextAttributes
  await t.tab()
  t.is((await t.attributesAt('More')) & INVERSE, INVERSE, 'Tab reaches the summary, which inverts')
  await t.tab()
  t.is((await t.attributesAt('Already')) & INVERSE, INVERSE, 'and passes the control a closed body holds')

  await t.tab({ shift: true })
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['▾ More here', 'Inside one', 'Deep'], 'Enter opens it, and the triangle points down')
  await t.eventually(async () => (await t.frame()).includes('toggles closed>open true'), 'toggle arrives with its states')

  await t.tab()
  t.is(handle.renderer.currentFocusedRenderable?.__tag, 'button', 'Tab now reaches the control inside')
  await t.tab({ shift: true })
  await t.press(' ')
  frame = await t.frame()
  t.ok(frame.includes('▸ More here') && !frame.includes('Inside one'), 'Space closes it')
  await t.eventually(async () => (await t.frame()).includes('closed>open true open>closed false'), 'and sends toggle again')

  await t.click('More')
  t.expectFrame(await t.frame(), ['▾ More here', 'Inside one'], 'a press opens it')
  await wait()
  await t.settle()
  const log = async () => (await t.frame()).split('\n')[0].trim()
  const before = await log()

  await t.click('Twice')
  await wait()
  await t.settle()
  t.is(await log(), before, 'two changes that cancel out send no toggle')

  await t.click('Held')
  frame = await t.frame()
  t.ok(frame.includes('▸ Held true') && !frame.includes('Inside held'), 'a prevented click hears the press and toggles nothing')

  await t.click('Flip')
  t.expectFrame(await t.frame(), ['▾ Held true', 'Inside held'], 'a live open shows the content')
}
