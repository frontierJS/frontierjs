/*
 * grouping.spec.mjs — Accordion, AccordionItem, Fieldset.
 *
 * Both are built on a platform element on purpose — `<details>` for the
 * disclosure, `<fieldset disabled>` for the group — so what the kit adds is
 * exactly one thing each: coordinating which panel may be open, and dropping
 * the UA chrome. Everything else is the browser's, and a spec that asserts the
 * markup rather than the element's own state is not testing either.
 *
 * `<details>` also has the property most worth checking in a real browser:
 * `open` is a state the USER can change without the component being told, so
 * the coordination has to survive a click that came from the caret.
 */
export const name = 'Accordion · Fieldset'
export const covers = ['layout/Accordion', 'layout/AccordionItem', 'forms/Fieldset']

export async function run(t) {
  await t.mount('grouping')

  t.is(await t.evaluate(`return document.querySelectorAll('#stage details.disclosure').length;`), 3,
    'each item is a native <details>')
  t.is(await t.evaluate(`return document.querySelectorAll('#stage details[open]').length;`), 0,
    'nothing is open by default')

  // The body of a closed <details> is not rendered by the browser at all,
  // which is the difference between this and a class-driven accordion.
  t.ok(await t.evaluate(`return !isVisible(document.querySelector('#body-1'));`),
    'a closed panel is not on screen')

  await t.clickAt('#stage details.disclosure:nth-of-type(1) .disclosure-summary')
  await t.eventually(`document.querySelectorAll('#stage details[open]').length`, 1,
    'clicking the summary opens that panel')
  // The panel animates open, so this waits rather than reading: a probe on
  // the click's own tick measures the first frame of the transition and
  // reports a working disclosure as empty.
  t.ok(await t.evaluate(`return await waitVisible('#body-1');`),
    'and its body is on screen')

  // The one thing <details> cannot do by itself at this browser floor.
  //
  // Settle first: the panel above is still growing, so its neighbour's summary
  // is moving down the page — and a coordinate click reads a rect and then
  // presses that point, landing wherever the layout has since put it. Green
  // alone, red under load, which is the shape that wastes a morning.
  await t.evaluate(`return await waitSettled('#stage');`)
  await t.clickAt('#stage details.disclosure:nth-of-type(2) .disclosure-summary')
  await t.eventually(`document.querySelectorAll('#stage details[open]').length`, 1,
    'opening a second panel closes the first — the single-open rule')
  await t.eventually(`[...document.querySelectorAll('#stage details')].map(d => d.open).join(',')`,
    'false,true,false', 'and the one left open is the one just clicked')

  await t.evaluate(`return await waitSettled('#stage');`)
  await t.clickAt('#stage details.disclosure:nth-of-type(2) .disclosure-summary')
  await t.eventually(`document.querySelectorAll('#stage details[open]').length`, 0,
    'clicking an open panel closes it')

  /* ── multiple ────────────────────────────────────────────────────────── */

  await t.mount('grouping', { multiple: true, defaultOpen: ['faq-1'] })
  await t.eventually(`document.querySelectorAll('#stage details[open]').length`, 1,
    'defaultOpen opens the item it names')
  await t.evaluate(`return await waitSettled('#stage');`)
  await t.clickAt('#stage details.disclosure:nth-of-type(2) .disclosure-summary')
  await t.eventually(`document.querySelectorAll('#stage details[open]').length`, 2,
    'multiple lets a second panel open alongside the first')

  t.ok(await t.evaluate(`
    return document.querySelector('#stage details:nth-of-type(3) .disclosure-summary')
      .getAttribute('aria-disabled') === 'true';
  `), 'a disabled item announces itself as disabled')

  /* ── Fieldset ────────────────────────────────────────────────────────── */

  t.ok(await t.evaluate(`
    const fs = document.querySelector('#stage fieldset');
    return fs.querySelector('legend')?.textContent.trim() === 'Billing address';
  `), 'the group is a real <fieldset> with a <legend>')

  // A UA fieldset draws a border and padding no form layout wants, and the
  // component's job is to remove them — which is a computed style and nothing
  // else.
  t.ok(await t.evaluate(`
    const cs = getComputedStyle(document.querySelector('#stage fieldset'));
    return cs.borderTopWidth === '0px' && cs.paddingTop === '0px';
  `), 'and the UA border and padding are gone')

  t.ok(await t.evaluate(`
    return [...document.querySelectorAll('#stage fieldset input')].every(i => !i.matches(':disabled'));
  `), 'its controls are live by default')

  // Matched with :disabled rather than read off `.disabled`: the IDL property
  // reflects a control's OWN attribute, so an input disabled by its ancestor
  // fieldset still reports false — which reads as a fieldset that does nothing.
  await t.mount('grouping', { disabled: true })
  t.ok(await t.evaluate(`
    return [...document.querySelectorAll('#stage fieldset input')].every(i => i.matches(':disabled'));
  `), 'disabled on the fieldset disables every control natively, one attribute deep')
}
