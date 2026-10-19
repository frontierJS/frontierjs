/*
 * overlay-host.spec.mjs -- the app-level overlays raised from inside a Modal.
 *
 * `FJS-2599`: the toast stack, the global alert, the palette and the dnd
 * ghost were all portaled to <body>, beneath the modal <dialog> in the top
 * layer and inert behind it. A press at a toast's Undo landed on the dialog's
 * backdrop, closed the modal and never ran Undo; the palette's input could not
 * take focus; the ghost was painted under the modal. `overlayHost()` in
 * utils.js is the one answer to where an overlay mounts (`FJS-D904`).
 *
 * Every assertion is a hit test or a focus read, never a presence check: each
 * surface existed, positioned and with correct markup, the whole time.
 */
export const name   = 'App overlays inside a Modal'
export const covers = ['feedback/Toaster', 'feedback/AlertProvider', 'overlay/CommandPalette', 'overlay/DropdownMenu', 'overlay/Popover']

const undos = `document.querySelector('#undos').textContent`
const state = `document.querySelector('#state').textContent`

// What a pointer at the centre of the element would actually hit.
const onTop = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  if (!el) return false
  const r = el.getBoundingClientRect()
  return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
})()`

export async function run(t) {
  await t.mount('overlay-host')

  await t.clickAt('#stage #open-modal')
  await t.evaluate(`await waitFor(() => document.querySelector('dialog.dialog')?.open); return true;`)
  await t.evaluate(`return await waitVisible('dialog.dialog');`)

  /* -- a toast's action ---------------------------------------------------- */

  await t.clickAt('#toast')
  await t.evaluate(`return await waitVisible('.fjs-toast-action');`)
  await t.eventually(onTop('.fjs-toast-action'), true, 'a toast raised in a modal is on top of it')
  await t.clickAt('.fjs-toast-action')
  await t.eventually(undos, '1', 'pressing Undo runs it')
  t.is(await t.evaluate(`return ${state};`), 'open', 'and the modal stays open')

  /* -- a toast raised as the modal closes ---------------------------------- */

  // A confirm dialog closes and its handler announces the move in the same
  // turn. The dialog is still the modal when the toast is raised, so a stack
  // that asks once would mount in a dialog that is shut a tick later.
  await t.clickAt('#close-toast')
  await t.eventually(state, 'shut', 'the modal closes')
  await t.evaluate(`await waitFor(() => byText('.toast', 'Working…')); return true;`)
  await t.eventually(`!!byText('.toast', 'Working…')?.closest('dialog')`, false,
    'a toast raised as the modal closes is not left inside it')
  await t.evaluate(`window.toasts.clear(); return true;`)
  await t.clickAt('#open-modal')
  await t.evaluate(`return await waitVisible('dialog.dialog');`)

  /* -- the global alert ---------------------------------------------------- */

  await t.clickAt('#alert')
  await t.evaluate(`return await waitVisible('.fjs-global-alert');`)
  await t.eventually(onTop('.fjs-global-alert'), true, 'an alert raised in a modal is on top of it')
  await t.evaluate(`window.alert_.hide(); return true;`)

  /* -- the palette --------------------------------------------------------- */

  await t.clickAt('#palette')
  await t.evaluate(`return await waitVisible('[role=combobox]');`)
  await t.eventually(`document.activeElement?.getAttribute('role')`, 'combobox',
    'the palette opened in a modal takes focus')
  await t.eventually(onTop('[role=combobox]'), true, 'and its input is on top of the modal')
  await t.evaluate(`window.commandPalette.hide(); return true;`)
  await t.eventually(`!!document.querySelector('[role=combobox]')`, false, 'the palette closes')

  /* -- a menu and a popover opened in it ------------------------------------ */

  await t.clickAt('#menu')
  await t.evaluate(`return await waitVisible('[role=menuitem]');`)
  await t.eventually(onTop('[role=menuitem]'), true, 'a menu opened in a modal is on top of it')
  await t.eventually(`document.activeElement?.getAttribute('role')`, 'menu', 'and takes focus')
  await t.clickAt('[role=menuitem]')
  await t.eventually(`document.querySelector('#picks').textContent`, '1', 'pressing an item runs it')
  t.is(await t.evaluate(`return ${state};`), 'open', 'and the modal stays open')

  await t.clickAt('#pop')
  await t.evaluate(`return await waitVisible('#pop-body');`)
  await t.eventually(onTop('#pop-body'), true, 'a popover opened in a modal is on top of it')
  await t.clickAt('#pop-body')
  await t.eventually(`document.activeElement?.id`, 'pop-body', 'and its content takes focus')
  t.is(await t.evaluate(`return ${state};`), 'open', 'and the modal stays open')
  await t.clickAt('#pop')
  await t.eventually(`!!document.querySelector('#pop-body')`, false, 'the popover closes')

  /* -- the dnd ghost ------------------------------------------------------- */

  await t.drag('#list li[data-id="1"]', '#list li[data-id="3"]', { release: false })
  await t.eventually(`!!document.querySelector('[data-dnd-ghost]')?.closest('dialog:modal')`, true,
    'the ghost of an item dragged in a modal is drawn in it, not beneath it')
  await t.drag('#list li[data-id="3"]', '#list li[data-id="3"]', { press: false, steps: 1 })
  await t.eventually(`document.querySelectorAll('[data-dnd-ghost]').length`, 0, 'the ghost is gone after the drop')
  t.is(await t.evaluate(`return ${state};`), 'open', 'and the modal stays open')

  /* -- after the modal ----------------------------------------------------- */

  await t.press('Escape')
  await t.eventually(state, 'shut', 'Escape closes the modal')
  await t.clickAt('#toast-outside')
  await t.evaluate(`await waitFor(() => byText('.toast', 'Outside')); return true;`)
  await t.eventually(`!!byText('.toast', 'Outside')?.closest('dialog')`, false,
    'a toast raised with no modal open is not left inside the closed one')
  await t.eventually(`(() => {
    const el = byText('.toast', 'Outside'), r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
  })()`, true, 'and it is on screen')
}
