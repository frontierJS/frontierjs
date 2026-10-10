/*
 * portal — `fixtures/Portal.mesa`: `<mesa:portal>` on one surface.
 *
 * A green run pins that a portal's children paint where it is written, so a
 * menu opens under its trigger and before what follows it; that `to` is never
 * read (the fixture names `document.body`, which a terminal does not have,
 * so reading it throws at the open); that what is inside stays live and its
 * handlers fire; and that the kit's click-away closes it from outside and
 * leaves it open from inside.
 */
export const name = 'portal'

export async function run(t) {
  await t.mount(await t.compile('Portal'), {}, { width: 40, height: 14 })
  await t.settle()

  let frame = await t.frame()
  t.expectFrame(frame, ['before', '[ menu ]', 'unaddressed', 'after'], 'a portal with no `to` paints where it is written')
  t.ok(!frame.includes('count'), 'a closed menu paints nothing')

  await t.click('menu')
  frame = await t.frame()
  t.expectFrame(frame, ['before', '[ menu ]', 'count 0', '[ more ]', 'unaddressed', 'after'], 'opened, the menu paints under its trigger and before what follows')

  await t.click('more')
  await t.click('more')
  frame = await t.frame()
  t.expectFrame(frame, ['count 2'], 'a press inside the portal reaches its handler, and its text stays live')

  await t.click('menu')
  frame = await t.frame()
  t.ok(!frame.includes('count'), 'the trigger closes it again')

  await t.click('menu')
  t.expectFrame(await t.frame(), ['count 2'], 'reopened, the state it read is the state there is')

  await t.click('elsewhere')
  frame = await t.frame()
  t.ok(!frame.includes('count'), 'a click outside closes it')
  t.expectFrame(frame, ['[ menu ]', 'unaddressed', 'after'], 'and leaves the page as it was')
}
