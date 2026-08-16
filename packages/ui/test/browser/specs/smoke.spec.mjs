/*
 * smoke.spec.mjs — is the harness itself telling the truth?
 *
 * Every other spec in this directory reads a component through three things
 * that can each fail silently: the server compiling `.mesa` on demand, the
 * import map resolving mesa's runtime, and `@frontierjs/css` actually being on
 * the page. If any of them is broken, a component spec fails in a way that
 * blames the component.
 *
 * So this one asks the three questions directly, and it deliberately covers
 * nothing: `Button` is verified by `example`'s drives on real screens.
 */
export const name = 'smoke — the harness'
export const covers = []

export async function run(t) {
  await t.mount('smoke')

  t.ok(await t.evaluate(`return !!document.querySelector('#stage .btn');`),
    'a fixture mounts and its component renders')

  t.is(await t.evaluate(`return document.querySelector('#stage .btn').className;`),
    'btn danger', 'the class the component computed reaches the DOM')

  // The stylesheet is a separate question from the class. `render.mjs` already
  // asserts `class="btn danger"`; what it cannot ask is whether anything paints
  // it, and a kit whose CSS never loaded passes every class assertion there is.
  const bg = await t.evaluate(`
    const el = document.querySelector('#stage .btn');
    return getComputedStyle(el).backgroundColor;
  `)
  t.ok(bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent',
    '@frontierjs/css is loaded and paints the button')

  // A click through the input pipeline, not el.click(): the delegation root is
  // what a mount registers, and a component reached without one renders fine
  // and handles nothing (Invariant 11).
  await t.clickAt('#stage .btn')
  t.is(await t.evaluate(`return document.querySelector('#clicks').textContent;`), '1',
    'a real click reaches the handler through the delegation root')

  // The teardown contract every other spec depends on.
  await t.evaluate('return window.kitUnmount();')
  t.is(await t.evaluate(`return document.querySelectorAll('#stage *').length;`), 0,
    'unmounting empties the stage')
}
