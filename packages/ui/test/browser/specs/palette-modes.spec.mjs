/*
 * palette-modes.spec.mjs — the branches of CommandPalette nothing has opened.
 *
 * `palette.spec.mjs` opens it with ⌘K, walks the list, runs a command and
 * measures that it is styled from the design system (`FJS-129`). What it never
 * touches is any of the props that select a different palette: `groupOrder`,
 * `emptyText`, `closeOnSelect`, `placeholder`, `maxWidth`/`maxHeight` — nor the
 * pointer half of the contract, nor a list long enough to scroll.
 *
 * The cursor is where the interesting failures live. It is an INDEX into a list
 * the query rebuilds under it, so every question about it is really a question
 * about ordering: does it come back to the top when the list changes, does the
 * scroll container follow it, and does the pointer hand it back to the keyboard
 * where it left off.
 *
 * The panel is portaled to `<body>`, so every selector here is document-wide; a
 * query scoped to the fixture finds nothing and reads as "it never opened".
 */
export const name = 'CommandPalette — the modes'
export const covers = ['overlay/CommandPalette']

const rows        = `[...document.querySelectorAll('.fjs-cp-row')]`
const labels      = `${rows}.map(r => r.querySelector('.item-title').textContent.trim())`
const activeLabel = `document.querySelector('.fjs-cp-row--active .item-title')?.textContent.trim()`
const groups      = `[...document.querySelectorAll('.fjs-cp-grouplabel')].map(g => g.textContent.trim())`
const panels      = `document.querySelectorAll('.fjs-cp-panel').length`

// A negative wants a beat rather than a poll: `eventually` returns the moment
// it matches, so waiting for "still 0" succeeds instantly and would pass
// against a close that happens right after.
const beat = (t) => t.evaluate(`await new Promise(r => setTimeout(r, 120)); return true;`)

