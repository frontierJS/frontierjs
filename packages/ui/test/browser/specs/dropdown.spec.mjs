/*
 * dropdown.spec.mjs — DropdownMenu, DropdownItem, DropdownLabel, DropdownSeparator.
 *
 * Four components that had never been opened in a browser. Everything they add
 * over `@frontierjs/css` is behaviour that only exists at runtime: a panel
 * portaled to <body> and positioned against the trigger's rect, a roving focus
 * walk over live DOM, click-away, Escape, and two ARIA attributes the component
 * writes onto markup the CALLER owns.
 *
 * None of that has a compile-time or render-time symptom. `example`'s
 * `verify:ui` opens a menu and reads its items, which is the shallowest of the
 * questions here — it never presses an arrow key, never closes by Escape, and
 * never asks where the panel ended up.
 *
 * The panel is portaled, so every selector is document-wide; one scoped to the
 * fixture finds nothing and reads as a menu that never opened.
 */
export const name = 'DropdownMenu'
export const covers = [
  'overlay/DropdownMenu', 'overlay/DropdownItem',
  'overlay/DropdownLabel', 'overlay/DropdownSeparator',
]

const items    = `[...document.querySelectorAll('[role=menu] [role=menuitem]')]`
const focused  = `document.activeElement?.textContent?.trim().replace(/\\s+/g, ' ')`

