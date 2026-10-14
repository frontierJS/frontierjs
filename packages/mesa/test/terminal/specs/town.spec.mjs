/*
 * town — `fixtures/Town.mesa`: a figure placed on a cell over `<pre>` art,
 * moved by arrow keys, and a bubble above it (FJS-D978, FJS-D979).
 *
 * A green run pins: an attach writing the engine's own `position`, `left` and
 * `top` puts a box on the cell asked for, over the art, and a move draws the
 * art back where the figure was; `<mesa:window on:keydown>` hears the arrows
 * by their DOM names; a box of `@frontierjs/css`'s surface lineage blanks its
 * cells, so the art under the spaces in `(hi all)` does not show through, while
 * `outlined` beside it, which a browser paints transparent, still lets it
 * through; and a bubble replaced by a shorter one leaves no cell of the longer
 * one behind. A live `class:card` turns the blanking on and off with it.
 */
export const name = 'town'

export async function run(t) {
  await t.mount(await t.compile('Town'))
  await t.settle()

  let frame = await t.frame()
  t.is((await t.at('@'))?.x, 4, 'the figure is on the column the attach asked for')
  t.ok(frame.includes('####@###'), 'and over the art, which keeps its columns either side')

  await t.press('ARROW_RIGHT')
  await t.press('ARROW_RIGHT')
  frame = await t.frame()
  t.is((await t.at('@'))?.x, 6, 'two arrows move it two cells')
  t.ok(frame.includes('######@#'), 'the art is drawn back on the cells it left')

  await t.enter()
  frame = await t.frame()
  t.ok(frame.includes('(hi all)'), 'a surface box hides the art under its own spaces')
  t.ok(frame.includes('[hi#all]'), 'an outlined one is transparent, as a browser paints it')
  t.is((await t.at('(hi all)'))?.x, 6, 'the bubble sits over the figure')
  t.ok(frame.includes('<hi all>'), 'a class:card that is on blanks its box')

  await t.press('ARROW_LEFT')
  frame = await t.frame()
  t.is((await t.at('(hi all)'))?.x, 5, 'and follows it')

  await t.enter()
  frame = await t.frame()
  t.ok(frame.includes('#####(o k)######'), 'a shorter bubble leaves nothing of the longer one')
  t.ok(frame.includes('<o#k>'), 'and one that turns off stops')
}
