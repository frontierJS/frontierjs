/*
 * button.spec.mjs -- Button's <a> branch.
 *
 * `FJS-4586`: onclick is a declared prop, so it is not in $attributes, and
 * only the <button> branch wired it. `<Button href onclick>` rendered a link
 * whose click called nothing, which is the shape of a row link that opens a
 * panel on a plain click and keeps its href for a modified one.
 */
export const name   = 'Button with an href'
export const covers = ['forms/Button']

const clicks = `document.querySelector('#clicks').textContent`

export async function run(t) {
  await t.mount('button')

  t.is(await t.evaluate(`return document.querySelector('#stage #link').tagName;`), 'A',
    'an href renders a link')

  await t.clickAt('#stage #link')
  await t.eventually(clicks, '1', 'a click on the link calls its onclick')
  t.is(await t.evaluate(`return location.hash;`), '',
    'the handler cancelled the navigation it was handed')

  // The <button> branch drops a click while loading; the link must not differ.
  await t.clickAt('#stage #busy')
  t.is(await t.evaluate(`return ${clicks};`), '1', 'a loading link does not call its onclick')

  // The page outlives the spec, and the loading link did navigate.
  await t.evaluate(`history.replaceState(null, '', location.pathname + location.search); return true;`)
}
