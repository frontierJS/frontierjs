/*
 * $async on an async function -- a write the template reads the state of.
 *
 * In a real browser because the claim is about unhandledrejection, which only
 * a browser decides: a call whose error the template shows has been handled,
 * and one whose error nothing reads has not, so the second must still reach
 * the console. Vitest pins the state machine; this pins the button.
 */
export const name = '$async on an async function'
export const covers = ['async-function-state']

export async function run(t) {
  await t.mount('async-function')

  const disabled = (id) => `String(document.querySelector('#${id}').disabled)`

  t.is(await t.evaluate(`return document.querySelector('#status').textContent;`), 'idle',
    'a function that has not run is idle')

  await t.clickAt('#shown')
  await t.eventually(disabled('shown'), 'true', 'the button is disabled while its call is in flight')
  await t.eventually(`document.querySelector('#status').textContent`, 'pending', 'and the status says pending')

  await t.clickAt('#release')
  await t.eventually(`document.querySelector('#error')?.textContent`, 'shown failure',
    'the rejection is shown where the template reads it')
  await t.eventually(disabled('shown'), 'false', 'and the button is enabled again')

  // The error the template reads is the handling, so nothing reaches the page.
  await t.clickAt('#silent')
  await t.eventually(`window.__unhandled.join()`, 'silent failure',
    'a rejection nothing reads still reaches unhandledrejection, and the shown one does not')
  t.allow(/silent failure/)
}
