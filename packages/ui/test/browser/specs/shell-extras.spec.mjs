/*
 * shell-extras.spec.mjs — what Shell draws only when asked: the ⌘K palette,
 * the light/dark switch, and the mounted Toaster and ConfirmProvider.
 *
 * The palette binds nothing unless `palette` is passed, since an app with its
 * own listener would otherwise toggle twice and see it open and shut in one
 * press. The switch reads `theme` through an expression Mesa takes its
 * dependencies from by text, so a label set once at mount is the likely
 * failure. The providers sit outside the frame's branches, so they are asserted
 * signed out with no frame and still restoring.
 *
 * A second Toaster warns through console.warn; the drive has no console feed,
 * so the spec wraps it in the page before mounting.
 */
export const name = 'Shell extras'
export const covers = ['layout/Shell', 'feedback/Toaster']

const count = (sel) => `document.querySelectorAll(${JSON.stringify(sel)}).length`
const ctrlK = (t) => t.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); return true;`)
const SIGNED_IN = { user: { email: 'a@b.c' } }

export async function run(t) {
  await t.viewport(1280)

  /* ── ⌘K ─────────────────────────────────────────────────────────────── */

  await t.mount('shell-extras', { ...SIGNED_IN, withPalette: true })
  await t.eventually(`!!document.querySelector('#stage .shell')`, 'true', 'the frame is drawn')
  t.is(await t.evaluate(`return ${count('#palette')};`), 0, 'the palette starts closed')

  await ctrlK(t)
  await t.eventually(count('#palette'), '1', 'one Ctrl+K opens the palette snippet')
  await ctrlK(t)
  await t.eventually(count('#palette'), '0', 'a second closes it')

  await ctrlK(t)
  await t.eventually(count('#palette'), '1', 'it opens again')
  await t.clickAt('#palette-close')
  await t.eventually(count('#palette'), '0', 'close() from inside hides it')

  t.ok(await t.evaluate(`
    const e = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e.defaultPrevented;
  `), 'Cmd+K is taken too, and its default is prevented')
  await t.eventually(count('#palette'), '1', 'and opens it')
  await ctrlK(t)
  await t.eventually(count('#palette'), '0', 'closed again')

  t.ok(await t.evaluate(`
    const e = new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return !e.defaultPrevented;
  `), 'a bare k is left alone')

  await t.mount('shell-extras', { ...SIGNED_IN })
  await t.eventually(`!!document.querySelector('#stage .shell')`, 'true', 'with no palette prop the frame is drawn')
  t.ok(await t.evaluate(`
    const e = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return !e.defaultPrevented;
  `), 'Ctrl+K is not taken')
  await new Promise((r) => setTimeout(r, 100))
  t.is(await t.evaluate(`return ${count('#palette')};`), 0, 'and nothing opens')

  await t.mount('shell-extras', { withPalette: true })
  t.is(await t.evaluate(`return ${count('#stage .shell')};`), 0, 'signed out with nothing offered a guest, no frame is drawn')
  await ctrlK(t)
  await new Promise((r) => setTimeout(r, 100))
  t.is(await t.evaluate(`return ${count('#palette')};`), 0, 'and the palette is not drawn outside a frame')
  // A key toggled while unframed would hold the store's flag, and the palette
  // would open by itself on the next frame.
  await t.mount('shell-extras', { ...SIGNED_IN, withPalette: true })
  t.is(await t.evaluate(`return ${count('#palette')};`), 0, 'and a key pressed unframed does not open it once the frame draws')

  /* ── the theme switch ───────────────────────────────────────────────── */

  const sw = '#stage .topbar button[aria-label^="Switch to"]'
  const label = `document.querySelector('${sw}')?.getAttribute('aria-label')`

  await t.mount('shell-extras', { ...SIGNED_IN })
  t.is(await t.evaluate(`return ${count(sw)};`), 0, 'with no ontheme there is no switch')

  await t.mount('shell-extras', { ...SIGNED_IN, withSwitch: true, theme: 'theme-notebook' })
  await t.eventually(label, 'Switch to dark theme', 'a light theme offers dark')
  t.is(await t.evaluate(`return document.querySelector('${sw}').textContent.trim();`), '☾', 'with the moon')
  t.ok(await t.evaluate(`const b = document.querySelector('${sw}'); const r = b.closest('.cluster'); return r.contains(document.querySelector('#top-right')) && b.compareDocumentPosition(document.querySelector('#top-right')) & Node.DOCUMENT_POSITION_FOLLOWING;`),
    'the switch sits in the right-hand cluster, ahead of the topbar snippet')
  await t.clickAt(sw)
  await t.eventually(`document.querySelector('#picked').textContent`, 'theme-notebook-dark', 'a theme with a pair goes to its pair')
  await t.eventually(label, 'Switch to light theme', 'the label follows the theme')
  t.is(await t.evaluate(`return document.querySelector('${sw}').textContent.trim();`), '☀', 'and the glyph')
  await t.clickAt(sw)
  await t.eventually(`document.querySelector('#picked').textContent`, 'theme-notebook', 'and the pair goes back')

  await t.mount('shell-extras', { ...SIGNED_IN, withSwitch: true, theme: 'theme-sunset' })
  await t.clickAt(sw)
  await t.eventually(`document.querySelector('#picked').textContent`, 'theme-dark', 'a light theme with no pair goes to Dark')

  await t.mount('shell-extras', { ...SIGNED_IN, withSwitch: true, theme: 'theme-dracula' })
  await t.eventually(label, 'Switch to light theme', 'a dark theme offers light')
  await t.clickAt(sw)
  await t.eventually(`document.querySelector('#picked').textContent`, 'theme-default', 'a dark theme with no pair goes to Default')

  await t.mount('shell-extras', { ...SIGNED_IN, withSwitch: true, layout: 'sidebar', theme: 'theme-default' })
  await t.eventually(count('#stage .sidebar-first > .topbar button[aria-label^="Switch to"]'), '1',
    'a sidebar layout draws the switch in its header with no topbar snippet guard in the way')
  t.is(await t.evaluate(`return ${count('#stage .topbar button[aria-label^="Switch to"]')};`), 1, 'once')

  /* ── toasts and confirm ─────────────────────────────────────────────── */

  const stack = '.toast-stack'
  await t.mount('shell-extras', { ...SIGNED_IN })
  t.is(await t.evaluate(`return ${count(stack)};`), 0, 'with no toasts prop there is no Toaster')

  await t.mount('shell-extras', { ...SIGNED_IN, toasts: true })
  await t.eventually(count(stack), '1', 'toasts mounts one Toaster')

  await t.mount('shell-extras', { ...SIGNED_IN, toasts: 'top-left' })
  await t.eventually(count(stack), '1', 'a position string mounts one too')
  t.is(await t.evaluate(`return document.querySelector('${stack}').style.top;`), 'var(--rem)', 'at that position')

  await t.mount('shell-extras', { toasts: true, checked: false })
  await t.eventually(count(stack), '1', 'still restoring, the Toaster is already there')
  t.is(await t.evaluate(`return ${count('#stage .shell')};`), 0, 'with no frame')
  await t.mount('shell-extras', { toasts: true })
  await t.eventually(count(stack), '1', 'signed out with no frame, one Toaster')

  // ConfirmProvider draws nothing until asked, so a data-confirm click is the
  // proof it is mounted: the click is held back and the panel asks instead.
  const ask = `const b = document.createElement('button'); b.id = 'ask'; b.setAttribute('data-confirm', 'Sure?'); b.textContent = 'Ask'; document.body.append(b); return true;`
  const asked = `(() => { document.getElementById('ask').click(); return !!document.querySelector('.popover[role=dialog]') })()`
  await t.mount('shell-extras', { toasts: true, confirm: true })
  await t.evaluate(ask)
  await t.eventually(asked, 'true', 'confirm mounts the ConfirmProvider, signed out with no frame')
  await t.evaluate(`document.getElementById('ask')?.remove(); return true;`)
  await t.mount('shell-extras', { toasts: true })
  await t.evaluate(ask)
  t.is(await t.evaluate(`return ${asked};`), false, 'and with no confirm prop a data-confirm click is not intercepted')
  await t.evaluate(`document.getElementById('ask')?.remove(); return true;`)

  /* ── a second Toaster ───────────────────────────────────────────────── */

  await t.evaluate(`window.__warns = []; const w = console.warn; window.__warn = w; console.warn = (...a) => { window.__warns.push(a.join(' ')); w.apply(console, a) }; return true;`)
  await t.mount('shell-extras', { ...SIGNED_IN, toasts: true })
  await t.eventually(count(stack), '1', 'one Toaster, no warning')
  t.is(await t.evaluate(`return window.__warns.filter(m => m.includes('[Toaster]')).length;`), 0, 'nothing is warned of')
  await t.mount('shell-extras', { ...SIGNED_IN, toasts: true, extraToaster: true })
  await t.eventually(count(stack), '2', 'two Toasters')
  t.is(await t.evaluate(`return window.__warns.filter(m => m.includes('[Toaster]') && m.includes('twice')).length;`), 1,
    'the second mount warns that every toast is drawn twice')
  await t.mount('shell-extras', { ...SIGNED_IN, toasts: true })
  t.is(await t.evaluate(`return window.__warns.filter(m => m.includes('[Toaster]')).length;`), 1,
    'and unmounting both leaves the count at zero, so one Toaster after warns of nothing')
  await t.evaluate(`console.warn = window.__warn; return true;`)
  /* ── a bar with nothing in it ───────────────────────────────────────── */

  const SIDE = { ...SIGNED_IN, layout: 'sidebar', bare: true }
  const shown = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && el.getClientRects().length > 0 })()`
  const screenTop = `Math.round(document.querySelector('#stage .screen').getBoundingClientRect().top - document.querySelector('#stage .shell').getBoundingClientRect().top)`
  const openDrawer = async () => {
    await t.clickAt('#stage .sidebar-toggle')
    await t.evaluate(`await waitFor(() => document.querySelector('dialog.drawer')?.open); return true;`)
  }

  await t.viewport(1280)
  await t.mount('shell-extras', SIDE)
  await t.eventually(`!!document.querySelector('#stage .shell')`, 'true', 'a bare sidebar frame is drawn')
  t.is(await t.evaluate(`return ${shown('#stage .topbar')};`), false, 'at 1280 a bar holding only the toggle is not drawn')
  t.is(await t.evaluate(`return ${screenTop};`), 0, 'and the screen starts at the top, no empty row above it')
  t.is(await t.evaluate(`const c = document.querySelector('#stage .topbar > .cluster'); return [document.querySelectorAll('#stage .topbar > *').length, c.children.length, c.querySelector('h1, nav') === null];`).then(String), '1,1,true',
    'it is one cluster holding the toggle, with no heading or nav inside')

  await t.viewport(390)
  t.is(await t.evaluate(`return ${shown('#stage .topbar')};`), true, 'at 390 the bar is drawn')
  t.is(await t.evaluate(`return ${screenTop};`) > 0, true, 'and the screen sits under it')
  await openDrawer()
  t.is(await t.evaluate(`return [...document.querySelectorAll('dialog.drawer .navlink-text')].map(s => s.textContent).join('|');`), 'Today',
    'its toggle opens the drawer, which holds the nav')
  t.is(await t.evaluate(`document.querySelector('dialog.drawer').close(); return true;`), true, 'closed again')

  await t.viewport(1280)
  await t.mount('shell-extras', { ...SIDE, title: 'Reports' })
  t.is(await t.evaluate(`return ${shown('#stage .topbar')};`), true, 'a title brings the bar back at 1280')
  await t.mount('shell-extras', { ...SIDE, withSwitch: true })
  t.is(await t.evaluate(`return ${shown('#stage .topbar')};`), true, 'so does ontheme')
  await t.mount('shell-extras', { ...SIDE, bare: false })
  t.is(await t.evaluate(`return ${shown('#stage .topbar')};`), true, 'so does a topbar snippet')

  /* ── a group that hides its heading ─────────────────────────────────── */

  const labels = (root) => `${count(`${root} .navlist-label`)}`
  const named = (root) => `[...document.querySelectorAll('${root} ul.navlist[aria-label]')].map(u => u.getAttribute('aria-label')).join('|')`
  await t.mount('shell-extras', { ...SIDE, hide: true })
  t.is(await t.evaluate(`return ${labels('#stage .sidebar')};`), 0, 'hideLabel draws no heading in the sidebar')
  t.is(await t.evaluate(`return ${named('#stage .sidebar')};`), 'Reports', 'and the list is named by the label')
  t.is(await t.evaluate(`return document.querySelectorAll('#stage .sidebar ul[aria-labelledby]').length;`), 0, 'not by a heading that is not there')
  await t.mount('shell-extras', { ...SIDE, hide: false })
  t.is(await t.evaluate(`return ${labels('#stage .sidebar')};`), 1, 'without it the heading is drawn')
  t.is(await t.evaluate(`return ${named('#stage .sidebar')};`), '', 'and names the list by id as before')

  await t.mount('shell-extras', { ...SIDE, hide: true, layout: 'rail' })
  t.is(await t.evaluate(`return [${labels('#stage .sidebar')}, ${count('#stage .sidebar.rail')}, ${named('#stage .sidebar')}.length];`).then(String), '0,1,7', 'a rail honors it, and names the list')
  await t.viewport(390)
  await openDrawer()
  t.is(await t.evaluate(`return ${labels('dialog.drawer')};`), 0, 'the drawer draws no heading')
  t.is(await t.evaluate(`return ${named('dialog.drawer')};`), 'Reports', 'and names the list')
  await t.evaluate(`document.querySelector('dialog.drawer').close(); return true;`)
  await t.viewport(1280)

  await t.evaluate(`window.__hideWarns = []; window.__hideWarn = console.warn; console.warn = (...a) => { window.__hideWarns.push(a.join(' ')); window.__hideWarn.apply(console, a) }; return true;`)
  await t.mount('shell-extras', { ...SIDE, hide: true, foldable: true })
  t.is(await t.evaluate(`return ${count('#stage .sidebar details > summary.navlist-label')};`), 1, 'under foldable the summary is drawn')
  t.is(await t.evaluate(`return window.__hideWarns.filter(m => m.includes('hideLabel') && m.includes('Reports')).length;`), 1,
    'and hideLabel is warned of once, naming the group')
  await t.evaluate(`console.warn = window.__hideWarn; return true;`)

  /* ── head(where) ────────────────────────────────────────────────────── */

  const marks = (root) => `[...document.querySelectorAll('${root} .head-mark')].map(m => m.dataset.where).join('|')`
  // After the brand, before the first group.
  const placed = (root) => `(() => { const r = document.querySelector('${root}'); const b = r.querySelector('.brand-mark'), h = r.querySelector('.head-mark'), g = r.querySelector('.navlist'); const F = Node.DOCUMENT_POSITION_FOLLOWING; return !!(b.compareDocumentPosition(h) & F) && !!(h.compareDocumentPosition(g) & F) })()`
  const HEAD = { ...SIDE, withHead: true }

  await t.mount('shell-extras', HEAD)
  t.is(await t.evaluate(`return ${marks('#stage .sidebar')};`), 'sidebar', 'head is drawn once in the sidebar, told so')
  t.is(await t.evaluate(`return ${placed('#stage .sidebar')};`), true, 'after the brand and before the first group')
  await t.mount('shell-extras', { ...HEAD, layout: 'rail' })
  t.is(await t.evaluate(`return ${marks('#stage .sidebar')};`), 'rail', 'a rail tells it so')
  t.is(await t.evaluate(`return ${placed('#stage .sidebar')};`), true, 'in the same place')
  await t.mount('shell-extras', { ...HEAD, collapsible: true, collapsed: true })
  t.is(await t.evaluate(`return ${marks('#stage .sidebar')};`), 'rail', 'a collapsed sidebar is a rail to it')
  t.is(await t.evaluate(`return ${placed('#stage .sidebar')};`), true, 'and it sits below the fold control line')
  await t.mount('shell-extras', { ...HEAD, collapsible: true, collapsed: false })
  t.is(await t.evaluate(`return ${marks('#stage .sidebar')};`), 'sidebar', 'a folded-out sidebar is a sidebar')
  t.is(await t.evaluate(`return ${placed('#stage .sidebar')};`), true, 'after the brand and fold line')
  await t.viewport(390)
  await openDrawer()
  t.is(await t.evaluate(`return ${marks('dialog.drawer')};`), 'drawer', 'the drawer draws it once, told so')
  t.is(await t.evaluate(`document.querySelector('dialog.drawer').close(); return true;`), true, 'closed')
  await t.viewport(1280)
  await t.mount('shell-extras', { ...HEAD, layout: 'topbar', bare: false })
  t.is(await t.evaluate(`return ${count('#stage .topbar .head-mark')};`), 0, 'the topbar layout draws none in its bar')
  await t.viewport(390)
  await openDrawer()
  t.is(await t.evaluate(`return ${marks('dialog.drawer')};`), 'drawer', 'but its drawer does')
  await t.evaluate(`document.querySelector('dialog.drawer').close(); return true;`)
  await t.viewport(1280)
}
