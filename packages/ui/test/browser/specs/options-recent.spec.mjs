/*
 * options-recent.spec.mjs — a picker's HEAD, and whether a person can tell.
 *
 * `resource.options()` puts the values this caller reached for last first and
 * marks them `recent` (`FJS-D121`). The mechanism worked and no control read
 * the flag, so the head arrived as entries at the top in an order that is
 * neither alphabetical nor whatever the set declared, with nothing saying why —
 * indistinguishable from a broken sort (`FJS-973`).
 *
 * Every assertion here is PAIRED with the same control over a list that has no
 * head. A caption drawn unconditionally reads as *working* from the head's
 * side, and the list with no head is the only thing that can tell one from the
 * other — which is also the ordinary case, since a set declaring no `recent(…)`
 * produces one on every render in every app.
 *
 * The third pair is the pinned value: `withUnavailable` prepends the value in
 * the box to a list that no longer offers it, ABOVE the head. It is at the top
 * for a different reason and captioning it as recent would say something false
 * about why it is there.
 */
export const name = 'a picker with a recent head'
export const covers = ['forms/Select', 'forms/Combobox']

/** Every <optgroup> label inside a named select, in document order. */
const groupsOf = (root, name) => `
  const el = document.querySelector('${root} [name=${name}]');
  return [...(el?.querySelectorAll('optgroup') ?? [])].map(g => g.label).join('|');
`

/** The options of one <optgroup>, by its label. */
const inGroup = (root, name, label) => `
  const el = document.querySelector('${root} [name=${name}]');
  const g  = [...(el?.querySelectorAll('optgroup') ?? [])].find(x => x.label === ${JSON.stringify(label)});
  return [...(g?.children ?? [])].map(o => o.textContent.trim()).join(',');
`

/** Options that are NOT inside any group — the placeholder and the pinned value. */
const ungrouped = (root, name) => `
  const el = document.querySelector('${root} [name=${name}]');
  return [...(el?.children ?? [])].filter(c => c.tagName === 'OPTION')
    .map(o => o.textContent.trim()).join(',');
`

/** Every row of an open combobox listbox, options and captions alike, in order. */
const listRows = (root) => `
  return [...document.querySelectorAll('${root} [role=listbox] li')]
    .map(li => (li.getAttribute('role') === 'presentation' ? '#' : '') + li.textContent.trim())
    .join(',');
`

const openCombobox = async (t, root) => {
  await t.evaluate(`
    const el = document.querySelector('${root} [name=tag]');
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await waitSettled('body');
    await waitVisible('${root} [role=listbox]');
  `)
}

export async function run(t) {
  await t.mount('options-recent')

  /* ── a native select gets two optgroups ───────────────────────────────── */

  // A hand-written `<Select name=…>` inside a `<Form>`, which is the only way a
  // native select receives a fetched list: the control table answers `picker` →
  // Combobox for every binding and every foreign key, so a GENERATED form never
  // produces one. It is the control that already had a grouping mechanism, so
  // the head costs it a label rather than a layout.
  await t.eventually(`(() => { ${groupsOf('#head', 'status')} })()`, 'Recently used|Everything else',
    'a list with a head is drawn as two captioned groups')

  await t.eventually(`(() => { ${inGroup('#head', 'status', 'Recently used')} })()`, 'zulu,mike',
    'the head keeps its own order inside its group, not the list order')

  await t.eventually(`(() => { ${inGroup('#head', 'status', 'Everything else')} })()`, 'alpha,bravo,charlie',
    'and everything else follows it, captioned as what it is')

  // The pair that keeps the three above honest. A control that captioned
  // unconditionally would render "Recently used" over a list nobody has used,
  // which is the ordinary list in every app.
  await t.eventually(`(() => { ${groupsOf('#plain', 'status')} })()`, '',
    'a list with no head is drawn exactly as it was before — no groups at all')

  /* ── the pinned value is not part of the head ─────────────────────────── */

  // `withUnavailable` prepends the value in the box. It is above the head and
  // it is not recent: it is there because it is selected, and a caption saying
  // otherwise is a wrong explanation rather than a missing one.
  await t.eventually(`(() => { ${ungrouped('#holding', 'status')} })()`, 'Select…,retired (unavailable)',
    'the value the field is holding stays above both groups, uncaptioned')

  await t.eventually(`(() => { ${inGroup('#holding', 'status', 'Recently used')} })()`, 'zulu,mike',
    'and the head under it is unchanged by the pin')

  /* ── the combobox draws the same two captions ─────────────────────────── */

  // A listbox has no <optgroup>, so the captions are rows — and they must not
  // be options: the cursor indexes the option array and `aria-activedescendant`
  // names its rows, so a caption inside it would be arrow-keyed onto and
  // announced as something choosable.
  await openCombobox(t, '#head')
  await t.eventually(`(() => { ${listRows('#head')} })()`,
    '#Recently used,zulu,mike,#Everything else,alpha,bravo,charlie',
    'the combobox captions the same two sections, as non-option rows')

  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#head [role=listbox] li[role=option]')].length;
  `), 5, 'and the captions are not options — five rows are choosable, not seven')

  // Arrowing lands on the first OPTION rather than on the caption above it,
  // which is what `role=presentation` buys and what a caption in the array
  // would have broken.
  await t.press('ArrowDown')
  await t.eventually(`(() => {
    const id = document.querySelector('#head [name=tag]')?.getAttribute('aria-activedescendant');
    return document.getElementById(id)?.textContent?.trim() ?? '';
  })()`, 'mike', 'the cursor moves between options and skips the captions')

  await t.press('Escape')

  // The pair again, on the other control.
  await openCombobox(t, '#plain')
  await t.eventually(`(() => { ${listRows('#plain')} })()`, 'alpha,bravo,charlie',
    'and a list with no head is a plain list of options')
}
