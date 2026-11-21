/*
 * hydrate() -- a hydratable server page adopted in Chrome (IDEAS/hydration.md
 * Phase 2). The server's nodes must be the client's nodes, so each one the
 * server wrote is tagged with an expando before hydrate() and read back after:
 * a client that re-rendered would hand back fresh nodes with no expando.
 * The $context half is FJS-4313's: under islands-replace a child read
 * undefined; under one adopted tree it reads the parent's value.
 */
export const name = 'hydrate()'
export const covers = []

export async function run(t) {
  await t.evaluate(`return await window.mesaHydrate('/mesa/test/browser/runtime/fixtures/hydrate-page.mesa');`)
  const kept = (tag) => `return String(document.querySelector('[data-tag="${tag}"]')?.__serverNode === '${tag}');`

  for (const tag of ['static', 'count', 'inc', 'list', 'row-a', 'row-b', 'branch', 'kid', 'shell', 'slotted'])
    t.is(await t.evaluate(kept(tag)), 'true', `the server's ${tag} node is the adopted node`)
  t.is(await t.evaluate(`return String(document.querySelectorAll('#stage p').length);`), '1', 'nothing was rendered beside it')

  t.is(await t.evaluate(`return document.querySelector('[data-tag="kid"]').textContent;`), 'theme: dark',
    'the adopted child reads the parent context')

  await t.clickAt('#inc')
  await t.eventually(`document.querySelector('[data-tag="count"]').textContent`, 'Hello 3 and 6', 'a signal write updates the adopted text')
  t.is(await t.evaluate(kept('count')), 'true', 'on the same node')
  t.is(await t.evaluate(`return document.querySelector('[data-tag="slotted"]').textContent;`), 'in 3',
    'and in content a parent hands a child as children')
  t.is(await t.evaluate(`return document.querySelector('[data-tag="count"]').className;`), 'on', 'and its class')

  await t.clickAt('#add')
  await t.eventually(`[...document.querySelectorAll('[data-tag="list"] > li')].map((li) => li.textContent).join()`, 'x,y,z',
    'a row added after adoption lands at the end of its list')
  t.is(await t.evaluate(kept('list')), 'true', 'inside the adopted list')
  t.is(await t.evaluate(kept('row-a')), 'true', 'beside the adopted rows')

  const branch = `document.querySelectorAll('[data-tag="branch"]').length`
  await t.clickAt('#flip')
  await t.eventually(branch, 0, 'an adopted {#if} branch still leaves when its condition flips')
  await t.clickAt('#flip')
  await t.eventually(branch, 1, 'and comes back')
}
