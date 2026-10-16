/*
 * counter — taps, `{#if}` and keyed `{#each}` on the native target, through
 * Chrome's own input pipeline.
 */
export async function run(t) {
  await t.open('Counter')
  await t.eventually(t.shows('Counter', 'Count: 0', 'Few', '0: a', '1: b'), true, 'it paints')
  await t.tap('Add')
  await t.eventually(t.shows('Count: 1', 'Few', '2: x1'), true, 'a tap writes the signal')
  await t.tap('Add')
  await t.tap('Add')
  await t.eventually(t.shows('Count: 3', 'Many', '4: x3'), true, 'the branch flips and the list grows')
  t.ok(!(await t.text()).includes('Few'), 'the replaced branch is gone')
}
