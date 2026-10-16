/*
 * bound — `bind:value` on a component in both directions, and `bind:this`
 * handing the parent the child's exported function.
 */
export async function run(t) {
  await t.open('Bound')
  await t.eventually(t.shows('A: 5', 'B: 1', 'Parent: 5 1'), true, 'it paints')
  await t.tap('A+')
  await t.eventually(t.shows('A: 6', 'Parent: 6 1'), true, 'the child writes the parent')
  await t.tap('Ten')
  await t.eventually(t.shows('A: 10', 'Parent: 10 1'), true, 'the parent pushes the child')
  await t.tap('Reset')
  await t.eventually(t.shows('A: 0', 'Parent: 0 1'), true, 'an exported function through bind:this')
}
