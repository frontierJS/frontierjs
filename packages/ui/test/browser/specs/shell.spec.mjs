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
 * gets the drawer toggle at every width; a topbar draws an unlabeled group
 * flat and a labeled one as a menu, puts the section bar on the Screen, and
 * hands its nav to the drawer below md.
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
  await t.eventually(`!!document.querySelector('#stage .shell.sidebar-first > main.screen#main #page')`, 'true',
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
  t.ok(await t.evaluate(`return !document.querySelector('#stage .skip-link') && !!document.querySelector('#stage main#main[tabindex="-1"]');`),
    'the Screen is the #main the document\'s skip link lands on, and can take focus; the link itself is Sierra\'s (FJS-D836)')

  t.is(await t.evaluate(`return ${current};`), 'Leads', 'the current page is marked, and an exact / is not')

  t.ok(!(await t.evaluate(`return ${visibleBox('#stage .sidebar-toggle')};`)),
    'above md the drawer toggle is hidden')
  t.ok(await t.evaluate(`return ${visibleBox('#stage .sidebar')};`), 'above md the sidebar is on screen')

  /* ── the section bar ────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return document.querySelector('#stage .topbar h1')?.textContent;`), 'Leads', 'the title is drawn')
  t.is(await t.evaluate(`return document.querySelectorAll('#stage h1').length;`), 1, 'and is the page\'s only h1')
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

  // In an app the document's skip link stands before the shell (FJS-D836); the
  // kit page has none, so a sentinel stands where it would, and Tab leaves it.
  await t.evaluate(`const s = document.createElement('button'); s.id = 'before-shell'; document.querySelector('#stage .shell').before(s); s.focus(); return true;`)
  await t.press('Tab')
  t.ok(await t.evaluate(`document.getElementById('before-shell').remove(); return document.activeElement.matches('#stage .sidebar [data-brand]:focus-visible');`),
    'Tab from before the shell lands in the rail')
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

  /* ── a sidebar that folds itself ────────────────────────────────────── */

  // The control sits inside what it folds, so the folded sidebar is a plain
  // rail: a peeking one would open again under the pointer that closed it.
  await t.mount('shell', { user: { email: 'a@b.c' }, collapsible: true })
  const fold = '#stage .sidebar .shell-fold'
  await t.eventually(`!!document.querySelector('${fold}')`, 'true', 'collapsible puts a fold control at the head of the sidebar')
  t.is(await t.evaluate(`return document.querySelector('${fold}').getAttribute('aria-expanded');`), 'true', 'which says the sidebar is open')
  await t.eventually(railWidth, String(15 * rem), 'at --sidebar-width')
  await t.clickAt(fold)
  await t.eventually(`document.querySelector('#stage .shell > nav.sidebar').classList.contains('rail')`, 'true', 'a click folds it to a rail')
  await t.eventually(railWidth, String(3.5 * rem), 'an icon wide')
  t.ok(await t.evaluate(`return !document.querySelector('#stage .sidebar').classList.contains('peek');`), 'and not a peeking one')
  t.is(await t.evaluate(`return document.querySelector('${fold}').getAttribute('aria-expanded');`), 'false', 'the control now says it is folded')
  t.ok(await t.evaluate(`return !!document.querySelector('#stage .sidebar [data-foot="rail"]') && !document.querySelector('#stage .sidebar [data-foot="sidebar"]');`),
    'the foot is told it is in a rail')
  t.ok(await t.evaluate(`return document.querySelector('#stage .topbar button.btn:not(.sidebar-toggle)')?.textContent === 'Sign out' && !document.querySelector('#stage .sidebar .navlist ~ div button');`),
    'and Sign out is in the bar')
  t.ok(await t.evaluate(`return !document.querySelector('dialog.drawer .shell-fold');`), 'the drawer carries no fold control')
  await t.clickAt(fold)
  await t.eventually(`document.querySelector('#stage .shell > nav.sidebar').classList.contains('rail')`, 'false', 'a second click opens it again')
  await t.eventually(railWidth, String(15 * rem), 'to --sidebar-width')

  /* ── groups that fold ───────────────────────────────────────────────── */

  // Promoted, the labeled groups are Admin then Help: the first starts open
  // and the other closed, and arriving on a page in a closed group opens it,
  // over the reader's own choice to close it.
  await t.mount('shell', { user: { email: 'a@b.c' }, level: 5, foldable: true })
  const folds = `[...document.querySelectorAll('#stage .sidebar details')].map(d => d.querySelector('summary').textContent + (d.open ? '+' : '-')).join('|')`
  await t.eventually(folds, 'Admin+|Help-', 'the first labeled group starts open and the rest closed')
  t.ok(await t.evaluate(`
    const summary = [...document.querySelectorAll('#stage .sidebar summary.navlist-label')].find(s => s.textContent === 'Help');
    return summary.nextElementSibling.getAttribute('aria-labelledby') === summary.id;
  `), 'a folding label still names its list')
  t.is(await t.evaluate(`return document.querySelectorAll('#stage .sidebar .navlist-label:not(summary)').length;`), 0,
    'and an unlabeled group draws flat')

  await t.clickAt('#stage .sidebar details:first-of-type > summary')
  await t.eventually(folds, 'Admin-|Help-', 'a click on a label closes its group')
  await t.clickAt('#stage #to-help')
  await t.eventually(folds, 'Admin-|Help+', 'arriving on a page in a closed group opens it')
  await t.eventually(current, 'Docs', 'with its link marked')
  await t.clickAt('#stage .sidebar details:last-of-type > summary')
  await t.eventually(folds, 'Admin-|Help-', 'the reader may close the current group')
  await t.clickAt('#stage .sidebar details:first-of-type > summary')
  await t.eventually(folds, 'Admin+|Help-', 'and open another')

  /* ── layout="topbar" ────────────────────────────────────────────────── */

  await t.mount('shell', { user: { email: 'a@b.c' }, layout: 'topbar' })
  await t.eventually(`!!document.querySelector('#stage .shell > header.topbar nav[aria-label="Main"]')`, 'true',
    'layout="topbar" draws the nav in the bar')
  t.ok(await t.evaluate(`return !document.querySelector('#stage .sidebar') && !${visibleBox('#stage .sidebar-toggle')};`),
    'with no sidebar, and above md no drawer toggle')
  const topCurrent = `[...document.querySelectorAll('#stage .topbar nav[aria-label="Main"] a[aria-current="page"] .navlink-text')].map(s => s.textContent).join('|')`
  t.is(await t.evaluate(`return [...document.querySelectorAll('#stage .topbar nav[aria-label="Main"] .navlink-text')].map(s => s.textContent).join('|');`),
    'Today|Leads|Clients|Contacts', 'an unlabeled group is drawn flat, in order')
  t.ok(await t.evaluate(`return !document.querySelector('#stage .topbar .navlist-label');`), 'with no group label in the bar')
  const helpMenu = '#stage .topbar nav[aria-label="Main"] button.navlink'
  t.is(await t.evaluate(`const b = document.querySelector('${helpMenu}'); return b?.textContent.trim() + '|' + b?.getAttribute('aria-haspopup');`),
    'Help ▾|menu', 'a labeled group is one menu, named by its label')
  t.is(await t.evaluate(`return ${topCurrent};`), 'Leads', 'the current page is marked')
  t.ok(await t.evaluate(`
    const right = document.querySelector('#stage .topbar > .cluster:last-child');
    return !!right.querySelector('#top-right') && !!right.querySelector('[data-foot="topbar"]') && right.querySelector('button.btn')?.textContent === 'Sign out';
  `), 'the topbar snippet, the foot (told it is in the topbar) and Sign out sit at the bar\'s end')
  t.is(await t.evaluate(`return document.querySelector('#stage main.screen h1')?.textContent;`), 'Leads', 'the title heads the Screen')
  t.is(await t.evaluate(`return [...document.querySelectorAll('#stage main.screen nav[aria-label="Section"] .navlink')].map(a => a.textContent + (a.getAttribute('aria-current') ? '*' : '')).join('|');`),
    'Open*|Lost', 'and so does the section bar')

  await t.clickAt('#stage .topbar a[href="/contacts/?kind=customer"]')
  await t.eventually(topCurrent, 'Clients', 'a click moves the highlight')
  t.ok(await t.evaluate(`return !document.querySelector('#stage main.screen nav[aria-label="Section"]');`),
    'and a page in no section draws no section bar')

  await t.clickAt(helpMenu)
  t.ok(await t.evaluate(`return await waitVisible('[role=menu] a[href="/help/"]');`), 'the menu opens on its entries')
  await t.clickAt(helpMenu)

  // The menu's rows are portaled out of the stage, where the fixture's router
  // does not reach, so the page is mounted inside the menu rather than
  // clicked to.
  await t.mount('shell', { user: { email: 'a@b.c' }, layout: 'topbar', path: '/help/' })
  await t.eventually(`document.querySelector('${helpMenu}')?.getAttribute('aria-current')`, 'true',
    'a page inside the menu marks its trigger')
  t.is(await t.evaluate(`return ${topCurrent};`), '', 'and no flat entry')
  await t.clickAt('#stage .topbar a[href="/leads/"]')
  await t.eventually(`document.querySelector('${helpMenu}')?.getAttribute('aria-current') ?? 'none'`, 'none',
    'and leaving the menu\'s pages unmarks it')

  await t.viewport(375)
  await t.eventually(`!${visibleBox('#stage .topbar-nav')} && ${visibleBox('#stage .sidebar-toggle')}`, 'true',
    'below md the bar draws the drawer toggle in place of the nav')
  t.ok(await t.evaluate(`return document.documentElement.scrollWidth <= innerWidth;`), 'and the page does not scroll sideways')
  await t.clickAt('#stage .sidebar-toggle')
  await t.evaluate(`await waitFor(() => document.querySelector('dialog.drawer')?.open); return true;`)
  t.is(await t.evaluate(`return [...document.querySelectorAll('dialog.drawer .navlist-label, dialog.drawer .navlink-text')].map(s => s.textContent).join('|');`),
    'Today|Leads|Clients|Contacts|Help|Docs', 'the drawer writes every group out, labels included')
  t.is(await t.evaluate(`return [...document.querySelectorAll('#stage button.btn, dialog.drawer button.btn')].filter(b => b.textContent === 'Sign out').length;`),
    1, 'Sign out stays in the bar and only there')
  await t.clickAt('dialog.drawer a[href="/leads/"]')
  await t.evaluate(`await waitFor(() => !document.querySelector('dialog.drawer').open); return true;`)
  t.ok(await t.evaluate(`return !document.querySelector('dialog.drawer').open;`), 'navigating from the drawer closes it')

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
