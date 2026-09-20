/*
 * datepicker-days.spec.mjs — the picker over a PLAIN DATE, in a real zone.
 *
 * Every other spec in this folder runs in whatever zone the host is in, and
 * every runner that grades this repo is UTC — which is exactly the zone where
 * a component that reads local fields and one that reads UTC fields render the
 * same bytes. So this file names its zone and asserts about a day.
 *
 * What it was written for: the hidden input is built by `formatYMD`, which
 * reads LOCAL fields, while an incoming `YYYY-MM-DD` was parsed by `new Date`,
 * which is UTC midnight by specification. West of Greenwich the round trip
 * therefore lost a day — open a form on a stored `dueOn`, save it without
 * touching the picker, and the day moved one back, every time, silently.
 *
 * The stepper's arithmetic has the same shape of trap one layer up: a day is
 * not always 86400000 ms, and the fall-back is where that shows.
 */
export const name = 'DatePicker · days'
export const covers = ['forms/DatePicker']

const DENVER   = 'America/Denver'   // UTC-7, and it observes DST
const AUCKLAND = 'Pacific/Auckland' // UTC+12, the other side of the same trap

const hidden = `document.querySelector('#stage input[type=hidden][name=dueOn]')?.value`
const header = `document.querySelector('#stage .fjs-dp-cal header span div').textContent`

export async function run(t) {
  /* ── the control that makes the rest of the file mean anything ───────── */

  // If the override did not take, every assertion below passes in UTC while
  // saying nothing, which is the failure this whole file exists to avoid.
  await t.timezone(DENVER)
  t.is(await t.evaluate(`return Intl.DateTimeFormat().resolvedOptions().timeZone;`), DENVER,
    'the page really is in Denver')
  t.is(await t.evaluate(`
    const d = new Date('2026-09-19');
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  `), '2026-09-18', 'and a UTC-parsed day really does read as the day before here')

  /* ── a stored day survives being rendered and submitted ──────────────── */

  await t.mount('datepicker-days', { startDateISO: '2026-09-19', showStepper: false })
  t.is(await t.evaluate(`return ${hidden};`), '2026-09-19',
    'the day the column holds is the day the field would submit, west of Greenwich')

  await t.timezone(AUCKLAND)
  await t.mount('datepicker-days', { startDateISO: '2026-09-19', showStepper: false })
  t.is(await t.evaluate(`return ${hidden};`), '2026-09-19',
    'and east of it')

  /* ── the stepper walks one day ───────────────────────────────────────── */

  await t.timezone(DENVER)
  await t.mount('datepicker-days', { startDateISO: '2026-09-19' })

  t.is(await t.evaluate(`return document.querySelectorAll('#stage .fjs-dp-stepper button').length;`), 2,
    'the stepper draws a pair of buttons')

  await t.clickAt('#stage .fjs-dp-stepper button[aria-label="Next day"]')
  await t.eventually(hidden, '2026-09-20', 'next day moves the value forward one')

  await t.clickAt('#stage .fjs-dp-stepper button[aria-label="Previous day"]')
  await t.clickAt('#stage .fjs-dp-stepper button[aria-label="Previous day"]')
  await t.eventually(hidden, '2026-09-18', 'and previous day moves it back')

  // Stepping off the end of a month has to take the calendar with it, or the
  // selected day is no longer on screen and the control looks broken.
  await t.mount('datepicker-days', { startDateISO: '2026-09-30' })
  await t.clickAt('#stage .fjs-dp-stepper button[aria-label="Next day"]')
  await t.eventually(hidden, '2026-10-01', 'a step crosses a month boundary')
  await t.eventually(header, 'October 2026', 'and the calendar follows it')

  /* ── the fall-back, which is what ms arithmetic gets wrong ───────────── */

  // Measured in Denver: stepping from 31 October by 86400000 ms answers
  // 1 November twice — the second hop lands at 23:00 on a 25-hour day — and
  // every day after that is one behind. Three clicks is the shortest walk that
  // separates the two spellings.
  await t.mount('datepicker-days', { todayISO: '2026-12-01', startDateISO: '2026-10-31' })
  await t.clickAt('#stage .fjs-dp-stepper button[aria-label="Next day"]')
  await t.eventually(hidden, '2026-11-01', 'one step into the long day')
  await t.clickAt('#stage .fjs-dp-stepper button[aria-label="Next day"]')
  await t.eventually(hidden, '2026-11-02', 'and out the other side, not stuck on it')
  await t.clickAt('#stage .fjs-dp-stepper button[aria-label="Next day"]')
  await t.eventually(hidden, '2026-11-03', 'and still not a day behind afterwards')

  /* ── the stepper refuses what the grid refuses ───────────────────────── */

  // A control whose two halves disagree about which days exist is worse than
  // one with no stepper at all.
  await t.mount('datepicker-days', {
    todayISO: '2026-09-19', startDateISO: '2026-09-19', disabledDates: ['2026-09-20'],
  })
  t.is(await t.evaluate(`
    return document.querySelector('#stage .fjs-dp-stepper button[aria-label="Next day"]').disabled;
  `), true, 'next day is dead when the day it would land on is disabled')
  t.is(await t.evaluate(`
    return document.querySelector('#stage .fjs-dp-stepper button[aria-label="Previous day"]').disabled;
  `), false, 'and the other direction is unaffected')

  // With nothing selected there is nothing to move, and seeding `today` on a
  // click near the calendar is how a date nobody chose gets saved.
  await t.mount('datepicker-days', { startDateISO: '' })
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#stage .fjs-dp-stepper button')].every(b => b.disabled);
  `), true, 'both are dead with no selection')

  /* ── opt-in ──────────────────────────────────────────────────────────── */

  await t.mount('datepicker-days', { showStepper: false })
  t.is(await t.evaluate(`return document.querySelectorAll('#stage .fjs-dp-stepper').length;`), 0,
    'and nothing is drawn unless it is asked for')

  await t.timezone(null)
}
