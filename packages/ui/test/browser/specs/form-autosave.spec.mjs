/*
 * form-autosave.spec.mjs — a <Form> that saves with nobody pressing anything.
 *
 * Every claim here is a PAIR, because each failure mode looks exactly like the
 * feature working from one side only. A mechanism that saved on every render
 * satisfies "the edit reached the service" and fails "a burst is one write". A
 * mechanism that saved nothing satisfies "a quiet form writes nothing" and
 * fails everything else. A form with autosave OFF sits beside all of it as the
 * control, because a bug in the shared write path would otherwise read as an
 * autosave bug.
 *
 * The quiet window is a real timer at 60ms rather than a stubbed clock: the
 * debounce is the thing under test, and a fake one grades the test's own
 * arithmetic.
 */
export const name = 'Form — autosave'
export const covers = ['forms/Form']

const text = (sel) => `document.querySelector(${JSON.stringify(sel)}).textContent`

async function typeInto(t, sel, value) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
}

/** Well past the quiet window, so "nothing happened" is a settled answer. */
const settle = (t) => t.evaluate(`return new Promise(r => setTimeout(() => r(true), 260));`)

export async function run(t) {
  await t.mount('form-autosave')

  /* ── the pair that decides everything ─────────────────────────────────── */

  // A form nobody has touched. The whole feature is a timer, and a timer that
  // fires on mount would pass every other row in this file.
  await settle(t)
  t.is(await t.evaluate(`return ${text('#count')};`), '0',
    'a form nobody typed into writes nothing')
  t.is(await t.evaluate(`return ${text('#state')};`), 'idle',
    'and says nothing about saving')

  // Three changes inside one quiet window. One input event cannot tell a
  // debounce from a save on every keystroke; three can.
  await typeInto(t, '#auto [name=reference]', 'O')
  await typeInto(t, '#auto [name=reference]', 'ORD')
  await typeInto(t, '#auto [name=reference]', 'ORD-77')
  await t.eventually(text('#state'), 'saved', 'typing and stopping saves by itself')
  t.is(await t.evaluate(`return ${text('#count')};`), '1',
    'and three keystrokes are ONE write, not three')
  t.is(await t.evaluate(`return ${text('#calls')};`), 'save:auto:v4:ORD-77',
    'the write is a patch carrying the revision the form read')

  /* ── it is not a submit ───────────────────────────────────────────────── */

  t.is(await t.evaluate(`return ${text('#autosaved')};`), '1', 'onautosaved fires')
  t.is(await t.evaluate(`return ${text('#done')};`), '0',
    'and ondone does NOT — a drawer that closes on ondone must not shut under a timer')

  /* ── the revision the write minted ────────────────────────────────────── */

  // The one that was always broken and only autosave makes certain: the record
  // holds the revision it READ, so a second write from the same open form
  // carries a number the row has already passed. The service bumps to 5 above.
  t.is(await t.evaluate(`return ${text('#held-version')};`), '5',
    'the form takes back the revision the answer carried')

  await typeInto(t, '#auto [name=reference]', 'ORD-78')
  await t.eventually(text('#count'), '2', 'a second edit saves again')
  t.is(await t.evaluate(`return ${text('#calls')};`), 'save:auto:v4:ORD-77|save:auto:v5:ORD-78',
    'and the SECOND write carries the new revision, not the one first read')

  /* ── a refusal does not retry ─────────────────────────────────────────── */

  // A loop that re-sent a refused write would hammer the boundary and, on a
  // real screen, tear down and rebuild the conflict panel somebody is reading.
  await t.evaluate(`window.kitFailNextSave(); return true;`)
  await typeInto(t, '#auto [name=reference]', 'ORD-79')
  await t.eventually(text('#state'), 'error', 'a refusal is reported')
  await settle(t)
  t.is(await t.evaluate(`return ${text('#count')};`), '3',
    'and is not retried — the next keystroke is the retry')

  // The pair: the next keystroke really is one.
  await typeInto(t, '#auto [name=reference]', 'ORD-80')
  await t.eventually(text('#state'), 'saved', 'editing again clears the refusal and saves')

  /* ── a parent swapping the record is not an edit ──────────────────────── */

  // A screen reloading somebody else's revision after a conflict replaces the
  // record. Saving that back is how autosave overwrites the person it just
  // showed you. `dirty` is set by a control and never by a prop push, which is
  // the whole reason this belongs inside the component.
  const before = await t.evaluate(`return ${text('#count')};`)
  await t.clickAt('#push')
  await settle(t)
  t.is(await t.evaluate(`return ${text('#count')};`), before,
    'a record replaced BY THE PARENT schedules nothing')
  t.is(await t.evaluate(`return ${text('#state-b')};`), 'idle',
    'and that form never left idle')

  // The pair: the same form still autosaves when a control changes it.
  await typeInto(t, '#pushed [name=reference]', 'MINE')
  await t.eventually(text('#state-b'), 'saved', 'but a keystroke in it still saves')

  /* ── a create is refused, by name ─────────────────────────────────────── */

  // A timer that creates rows makes one per pause. There is no id to patch, so
  // the only safe answer is to do nothing and say why.
  const madeBefore = await t.evaluate(`return ${text('#count')};`)
  await typeInto(t, '#creating [name=reference]', 'NEW-1')
  await settle(t)
  t.is(await t.evaluate(`return ${text('#count')};`), madeBefore,
    'a form with no id never autosaves — a timer must not make rows')

  /* ── flush, for the person walking away ───────────────────────────────── */

  await typeInto(t, '#auto [name=reference]', 'ORD-81')
  const beforeFlush = Number(await t.evaluate(`return ${text('#count')};`))
  await t.clickAt('#flush')
  await t.eventually(text('#count'), String(beforeFlush + 1),
    'flushAutosave sends what is sitting in the quiet window')

  /* ── the button disarms the timer ─────────────────────────────────────── */

  // Pressing Save does what the timer was about to do. An armed timer left
  // behind sends the same record again a second later — which after a refusal
  // is the write going out behind the panel somebody is reading, and after a
  // reload of another person's revision is that revision written back over
  // them. Both are silent.
  await typeInto(t, '#auto [name=reference]', 'ORD-82')
  const beforeSubmit = Number(await t.evaluate(`return ${text('#count')};`))
  await t.clickAt('#submit')
  await t.eventually(text('#count'), String(beforeSubmit + 1), 'the button writes once')
  await settle(t)
  t.is(await t.evaluate(`return ${text('#count')};`), String(beforeSubmit + 1),
    'and the pending autosave is disarmed rather than firing behind it')
  t.is(await t.evaluate(`return ${text('#done')};`), '1',
    'that one WAS a submit, so ondone fires for it')

  /* ── the control: autosave off ────────────────────────────────────────── */

  // Everything above is a claim about a form that opted IN. If the shared write
  // path had simply started firing, this row would fail too.
  const beforeManual = await t.evaluate(`return ${text('#count')};`)
  await typeInto(t, '#manual [name=reference]', 'NEVER')
  await settle(t)
  t.is(await t.evaluate(`return ${text('#count')};`), beforeManual,
    'a form without autosave writes nothing, however long you leave it')
}
