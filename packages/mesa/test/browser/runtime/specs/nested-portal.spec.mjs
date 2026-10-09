/*
 * nested-portal.spec.mjs -- Invariant 11 when the inner root goes away during
 * the click it is dispatching.
 *
 * A portal's target is a delegation root. Into <body> it sits ABOVE the app's
 * root, but into a modal <dialog> (the only place a panel opened from a Drawer
 * can be seen) it sits inside it. A handler that closes the portal releases
 * that root before the event reaches the outer one, and ownership read at the
 * outer root then runs the same handler a second time (FJS-1983).
 */
export const name = 'a portal root released by its own click (FJS-1983)'
export const covers = ['delegation-root', 'invariant-11', 'portal']

export async function run(t) {
  await t.mount('nested-portal')

  await t.clickAt('#portal-open')
  await t.eventually(`!!document.querySelector('#portal-host #portal-close')`, true,
    'the portal renders into a target inside the app root')

  await t.clickAt('#portal-close')
  await t.eventually(`!!document.querySelector('#portal-close')`, false, 'the click closes it')
  t.is(await t.evaluate(`return document.querySelector('#portal-hits').textContent;`), '1',
    'and its handler ran once, not once more at the outer root')

  await t.clickAt('#portal-open')
  await t.clickAt('#portal-close')
  await t.eventually(`document.querySelector('#portal-hits').textContent`, '2',
    'a second open and close counts one more')
}
