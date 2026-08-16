/*
 * events.spec.mjs — the events mesa may not delegate.
 *
 * Mesa routes every handler through one listener on the delegation root
 * (Invariant 11), and keeps a list of the events that do not bubble and
 * therefore have to be bound on the element itself. A name missing from that
 * list fails in the worst available way: the element renders, the BROWSER does
 * its half, and the component's half never runs. `<dialog on:close>` was
 * missing, so Escape closed a Drawer natively while `bind:open` was never
 * written back — the caller's state said "open" for the rest of the page's
 * life and the drawer could not be reopened. Nothing threw.
 *
 * The list is in `mesa/src/compiler.js` and a unit test pins it, but a unit
 * test can only compare the compiler against a list somebody typed. This asks
 * the browser instead — first whether each event bubbles at all, then whether
 * a handler written the way a component writes one actually fires.
 *
 * It covers no component on purpose: what is under test is the compiler's
 * assumption, and the kit is where the cost of it being wrong was paid.
 */
export const name = 'non-bubbling events'
export const covers = []

// `bubbles` is a property of the event the browser dispatches, so this is a
// measurement rather than a restatement of the spec. Every entry here is also
// an entry in NON_DELEGATED_EVENTS.
const CLAIMED_NOT_TO_BUBBLE = ['close', 'cancel', 'toggle', 'beforetoggle', 'invalid']

export async function run(t) {
  const bubbles = await t.evaluate(`
    const seen = {};
    const dialog = document.createElement('dialog');
    const pop    = document.createElement('div');
    const input  = document.createElement('input');
    pop.setAttribute('popover', 'auto');
    pop.textContent = 'p';
    input.required = true;
    document.body.append(dialog, pop, input);

    dialog.addEventListener('close',  e => seen.close  = e.bubbles, { once: true });
    dialog.addEventListener('cancel', e => seen.cancel = e.bubbles, { once: true });
    pop.addEventListener('beforetoggle', e => seen.beforetoggle = e.bubbles, { once: true });
    pop.addEventListener('toggle',       e => seen.toggle       = e.bubbles, { once: true });
    input.addEventListener('invalid',    e => seen.invalid      = e.bubbles, { once: true });

    dialog.showModal();
    // requestClose() is what fires \`cancel\` without a trusted Escape.
    if (typeof dialog.requestClose === 'function') dialog.requestClose(); else dialog.close();
    pop.showPopover();
    input.reportValidity();

    await new Promise(r => setTimeout(r, 100));
    dialog.remove(); pop.remove(); input.remove();
    return seen;
  `)

  for (const event of CLAIMED_NOT_TO_BUBBLE)
    t.is(bubbles[event], false, `${event} does not bubble in this browser`)

  /* ── and therefore: a component's handler still fires ────────────────── */

  await t.mount('events')
  await t.clickAt('#stage #drive')

  await t.eventually(`document.querySelector('#closes').textContent`, '1',
    'on:close fires on a <dialog>')
  await t.eventually(`document.querySelector('#toggles').textContent`, '1',
    'on:toggle fires on a <details>')
  await t.eventually(`document.querySelector('#invalids').textContent`, '1',
    'on:invalid fires on a field that fails constraint validation')
}
