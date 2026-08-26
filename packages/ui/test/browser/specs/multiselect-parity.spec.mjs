/*
 * multiselect-parity.spec.mjs — the collapse chip, and what the events say.
 *
 * `FJS-397` items (3) and (4). Both are things the Svelte component this one
 * replaced had and this one did not: a long selection grew the control down
 * the page, and `onchange` was the only signal, so a caller could see that the
 * selection was now X and never what MOVED — recoverable only by keeping a
 * copy of the previous value and diffing it.
 *
 * The event assertions are ordered, not just present. `oncreate` firing after
 * `onadd` would mean a listener persisting a minted option sees the selection
 * change first, which is the wrong way round for anything writing it to a
 * server before the form is saved.
 */
export const name = 'MultiSelect — collapse and events'
export const covers = ['forms/MultiSelect']

const log      = `document.querySelector('#events-log').textContent.trim()`
const pills    = (id) => `[...document.querySelectorAll('${id} .pill')]`
const summary  = `document.querySelector('#collapse .fjs-multiselect-summary')`

export async function run(t) {
  await t.mount('multiselect-parity')

  /* ── collapse ─────────────────────────────────────────────────────────── */

  // Five selected, collapseAfter={4}: one chip standing for all of them, and
  // none of the tokens it replaced.
  t.is(await t.evaluate(`return ${summary}?.textContent.trim() ?? null;`), '5 selected',
    'past the threshold the tokens collapse to one chip that counts them')

  t.is(await t.evaluate(`return ${pills('#collapse')}.filter(p => !p.classList.contains('fjs-multiselect-summary')).length;`), 0,
    'and no individual token is rendered beside it')

  // A button, not a styled span — it is the only way back and a keyboard has
  // to reach it.
  t.is(await t.evaluate(`return ${summary}?.tagName;`), 'BUTTON',
    'the chip is focusable, being the only route back to the tokens')

  await t.clickAt('#collapse .fjs-multiselect-summary')
  await t.eventually(`${pills('#collapse')}.length`, 5,
    'clicking it expands to every token')
  t.is(await t.evaluate(`return ${summary} === null;`), true,
    'and the chip goes away while expanded')

  /* ── the events ───────────────────────────────────────────────────────── */

  // Add by clicking an option.
  await t.evaluate(`
    document.querySelector('#events input').focus();
    await waitSettled('body');
  `)
  await t.evaluate(`
    const opt = document.querySelector('#events .fjs-multiselect-option');
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    opt.click();
    await waitSettled('body');
  `)

  t.is(await t.evaluate(`return ${log};`), 'add:email change:1',
    'an add reports the value that arrived, then the new selection')

  // Remove by its own close button.
  await t.evaluate(`
    document.querySelector('#events .pill-close').click();
    await waitSettled('body');
  `)
  t.is(await t.evaluate(`return ${log};`), 'add:email change:1 remove:email change:0',
    'a remove reports the value that left')

  // allowNew mints a value: create fires BEFORE add, so a listener persisting
  // the option has it before anything reacts to the selection.
  await t.evaluate(`
    const input = document.querySelector('#events input');
    input.focus();
    await waitSettled('body');
  `)
  await t.type('brand new')
  await t.press('Enter')

  await t.eventually(log, 'add:email change:1 remove:email change:0 create:brand new add:brand new change:1',
    'a minted value reports create before add')
}
