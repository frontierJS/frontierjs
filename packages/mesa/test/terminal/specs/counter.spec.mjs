/*
 * counter — `fixtures/Counter.mesa` compiled with `target: 'terminal'`, mounted
 * on the headless renderer and driven by keys.
 *
 * A green run pins the whole slice end to end: the emitter's module shape
 * (its `$$tui` calls, in the order the contract lists them) against the
 * runtime that executes it, one signal graph shared between a text binding,
 * an `{#if}` and a keyed `{#each}`, and Tab/Enter reaching a `on:click`
 * through the engine's own key pipeline. The static frame alone would pass
 * with a runtime that never updates; the three presses are the part that
 * proves the flush paints.
 */
export const name = 'counter'

export async function run(t) {
  const Counter = await t.compile('Counter')
  await t.mount(Counter)

  let frame = await t.frame()
  t.expectFrame(frame, ['Counter', 'Count: 0', 'Add', 'Few', '0: a', '1: b'], 'initial frame')
  t.ok(!frame.includes('Many'), 'the else branch alone is painted')

  await t.tab()
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['Count: 1', 'Few', '0: a', '1: b', '2: x1'], 'one press: count, same branch, a new row')

  await t.enter()
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['Counter', 'Count: 3', 'Add', 'Many', '0: a', '1: b', '2: x1', '3: x2', '4: x3'], 'three presses: count, flipped branch, three rows')
  t.ok(!frame.includes('Few'), 'the replaced branch is gone')
}
