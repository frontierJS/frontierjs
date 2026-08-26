/*
 * confirm-attribute.spec.mjs — `data-confirm`, one delegated listener.
 *
 * `FJS-D115`: a destructive action asks for a confirmation by writing an
 * attribute, and <ConfirmProvider /> is the one listener that answers. The
 * claims that need a real browser are all about the CLICK — that the original
 * handler does not run while the question is open, that it runs exactly once
 * when the answer is yes, that it never runs when the answer is no, and that a
 * form submit and an anchor are covered by the same re-fire.
 */
export const name   = 'data-confirm — the declarative confirmation'
export const covers = ['overlay/ConfirmProvider', 'overlay/ConfirmPanel']

const ran     = `document.querySelector('#ran').textContent`
const panel   = `document.querySelector('[role=dialog][aria-modal=false]')`

export async function run(t) {
  await t.mount('confirm-attribute')

  /* ── the question is asked, and the action is held ─────────────────────── */

  await t.clickAt('#guarded')
  await t.eventually(`!!${panel}`, true, 'a click on a guarded element opens the confirmation')
  t.is(await t.evaluate(`return ${ran};`), '',
    'and the handler it guards has not run')
  t.is(await t.evaluate(`return ${panel}.textContent.includes('Delete this order?');`), true,
    'the attribute value is the message')

  /* ── no ──────────────────────────────────────────────────────────────── */

  await t.clickAt('[role=dialog] .btn.ghost')
  await t.eventually(`!!${panel}`, false, 'cancel closes it')
  t.is(await t.evaluate(`return ${ran};`), '', 'and the action never happened')

  /* ── yes ─────────────────────────────────────────────────────────────── */

  await t.clickAt('#guarded')
  await t.clickAt('[role=dialog] .btn.danger')
  await t.eventually(ran, 'delete', 'confirming runs the handler')
  await t.eventually(`!!${panel}`, false, 'and closes the panel')

  // Once. The re-fire re-enters the same listener, so an element that stayed
  // marked would run its handler twice on the next click — or never ask again.
  await t.clickAt('#guarded')
  await t.eventually(`!!${panel}`, true, 'the next click asks again')
  await t.clickAt('[role=dialog] .btn.danger')
  await t.eventually(ran, 'delete|delete', 'and the handler ran once per confirmation')

  /* ── an element with no attribute is untouched ────────────────────────── */

  await t.clickAt('#plain')
  await t.eventually(ran, 'delete|delete|plain', 'an unguarded element is not intercepted')
  t.is(await t.evaluate(`return !!${panel};`), false, 'and nothing opened')

  /* ── the wording attributes ───────────────────────────────────────────── */

  await t.clickAt('#worded')
  await t.eventually(`${panel}.textContent.includes('Leave the workspace?')`, true,
    'data-confirm-title is the heading')
  t.is(await t.evaluate(`return ${panel}.textContent.includes('Leave');`), true,
    'and data-confirm-label is the confirm button')
  // A bare `data-confirm` asks for the app's default wording, not a blank panel.
  t.is(await t.evaluate(`return ${panel}.textContent.includes('cannot be undone');`), true,
    'a valueless data-confirm falls back to the provider default')
  await t.clickAt('[role=dialog] .btn.ghost')

  /* ── a submit button ──────────────────────────────────────────────────── */

  await t.clickAt('#submit')
  await t.eventually(`!!${panel}`, true, 'a submit button asks like anything else')
  t.is(await t.evaluate(`return document.querySelector('#submits').textContent;`), '0',
    'and the form has not submitted')
  await t.clickAt('[role=dialog] .btn.danger')
  await t.eventually(`document.querySelector('#submits').textContent`, '1',
    'confirming submits it — one re-fire covers the shape a handler does not')
}
