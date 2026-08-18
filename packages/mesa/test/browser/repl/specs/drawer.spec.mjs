/*
 * drawer — browsing to another example, and compiling it.
 *
 * The drawer is built at boot from `EXAMPLE_GROUPS`, so it is the other half
 * of the import that once vanished: a list of 73 items is proof the module
 * resolved, and choosing one is proof the compile path runs on demand rather
 * than only for whatever happened to be the default.
 *
 * It slides in. `waitVisible` answers *can this be seen*, which is not *has it
 * stopped moving* — a coordinate click reads a rect and then presses that
 * point, so clicking the search box mid-animation lands on whatever has moved
 * under it and the characters go nowhere. That failure looks exactly like a
 * filter that does not work.
 */
export const name = 'repl — the examples drawer'
export const covers = ['repl-drawer', 'repl-example-switch']

export async function run(t) {
  await t.clickAt('#ex-btn')
  t.ok(await t.evaluate(`return await window.waitVisible('#ex-drawer');`), 'the drawer opens')
  await t.evaluate(`return await window.waitSettled('#ex-drawer');`)

  // `openDrawer` focuses the search box on a 50ms timer, so it steals focus
  // from anything clicked before then.
  await t.evaluate(`await new Promise(r => setTimeout(r, 120)); return true;`)
  await t.clickAt('#ex-search')
  await t.type('each')

  const filtered = await t.evaluate(`
    await new Promise(r => setTimeout(r, 200));
    const items = [...document.querySelectorAll('#ex-drawer-body .ex-item')];
    const shown = items.filter(el => el.offsetParent !== null);
    return { total: items.length, shown: shown.length, value: document.getElementById('ex-search').value };
  `)
  t.is(filtered.value, 'each', 'the typed characters reached the search box')
  t.ok(filtered.shown > 0 && filtered.shown < filtered.total,
    `and the filter narrows the list (${filtered.shown} of ${filtered.total})`)

  const before = await t.evaluate(`
    return { key: document.querySelector('#ex-drawer-body .ex-item.active')?.dataset.key ?? null,
             preview: document.getElementById('pv-container').textContent.trim().slice(0, 120) };
  `)

  // Choose the first match. The handler loads the example and closes the
  // drawer, so both are asserted off the one click.
  const picked = await t.evaluate(`
    const el = [...document.querySelectorAll('#ex-drawer-body .ex-item')].find(e => e.offsetParent !== null);
    if (!el) throw new Error('no visible example to choose');
    el.id = 'repl-pick';
    return { key: el.dataset.key };
  `)
  t.ok(picked.key !== before.key, `the chosen example is not the one loaded (${picked.key})`)

  await t.clickAt('#repl-pick')

  // Wait for the PREVIEW to change, not for the status word. `#pvlbl` already
  // said "running" before the click, so waiting on it returns immediately and
  // the assertion below reads the previous example.
  await t.eventually(
    `document.getElementById('pv-container').textContent.trim().slice(0, 120) !== ${JSON.stringify(before.preview)}`,
    'true', 'the preview becomes the newly chosen example', 8000)

  const after = await t.evaluate(`
    return { status: document.getElementById('pvlbl').textContent,
             open:   document.querySelector('#ex-drawer').classList.contains('open') };
  `)
  t.ok(!/error|failed/i.test(after.status), `it compiled and ran (${after.status})`)
  t.is(after.open, false, 'and the drawer closed behind it')
}
