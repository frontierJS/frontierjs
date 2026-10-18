/*
 * select-open.spec.mjs -- a Select can be told to open its list.
 *
 * `FJS-2637`: Select exposed focus() and nothing else, so a value that swaps
 * to a picker on click needed a second click on the select itself where the
 * native showPicker() opens it from the first. Headless Chrome draws no
 * native popup to look at, so the spec spies on the element's showPicker and
 * asserts it was called on the <select>, from a trusted press.
 */
export const name   = 'Select showPicker'
export const covers = ['forms/Select']

export async function run(t) {
  await t.mount('select-open')

  await t.evaluate(`
    window.__opened = [];
    HTMLSelectElement.prototype.showPicker = function () { window.__opened.push(this.id || this.name || 'select') };
  `)

  await t.clickAt('#stage #open')
  await t.eventually(`window.__opened.join()`, 'status',
    'showPicker() on the component opens the native list of its <select>')
  t.is(await t.evaluate(`return document.activeElement?.id;`), 'status',
    'and the select holds focus, so the keyboard drives the open list')
}
