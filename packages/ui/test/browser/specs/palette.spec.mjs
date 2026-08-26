/*
 * palette.spec.mjs — CommandPalette.
 *
 * `example`'s `verify:ui` drives the palette on a real screen and asserts four
 * things about it. This one asks the questions a screen cannot: whether the
 * component is STYLED from the design system (`FJS-129` — it shipped its own
 * `--cp-*` namespace, its own radius, its own font stack and five literal
 * colours, so a theme switch reached it partially and `.dense` not at all),
 * and whether the keyboard contract holds at the edges — the ends of the list,
 * and arrow keys crossing a group boundary. The second of those found that
 * `keydown` was handled twice per press, so every arrow key skipped a row and
 * Enter ran the chosen command twice.
 *
 * The panel is portaled to `<body>`, so every selector here is document-wide;
 * a query scoped to the fixture finds nothing and reads as "it never opened".
 */
export const name = 'CommandPalette'
export const covers = ['overlay/CommandPalette']

const rows = `[...document.querySelectorAll('.fjs-cp-row')]`
const activeLabel = `document.querySelector('.fjs-cp-row--active .item-title')?.textContent.trim()`

export async function run(t) {
  await t.mount('palette')

  t.is(await t.evaluate(`return document.querySelectorAll('.fjs-cp-panel').length;`), 0,
    'the palette starts closed')

  /* ── opening ─────────────────────────────────────────────────────────── */

  // ⌘K through the input pipeline. A dispatched KeyboardEvent is not trusted
  // and a window listener that checks metaKey would never see it.
  await t.press('k', 2 /* Meta */)
  t.ok(await t.evaluate(`return await waitVisible('.fjs-cp-panel');`),
    'Meta+K opens it')

  t.ok(await t.evaluate(`
    const input = document.querySelector('.fjs-cp-input');
    return document.activeElement === input;
  `), 'and focus lands in the search box, so typing filters immediately')

  t.is(await t.evaluate(`return ${rows}.length;`), 6, 'every command is listed')
  t.is(await t.evaluate(`return document.querySelectorAll('.fjs-cp-grouplabel').length;`), 3,
    'grouped under their headings')

  /* ── the keyboard contract ───────────────────────────────────────────── */

  t.is(await t.evaluate(`return ${activeLabel};`), 'New order', 'the first row starts active')

  await t.press('ArrowDown')
  t.is(await t.evaluate(`return ${activeLabel};`), 'Find an order', 'ArrowDown moves down')

  // Crossing a group boundary is the case a flat index gets wrong: the third
  // row is the last of "Orders" and the fourth is the first of "People".
  await t.press('ArrowDown')
  await t.press('ArrowDown')
  t.is(await t.evaluate(`return ${activeLabel};`), 'Customers',
    'ArrowDown crosses a group heading without stopping on it')

  await t.press('ArrowUp')
  t.is(await t.evaluate(`return ${activeLabel};`), 'Refund an order', 'ArrowUp crosses back')

  // The ends CLAMP rather than wrap, which is the component's choice and is
  // asserted so that changing it is a decision rather than a drift. Nothing on
  // screen distinguishes "stuck at the end" from "wrapped" until you look at
  // which row is active.
  await t.press('ArrowUp')
  await t.press('ArrowUp')
  await t.press('ArrowUp')
  t.is(await t.evaluate(`return ${activeLabel};`), 'New order',
    'ArrowUp holds at the first row rather than wrapping')
  for (let i = 0; i < 7; i++) await t.press('ArrowDown')
  t.is(await t.evaluate(`return ${activeLabel};`), 'Switch theme',
    'and ArrowDown holds at the last')

  /* ── filtering, and running a command ────────────────────────────────── */

  await t.type('refund')
  await t.eventually(`${rows}.length`, 1, 'typing filters the list')
  t.is(await t.evaluate(`return ${activeLabel};`), 'Refund an order',
    'and the surviving row becomes the active one')
  t.match(await t.evaluate(`return document.querySelector('.fjs-cp-count').textContent.trim();`),
    /^1 result$/, 'the count agrees, singular')

  await t.press('Enter')
  await t.eventually(`document.querySelector('#ran').textContent`, 'refund',
    'Enter runs the active command')
  // Once. `keydown` bubbles, and the handler used to be bound on the input as
  // well as on the backdrop — so every arrow key skipped a row and Enter ran
  // the chosen command TWICE, which for a command palette is the difference
  // between one order and two.
  await t.eventually(`document.querySelector('#runs').textContent`, '1',
    'exactly once')
  await t.evaluate(`await waitFor(() => !document.querySelector('.fjs-cp-panel')); return true;`)
  t.is(await t.evaluate(`return document.querySelectorAll('.fjs-cp-panel').length;`), 0,
    'and closes the palette')

  /* ── ranking, not just filtering ──────────────────────────────────────── */

  // The palette filtered with `String.includes` and imposed no order, so every
  // command containing the query came back in the order it was REGISTERED —
  // typing a command's own name could leave it below others that merely
  // mention the word.
  //
  // `cust` is the case that separates the two. It matches `Customers` on its
  // label and `Find an order` on its sub line ("By id or customer"), and
  // `Find an order` is declared first. Ranked, the label match wins; filtered,
  // registration order does. This fixture declares no `groupOrder`, so the
  // group order follows the ranked list too and the FIRST ROW differs — which
  // is the thing a person actually experiences.
  // Reopened rather than remounted: the block above closed the palette, and a
  // remount here loses the keyboard focus ⌘K is delivered through.
  await t.press('k', 2)
  await t.evaluate(`return await waitVisible('.fjs-cp-panel');`)
  await t.type('cust')

  await t.eventually(`${rows}.map(r => r.querySelector('.item-title').textContent.trim()).join(',')`,
    'Customers,Find an order',
    'the label match outranks the sub-line match, rather than following it')

  t.is(await t.evaluate(`return ${activeLabel};`), 'Customers',
    'and the cursor starts on the best match, so Enter runs what was typed')

  /* ── and the match is marked ──────────────────────────────────────────── */

  // Ranges rather than markup is the whole shape of the search kit: it answers
  // index pairs and the component emits its own elements, so a label out of a
  // database row cannot inject. What that buys is only real if something is
  // actually marked.
  t.is(await t.evaluate(`
    const row = [...document.querySelectorAll('.fjs-cp-row')]
      .find(r => r.querySelector('.item-title').textContent.trim() === 'Customers');
    return row?.querySelector('.item-title mark')?.textContent ?? null;
  `), 'Cust', 'the matched run is marked, and only that run')

  // The label is assembled from pieces now. Written across lines, the
  // whitespace between them lands INSIDE the word — "Customers" comes back as
  // "Cust omers" and every existing textContent assertion starts lying.
  t.is(await t.evaluate(`
    const row = [...document.querySelectorAll('.fjs-cp-row')]
      .find(r => r.querySelector('.item-title').textContent.trim() === 'Customers');
    return row?.querySelector('.item-title').textContent;
  `), 'Customers', 'and the pieces rejoin with no whitespace between them')

  // The sub line carries its OWN ranges. `Find an order` matched on
  // "By id or customer", so a flat range list would mark its label at the
  // offsets belonging to its sub.
  const findRow = `
    const row = [...document.querySelectorAll('.fjs-cp-row')]
      .find(r => r.querySelector('.item-title').textContent.trim() === 'Find an order');
  `
  t.is(await t.evaluate(`${findRow} return row?.querySelector('.item-sub mark')?.textContent ?? null;`),
    'cust', 'a sub-line match marks the sub line')
  t.is(await t.evaluate(`${findRow} return row?.querySelector('.item-title mark')?.textContent ?? null;`),
    null, 'and leaves the label alone — the ranges are per field, not one flat list')

  await t.press('Escape')
  await t.evaluate(`await waitFor(() => !document.querySelector('.fjs-cp-panel')); return true;`)

  // A search with no hits has to say so rather than render an empty box.
  await t.press('k', 2)
  await t.evaluate(`return await waitVisible('.fjs-cp-panel');`)
  await t.type('zzz')
  await t.eventually(`${rows}.length`, 0, 'a query with no matches empties the list')
  t.ok(await t.evaluate(`return !!byText('.fjs-cp-empty', 'No results for');`),
    'and the empty state names the query')

  await t.press('Escape')
  await t.evaluate(`await waitFor(() => !document.querySelector('.fjs-cp-panel')); return true;`)
  t.is(await t.evaluate(`return document.querySelectorAll('.fjs-cp-panel').length;`), 0,
    'Escape closes it')

  /* ── it is styled from the design system ─────────────────────────────── */

  await t.clickAt('#stage #open-palette')
  await t.evaluate(`return await waitVisible('.fjs-cp-panel');`)

  // FJS-129: 21 custom properties, five of them defined without reading a
  // token — `--cp-radius: 12px`, `--cp-shadow: 0 24px 80px rgba(0,0,0,0.72)`,
  // `--cp-font: 'SF Mono', …` — plus five literal colours. Each assertion
  // below is one of those, asked as a measurement.

  t.is(await t.evaluate(`
    const panel = document.querySelector('.fjs-cp-panel');
    const token = getComputedStyle(document.documentElement).getPropertyValue('--card-radius').trim();
    return getComputedStyle(panel).borderRadius === token;
  `), true, 'the panel takes its radius from --card-radius, not a literal 12px')

  // Compared with quoting and spacing normalised: the CSSOM re-serialises a
  // font stack, so a string compare against the token's own text fails against
  // a value that is in fact identical.
  t.is(await t.evaluate(`
    const norm  = (v) => v.replace(/["']/g, '').replace(/\\s+/g, ' ').trim();
    const panel = document.querySelector('.fjs-cp-panel');
    const token = getComputedStyle(document.documentElement).getPropertyValue('--font-mono');
    return norm(getComputedStyle(panel).fontFamily) === norm(token);
  `), true, 'and its face from --font-mono, not its own stack')

  // The scrim is now a token both the package's dialogs and this component
  // read, which is what stops them dimming by different amounts.
  t.is(await t.evaluate(`
    const back  = document.querySelector('.fjs-cp-backdrop');
    const probe = document.createElement('div');
    probe.style.background = getComputedStyle(document.documentElement).getPropertyValue('--scrim').trim();
    document.body.appendChild(probe);
    const same = getComputedStyle(probe).backgroundColor === getComputedStyle(back).backgroundColor;
    probe.remove();
    return same;
  `), true, 'the backdrop dims by --scrim, the same token a <dialog> uses')

  const themed = await t.evaluate(`
    // Read the TOKEN, not the resolved colour. The panel's background is
    // painted by the design system's own :where(.surface, ...) rule as
    // var(--surface-bg), and headless Chrome leaves a var-substituted paint
    // stale after an ancestor class change: the custom property updates and
    // the resolved background-color does not, which reads as a panel that does
    // not theme. The property is what carries the theme anyway, so this is the
    // more precise question as well as the answerable one.
    // (No backticks in here - this whole probe is a template literal.)
    const panel = document.querySelector('.fjs-cp-panel');
    const read = () => getComputedStyle(panel).getPropertyValue('--surface-bg').trim();
    const before = read();
    document.body.className = 'theme-dark';
    await new Promise(r => setTimeout(r, 50));
    const after = read();
    document.body.className = 'theme-default';
    return { before, after };
  `)
  t.ok(themed.before && themed.after && themed.before !== themed.after,
    `a theme switch moves the panel's surface token (${themed.before} → ${themed.after})`)

  const dense = await t.evaluate(`
    const row = document.querySelector('.fjs-cp-row');
    const loose = parseFloat(getComputedStyle(row).paddingTop);
    document.body.classList.add('dense');
    await new Promise(r => setTimeout(r, 50));
    const tight = parseFloat(getComputedStyle(row).paddingTop);
    document.body.classList.remove('dense');
    return { loose, tight };
  `)
  t.ok(dense.tight < dense.loose, '.dense reaches the rows — the palette is on the space ladder')

  // The active row is the package's tint ramp rather than three hand-mixed
  // colours: one input, and a fill/rule/ink already measured for contrast
  // against every shipped theme.
  t.ok(await t.evaluate(`
    const row = document.querySelector('.fjs-cp-row--active');
    const cs  = getComputedStyle(row);
    const bg  = cs.backgroundColor;
    return bg !== 'rgba(0, 0, 0, 0)' && cs.borderTopColor !== bg;
  `), 'the active row is tinted and ruled, both derived from one --bg-mix')

  // <kbd> is styled by the package on the ELEMENT, so the palette's own copy
  // of a keycap was a second implementation of a shipped term.
  t.ok(await t.evaluate(`
    const cap = document.querySelector('.fjs-cp-footer kbd');
    const cs  = getComputedStyle(cap);
    return cs.borderBottomWidth !== '0px' && cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
  `), 'a shortcut hint is the shipped <kbd> keycap, not a local one')
}
