/*
 * {#each} with a DECLARED key that repeats — FJS-856.
 *
 * A duplicate is still an author error and still warns once. What changed is
 * what happens next: the list stays the length of the array, every block is
 * reachable, and deleting the duplicate REPAIRS the list rather than leaving a
 * row and its effects behind for the life of the page.
 *
 * Only a real browser can ask it. The corruption is visible as DOM that
 * survives a render, and the row left behind is one nothing has a key for.
 */
export const name = '{#each} — a declared duplicate key (FJS-856)'
export const covers = ['each-keyed', 'duplicate-key']

const labels = `[...document.querySelectorAll('#dup li')].map(e => e.textContent).join('')`

export async function run(t) {
  t.allow(/duplicate key/)

  await t.mount('each-dup-key')

  t.is(await t.evaluate(`return ${labels};`), 'abc',
    'every item in the array has a row, duplicate key or not')

  const warned = await t.warnings()
  t.ok(warned.some((w) => /duplicate key "1"/.test(w)),
    'and the author is told once, naming the key')

  // A render that keeps the duplicate must keep the rows it already has.
  await t.evaluate(`
    document.querySelectorAll('#dup li').forEach((li, i) => { li.__stamp = i });
    return true;
  `)
  await t.clickAt('#relabel')
  await t.eventually(labels, 'ABC', 'a re-render updates each row in place')
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#dup li')].map(li => li.__stamp ?? '(new)').join(',');
  `), '0,1,2', 'and the duplicated row keeps its own node rather than being rebuilt')

  // A reorder is where a collision used to throw out of the move.
  await t.clickAt('#reorder')
  await t.eventually(labels, 'cab', 'a reorder across the duplicate is just a reorder')
  t.is(await t.evaluate(`return document.querySelectorAll('#dup li').length;`), 3,
    'and leaves no extra row behind')

  // The half FJS-325 did not close: taking the duplicate away must repair it.
  await t.clickAt('#fix')
  await t.eventually(labels, 'ac', 'removing the duplicate leaves exactly the rows the array asks for')
  t.is(await t.evaluate(`return document.querySelectorAll('#dup li').length;`), 2,
    'so no orphaned block is left in the DOM')
}
