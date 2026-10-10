/*
 * scroll — `fixtures/Long.mesa`: a page taller than the screen, in the
 * renderer's document (`FJS-2487`).
 *
 * A green run pins that each row keeps a line of its own rather than being
 * pressed into the screen's height; that focus moving past the bottom edge
 * scrolls the least that shows the node, a link inside prose by its line;
 * that PageDown and PageUp move a screen less one row; that the wheel
 * scrolls and a press after it lands on what is drawn there; and that a
 * page that fits shows no scrollbar.
 */
export const name = 'scroll'

const lines = async (t) => (await t.frame()).split('\n').map((l) => l.trimEnd())
const text = (l) => l.replace(/[█▀▄]+$/, '').trimEnd()
const first = async (t) => text((await lines(t))[0])
const last = async (t) => text((await lines(t)).at(-2))

export async function run(t) {
  await t.mount(await t.compile('Long'), {}, { width: 40, height: 10 })
  await t.settle()

  const top = (await lines(t)).map(text)
  t.is(top.slice(0, 10).join('|'), ['Top', '[ first ]', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `row ${n} of the page`)].join('|'),
    'every row keeps a line of its own')

  await t.tab()
  t.is(await first(t), 'Top', 'focus on a control in view moves nothing')

  await t.tab()
  t.ok((await last(t)).includes('the docs'), 'a link on the second line of a wrapped sentence is scrolled into view')
  t.is(await first(t), 'row 13 of the page', 'by the least that shows the sentence')

  await t.tab()
  t.is(await last(t), '[ last ]', 'the next control is brought on screen')

  await t.tab({ shift: true })
  await t.tab({ shift: true })
  t.is(await first(t), '[ first ]', 'focus moving back up scrolls back up, by the least')

  const read = await last(t)
  await t.press('\x1b[6~')
  t.is(await first(t), read, 'PageDown: the last line read is now the first')
  await t.press('\x1b[6~')
  t.is(await last(t), 'pressed none', 'and stops at the end of the page')
  await t.press('\x1b[5~')
  t.is(await first(t), 'row 6 of the page', 'PageUp goes back by a screen less one row')

  await t.wheel('row 8')
  t.is(await first(t), 'row 7 of the page', 'the wheel scrolls the page')
  await t.press('\x1b[6~')
  await t.click('[ last ]')
  t.ok((await lines(t)).some((l) => text(l) === 'pressed last'), 'a press after scrolling lands on what is drawn there')

  await t.mount(await t.compile('Counter'), {}, { width: 40, height: 10 })
  await t.settle()
  t.ok(!/[█▀▄]/.test(await t.frame()), 'a page that fits shows no scrollbar')
}
