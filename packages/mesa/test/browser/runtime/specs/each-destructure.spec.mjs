/*
 * {#each} over a destructured item — the names follow the item on a rebind.
 *
 * Index keying rebinds a row in place (`each-unkeyed.spec`), so a row whose
 * item changed keeps its nodes and must read the new item. A read of the whole
 * item always did; a destructured one read a `const` taken at row creation, and
 * both an attribute and the text went on showing the first item. Asserted
 * through a `$:` derivation, which is how it was found, and through a plain
 * reassignment, with the whole-item and keyed rows beside them as controls.
 */
export const name = '{#each} — a destructured item rebinds'
export const covers = ['each-destructure']

export async function run(t) {
  await t.mount('each-destructure')
  const ids = (sel) => `[...document.querySelectorAll('${sel} [id]')].map(e => e.id + ':' + e.textContent).join(',')`

  t.is(await t.evaluate(`return ${ids('#derived')};`), 'm-activate:Activate,m-archive:Archive', 'derived renders')
  await t.clickAt('#move')
  await t.eventually(`document.querySelector('#status').textContent`, 'active', 'status moved')
  await t.eventually(ids('#derived'), 'm-pause:Pause,m-archive:Archive', 'derived rows rebind')

  await t.clickAt('#swap')
  await t.eventually(ids('#plain'), 'p-c:C,p-b:B', 'plain rows rebind')
  await t.eventually(ids('#whole'), 'w-c:C,w-b:B', 'an item read whole rebinds')
  await t.eventually(ids('#keyed'), 'k-c:C,k-b:B', 'a keyed destructured item rebuilds')
}
