/*
 * table-depth.spec.mjs — the modes of Table one spec did not drive.
 *
 * `datatable.spec.mjs` covers the component's happy path. This is the second
 * pass, the one `Form` has already had: the two snippets, the three modifiers,
 * per-column alignment and width, the sort pair pushed from OUTSIDE, the
 * skeleton row count, and whether a sortable header is operable by keyboard at
 * all — which the component's own header says the old markup got wrong by
 * putting `on:click` on the `<th>`.
 *
 * Row tone is asked as a painted colour rather than a class, because that is
 * where it went wrong before: stripe, hover and tone all set one row's
 * background, and a striped table used to lose its tones on every odd row.
 */
export const name = 'Table — the modes'
export const covers = ['display/Table']

const headers = `[...document.querySelectorAll('#plain thead th')]`

export async function run(t) {
  await t.mount('table-depth')

  // ── a sort the CALLER owns ──────────────────────────────────────────────
  // `bind:sortKey` makes the component the owner, and a component cannot own a
  // sort that lives in the URL. With `onsort` the component states the move and
  // changes nothing — so a caller that navigates instead of assigning does not
  // get an arrow flipping to a state it is about to overrule.
  await t.clickAt('#reported thead th:nth-child(3) button')
  await t.eventually(`document.getElementById('reported-out').textContent`, 'amount:asc',
    'a new column reports ascending')

  const untouched = await t.evaluate(`
    const th = document.querySelectorAll('#reported thead th');
    return { first: th[0].getAttribute('aria-sort'), clicked: th[2].getAttribute('aria-sort') };
  `)
  t.is(untouched.first, 'ascending', 'and the pushed pair is still what the header shows')
  t.is(untouched.clicked, 'none', 'the clicked column did NOT take the sort for itself')

  // Clicking the column the caller pushed asks for the opposite direction.
  await t.clickAt('#reported thead th:nth-child(1) button')
  await t.eventually(`document.getElementById('reported-out').textContent`, 'ref:desc',
    'the sorted column reports the flip')

  // A `hideLabel` column. An actions column with a bare <th> leaves a screen
  // reader saying nothing for a column that has a control in every row, and a
  // visible "Actions" over a column of buttons is noise — so the text is there
  // and only the pixels are not.
  const act = await t.evaluate(`
    const th = [...document.querySelectorAll('#hidden-header thead th')].at(-1);
    const vh = th.querySelector('.visually-hidden');
    return { text: th.textContent.trim(), hidden: !!vh, scope: th.getAttribute('scope'),
             width: vh ? vh.getBoundingClientRect().width : -1,
             sortable: !!th.querySelector('button') };
  `)
  t.is(act.text, 'Actions', 'a hideLabel header still carries its text')
  t.is(act.hidden, true, 'inside a .visually-hidden span')
  t.is(act.scope, 'col', 'and is still scoped as a column header, which the a11y pass requires')
  // The clip technique leaves a 1px box rather than a 0px one — a zero-size
  // element is skipped by some screen readers, which is the whole failure.
  t.ok(act.width > 0 && act.width <= 1, `and takes no visible width (${act.width}px)`)
  t.is(act.sortable, false, 'hiding a label does not make it a sort control')

  await t.mount('table-depth')

  /* ── per-column layout ────────────────────────────────────────────────── */

  // `align` and `width` are column facts, not cell facts: stating them per row
  // is what makes a table drift a column at a time.
  const col = await t.evaluate(`
    const th = ${headers}[2];
    const cs = getComputedStyle(th);
    return { align: cs.textAlign, width: th.style.width };
  `)
  t.is(col.align, 'right', 'a column alignment reaches its header')
  t.is(col.width, '8rem', 'and so does a stated width')
  t.ok(await t.evaluate(`
    const first = getComputedStyle(${headers}[0]).textAlign;
    return first !== 'right';
  `), 'while a column that states neither is left alone')

  // The wrap is what makes a wide table scroll instead of the page — the same
  // failure `.table-wrap` exists to prevent everywhere else in the system.
  t.ok(await t.evaluate(`
    const wrap = document.querySelector('#plain .table-wrap');
    return wrap && ['auto', 'scroll'].includes(getComputedStyle(wrap).overflowX);
  `), 'the table sits in a wrap that scrolls sideways on its own')

  /* ── a row tone survives the stripe ───────────────────────────────────── */

  // A tone on a <tr> is free-standing vocabulary, and the one thing that must
  // be true of it is that it PAINTS — a failed row that looks like every other
  // row is the bug the stylesheet's own header records.
  const toned = await t.evaluate(`
    const cell = (i) => getComputedStyle(document.querySelectorAll('#plain tbody tr')[i].querySelector('td')).backgroundColor;
    return { plain: cell(0), danger: cell(1), alsoPlain: cell(2) };
  `)
  t.ok(toned.danger !== toned.plain, `a toned row paints differently (${toned.danger} vs ${toned.plain})`)
  t.is(toned.alsoPlain, toned.plain, 'and the untoned rows agree with each other')

  /* ── the modifiers ────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`
    const el = document.querySelector('#dressed table');
    return [...el.classList].sort().join(' ');
  `), 'compact striped table', 'striped and compact are on; hover={false} takes it off')

  // Measured, not read off the class list: compact is a padding change and
  // striped is a background one, and either could be a class the stylesheet
  // stopped defining.
  t.ok(await t.evaluate(`
    const px = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).paddingTop);
    return px('#dressed tbody td') < px('#plain tbody td');
  `), 'compact really is tighter than the default')
  t.ok(await t.evaluate(`
    const bg = (i) => getComputedStyle(document.querySelectorAll('#dressed tbody tr')[i].querySelector('td')).backgroundColor;
    return bg(0) !== bg(1);
  `), 'and striped really alternates')

  // The regression tables.css records in its own header: the stripe rule and
  // the tone rule land at the same specificity in the same layer, so the
  // stripe won and a striped list lost every toned row that fell on an odd
  // stripe. Both parities are checked, because getting one right is what the
  // broken version did.
  const stripedTone = await t.evaluate(`
    const bg = (i) => getComputedStyle(document.querySelectorAll('#dressed tbody tr')[i].querySelector('td')).backgroundColor;
    return { plain0: bg(0), toned1: bg(1), plain2: bg(2), toned3: bg(3) };
  `)
  t.ok(stripedTone.toned1 !== stripedTone.plain0 && stripedTone.toned1 !== stripedTone.plain2,
    `a toned row on an even stripe keeps its tone (${stripedTone.toned1})`)
  t.ok(stripedTone.toned3 !== stripedTone.plain0 && stripedTone.toned3 !== stripedTone.plain2,
    `and so does one on an odd stripe (${stripedTone.toned3})`)

  /* ── the actions snippet ──────────────────────────────────────────────── */

  t.ok(await t.evaluate(`
    return document.querySelector('#dressed .table-actions #table-action') !== null;
  `), 'an actions snippet renders in its own toolbar')
  t.ok(await t.evaluate(`
    const wrap = document.querySelector('#dressed .table-wrap');
    const bar  = document.querySelector('#dressed .table-actions');
    return bar.compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_FOLLOWING;
  `), 'above the table, not inside it')
  t.is(await t.evaluate(`return document.querySelectorAll('#plain .table-actions').length;`), 0,
    'and no toolbar at all when nobody passed one')

  /* ── the empty snippet ────────────────────────────────────────────────── */

  // The override replaces the default entirely. Both rendering would be two
  // empty states stacked, which is the shape a naive `{#if}` produces.
  t.ok(await t.evaluate(`return document.querySelector('#custom-empty #my-empty') !== null;`),
    'an empty snippet replaces the default empty state')
  t.is(await t.evaluate(`return document.querySelectorAll('#custom-empty .empty-text').length;`), 0,
    'and the default does not render underneath it')
  t.ok(await t.evaluate(`
    return document.querySelector('#custom-empty #my-empty a') !== null;
  `), 'so an empty state can offer a way out of itself')

  /* ── skeletonRows ─────────────────────────────────────────────────────── */

  // Stated as 2 rather than left at the default 5. A prop that silently does
  // not apply is the kind of thing a render test cannot see, because five grey
  // boxes look as reasonable as two.
  t.is(await t.evaluate(`return document.querySelectorAll('#skel tbody tr[aria-busy=true]').length;`), 2,
    'skeletonRows is honoured rather than fixed at five')

  /* ── sorting, pushed from outside ─────────────────────────────────────── */

  // A bound sort pair is how a list restores its sort out of a URL. The push
  // takes a different path through the component than a header click does, and
  // the arrow and `aria-sort` are derived from the same pair, so both have to
  // follow.
  t.is(await t.evaluate(`
    return ${headers}.map(th => th.getAttribute('aria-sort') ?? 'none').join(',');
  `), 'none,none,none', 'nothing is sorted to begin with')

  await t.clickAt('#sort-amount')
  await t.eventually(`${headers}[2].getAttribute('aria-sort')`, 'descending',
    'a sort set from outside reaches the header it names')
  await t.eventually(`${headers}[0].getAttribute('aria-sort')`, 'none',
    'and leaves the other sortable column alone')

  // Clicking that same column now continues the cycle from where the outside
  // put it, rather than restarting at ascending.
  await t.clickAt('#plain thead th:last-child button')
  await t.eventually(`document.querySelector('#sort').textContent`, 'amount:asc',
    'clicking it continues the cycle rather than restarting it')

  /* ── sorting is STATE, not an ordering ────────────────────────────────── */

  // The component never reorders anything: it announces which column and which
  // direction, and the caller re-queries. Anything else would be a table that
  // sorts the page it is showing and disagrees with the server about what page
  // two contains. Worth pinning because "it has a sort control" reads as "it
  // sorts".
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#plain tbody tr')].map(r => r.querySelector('td').textContent).join(',');
  `), 'ORD-1,ORD-2,ORD-3,ORD-4', 'the rows are in the order they were given, after two sorts')

  /* ── a sortable header is a real control ──────────────────────────────── */

  // The component's own header records the earlier mistake: `on:click` on the
  // <th>, which meant a keyboard user could not sort at all. A <button> is the
  // fix, and this is what proves it stayed one.
  await t.evaluate(`document.querySelector('#plain thead th:first-child button').focus(); return true;`)
  t.is(await t.evaluate(`return document.activeElement?.closest('th')?.textContent?.trim().split(/\\s+/)[0];`),
    'Reference', 'a sortable header is focusable')
  await t.press('Enter')
  await t.eventually(`document.querySelector('#sort').textContent`, 'ref:asc',
    'and Enter sorts by it — the whole reason it is a button')
  await t.press(' ')
  await t.eventually(`document.querySelector('#sort').textContent`, 'ref:desc', 'Space reverses it')

  // A plain column offers nothing to press: a header that looks interactive
  // and is not is worse than one that never invited the click.
  t.is(await t.evaluate(`return ${headers}[1].querySelector('button');`), null,
    'a column that is not sortable has no control at all')
  t.is(await t.evaluate(`return ${headers}[1].getAttribute('aria-sort');`), null,
    'and says nothing about sorting')
}
