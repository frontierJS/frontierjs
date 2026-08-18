/*
 * tabs.spec.mjs — Tabs, TabList, Tab, TabPanel.
 *
 * Four components that had never been opened by this drive. `example`'s
 * `verify:ui` clicks a tab and reads the panel behind it, which is one of the
 * questions here — it presses no arrow key, never asks where focus went, and
 * never sees a second strip.
 *
 * What this family is, is a context provider and three consumers. Everything
 * it adds over `@frontierjs/css` — which keys the selected look off
 * `[aria-selected]` and ships no behaviour at all — exists only at runtime:
 * which tab is selected, the roving tabindex, the arrow/Home/End walk, and
 * whether a panel is hidden or absent.
 *
 * Two strips are mounted on purpose. A single one cannot distinguish "the
 * context reached the right subtree" from "there is only one subtree", and
 * `$context` is the mechanism this whole family is built out of.
 */
export const name = 'Tabs'
export const covers = [
  'layout/Tabs', 'layout/TabList', 'layout/Tab', 'layout/TabPanel',
]

const focusedTab = `document.activeElement?.getAttribute?.('data-tab-id')`
const selected   = `document.querySelector('#t-main [role=tab][aria-selected=true]')?.getAttribute('data-tab-id')`

export async function run(t) {
  await t.mount('tabs')

  /* ── the strip ────────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return document.querySelectorAll('#t-main [role=tab]').length;`), 4,
    'every Tab is a tab')
  t.is(await t.evaluate(`
    return document.querySelector('#t-main [role=tablist]').getAttribute('aria-label');
  `), 'Settings sections', 'the strip carries the label it was given')
  // The variant is the stylesheet's, not a class this kit invented — a tone or
  // a variant that lands nowhere is a strip that silently looks default.
  t.ok(await t.evaluate(`
    return document.querySelector('#t-unmount [role=tablist]').classList.contains('pills');
  `), 'a variant reaches the tablist')

  /* ── defaulting to the first tab ──────────────────────────────────────── */

  // Nobody stated an activeId, so the strip has to pick one. This depends on
  // children registering before the parent's $onMount runs, which is mount
  // ORDER — the sort of thing that works until a block defers a child.
  await t.eventually(selected, 'general', 'with no stated activeId the first tab is selected')
  await t.eventually(`document.querySelector('#active').textContent`, 'general',
    'and the binding is written back to the caller')
  await t.eventually(`document.querySelector('#last').textContent`, 'general',
    'onchange is told which one it picked')

  // Selected state and announced state are the same fact here, because the
  // stylesheet draws from [aria-selected]. Assert the other three are false
  // rather than just that one is true: two selected tabs paint identically to
  // one and read as a broken strip.
  t.is(await t.evaluate(`
    return document.querySelectorAll('#t-main [role=tab][aria-selected=true]').length;
  `), 1, 'exactly one tab is selected')

  // Roving tabindex: one stop for the whole strip, which is what makes a Tab
  // key leave the strip instead of walking it.
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#t-main [role=tab]')]
      .map(el => el.tabIndex).join(',');
  `), '0,-1,-1,-1', 'only the selected tab is a tab stop')

  /* ── the pairing ──────────────────────────────────────────────────────── */

  // A panel that names a tab that does not exist is invisible to a screen
  // reader and looks perfect on screen.
  t.ok(await t.evaluate(`
    return [...document.querySelectorAll('#t-main [role=tab]')].every(tab => {
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      return panel && panel.getAttribute('aria-labelledby') === tab.id;
    });
  `), 'every tab controls a panel that names it back')

  t.is(await t.evaluate(`
    return document.querySelectorAll('#t-main [role=tabpanel]').length;
  `), 4, 'the default mode keeps every panel mounted')
  t.is(await t.evaluate(`
    return document.querySelectorAll('#t-main [role=tabpanel]:not([hidden])').length;
  `), 1, 'and hides all but the active one')
  t.ok(await t.evaluate(`
    return document.querySelector('#panel-general').offsetParent !== null
        && document.querySelector('#panel-security').offsetParent === null;
  `), 'hidden is real hiding, not an attribute nothing reads')
  t.is(await t.evaluate(`return document.querySelector('#panel-general').tabIndex;`), 0,
    'the panel is a tab stop, so content that is not focusable is still reachable')

  /* ── clicking ─────────────────────────────────────────────────────────── */

  await t.clickAt('#tab-security')
  await t.eventually(selected, 'security', 'clicking a tab selects it')
  await t.eventually(`document.querySelector('#panel-security').hidden`, 'false',
    'and shows its panel')
  await t.eventually(`document.querySelector('#panel-general').hidden`, 'true',
    'and hides the one that was open')
  await t.eventually(`document.querySelector('#active').textContent`, 'security',
    'the binding follows')
  await t.eventually(`document.querySelector('#changes').textContent`, '2',
    'onchange fires once per change, not once per render')
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#t-main [role=tab]')].map(el => el.tabIndex).join(',');
  `), '-1,0,-1,-1', 'and the tab stop moves with it')

  /* ── the arrow walk ───────────────────────────────────────────────────── */

  // A real click focused the button, so the keydown lands on the tablist by
  // bubbling — which is where the handler is.
  t.is(await t.evaluate(`return ${focusedTab};`), 'security',
    'a real click leaves focus on the tab (the premise for every key below)')

  // The disabled tab sits between `security` and `billing`. Selecting one is
  // worse than a dead focus stop: the strip ends up announcing a disabled tab
  // as selected, and showing its panel.
  await t.press('ArrowRight')
  await t.eventually(selected, 'billing', 'ArrowRight steps OVER the disabled tab')
  await t.eventually(focusedTab, 'billing', 'and takes focus with it')

  await t.press('ArrowRight')
  await t.eventually(selected, 'general', 'and wraps at the end')

  await t.press('ArrowLeft')
  await t.eventually(selected, 'billing', 'ArrowLeft wraps backwards')

  await t.press('ArrowLeft')
  await t.eventually(selected, 'security', 'and steps over the disabled tab going back')

  await t.press('Home')
  await t.eventually(selected, 'general', 'Home selects the first tab')
  await t.eventually(focusedTab, 'general', 'and focuses it')

  await t.press('End')
  await t.eventually(selected, 'billing', 'End selects the last tab')

  // Home from the last tab is the case a walk built out of "step one back and
  // wrap" gets wrong — it answers the tab before this one, not the first.
  await t.press('Home')
  await t.eventually(selected, 'general', 'Home from the far end still answers the first tab')

  // A key the strip does not own has to travel: swallowing ArrowDown here is
  // how a tablist inside a scrollable page stops the page scrolling.
  const untouched = await t.evaluate(`
    const el = document.querySelector('#tab-general');
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, still: ${selected} };
  `)
  t.is(untouched.prevented, false, 'a key the strip does not handle is not swallowed')
  t.is(untouched.still, 'general', 'and changes nothing')

  /* ── a disabled tab ───────────────────────────────────────────────────── */

  t.ok(await t.evaluate(`return document.querySelector('#tab-archived').disabled;`),
    'a disabled Tab is a disabled button')
  await t.evaluate(`document.querySelector('#tab-archived').click(); return true;`)
  await t.eventually(selected, 'general', 'and clicking it selects nothing')

  /* ── two strips are two strips ────────────────────────────────────────── */

  // Both provide `activeId` under the same key. A context read that escaped
  // its own subtree would make the second strip follow the first.
  await t.eventually(`
    document.querySelector('#t-unmount [role=tab][aria-selected=true]')?.getAttribute('data-tab-id')
  `, 'two', 'a stated activeId is honoured, and the other strip does not move it')

  /* ── unmount panels ───────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return document.querySelectorAll('#t-unmount [role=tabpanel]').length;`), 1,
    'with unmount, an inactive panel is absent rather than hidden')
  t.ok(await t.evaluate(`return !!document.querySelector('#panel-two');`),
    'and the active one is there')

  await t.clickAt('#tab-one')
  await t.eventually(`document.querySelector('#panel-one')?.textContent?.trim()`, 'One body',
    'switching builds the panel that was not in the DOM')
  t.is(await t.evaluate(`return document.querySelectorAll('#t-unmount [role=tabpanel]').length;`), 1,
    'and destroys the one that was')
  await t.eventually(selected, 'general', 'the first strip is untouched by all of it')

  /* ── the strip is one tab stop ────────────────────────────────────────── */

  // Tab from the selected tab must land on the panel it controls, not on the
  // next tab button — that is the whole point of the roving tabindex, and it
  // is the half a `tabindex` written once at render time gets wrong.
  await t.clickAt('#tab-security')
  await t.eventually(focusedTab, 'security', 'focus is on the selected tab')
  await t.press('Tab')
  await t.eventually(`document.activeElement?.id`, 'panel-security',
    'Tab from the strip lands on the active panel, not the next tab')

  /* ── disabled after registration ──────────────────────────────────────── */

  // Registration happens once, on mount, and `disabled` is a prop that can
  // change at any time afterwards. A registry holding a copied boolean passes
  // every assertion above and then walks straight onto a tab the app has since
  // turned off.
  await t.clickAt('#off-billing')
  await t.eventually(`document.querySelector('#tab-billing').disabled`, 'true',
    'a tab can be disabled after it has registered')
  await t.clickAt('#tab-security')
  await t.eventually(focusedTab, 'security', 'from the tab before it')
  await t.press('ArrowRight')
  await t.eventually(selected, 'general',
    'and the walk steps over the newly disabled tab too, rather than a stale copy of it')

  /* ── a disabled FIRST tab ─────────────────────────────────────────────── */

  // The default pick is the one decision taken before anyone can correct it,
  // so it is the one place a disabled tab cannot be stepped off afterwards.
  await t.mount('tabs', { firstDisabled: true })
  await t.eventually(selected, 'security',
    'with the first tab disabled, the strip defaults to the first SELECTABLE one')
  await t.eventually(`document.querySelector('#panel-security').hidden`, 'false',
    'and opens its panel')
}
