/*
 * form-sealed.spec.mjs — a frozen column on a document that has been issued.
 *
 * `@immutable` on a model that seals means *frozen at the seal*, so the answer
 * is in the row and no schema keyword can carry it: the field arrives with
 * `x-litestone-seal` INSTEAD of `readOnly`, and nothing read it. A person
 * edited a sealed invoice's number, pressed save, and got a 409 for a field the
 * screen had shown as writable.
 *
 * EVERY assertion here is a PAIR — the same field on a DRAFT record, which must
 * stay editable and must still be sent. A fix that froze both looks identical
 * from the frozen side to a fix that froze neither, and the draft is the only
 * thing that can tell them apart.
 *
 * The second half is the one the affordance alone does not cover: `@immutable`
 * refuses the KEY and not the value, so a form that greys the box and still
 * round-trips the column is the same 409 with a nicer screen.
 *
 * The third half is WHICH ROW is graded. The boundary grades the STORED state,
 * so picking the sealing move in the picker must not freeze the columns beside
 * it: the row is still a draft until the write lands, and the write that lands
 * is the one carrying the correction. Every assertion above reads a form whose
 * state column nobody touches, which is the one arrangement where a seal read
 * off the draft and a seal read off the opened row agree.
 */
export const name = 'Form — a sealed document'
export const covers = ['forms/Form']

const isDisabled = (sel) =>
  `!!document.querySelector(${JSON.stringify(sel)})?.disabled`

async function pick(t, sel, value) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    return true;
  `)
}

async function typeInto(t, sel, value) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
}

const submit = (sel) => `
  document.querySelector(${JSON.stringify(sel)} + ' form').requestSubmit();
  return true;
`

export async function run(t) {
  await t.mount('form-sealed')

  /* ── the affordance ───────────────────────────────────────────────────── */

  t.ok(await t.evaluate(`return ${isDisabled('#issued [name=number]')};`),
    'a frozen column on an issued document is not editable')
  t.ok(!await t.evaluate(`return ${isDisabled('#draft [name=number]')};`),
    'the same column on a draft still is')

  // The pair that says the seal is per FIELD rather than per form: `note` is
  // ordinary on both rows, and a form that disabled itself wholesale would
  // satisfy the first assertion above.
  t.ok(!await t.evaluate(`return ${isDisabled('#issued [name=note]')};`),
    'and the columns beside it on the same issued document are untouched')

  // No record is a draft being made, so nothing is frozen — a create form that
  // read the seal off an absent row would offer no box at all.
  t.ok(!await t.evaluate(`return ${isDisabled('#create [name=number]')};`),
    'a create form freezes nothing')

  /* ── the payload ──────────────────────────────────────────────────────── */

  // `@immutable` refuses the KEY, so the same value sent back is refused too.
  // An edit form round-trips the whole record, which is why greying the box is
  // only half of it.
  await typeInto(t, '#issued [name=note]', 'edited after issue')
  await t.evaluate(submit('#issued'))
  await t.eventually(`window.kitSent().length`, 1, 'the issued form saves')

  t.ok(!await t.evaluate(`return window.kitSent()[0].keys.includes('number');`),
    'and the frozen column is not in what it sent')
  t.ok(await t.evaluate(`return window.kitSent()[0].keys.includes('note');`),
    'while the column beside it is')
  t.ok(await t.evaluate(`return window.kitSent()[0].data.note === 'edited after issue';`),
    'carrying what was typed')

  // The pair. A draft sends its number like any other column — a strip that
  // dropped it everywhere would pass every assertion above.
  await typeInto(t, '#draft [name=number]', 'A-2-revised')
  await t.evaluate(submit('#draft'))
  await t.eventually(`window.kitSent().length`, 2, 'the draft form saves too')

  t.ok(await t.evaluate(`return window.kitSent()[1].keys.includes('number');`),
    'and a draft still sends the column')
  t.ok(await t.evaluate(`return window.kitSent()[1].data.number === 'A-2-revised';`),
    'with the edit in it')

  /* ── which row is graded ──────────────────────────────────────────────── */
  //
  // Picking the sealing state is an unsaved edit. The stored row is a draft, so
  // the boundary would accept every column — and a form grading the seal off
  // the draft freezes them a keystroke early, which is not a frozen box but a
  // SILENT DROP: `_writable()` deletes every sealed key on the way out, so the
  // correction typed in the same submit never reaches the server.

  await pick(t, '#draft [name=state]', 'issued')

  t.ok(!await t.evaluate(`return ${isDisabled('#draft [name=number]')};`),
    'choosing the sealing state does not freeze the column beside it')

  // The control. A form that simply stopped sealing passes the line above and
  // fails here, and it is the same field on the same screen.
  t.ok(await t.evaluate(`return ${isDisabled('#issued [name=number]')};`),
    'while the document that IS issued stays frozen')

  // The cost, and the reason this is not cosmetic.
  await typeInto(t, '#draft [name=number]', 'A-2-corrected')
  await t.evaluate(submit('#draft'))
  await t.eventually(`window.kitSent().length`, 3, 'the draft form saves again')

  t.ok(await t.evaluate(`return window.kitSent()[2].keys.includes('number');`),
    'and issuing and correcting in one submit still sends the correction')
  t.is(await t.evaluate(`return window.kitSent()[2].data.number;`), 'A-2-corrected',
    'with what was typed in it')
  t.is(await t.evaluate(`return window.kitSent()[2].data.state;`), 'issued',
    'alongside the move that seals it')
}
