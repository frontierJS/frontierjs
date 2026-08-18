/*
 * smoke — the harness itself.
 *
 * Everything here failing means the DRIVE is broken, not the runtime: the
 * server compiled nothing, the import map resolved nothing, or the delegation
 * root was never registered. Worth being the first spec so a harness fault
 * does not read as thirty component failures.
 */
export const name = 'smoke — the harness'
export const covers = ['mount', 'delegation-root']

export async function run(t) {
  await t.mount('smoke')

  t.is(await t.evaluate(`return document.querySelector('#clicks').textContent;`), '0',
    'a fixture mounts and renders its own state')
  t.is(await t.evaluate(`return document.querySelector('.child').textContent;`), 'composed',
    'a child component resolved through the import map and rendered')

  await t.clickAt('#hit')
  await t.eventually(`document.querySelector('#clicks').textContent`, '1',
    'a real click reaches a delegated handler')

  // The same fixture called directly rather than mounted. `mount()` is what
  // registers the delegation root (Invariant 11), so this renders identically
  // and handles nothing — which is the failure mode that reads as "the click
  // did nothing" in an app.
  await t.mountBare('smoke')
  t.is(await t.evaluate(`return document.querySelector('#clicks').textContent;`), '0',
    'a component called directly still renders')
  await t.clickAt('#hit')
  await t.evaluate(`await new Promise(r => setTimeout(r, 50)); return true;`)
  t.is(await t.evaluate(`return document.querySelector('#clicks').textContent;`), '0',
    'and handles no events at all, because nothing registered a root')
}
