/*
 * hover-card.spec.mjs — HoverCard.
 *
 * One card for hundreds of triggers: the component is two listeners on a
 * wrapper and a portaled panel, so everything worth asserting is behavior a
 * render test cannot see — the card opening for the trigger under the pointer,
 * following it to the next trigger without a second panel, being reachable by
 * the pointer (a link inside it), opening on focus for a keyboard user, and
 * closing on Escape and on leaving.
 */
export const name = 'HoverCard'
export const covers = ['overlay/HoverCard']

const cards = `document.querySelectorAll('body > .popover').length`
const body  = `document.querySelector('body > .popover #card-body')?.textContent ?? null`

export async function run(t) {
  await t.mount('hover-card')

  t.is(await t.evaluate(`return ${cards};`), 0, 'a hover card starts closed')

  await t.hover('#word3')
  t.ok(await t.evaluate(`return await waitVisible('body > .popover');`),
    'resting the pointer on a trigger opens the card, visible after its entrance')
  t.is(await t.evaluate(`return ${body};`), 'card for word3',
    'the content snippet is handed the trigger it is for')
  t.is(await t.evaluate(`return document.querySelector('#word3').getAttribute('aria-describedby') === document.querySelector('body > .popover').id;`), true,
    'the trigger is described by the card')

  t.ok(await t.evaluate(`
    const tr = document.querySelector('#word3').getBoundingClientRect();
    const pr = document.querySelector('body > .popover').getBoundingClientRect();
    return pr.top >= tr.bottom && Math.abs(pr.left - tr.left) < 40;
  `), 'the card is placed under the trigger, not at the viewport origin')

  // Moving to a second trigger re-targets the one card instead of mounting another.
  await t.hover('#word4')
  await t.eventually(body, 'card for word4', 'moving to another trigger re-targets the card')
  t.is(await t.evaluate(`return ${cards};`), 1, 'there is still exactly one card')
  t.ok(await t.evaluate(`return document.querySelector('#word3').getAttribute('aria-describedby') === null;`),
    'the trigger left behind is no longer described by it')

  // The card is reachable: crossing from the trigger to it keeps it open.
  const link = await t.evaluate(`
    const r = document.querySelector('body > .popover #card-link').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `)
  await t.hover(link)
  await t.evaluate(`await new Promise(r => setTimeout(r, 250)); return true;`)
  t.is(await t.evaluate(`return ${cards};`), 1, 'the pointer on the card holds it open')

  await t.hover('#outside')
  await t.eventually(cards, 0, 'leaving the trigger and the card closes it')

  // Keyboard: focus opens at once, Escape closes, focus stays put.
  await t.evaluate(`document.querySelector('#word7').focus(); return true;`)
  t.ok(await t.evaluate(`return await waitVisible('body > .popover');`), 'focusing a trigger opens the card')
  t.is(await t.evaluate(`return ${body};`), 'card for word7', 'the focused trigger is the one the card is for')
  await t.press('Escape')
  await t.eventually(cards, 0, 'Escape closes the card')
  t.ok(await t.evaluate(`return document.activeElement === document.querySelector('#word7');`),
    'closing does not move focus off the trigger')

  // A far-right trigger still places inside the viewport.
  await t.evaluate(`document.querySelector('#word299').scrollIntoView(); document.querySelector('#word299').focus(); return true;`)
  t.ok(await t.evaluate(`
    await waitVisible('body > .popover');
    const pr = document.querySelector('body > .popover').getBoundingClientRect();
    return pr.left >= 0 && pr.right <= innerWidth + 1 && pr.top >= 0;
  `), 'a trigger at the end of the region places its card inside the viewport')
  await t.press('Escape')
  await t.eventually(cards, 0, 'closed again')
}
