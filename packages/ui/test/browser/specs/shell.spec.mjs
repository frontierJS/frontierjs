/*
 * shell.spec.mjs — Shell, the app frame drawn from a nav.js table.
 *
 * nav.mjs pins which groups, entries and section a table answers. What only a
 * browser shows is the frame around them: nothing drawn while the session
 * restores, the signed-out frame, the nav present in BOTH the sidebar and the
 * drawer, which one of the two a width shows, `aria-current` moving when the
 * page does (Mesa takes an expression's dependencies from its text, so a
 * highlight set once at mount and never moved is the likely failure), and the
 * drawer closing on navigation.
 *
 * Navigation is the fixture's stand-in router: a click on a link inside is
 * taken and becomes `path` and `query`, so these are real clicks on real
 * anchors.
 */
export const name = 'Shell'
export const covers = ['layout/Shell']

const current = `[...document.querySelectorAll('#stage .sidebar a[aria-current="page"] .navlink-text')].map(s => s.textContent).join('|')`
const visibleBox = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && el.getClientRects().length > 0 })()`

export async function run(t) {
  await t.viewport(1280)

  /* ── the restore in flight, then signed out ─────────────────────────── */

  await t.mount('shell', { checked: false })
  t.ok(await t.evaluate(`return !document.querySelector('#stage .shell, #stage main');`),
    'nothing is drawn while the session restores')

  await t.clickAt('#stage #restore')
  await t.eventually(`!!document.querySelector('#stage main.screen > .container.narrow #page')`, 'true',
    'signed out, the page sits in a narrow container with no frame')
  t.ok(await t.evaluate(`return !document.querySelector('#stage nav, #stage .shell');`),
    'signed out, no nav is drawn')

  await t.clickAt('#stage #sign-in')
  await t.eventually(`!!document.querySelector('#stage .shell.sidebar-first > main.screen#screen #page')`, 'true',
    'signing in draws the frame around the same page')

  /* ── the table, at 1280 ─────────────────────────────────────────────── */

  t.is(await t.evaluate(`return [...document.querySelectorAll('#stage .sidebar .navlink-text')].map(s => s.textContent).join('|');`),
    'Today|Leads|Clients|Contacts|Docs',
    'the sidebar draws every visible entry, in order — Admin hidden, a throwing show shown, an empty group dropped')
  t.ok(await t.evaluate(`
    const label = [...document.querySelectorAll('#stage .sidebar .navlist-label')].find(l => l.textContent === 'Help');
    const list = label?.nextElementSibling;
    return !!label && list.matches('ul.navlist') && list.getAttribute('aria-labelledby') === label.id;
  `), 'a labeled group names its list')
  t.is(await t.evaluate(`return document.querySelectorAll('#stage .sidebar .navlist-label').length;`), 1,
    'an unlabeled group draws no label')
  t.is(await t.evaluate(`return document.querySelectorAll('#stage .sidebar .navlink [data-icon]').length;`), 4,
    'the app\'s icon snippet draws each entry that names an icon, and only those')
  t.ok(await t.evaluate(`return !!document.querySelector('#stage .sidebar [data-brand]') && !!document.querySelector('#stage .sidebar [data-foot="sidebar"]');`),
    'the brand and the foot are drawn, and the foot is told it is in the sidebar')
  t.ok(await t.evaluate(`return !!document.querySelector('#stage .topbar #top-right');`),
    'the topbar snippet lands in the topbar')
  t.ok(await t.evaluate(`return document.querySelector('#stage .skip-link')?.getAttribute('href') === '#screen' && !!document.querySelector('#stage #screen[tabindex="-1"]');`),
    'the skip link targets the Screen, which can take focus')

  t.is(await t.evaluate(`return ${current};`), 'Leads', 'the current page is marked, and an exact / is not')

  t.ok(!(await t.evaluate(`return ${visibleBox('#stage .sidebar-toggle')};`)),
    'above md the drawer toggle is hidden')
  t.ok(await t.evaluate(`return ${visibleBox('#stage .sidebar')};`), 'above md the sidebar is on screen')

  /* ── the section bar ────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return document.querySelector('#stage .topbar strong')?.textContent;`), 'Leads', 'the title is drawn')
  t.is(await t.evaluate(`return [...document.querySelectorAll('#stage .topbar nav[aria-label="Section"] .navlink')].map(a => a.textContent + (a.getAttribute('aria-current') ? '*' : '')).join('|');`),
    'Open*|Lost', 'the section\'s tabs are drawn and an exact tab is current on its own path')
  t.is(await t.evaluate(`return document.querySelector('#stage .topbar nav[aria-label="Section"] a.btn.primary')?.getAttribute('href');`),
    '/contacts/create/', 'the section\'s action is drawn')

  await t.clickAt('#stage .topbar nav[aria-label="Section"] a[href="/leads/lost/"]')
  await t.eventually(`[...document.querySelectorAll('#stage .topbar nav[aria-label="Section"] [aria-current]')].map(a => a.textContent).join('|')`, 'Lost',
    'a tab click moves the tab highlight')
  t.is(await t.evaluate(`return ${current};`), 'Leads', 'a page beneath an entry keeps the entry current')

  /* ── navigation moves the highlight ─────────────────────────────────── */

  await t.clickAt('#stage .sidebar a[href="/contacts/?kind=customer"]')
  await t.eventually(current, 'Clients', 'match tells two entries on one path apart, by the query')
  t.ok(await t.evaluate(`return !document.querySelector('#stage .topbar nav[aria-label="Section"]');`),
    'a page in no section draws no tabs')

  await t.clickAt('#stage .sidebar a[href="/contacts/"]')
  await t.eventually(current, 'Contacts', 'a query-only navigation moves it back')

  await t.clickAt('#stage .sidebar [data-brand]')
  await t.eventually(current, 'Today', 'an exact entry is current on its own path')

  /* ── the app's state reaches its snippets and its predicates ───────── */

  await t.clickAt('#stage #more')
  await t.eventually(`document.querySelector('#stage .sidebar [data-unread]')?.textContent`, '3',
    'a badge snippet follows the app\'s state')

  await t.clickAt('#stage #promote')
  await t.eventually(`[...document.querySelectorAll('#stage .sidebar .navlink-text')].map(s => s.textContent).includes('Settings')`, 'true',
    'a group show re-runs when the level changes')

  /* ── below md: the drawer ───────────────────────────────────────────── */

  await t.viewport(375)
  await t.eventually(visibleBox('#stage .sidebar'), 'false', 'below md the sidebar is hidden')
  t.ok(await t.evaluate(`return ${visibleBox('#stage .sidebar-toggle')};`), 'below md the toggle is on screen')
  t.is(await t.evaluate(`return document.querySelector('#stage .sidebar-toggle').getAttribute('aria-expanded');`), 'false',
    'the toggle says the drawer is closed')

  await t.clickAt('#stage .sidebar-toggle')
  await t.evaluate(`await waitFor(() => document.querySelector('dialog.drawer')?.open); return true;`)
  t.ok(await t.evaluate(`return await waitVisible('dialog.drawer');`), 'the toggle opens the drawer')
  t.is(await t.evaluate(`return document.querySelector('#stage .sidebar-toggle').getAttribute('aria-expanded');`), 'true',
    'and says so')
  t.is(await t.evaluate(`return [...document.querySelectorAll('dialog.drawer .navlink-text')].map(s => s.textContent).join('|');`),
    'Today|Leads|Clients|Contacts|Settings|Docs',
    'the drawer draws the same entries as the sidebar')
  t.ok(await t.evaluate(`return !!document.querySelector('dialog.drawer [data-foot="drawer"]') && !document.querySelector('dialog.drawer [data-foot="sidebar"]');`),
    'the foot is told it is in the drawer')
  t.is(await t.evaluate(`return [...document.querySelectorAll('dialog.drawer a[aria-current="page"]')].map(a => a.textContent.trim()).join('|');`),
    'Today', 'the drawer marks the current page too')

  await t.clickAt('dialog.drawer a[href="/leads/"]')
  await t.evaluate(`await waitFor(() => !document.querySelector('dialog.drawer').open); return true;`)
  t.ok(await t.evaluate(`return !document.querySelector('dialog.drawer').open;`), 'navigating from the drawer closes it')
  await t.eventually(`document.querySelector('#stage #page').textContent`, 'Page at /leads/', 'and the page it went to is showing')

  /* ── signing out ────────────────────────────────────────────────────── */

  await t.viewport(1280)
  await t.clickAt('#stage .sidebar button.btn')
  t.ok(await t.evaluate(`return document.querySelector('#stage .sidebar button.btn').disabled;`),
    'Sign out is disabled while onsignout is pending')
  await t.eventually(`!!document.querySelector('#stage main.screen > .container.narrow')`, 'true',
    'an awaited sign-out lands on the signed-out frame')
  t.is(await t.evaluate(`return document.querySelector('#stage #signouts').textContent;`), '1', 'onsignout ran once')
}
