/*
 * progress — `fixtures/Bars.mesa`: `<progress>`.
 *
 * A green run pins a bar as wide as its parent, `value` over `max` of it
 * filled, read as a browser reads the numbers: a value past `max` fills the
 * row, no `max` is 1, no `value` is the words `in progress`. The children are
 * the fallback a browser never shows while it can draw the bar, so none of
 * them paints. A live value moves the fill, and dropping it turns the bar
 * indeterminate and back.
 */
export const name = 'progress'

const bar = (filled, width) => '█'.repeat(filled) + '░'.repeat(width - filled)

export async function run(t) {
  const Bars = await t.compile('Bars')
  await t.mount(Bars, {}, { width: 40, height: 16 })
  await t.settle()

  let rows = (await t.frame()).split('\n').map((r) => r.trimEnd())
  const after = (label) => rows[rows.indexOf(label) + 1]
  t.is(after('top'), bar(12, 40), '3 of 10 fills 12 of 40 columns')
  t.is(after('half'), bar(20, 40), 'a static value and max')
  t.is(after('over'), bar(40, 40), 'a value past max fills the row')
  t.is(after('no max'), bar(10, 40), 'no max is 1')
  t.is(after('wait'), 'in progress', 'no value is indeterminate')
  t.ok(!rows.some((r) => /of 10|busy|idle/.test(r)), 'the fallback children never paint')

  await t.click('more')
  rows = (await t.frame()).split('\n').map((r) => r.trimEnd())
  t.is(after('top'), bar(32, 40), 'a live value moves the fill')

  await t.click('flip')
  rows = (await t.frame()).split('\n').map((r) => r.trimEnd())
  t.is(after('wait'), bar(40, 40), 'a value written turns the bar determinate')

  await t.click('flip')
  rows = (await t.frame()).split('\n').map((r) => r.trimEnd())
  t.is(after('wait'), 'in progress', 'and removing it turns it back')
}
