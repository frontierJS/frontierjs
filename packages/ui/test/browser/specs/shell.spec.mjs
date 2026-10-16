/*
 * shell.spec.mjs — Shell, the app frame drawn from a nav.js table.
 *
 * nav.mjs pins which groups, entries and section a table answers. What only a
 * browser shows is the frame around them: nothing drawn while the session
 * restores, the signed-out frame (and the frame a guest gets when the table
 * offers one something), the nav present in BOTH the sidebar and the
 * drawer, which one of the two a width shows, `aria-current` moving when the
 * page does (Mesa takes an expression's dependencies from its text, so a
 * highlight set once at mount and never moved is the likely failure), and the
 * drawer closing on navigation.
 *
 * The rail and the topbar draw the same table. What each changes is
 * geometry and placement: a closed rail is an icon wide and does not move
 * the page as it opens, Sign out leaves it for the bar, and a touch screen
 * gets the drawer toggle at every width; a topbar draws the groups flat,
 * puts the section bar on the Screen and wraps below md.
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
    'signed out with nothing in the table for a guest, the page sits in a narrow container with no frame')
  t.ok(await t.evaluate(`return !document.querySelector('#stage nav, #stage .shell');`),
    'and no nav is drawn')

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

  /* ── layout="rail" ──────────────────────────────────────────────────── */

  // Headless Chrome has no hovering pointer: it answers (hover: none) like a
  // touch screen, and CDP cannot emulate the feature. So this drive is the
  // touch case, and the rail is opened by the keyboard, whose :focus-visible
  // shares the open rule with :hover. css's frame.spec measures the geometry
  // either way; what is asserted here is that the Shell's markup gets it.
  const px = (expr) => `Math.round(${expr})`
  const railWidth = px(`document.querySelector('#stage .sidebar').getBoundingClientRect().width`)
  const screenLeft = px(`document.querySelector('#stage main.screen').getBoundingClientRect().left - document.querySelector('#stage .shell').getBoundingClientRect().left`)
  const leadsOpacity = `getComputedStyle(document.querySelector('#stage .sidebar a[href="/leads/"] .navlink-text')).opacity`
  const rem = await t.evaluate(`return parseFloat(getComputedStyle(document.documentElement).fontSize);`)

  t.ok(await t.evaluate(`return matchMedia('(hover: none)').matches;`), 'this browser answers (hover: none)')
  await t.mount('shell', { user: { email: 'a@b.c' }, layout: 'rail' })
  await t.eventually(`!!document.querySelector('#stage .shell.sidebar-first > nav.sidebar.rail')`, 'true',
    'layout="rail" draws a .sidebar.rail')
  await t.eventually(railWidth, String(3.5 * rem), 'a closed rail is --rail-width')
  await t.eventually(leadsOpacity, '0', 'and its labels are faded')
  t.is(await t.evaluate(`return [...document.querySelectorAll('#stage .sidebar .navlink-text')].map(s => s.textContent).join('|');`),
    'Today|Leads|Clients|Contacts|Docs', 'the labels are still there, as each link\'s name')
  t.ok(await t.evaluate(`return !!document.querySelector('#stage .sidebar [data-foot="rail"]');`), 'the foot is told it is in a rail')
  t.ok(await t.evaluate(`return !document.querySelector('#stage .sidebar button') && document.querySelector('#stage .topbar button.btn:not(.sidebar-toggle)')?.textContent === 'Sign out';`),
    'Sign out is in the topbar, not the rail')

  await t.evaluate(`document.querySelector('#stage .skip-link').focus(); return true;`)
  await t.press('Tab')
  t.ok(await t.evaluate(`return document.activeElement.matches('#stage .sidebar [data-brand]:focus-visible');`),
    'Tab from the skip link lands in the rail')
  await t.eventually(railWidth, String(15 * rem), 'with the keyboard in it the rail opens to --sidebar-width')
  await t.eventually(leadsOpacity, '1', 'and shows its labels')
  t.is(await t.evaluate(`return ${screenLeft};`), 3.5 * rem, 'the page does not move as the rail opens over it')
  await t.evaluate(`document.activeElement.blur(); return true;`)
  await t.eventually(railWidth, String(3.5 * rem), 'and closes when focus leaves')

  /* ── a rail with no hover: the drawer toggle at every width ─────────── */

  t.ok(await t.evaluate(`return ${visibleBox('#stage .sidebar-toggle')};`),
    'above md, beside a rail, the toggle is on screen — nothing on a touch screen opens the rail')
  await t.clickAt('#stage .sidebar-toggle')
  await t.evaluate(`await waitFor(() => document.querySelector('dialog.drawer')?.open); return true;`)
  t.ok(await t.evaluate(`return await waitVisible('dialog.drawer');`), 'and opens the drawer')
  t.ok(await t.evaluate(`
    const d = document.querySelector('dialog.drawer');
    return !d.querySelector('.rail') && getComputedStyle(d.querySelector('.navlink-text')).opacity === '1';
  `), 'where the labels are written out')
  t.ok(await t.evaluate(`return !document.querySelector('dialog.drawer button.btn:not([aria-label])');`),
    'with no second Sign out beside the bar\'s')
  await t.clickAt('dialog.drawer a[href="/contacts/?kind=customer"]')
  await t.evaluate(`await waitFor(() => !document.querySelector('dialog.drawer').open); return true;`)
  await t.eventually(current, 'Clients', 'a rail marks the current page')

  /* ── collapsing for good, while mounted ─────────────────────────────── */

  await t.clickAt('#stage #collapse')
  await t.eventually(`document.querySelector('#stage .shell > nav.sidebar').classList.contains('rail')`, 'false',
    'flipping layout to sidebar drops the rail')
  await t.eventually(railWidth, String(15 * rem), 'and the sidebar is full width')
  t.ok(!(await t.evaluate(`return ${visibleBox('#stage .sidebar-toggle')};`)), 'and a sidebar needs no toggle above md')
  t.ok(await t.evaluate(`return !!document.querySelector('#stage .sidebar button.btn') && !document.querySelector('#stage .topbar button.btn:not(.sidebar-toggle)');`),
    'and Sign out moves back into it')
  await t.clickAt('#stage #collapse')
  await t.eventually(`document.querySelector('#stage .shell > nav.sidebar').classList.contains('rail')`, 'true',
    'and back to a rail')

  /* ── layout="topbar" ────────────────────────────────────────────────── */

  await t.mount('shell', { user: { email: 'a@b.c' }, layout: 'topbar' })
  await t.eventually(`!!document.querySelector('#stage .shell > header.topbar nav[aria-label="Main"]')`, 'true',
    'layout="topbar" draws the nav in the bar')
  t.ok(await t.evaluate(`return !document.querySelector('#stage .sidebar, #stage .sidebar-toggle, dialog.drawer');`),
    'with no sidebar, no toggle and no drawer')
  const topCurrent = `[...document.querySelectorAll('#stage .topbar nav[aria-label="Main"] a[aria-current="page"] .navlink-text')].map(s => s.textContent).join('|')`
  t.is(await t.evaluate(`return [...document.querySelectorAll('#stage .topbar nav[aria-label="Main"] .navlink-text')].map(s => s.textContent).join('|');`),
    'Today|Leads|Clients|Contacts|Docs', 'the groups are drawn flat, in order')
  t.ok(await t.evaluate(`return !document.querySelector('#stage .topbar .navlist-label');`), 'and their labels dropped')
  t.is(await t.evaluate(`return ${topCurrent};`), 'Leads', 'the current page is marked')
  t.ok(await t.evaluate(`
    const right = document.querySelector('#stage .topbar > .cluster:last-child');
    return !!right.querySelector('#top-right') && !!right.querySelector('[data-foot="topbar"]') && right.querySelector('button.btn')?.textContent === 'Sign out';
  `), 'the topbar snippet, the foot (told it is in the topbar) and Sign out sit at the bar\'s end')
  t.is(await t.evaluate(`return document.querySelector('#stage main.screen strong')?.textContent;`), 'Leads', 'the title heads the Screen')
  t.is(await t.evaluate(`return [...document.querySelectorAll('#stage main.screen nav[aria-label="Section"] .navlink')].map(a => a.textContent + (a.getAttribute('aria-current') ? '*' : '')).join('|');`),
    'Open*|Lost', 'and so does the section bar')

  await t.clickAt('#stage .topbar a[href="/contacts/?kind=customer"]')
  await t.eventually(topCurrent, 'Clients', 'a click moves the highlight')
  t.ok(await t.evaluate(`return !document.querySelector('#stage main.screen nav[aria-label="Section"]');`),
    'and a page in no section draws no section bar')

  await t.viewport(375)
  await t.eventually(`[...document.querySelectorAll('#stage .topbar nav[aria-label="Main"] .navlink')].every(a => { const r = a.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth })`, 'true',
    'below md every entry is still in the bar, inside the viewport')
  t.ok(await t.evaluate(`return document.documentElement.scrollWidth <= innerWidth;`), 'the bar wraps rather than scrolling the page sideways')
  t.ok(!(await t.evaluate(`return ${visibleBox('#stage .sidebar-toggle')};`)), 'and there is still no toggle')

  /* ── a guest the table offers something ─────────────────────────────── */

  // A shop's nav is public. The table says so by what `show` lets through,
  // and the frame follows; Sign out is the one thing a guest never gets.
  await t.viewport(1280)
  await t.mount('shell', { guests: true, layout: 'topbar' })
  await t.eventually(`[...document.querySelectorAll('#stage .shell > header.topbar nav[aria-label="Main"] .navlink-text')].map(s => s.textContent).join('|')`,
    'Today|Leads|Clients|Contacts', 'signed out, a topbar draws the entries a guest is offered')
  t.ok(await t.evaluate(`return !!document.querySelector('#stage #top-right') && ![...document.querySelectorAll('#stage button.btn')].some(b => b.textContent === 'Sign out');`),
    'with the topbar snippet and no Sign out')

  await t.mount('shell', { guests: true })
  await t.eventually(`!!document.querySelector('#stage .shell.sidebar-first > nav.sidebar')`, 'true',
    'signed out, a sidebar draws the frame too')
  t.ok(await t.evaluate(`return ![...document.querySelectorAll('#stage button.btn, dialog.drawer button.btn')].some(b => b.textContent === 'Sign out');`),
    'with no Sign out in the sidebar or the drawer')
}