export async function run(t) {
  await t.mount('dropdown')

  /* ── closed, and announcing itself as closed ──────────────────────────── */

  t.is(await t.evaluate(`return document.querySelectorAll('[role=menu]').length;`), 0,
    'the menu starts closed')

  // The two attributes go on the caller's own button, not on the wrapper the
  // component renders — a wrapper is not focusable, so state announced there
  // is state nobody hears. This is the one place the component reaches into
  // markup it does not own, which is exactly why it is worth asserting.
  const closedAria = await t.evaluate(`
    const b = document.querySelector('#dd-trigger');
    return { haspopup: b.getAttribute('aria-haspopup'), expanded: b.getAttribute('aria-expanded') };
  `)
  t.is(closedAria.haspopup, 'menu', 'the trigger says it opens a menu')
  t.is(closedAria.expanded, 'false', 'and that the menu is closed')

  /* ── opening ──────────────────────────────────────────────────────────── */

  await t.clickAt('#dd-trigger')
  t.ok(await t.evaluate(`return await waitVisible('[role=menu]');`), 'clicking the trigger opens it')
  await t.eventually(`document.querySelector('#dd-trigger').getAttribute('aria-expanded')`, 'true',
    'and the trigger says so')

  // Portaled to <body>, which is the whole reason it escapes an
  // `overflow: hidden` ancestor.
  t.ok(await t.evaluate(`
    return document.querySelector('[role=menu]').closest('#stage') === null;
  `), 'the panel is portaled out of the component tree')

  // Positioned against the trigger's rect. This is the assertion that would
  // have caught a panel pinned at 0,0 — which is what happens if the frame
  // callback that measures it never runs.
  //
  // Settled first: the panel scales in, so a rect read mid-flight is the
  // transform's, off by a sub-pixel that changes every run.
  await t.evaluate(`return await waitSettled('body');`)
  const box = await t.evaluate(`
    const tr = document.querySelector('#dd-trigger').getBoundingClientRect();
    const p  = document.querySelector('.popover').getBoundingClientRect();
    return { panelTop: Math.round(p.top), triggerBottom: Math.round(tr.bottom),
             panelLeft: Math.round(p.left), triggerLeft: Math.round(tr.left) };
  `)
  t.ok(box.panelTop > box.triggerBottom && box.panelTop - box.triggerBottom < 24,
    `the panel sits just below the trigger (${box.triggerBottom} → ${box.panelTop})`)
  t.is(box.panelLeft, box.triggerLeft, 'and starts at its left edge, for bottom-start')

  /* ── what is in it ────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return ${items}.length;`), 4, 'every item is a menuitem')
  // A heading and a rule are not actions, and a keyboard walk that lands on
  // one is a walk that stops working.
  t.is(await t.evaluate(`return document.querySelectorAll('[role=menu] .navlist-label').length;`), 2,
    'a label is a heading, not an item')
  t.is(await t.evaluate(`
    const hr = document.querySelector('[role=menu] hr');
    return hr && hr.getAttribute('role') === null && hr.matches(':not([role=menuitem])');
  `), true, 'a separator is a bare <hr>, which already means separator')

  t.is(await t.evaluate(`
    const a = [...document.querySelectorAll('[role=menu] a[role=menuitem]')];
    return a.length === 1 && a[0].getAttribute('href');
  `), '/settings/', 'an item with an href is a real link')

  /* ── the keyboard walk ────────────────────────────────────────────────── */

  // Asserted rather than assumed. Every arrow assertion below passes just as
  // well with focus left on the trigger — `indexOf(activeElement)` is -1 for
  // anything outside the list — so nothing here can see a menu that opened
  // without taking focus, which is what it did while `bind:this` sat on the
  // surface rather than on the list.
  await t.eventually(`document.activeElement?.getAttribute('role')`, 'menu',
    'opening moves focus into the panel')

  // Opening focuses the panel itself, so the first ArrowDown has to land on
  // the first item rather than on the second.
  await t.press('ArrowDown')
  await t.eventually(focused, 'Edit ⌘E', 'ArrowDown from a freshly opened menu lands on the first item')

  await t.press('ArrowDown')
  await t.eventually(focused, 'Settings', 'and walks down')

  // The disabled row is skipped, not focused-and-ignored: a focus stop that
  // does nothing reads as a menu that has frozen.
  await t.press('ArrowDown')
  await t.eventually(focused, 'Delete', 'and steps over the disabled row')

  await t.press('ArrowDown')
  await t.eventually(focused, 'Edit ⌘E', 'and wraps at the end')

  await t.press('ArrowUp')
  await t.eventually(focused, 'Delete', 'ArrowUp wraps backwards')

  /* ── ArrowUp from a freshly opened menu ───────────────────────────────── */

  await t.press('Escape')
  await t.evaluate(`await waitFor(() => !document.querySelector('[role=menu]')); return true;`)
  await t.clickAt('#dd-trigger')
  await t.evaluate(`return await waitVisible('[role=menu]');`)

  // The mirror of the first ArrowDown, and the case an index walk gets wrong:
  // focus is on the PANEL, so `indexOf(activeElement)` is -1 and stepping back
  // from -1 lands one before the end rather than on it.
  await t.press('ArrowUp')
  await t.eventually(focused, 'Delete', 'ArrowUp from a freshly opened menu lands on the LAST item')

  /* ── choosing ─────────────────────────────────────────────────────────── */

  // Driven from an ACTION row rather than the link one: Enter on an <a href>
  // navigates, which is the browser doing its job and the end of the page this
  // spec is running in.
  await t.press('Enter')
  await t.eventually(`document.querySelector('#chose').textContent`, 'delete',
    'Enter on a focused item runs it')
  await t.eventually(`document.querySelector('#runs').textContent`, '1', 'exactly once')
  await t.eventually(`document.querySelectorAll('[role=menu]').length`, 0,
    'and choosing closes the menu')

  // Focus goes back where it came from. Losing it to <body> after a menu
  // closes is the difference between a keyboard user carrying on and starting
  // over from the top of the page.
  t.ok(await t.evaluate(`return document.activeElement === document.querySelector('#dd-trigger');`),
    'and returns focus to the trigger')

  /* ── a disabled row is not a row ──────────────────────────────────────── */

  await t.clickAt('#dd-trigger')
  await t.evaluate(`return await waitVisible('[role=menu]');`)
  await t.evaluate(`
    byText('[role=menu] [role=menuitem]', 'Coming soon').click();
    return true;
  `)
  await t.eventually(`document.querySelector('#runs').textContent`, '1',
    'clicking a disabled item runs nothing')
  t.is(await t.evaluate(`return document.querySelectorAll('[role=menu]').length;`), 1,
    'and does not close the menu')

  /* ── the ways out ─────────────────────────────────────────────────────── */

  // Click-away is a capture-phase listener on document, added when the menu
  // opens. Added a moment too early it would eat the click that opened it.
  await t.clickAt('#stage')
  await t.eventually(`document.querySelectorAll('[role=menu]').length`, 0,
    'a click outside closes it')

  await t.clickAt('#dd-trigger')
  await t.evaluate(`return await waitVisible('[role=menu]');`)
  await t.press('Tab')
  await t.eventually(`document.querySelectorAll('[role=menu]').length`, 0,
    'Tab closes it rather than tabbing into a portal')

  // Tab moved focus to the next control on the page — the second menu's
  // trigger, a viewport below — and the browser scrolls focus into view. Every
  // coordinate click after this one would land off-screen otherwise, which
  // reads as a trigger that stopped responding.
  await t.evaluate(`window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 50)); return true;`)

  // The trigger toggles. The click-away listener sees this click first and has
  // to let it through, or the second press would close and reopen in one go.
  //
  // The state about to be inverted is asserted first. An open that did not
  // happen turns the second click into an OPEN, and the two assertions after
  // it then report a broken toggle with nothing naming the click that went
  // missing — which is how FJS-331 read for as long as it was open.
  await t.clickAt('#dd-trigger')
  t.ok(await t.evaluate(`return await waitVisible('[role=menu]');`), 'the trigger opens it again')
  await t.eventually(`document.querySelector('#dd-trigger').getAttribute('aria-expanded')`, 'true',
    'and says so, before the toggle is asked to invert it')

  await t.clickAt('#dd-trigger')
  await t.eventually(`document.querySelectorAll('[role=menu]').length`, 0,
    'and a second click on the trigger closes it')
  await t.eventually(`document.querySelector('#dd-trigger').getAttribute('aria-expanded')`, 'false',
    'with the trigger saying so again')

  /* ── never painted where it used to be ────────────────────────────────── */

  // The panel is placed in a frame callback, so between `open` and that frame
  // x and y still hold the LAST open's placement. Painted there it appears
  // wherever the trigger used to be, and after a scroll that can be ON the
  // trigger: the click meant to close the menu then lands inside the panel,
  // where click-away deliberately lets it through, so the menu stays open and
  // nothing on screen says why. That is FJS-331, which read as a flaky
  // assertion because the frame is late only under load.
  //
  // Read at insertion through a MutationObserver — by the time a poll can see
  // the panel the frame has been and gone.
  await t.evaluate(`
    window.__ddPaint = null;
    new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) {
        if (n.nodeType === 1 && n.classList?.contains('popover') && !window.__ddPaint)
          window.__ddPaint = { top: n.style.top, shown: getComputedStyle(n).visibility !== 'hidden' };
      }
    }).observe(document.body, { childList: true, subtree: true });
    window.scrollTo(0, 60);
    return true;
  `)
  await t.clickAt('#dd-trigger')
  await t.evaluate(`return await waitVisible('[role=menu]');`)
  const paint = await t.evaluate(`
    return { first: window.__ddPaint, top: document.querySelector('.popover').style.top };
  `)
  t.ok(!paint.first.shown || paint.first.top === paint.top,
    `the panel is not shown until it is placed (first ${paint.first.top}, placed ${paint.top})`)

  await t.press('Escape')
  await t.eventually(`document.querySelectorAll('[role=menu]').length`, 0, 'and Escape closes it')

  /* ── it flips when there is no room below ─────────────────────────────── */

  // Driven from the second trigger, which sits near the bottom of a scrollable
  // page. The panel is `position: fixed`, so what decides the flip is where the
  // trigger sits in the VIEWPORT once scrolled there.
  const room = await t.evaluate(`
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(r => setTimeout(r, 80));
    const tr = document.querySelector('#dd-low').getBoundingClientRect();
    return { below: Math.round(innerHeight - tr.bottom), scrolled: Math.round(scrollY) };
  `)
  // Assert the PREMISE before the behaviour: a spacer shorter than the window
  // leaves room below, and then not flipping is the correct answer and the
  // check below proves nothing at all.
  t.ok(room.scrolled > 0 && room.below < 120,
    `the low trigger really is near the bottom (${room.below}px below it)`)

  await t.clickAt('#dd-low')
  await t.evaluate(`return await waitVisible('[role=menu]');`)
  await t.evaluate(`return await waitSettled('body');`)
  t.ok(await t.evaluate(`
    const tr = document.querySelector('#dd-low').getBoundingClientRect();
    const p  = document.querySelector('.popover').getBoundingClientRect();
    return p.bottom <= tr.top + 1;
  `), 'with no room below, the panel opens above the trigger')
  await t.press('Escape')
}
