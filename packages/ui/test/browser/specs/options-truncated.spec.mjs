/*
 * options-truncated.spec.mjs — a list the server cut, and what a control says
 * about it.
 *
 * `resource.options()` answers `{ options, total, truncated }`. The rows were
 * always rendered; the COUNT was dropped, so a picker over four hundred rows
 * offered an alphabetical hundred and read exactly like a complete list — the
 * row somebody was looking for was absent, no message said why, and the screen
 * was indistinguishable from one where the row does not exist (`FJS-391`).
 *
 * Two behaviors, and they fail separately:
 *
 *   · say it     — every list control, from the count it was handed
 *   · search it  — by sending what was typed to the SERVER rather than
 *                  filtering the page already in hand
 *
 * The third assertion is the one that keeps the first two honest: a COMPLETE
 * list must say nothing. An honest count and a wrong one look identical on a
 * screen, and a control that always announces a truncation is worse than one
 * that never does.
 */
export const name = 'a list the server cut'
export const covers = ['forms/Select', 'forms/Combobox', 'forms/MultiSelect']

const hintOf = (sel) => `document.querySelector(${JSON.stringify(sel)})?.textContent?.trim() ?? ''`

/** The `.field-hint` inside the field-group holding a named control. */
const hintFor = (root, name) => `
  const el = document.querySelector('${root} [name=${name}]');
  const group = el?.closest('.field-group') ?? el?.parentElement?.parentElement;
  return group?.querySelector('.field-hint')?.textContent?.trim() ?? '';
`

export async function run(t) {
  await t.mount('options-truncated')

  /* ── say it ───────────────────────────────────────────────────────────── */

  // A picker over a relation, which is a searchable select (`FJS-459`) — so it
  // says the count AND what to do about it. It was a native `<select>` until
  // that issue, which could report the number and reach none of the rows
  // behind it.
  await t.eventually(`(() => { ${hintFor('#big', 'customerId')} })()`, 'Showing 2 of 400 — type to search the rest.',
    'a picker says how many rows it is not showing, and that typing reaches them')

  // The same sentence for a bound column, from the same owner — three controls
  // wording it three ways is what `truncationNote` exists to stop.
  await t.eventually(`(() => { ${hintFor('#big', 'tag')} })()`, 'Showing 2 of 400 — type to search the rest.',
    'and a bound column says it identically')

  /* ── and a complete list says nothing ─────────────────────────────────── */

  // The negative control. `total` equal to the rows is a list in hand, and a
  // control announcing a truncation there would train everyone to ignore it.
  await t.eventually(`(() => { ${hintFor('#whole', 'tag')} })()`, '',
    'a list that is complete says nothing at all')

  /* ── search it ────────────────────────────────────────────────────────── */

  // Nothing has been sent yet: the count arriving is not a search, and a
  // control that fetched on mount would show up here.
  t.is(await t.evaluate(`return ${hintOf('#searches')};`), '',
    'the count alone provokes no request')

  await t.evaluate(`
    const el = document.querySelector('#big [name=tag]');
    el.focus();
    await waitSettled('body');
  `)
  await t.type('zu')

  // The assertion the whole issue is about: `zulu` is not in the page the
  // control was handed, so a control filtering its own rows can only ever
  // offer nothing. It is here because the query went to the server.
  await t.eventually(`document.querySelector('#searches').textContent.includes('tag:zu')`, 'true',
    'typing sends the query to the server, not to the rows in hand')
  await t.eventually(`
    [...document.querySelectorAll('#big [role=option]')].map(o => o.textContent.trim()).join(',')
  `, 'zulu', 'and the server’s answer is what is offered')

  // Having searched, the count describes the SEARCH — one row, and one row is
  // all there is, so the note goes quiet rather than claiming 400 again.
  await t.eventually(`(() => { ${hintFor('#big', 'tag')} })()`, '',
    'the note follows the answer it is describing')

  /* ── the array form ───────────────────────────────────────────────────── */

  // MultiSelect already had a search seam — `asyncOptions` — and it was the
  // CALLER's to supply, which a generated form has nobody to ask. Where the
  // form can answer and the list came back cut, it is supplied.
  await t.evaluate(`
    const box = document.querySelectorAll('#big .fjs-multiselect-input')[0];
    box.focus();
    await waitSettled('body');
  `)
  await t.type('zu')
  await t.eventually(`document.querySelector('#searches').textContent.includes('labels:zu')`, 'true',
    'a bound array searches the server too, with no asyncOptions written by hand')

  /* ── a list nobody could fetch ────────────────────────────────────────── */
  //
  // The sibling failure, and the sharper one: a truncated list is missing rows,
  // an unreachable one is missing all of them — and both render as an empty
  // box, which a person reads as *there are none*. `resource.options()` has
  // answered `error` since `FJS-570`; nothing read it (`FJS-587`).

  await t.eventually(`(() => { ${hintFor('#broken', 'customerId')} })()`,
    'Options could not be loaded — /productVariants not found',
    'a picker that could not ask says so, and says why')

  await t.eventually(`(() => { ${hintFor('#broken', 'tag')} })()`,
    'Options could not be loaded — /productVariants not found',
    'and a combobox words it identically')

  await t.eventually(`(() => {
    const el = document.querySelector('#broken .fjs-multiselect-input');
    const group = el?.closest('.field-group');
    return group?.querySelector('.field-hint')?.textContent?.trim() ?? '';
  })()`,
    'Options could not be loaded — /productVariants not found',
    'and so does the array form — one owner for the sentence, three controls')

  // The negative control, and the one that keeps the other three honest: a
  // relation with no rows is an ordinary, correct answer. A control that said
  // something here would be saying it on every empty picker in every app.
  await t.eventually(`(() => { ${hintFor('#empty', 'tag')} })()`, '',
    'a list that is genuinely empty says nothing at all')
}
