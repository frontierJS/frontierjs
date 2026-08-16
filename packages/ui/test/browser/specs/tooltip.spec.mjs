/*
 * tooltip.spec.mjs — Tooltip.
 *
 * The component is deliberately NOT a portal: `.tooltip-anchor` wraps the
 * trigger and the label together and `@frontierjs/css` shows it on
 * `:hover`/`:focus-within`. So the three things worth asserting are the three
 * the portal version did not have — a name a screen reader can reach, showing
 * on FOCUS and not only hover, and Escape dismissing it.
 *
 * Showing on focus is why this needs a browser at all: `:focus-within` is a
 * live selector, and the only way to satisfy it is to actually move focus.
 */
export const name = 'Tooltip'
export const covers = ['overlay/Tooltip']

export async function run(t) {
  await t.mount('tooltip')

  t.ok(await t.evaluate(`
    const trigger = document.querySelector('#tip-trigger');
    const tip = document.querySelector('.tooltip');
    return !!tip && trigger.getAttribute('aria-describedby') === tip.id;
  `), 'the trigger is described by the tooltip it was given the id of')

  t.is(await t.evaluate(`return document.querySelector('.tooltip').getAttribute('role');`), 'tooltip',
    'the label carries role="tooltip"')

  // Hidden here means "not painted", not "not in the DOM": the anchor keeps
  // the label mounted and reveals it with opacity, which is what makes the
  // describedby relationship stable.
  t.ok(await t.evaluate(`return !isVisible(document.querySelector('.tooltip'));`),
    'the tooltip is not shown before the trigger is reached')

  await t.evaluate(`document.querySelector('#tip-trigger').focus(); return true;`)
  t.ok(await t.evaluate(`
    await new Promise(r => setTimeout(r, 200));
    return isVisible(document.querySelector('.tooltip'));
  `), 'focusing the trigger shows the tooltip — a keyboard user gets it by tabbing')

  await t.press('Escape')
  t.ok(await t.evaluate(`
    await waitFor(() => document.querySelector('.tooltip').hidden);
    return !isVisible(document.querySelector('.tooltip'));
  `), 'Escape dismisses it while focus stays where it was')

  t.ok(await t.evaluate(`return document.activeElement === document.querySelector('#tip-trigger');`),
    'dismissing does not move focus off the control')
}
