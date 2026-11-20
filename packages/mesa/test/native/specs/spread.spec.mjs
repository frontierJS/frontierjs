/*
 * spread — `{...attrs}` on a host element carries an `onclick`, then the
 * object is replaced with one naming a different handler. A tap after the
 * swap must run only the new handler: a spread that bound a second listener
 * instead of swapping the one behind it would run both.
 */
export async function run(t) {
  await t.open('SpreadHandler')
  await t.eventually(t.shows('hits: []'), true, 'it paints')
  await t.tap('Hit')
  await t.eventually(t.shows('hits: [a]'), true, 'the spread handler runs')
  await t.tap('Swap')
  await t.tap('Hit')
  await t.eventually(t.shows('hits: [ab]'), true, 'a replaced handler runs alone, not beside the first')
}
