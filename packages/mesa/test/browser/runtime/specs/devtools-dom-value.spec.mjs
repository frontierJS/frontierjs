/*
 * devtools-dom-value — a write whose value holds an element returns (`FJS-1558`).
 *
 * `__dev` records each write's value for the panel, and it did so by walking
 * the value's enumerable properties with no depth bound and no memory of what
 * it had seen. An element's properties are enumerable accessors, so a button
 * inside a form walked to the form, the form's indexed controls, each
 * control's form, and on without end: the page stopped answering on a click,
 * in a dev build only, which is where the app's drive ran. The same button
 * outside a form reached a dead end and returned, so it looked like a form bug.
 */
export const name = 'devtools logs a write holding an element, and returns'
export const covers = ['devtools-dom-value']

export async function run(t) {
  await t.mount('devtools-dom-value', {}, { dev: true })

  // el.click() from script, as an app's drive presses a button: a walk that
  // never ends holds this evaluate until CDP gives up on it.
  await t.evaluate(`document.querySelector('#hold').click(); return true;`)
  await t.eventually(`document.querySelector('#held').textContent`, 'held', 'the write landed and rendered')

  const logged = await t.evaluate(
    `return { v: window.__MESA_DEV__._log.filter((w) => w.name === 'held').pop()?.value };`
  ).then((r) => r.v)
  t.is(logged?.note, 'held', 'the logged value keeps its plain fields')
  // The scope class the compiler adds follows the two the fixture wrote.
  t.is(/^<button#hold\.btn\.danger[.>]/.test(logged?.el), true,
    `and names the element rather than walking into it (got ${logged?.el})`)
}
