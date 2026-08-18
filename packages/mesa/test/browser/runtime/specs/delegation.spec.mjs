/*
 * delegation — `|self`, `currentTarget`, and the events that do not bubble.
 *
 * All of it is invisible to a dispatched event: `|self` is a comparison
 * against `currentTarget`, and five of the events below never reach a
 * delegation root by bubbling at all.
 */
export const name = 'delegation'
export const covers = ['delegation-root', 'event-modifiers', 'non-bubbling-events']

export async function run(t) {
  await t.mount('delegation')

  // `|self` — a click on the backdrop itself counts, a click on the child
  // inside it does not. `currentTarget` inside a delegated handler must be the
  // element the handler was written on; when it was the delegation root, the
  // comparison could never be true and the branch was dead (`FJS-321`).
  await t.clickAt('#backdrop')
  await t.eventually(`document.querySelector('#backdrop-hits').textContent`, '1',
    'on:click|self fires for a click on the element itself')
  t.is(await t.evaluate(`return document.querySelector('#seen-target').textContent;`), 'backdrop',
    'currentTarget in a delegated handler is the element, not the delegation root')

  await t.clickAt('#inner')
  await t.eventually(`document.querySelector('#inner-hits').textContent`, '1',
    'the inner button has its own handler')
  t.is(await t.evaluate(`return document.querySelector('#backdrop-hits').textContent;`), '1',
    'and |self refused the click that only passed through the backdrop')

  // close · cancel · toggle · invalid do not bubble. A component whose Escape
  // handler sits on a <dialog> could not be reopened once (`FJS-297`).
  await t.clickAt('#drive')
  await t.eventually(`document.querySelector('#closes').textContent`, '1',
    'close is delivered, and does not bubble')
  await t.eventually(`document.querySelector('#toggles').textContent`, '1',
    'toggle is delivered, and does not bubble')
  await t.eventually(`document.querySelector('#invalids').textContent`, '1',
    'invalid is delivered, and does not bubble')
}
