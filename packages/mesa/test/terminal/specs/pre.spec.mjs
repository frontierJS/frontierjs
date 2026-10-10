/*
 * pre — `fixtures/Pre.mesa`: `<pre>`, `{@html}`, and `<del>`/`<ins>`/`<dfn>`.
 *
 * A green run pins a `<pre>` painted with its whitespace, less the two
 * newlines a browser drops: the one after the open tag and the one ending
 * the block, so neither leaves a blank row. `{@html}` paints the text
 * `innerText` reads from the markup: tags gone, references decoded, a `<br>`
 * or a block's end a new row, whitespace kept inside a `<pre>` and collapsed
 * outside it, and an inline `<svg>`'s title never read. A live one follows
 * its value. The three inline tags carry their default-stylesheet look as
 * cell attributes: struck through, underlined, italic.
 */
import { TextAttributes } from '@opentui/core'

export const name = 'pre'

// The row holding `b` comes right after the row holding `a`, no blank between.
const adjacent = (frame, a, b) => {
  const rows = frame.split('\n')
  const i = rows.findIndex((r) => r.includes(a))
  return i >= 0 && rows[i + 1]?.includes(b)
}

export async function run(t) {
  await t.mount(await t.compile('Pre'), {}, { height: 16 })
  await t.settle()

  let frame = await t.frame()
  t.expectFrame(frame, ['top', 'static one', '  two & three', 'fn main() {', '    let  x = 1', '}', 'let  a < b', 'next', 'One two', 'third', 'a', 'gone', 'new', 'term'])
  t.ok(adjacent(frame, 'top', 'static one'), 'the newline after <pre> opens no row')
  t.ok(adjacent(frame, 'two & three', 'fn main'), 'nor does the newline ending a static block')
  t.ok(adjacent(frame, '}', 'let  a'), 'nor the one ending a live block')
  t.ok(adjacent(frame, 'One two', 'third'), "a block's end in markup starts a row")
  t.ok(!frame.includes('<') || frame.includes('a < b'), 'no tag reaches the screen')
  t.ok(!frame.includes('icon'), 'an inline svg is drawn, not read')

  const { STRIKETHROUGH, UNDERLINE, ITALIC } = TextAttributes
  t.is((await t.attributesAt('gone')) & STRIKETHROUGH, STRIKETHROUGH, '<del> is struck through')
  t.is((await t.attributesAt('new')) & UNDERLINE, UNDERLINE, '<ins> is underlined')
  t.is((await t.attributesAt('term')) & ITALIC, ITALIC, '<dfn> is italic')

  await t.click('swap')
  frame = await t.frame()
  t.expectFrame(frame, ['next', 'plain & simple', 'a'], 'live markup follows its value')
  t.ok(!frame.includes('third'), 'and the old text is gone')
}
