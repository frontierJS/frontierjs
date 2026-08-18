/*
 * {#each} with no key — the default key is the INDEX.
 *
 * It used to be the item itself (`eachDefaultKey = (item) => item`), which is
 * unique only when the values are. Two ordinary shapes are not: a list of
 * repeated primitives, and an array-like, whose every item is `undefined` —
 * which is exactly what a calendar grid is built from. A collision did not
 * degrade, it corrupted: the first reorder threw out of `_moveBlock` and
 * every assignment after it rendered less (`FJS-325`).
 *
 * Index keying cannot collide, and this spec is the whole trade written down:
 * the list is always correct, and a row that moves is REBOUND in place rather
 * than moved, so DOM state a row owns stays with the position. An author who
 * needs identity states a key — that is `each.spec`.
 */
export const name = '{#each} — the default key (FJS-325)'
export const covers = ['each-default-key']

export async function run(t) {
  await t.mount('each-unkeyed')

  const text = `[...document.querySelectorAll('#unkeyed li')].map(e => e.textContent).join('')`

  t.is(await t.evaluate(`return ${text};`), 'aba',
    'a repeated primitive renders once per position')
  t.is(await t.evaluate(`return document.querySelectorAll('#grid .cell').length;`), 3,
    'and an array-like, whose every item is undefined, is a list like any other')

  const warned = await t.warnings()
  t.ok(!warned.some((w) => /duplicate key/.test(w)),
    'neither is a duplicate key any more — an index is unique by construction')

  await t.clickAt('#grow')
  await t.eventually(text, 'abac', 'appending renders the new item')

  // Stamp the nodes: index keying gives up identity across a reorder, so the
  // rows must be the SAME nodes rebound, in the order the array asks for.
  await t.evaluate(`
    document.querySelectorAll('#unkeyed li').forEach((li, i) => { li.__stamp = i });
    return true;
  `)

  await t.clickAt('#swap')
  await t.eventually(text, 'baa', 'a reorder that collided under item keying is just a reorder')

  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#unkeyed li')].map(li => li.__stamp ?? '(new)').join(',');
  `), '0,1,2', 'and the rows are the nodes that were already there, rebound in place')

  await t.clickAt('#distinct')
  await t.eventually(text, 'xyz', 'and the list keeps answering every later assignment')
}