export async function run(t) {
  /* ── group ordering ───────────────────────────────────────────────────── */

  await t.mount('palette-modes')

  t.is(await t.evaluate(`return ${groups}.join(',');`), 'Settings,Orders,People',
    'with no groupOrder the groups keep the order their items declared them in')

  await t.mount('palette-modes', { groupOrder: ['People', 'Orders'] })

  t.is(await t.evaluate(`return ${groups}.join(',');`), 'People,Orders,Settings',
    'groupOrder leads, and a group it does not name follows rather than vanishing')
  t.is(await t.evaluate(`return ${activeLabel};`), 'Staff',
    'and the cursor starts on the first row of the reordered list, not the first declared item')

  // A heading over no rows is worse than no heading: the reorder has to be
  // applied to what SURVIVED the query, not to the declared set.
  await t.type('staff')
  await t.eventually(`${groups}.join(',')`, 'People',
    'a group the query empties drops its heading, ordered or not')

  /* ── what a query searches ────────────────────────────────────────────── */

  await t.mount('palette-modes')
  await t.type('SETTINGS')
  await t.eventually(`${labels}.join(',')`, 'Switch theme',
    'a query matches the GROUP name, case-insensitively')

  await t.mount('palette-modes')
  await t.type('ordered')
  await t.eventually(`${labels}.join(',')`, 'Customers',
    'and the SUB line — the two fields a label-only search would miss')

  /* ── the cursor ───────────────────────────────────────────────────────── */

  await t.mount('palette-modes')

  t.is(await t.evaluate(`return ${activeLabel};`), 'Switch theme', 'the first row starts active')
  for (let i = 0; i < 3; i++) await t.press('ArrowDown')
  t.is(await t.evaluate(`return ${activeLabel};`), 'Staff',
    'arrows cross group headings without stopping on them')

  // The cursor is an index into a list the query rebuilds under it. Three rows
  // down and then a query matching three leaves it pointing past the end: no
  // row is active, and Enter — the whole point of a palette — runs nothing.
  await t.type('order')
  await t.eventually(`${rows}.length`, 3, 'typing filters the list')
  t.is(await t.evaluate(`return ${activeLabel};`), 'New order',
    'and the cursor returns to the top rather than pointing past the end of the new list')

  await t.press('Enter')
  await t.eventually(`document.querySelector('#ran').textContent`, 'new',
    'so Enter still runs the row it is showing as active')

  /* ── the pointer, and handing back to the keyboard ────────────────────── */

  await t.mount('palette-modes')

  await t.evaluate(`
    ${rows}[4].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    return true;
  `)
  await t.eventually(activeLabel, 'Customers', 'moving the pointer onto a row takes the cursor')
  await t.press('ArrowUp')
  t.is(await t.evaluate(`return ${activeLabel};`), 'Staff',
    'and the keyboard continues from where the pointer left it, not from the top')

  // ⌘K is a keyboard gesture and the mouse is wherever it was left, so a
  // palette opens under a stationary pointer nearly every time. Taking the
  // cursor from whichever row lands under it means Enter runs a command
  // nobody chose — and nothing on screen distinguishes that from the palette
  // working. `mouseenter` fires on an element arriving under a still pointer;
  // `mousemove` needs the pointer to actually move.
  await t.clickAt('.fjs-cp-row:nth-of-type(4)')
  await t.mount('palette-modes')
  await t.evaluate(`await waitSettled('.fjs-cp-backdrop'); return true;`)
  t.is(await t.evaluate(`return ${activeLabel};`), 'Switch theme',
    'and a palette that opens under a stationary pointer keeps its cursor on the first row')

  /* ── the clear button ─────────────────────────────────────────────────── */

  await t.mount('palette-modes')

  t.is(await t.evaluate(`return document.querySelectorAll('.fjs-cp-clear').length;`), 0,
    'no clear button while the box is empty')
  await t.type('order')
  await t.eventually(`document.querySelectorAll('.fjs-cp-clear').length`, 1,
    'and one once there is something to clear')

  await t.clickAt('.fjs-cp-clear')
  await t.eventually(`${rows}.length`, 5, 'clearing it restores the whole list')
  t.is(await t.evaluate(`return document.querySelector('.fjs-cp-input').value;`), '',
    'and empties the box')

  // The button is inside the panel, so clicking it moves focus off the input.
  // Nothing on screen says so — the list is right, the box is empty, the caret
  // is gone — and the next keystroke is dropped.
  await t.type('staff')
  await t.eventually(`${labels}.join(',')`, 'Staff',
    'and leaves focus in the box, so the next keystroke filters')

  /* ── running a command with the pointer ───────────────────────────────── */

  await t.mount('palette-modes')

  await t.clickAt('.fjs-cp-row')
  await t.eventually(`document.querySelector('#ran').textContent`, 'theme', 'clicking a row runs it')
  await t.eventually(`document.querySelector('#closes').textContent`, '1',
    'and closes the palette, which is what closeOnSelect defaults to')
  t.is(await t.evaluate(`return ${panels};`), 0, 'the panel goes with it')

  await t.mount('palette-modes', { closeOnSelect: false })

  await t.clickAt('.fjs-cp-row')
  await t.eventually(`document.querySelector('#ran').textContent`, 'theme',
    'closeOnSelect={false} still runs the command')
  t.is(await t.evaluate(`return ${panels};`), 1, 'and leaves the palette open')
  t.is(await t.evaluate(`return document.querySelector('#closes').textContent;`), '0',
    'announcing no close, so an app does not tear down a palette that is still up')

  await t.press('ArrowDown')
  await t.press('Enter')
  await t.eventually(`document.querySelector('#runs').textContent`, '2',
    'so a second command can be run without reopening it')
  t.is(await t.evaluate(`return document.querySelector('#ran').textContent;`), 'new',
    'and the keyboard still drives the list it left open')

  /* ── the empty states ─────────────────────────────────────────────────── */

  // Two of them, and they are different sentences: nothing to show, and
  // nothing matching what you typed.
  await t.mount('palette-modes', { set: 'none' })

  t.ok(await t.evaluate(`return !!byText('.fjs-cp-empty', 'No commands available');`),
    'a palette with no items says so rather than rendering an empty box')
  t.match(await t.evaluate(`return document.querySelector('.fjs-cp-count').textContent.trim();`),
    /^0 results$/, 'and the count is plural at zero')

  await t.press('Enter')
  await beat(t)
  t.is(await t.evaluate(`return document.querySelector('#runs').textContent;`), '0',
    'Enter over nothing runs nothing and throws nothing')

  await t.mount('palette-modes', { useEmptyText: true })
  await t.type('zzz')
  await t.eventually(`document.querySelector('.fjs-cp-empty').textContent.includes('nothing here for “zzz”')`,
    true, 'emptyText replaces the built-in message and is handed the query')

  /* ── dismissal ────────────────────────────────────────────────────────── */

  // Small enough that the centre of the viewport is backdrop rather than
  // panel, which is the only way to click one and not the other.
  await t.mount('palette-modes', { maxWidth: 320, maxHeight: '120px' })

  // The panel scales in from 0.97, so a rect read on arrival is 3% short of
  // every dimension the caller asked for.
  await t.evaluate(`await waitSettled('.fjs-cp-backdrop'); return true;`)

  const box = await t.evaluate(`
    const r = document.querySelector('.fjs-cp-panel').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  `)
  t.is(box.w, 320, 'maxWidth is a pixel count the panel honours')
  t.ok(box.h <= 121, 'and maxHeight caps its height, so the list scrolls inside it')

  await t.clickAt('.fjs-cp-footer')
  await beat(t)
  t.is(await t.evaluate(`return document.querySelector('#closes').textContent;`), '0',
    'a click inside the panel does not dismiss it')

  await t.clickAt('.fjs-cp-backdrop')
  await t.eventually(`document.querySelector('#closes').textContent`, '1',
    'while one on the backdrop does')

  /* ── a list longer than the panel ─────────────────────────────────────── */

  await t.mount('palette-modes', { set: 'long', maxHeight: '240px' })

  t.is(await t.evaluate(`return ${rows}.length;`), 30, 'thirty rows in one group')

  for (let i = 0; i < 20; i++) await t.press('ArrowDown')
  const seen = await t.evaluate(`
    const list = document.querySelector('.fjs-cp-list');
    const row  = document.querySelector('.fjs-cp-row--active');
    if (!row) return { label: '(none active)' };
    const lr = list.getBoundingClientRect(), rr = row.getBoundingClientRect();
    return {
      label:    row.querySelector('.item-title').textContent.trim(),
      scrolled: list.scrollTop > 0,
      inside:   rr.top >= lr.top - 1 && rr.bottom <= lr.bottom + 1,
    };
  `)
  t.is(seen.label, 'Command 20', 'twenty presses reach the twenty-first command')
  t.ok(seen.scrolled, 'the list scrolled to follow the cursor')
  // The watcher reads `[data-active="true"]` out of the DOM, so it is only
  // right if it runs after the render that moved the flag. One tick early and
  // it scrolls the previous row into view — the cursor stays a row below the
  // fold and the palette looks like it stopped responding.
  t.ok(seen.inside, 'and the active row is inside the visible box, not below it')

  await t.type('9')
  await t.eventually(`${rows}.length`, 3, 'a query narrows the long list')
  await t.eventually(`document.querySelector('.fjs-cp-list').scrollTop`, 0,
    'and the list scrolls back to the top with the cursor')

  /* ── the row, and what a caller can reach ─────────────────────────────── */

  await t.mount('palette-modes', { placeholder: 'Type a command' })

  t.is(await t.evaluate(`return document.querySelector('.fjs-cp-input').placeholder;`), 'Type a command',
    'the placeholder is the caller\'s')
  t.is(await t.evaluate(`return document.querySelector('.fjs-cp-panel').getAttribute('data-fixture');`), 'modes',
    'and its attributes land on the panel')

  // The shortcut column is the row's own hint until the cursor arrives, when
  // it becomes the key that would run it.
  t.is(await t.evaluate(`return ${rows}[0].querySelector('kbd')?.textContent.trim();`), '↵',
    'the active row offers Enter where its shortcut hint would be')
  await t.press('ArrowDown')
  await t.eventually(`${rows}[0].querySelector('.fjs-cp-rowkbd')?.textContent.trim()`, '⌘ T',
    'and hands the hint back when the cursor leaves')
  t.is(await t.evaluate(`return ${rows}[2].querySelector('.fjs-cp-badge')?.textContent.trim();`), 'Beta',
    'a badge renders where an item declares one')
  t.is(await t.evaluate(`return ${rows}[3].querySelector('.fjs-cp-rowicon');`), null,
    'and an item with no icon gets no icon slot rather than an empty one')

  /* ── what it says to a screen reader ──────────────────────────────────── */

  t.is(await t.evaluate(`return document.querySelector('.fjs-cp-panel').getAttribute('aria-modal');`), 'true',
    'the panel is a modal dialog')
  t.is(await t.evaluate(`return document.querySelectorAll('.fjs-cp-list[role=listbox]').length;`), 1,
    'the list is a listbox')
  t.is(await t.evaluate(`return ${rows}.filter(r => r.getAttribute('role') === 'option').length;`), 5,
    'every row is one of its options')
  t.is(await t.evaluate(`return ${rows}.filter(r => r.getAttribute('aria-selected') === 'true').length;`), 1,
    'and exactly one is selected, wherever the cursor is')

  // Focus never leaves the search box, so `aria-selected` moving down the list
  // is invisible to a screen reader on its own: the input has to NAME the row
  // it would run. Without it the reader hears the query they typed and nothing
  // about what Enter is about to do.
  const active = await t.evaluate(`
    const input = document.querySelector('.fjs-cp-input');
    const id    = input.getAttribute('aria-activedescendant');
    const row   = id && document.getElementById(id);
    return { id, active: !!row && row.classList.contains('fjs-cp-row--active') };
  `)
  t.ok(active.active, 'and the search box names the active row through aria-activedescendant')

  // The pointer is left wherever the last click put it, and the palette is
  // portaled outside the fixture. Both outlive this spec: the next one opens a
  // palette under that pointer, on a page this one left a panel on.
  await t.press('Escape')
}
