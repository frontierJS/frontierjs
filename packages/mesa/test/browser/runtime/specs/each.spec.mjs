/*
 * {#each} — node identity, and what counts as a list.
 *
 * A keyed list promises that a reordered row is the SAME element moved. Text
 * comparison cannot tell that from a rebuilt one, and everything that survives
 * a reorder in an app depends on it: focus, a running animation, the character
 * a user has typed but not committed. The node is stamped with a JS property
 * before the reorder, because a property is exactly what does not survive
 * being rebuilt.
 */
export const name = '{#each}'
export const covers = ['each-keyed', 'each-array-like']

export async function run(t) {
  await t.mount('each')

  t.is(await t.evaluate(`return document.querySelectorAll('#rows li').length;`), 3,
    'a keyed list renders its rows')
  t.is(await t.evaluate(`return document.querySelectorAll('#grid .cell').length;`), 6,
    'an array-like ({ length: 6 }) is a list — the shape a calendar is built from')
  t.is(await t.evaluate(`return [...document.querySelectorAll('#grid .cell')].map(e => e.textContent).join('');`),
    '012345', 'and its index is the iteration variable')

  await t.evaluate(`
    for (const li of document.querySelectorAll('#rows li')) li.__stamp = li.dataset.id;
    return true;
  `)

  await t.clickAt('#reverse')
  await t.eventually(`[...document.querySelectorAll('#rows li')].map(e => e.dataset.id).join('')`, 'cba',
    'a reorder puts the rows in the new order')

  const moved = await t.evaluate(`
    const stamps = [...document.querySelectorAll('#rows li')].map(li => li.__stamp ?? '(rebuilt)');
    return { stamps: stamps.join(',') };
  `)
  t.is(moved.stamps, 'c,b,a',
    'and every row is the same NODE moved, not a rebuilt one with the same text')

  await t.clickAt('#drop')
  await t.eventually(`[...document.querySelectorAll('#rows li')].map(e => e.dataset.id).join('')`, 'ca',
    'a removed key takes its row and leaves the others')
  const kept = await t.evaluate(`
    const stamps = [...document.querySelectorAll('#rows li')].map(li => li.__stamp ?? '(rebuilt)');
    return { stamps: stamps.join(',') };
  `)
  t.is(kept.stamps, 'c,a', 'without rebuilding the survivors')
}
