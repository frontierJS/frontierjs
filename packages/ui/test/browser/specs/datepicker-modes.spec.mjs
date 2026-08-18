/*
 * datepicker-modes.spec.mjs — the branches of DatePicker nothing has opened.
 *
 * `datepicker.spec.mjs` renders one picker and asks about the grid, the
 * navigation, disabled days and the tokens. What it never turns on is any of
 * the modes: the preset sidebar, the time picker, the two-pane range, a
 * Monday-start week, the year controls, an allow-list of dates, or the form
 * seam that `FJS-077` gave it.
 *
 * Each is a branch of the template, and this component is the one whose first
 * browser run found that it could not render at all (`FJS-147`) — a branch
 * nothing mounts is exactly where that hid.
 *
 * The month is pinned to January 2026 throughout, so every count and label is
 * a fact about one month rather than about the day the suite runs.
 */
export const name = 'DatePicker — the modes'
export const covers = ['forms/DatePicker']

const JAN = '2026-01-15'
const header = `document.querySelector('#stage .fjs-dp-cal header span > div:first-child').textContent.trim()`
const dayNamed = (n) =>
  `[...document.querySelectorAll('#stage .fjs-dp-cal button.fjs-dp-day')].find(b => b.textContent.trim() === '${n}')`

export async function run(t) {
  /* ── the preset sidebar ───────────────────────────────────────────────── */

  await t.mount('datepicker-modes', { todayISO: JAN, isRange: true, showPresets: true })

  t.is(await t.evaluate(`return document.querySelectorAll('#stage .fjs-dp-presets button').length;`), 2,
    'a preset per range, in the sidebar')
  t.ok(await t.evaluate(`
    return document.querySelector('#stage .fjs-dp-panel').classList.contains('presets');
  `), 'and the panel says it has one, so the stylesheet can lay it out')

  // A preset sets BOTH ends in one click, which is the whole point of it —
  // and `inclusiveEnd` means the end is the last millisecond of the day, not
  // its midnight, or a range query drops everything that happened that day.
  await t.clickAt('#stage .fjs-dp-presets button:last-child')
  await t.eventually(`document.querySelector('#payload').textContent`,
    '2026-01-10 00:00:00..2026-01-20 23:59:59',
    'a preset sets both ends, the end inclusive to the last millisecond of the day')

  t.ok(await t.evaluate(`
    return document.querySelector('#stage .fjs-dp-presets button:last-child').classList.contains('active');
  `), 'and the chosen preset is marked active')
  t.ok(await t.evaluate(`
    return !document.querySelector('#stage .fjs-dp-presets button:first-child').classList.contains('active');
  `), 'while the other one is not')

  // The range it set is drawn on the calendar too — a sidebar that sets a
  // value the grid does not show is two views of one state disagreeing.
  t.ok(await t.evaluate(`return ${dayNamed(10)}.classList.contains('start');`),
    'the calendar marks the start of the preset range')
  t.ok(await t.evaluate(`return ${dayNamed(20)}.classList.contains('end');`), 'and its end')
  t.ok(await t.evaluate(`return ${dayNamed(15)}.classList.contains('range');`),
    'and the days between')

  /* ── inclusiveEnd={false} ─────────────────────────────────────────────── */

  await t.mount('datepicker-modes',
    { todayISO: JAN, isRange: true, showPresets: true, inclusiveEnd: false })
  await t.clickAt('#stage .fjs-dp-presets button:last-child')
  await t.eventually(`document.querySelector('#payload').textContent`,
    '2026-01-10 00:00:00..2026-01-20 00:00:00',
    'inclusiveEnd={false} ends at midnight instead — the half-open range')

  /* ── the time picker ──────────────────────────────────────────────────── */

  await t.mount('datepicker-modes', { todayISO: JAN, showTimePicker: true })

  t.is(await t.evaluate(`return document.querySelectorAll('#stage .fjs-dp-time input[type=time]').length;`), 1,
    'a single-date picker gets one time input')

  // The date carries the time. This is the assertion a YYYY-MM-DD check cannot
  // make, and the reason the fixture prints the emitted value with seconds.
  await t.clickAt(`#stage .fjs-dp-cal button.fjs-dp-day:nth-of-type(1)`)
  await t.eventually(`document.querySelector('#payload').textContent`, '2026-01-01 08:00:00',
    'picking a day takes the time picker\'s default time with it')

  await t.evaluate(`
    const el = document.querySelector('#stage .fjs-dp-time input[type=time]');
    el.value = '14:30';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await t.eventually(`document.querySelector('#payload').textContent`, '2026-01-01 14:30:00',
    'and changing the time moves the value that is already picked')
  // Both views of one value, checked together. The binding moved and the
  // callback did not, so which of the two an app happened to read decided
  // whether it saved 14:30 or 08:00 (`FJS-318`).
  await t.eventually(`document.querySelector('#bound').textContent`, '2026-01-01 14:30:00',
    'and the binding agrees with what was announced')

  await t.mount('datepicker-modes', { todayISO: JAN, isRange: true, showTimePicker: true })
  t.is(await t.evaluate(`return document.querySelectorAll('#stage .fjs-dp-time input[type=time]').length;`), 2,
    'a range gets a second time input for its end')

  /* ── the two-pane range ───────────────────────────────────────────────── */

  await t.mount('datepicker-modes', { todayISO: JAN, isRange: true, isMultipane: true })

  t.is(await t.evaluate(`return document.querySelectorAll('#stage .fjs-dp-cal').length;`), 2,
    'multipane renders two calendars')
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#stage .fjs-dp-cal header span > div:first-child')].map(d => d.textContent.trim()).join(' | ');
  `), 'January 2026 | February 2026', 'showing consecutive months')

  // One month button per direction across the pair: two "next month" arrows
  // that move the panes independently is how the second pane ends up before
  // the first.
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#stage .fjs-dp-cal header button[aria-label="Next month"]')]
      .filter(b => !b.classList.contains('hide')).length;
  `), 1, 'with only one live next-month arrow between them')

  await t.clickAt('#stage .fjs-dp-cal:last-child header button[aria-label="Next month"]')
  await t.eventually(`
    [...document.querySelectorAll('#stage .fjs-dp-cal header span > div:first-child')].map(d => d.textContent.trim()).join(' | ')
  `, 'February 2026 | March 2026', 'and advancing moves both panes together')

  /* ── the year controls ────────────────────────────────────────────────── */

  await t.mount('datepicker-modes', { todayISO: JAN })

  await t.clickAt('#stage .fjs-dp-cal header button[aria-label="Next year"]')
  await t.eventually(header, 'January 2027', 'the year control moves a whole year')
  await t.eventually(`document.querySelector('#navs').textContent`, 'next:year',
    'and says so through onNavigationChange, naming the unit')

  await t.clickAt('#stage .fjs-dp-cal header button[aria-label="Previous year"]')
  await t.eventually(header, 'January 2026', 'and back')

  await t.clickAt('#stage .fjs-dp-cal header button[aria-label="Next month"]')
  await t.eventually(`document.querySelector('#navs').textContent`, 'next:month',
    'a month step reports the month unit, not the year')

  await t.mount('datepicker-modes', { todayISO: JAN, showYearControls: false })
  t.is(await t.evaluate(`return document.querySelectorAll('#stage .fjs-dp-years').length;`), 0,
    'showYearControls={false} removes them rather than hiding them')
  t.is(await t.evaluate(`
    return document.querySelectorAll('#stage .fjs-dp-cal header button[aria-label$="month"]').length;
  `), 2, 'while the month arrows stay')

  /* ── a Monday-start week ──────────────────────────────────────────────── */

  await t.mount('datepicker-modes', { todayISO: JAN, startOfWeek: 1 })

  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#stage .fjs-dp-dow')].map(s => s.textContent.trim()).join('');
  `), 'MoTuWeThFrSaSu', 'startOfWeek={1} rotates the day labels to Monday first')

  // The offset is the half that goes wrong: rotating the labels without
  // rotating the grid puts every date under the wrong weekday, and the
  // calendar still looks like a calendar. 1 January 2026 is a Thursday, so on
  // a Monday-start grid it is the fourth cell of its row.
  t.is(await t.evaluate(`
    const cells = [...document.querySelectorAll('#stage .fjs-dp-grid > *')].filter(el => !el.classList.contains('fjs-dp-dow'));
    return cells.findIndex(el => el.textContent.trim() === '1');
  `), 3, 'and rotates the grid with them — 1 Jan 2026 is a Thursday')

  await t.mount('datepicker-modes', { todayISO: JAN, startOfWeek: 0 })
  t.is(await t.evaluate(`
    const cells = [...document.querySelectorAll('#stage .fjs-dp-grid > *')].filter(el => !el.classList.contains('fjs-dp-dow'));
    return cells.findIndex(el => el.textContent.trim() === '1');
  `), 4, 'while a Sunday-start week puts it one cell further along')

  /* ── an allow-list of dates ───────────────────────────────────────────── */

  // The mirror of `disabledDates`, and the more dangerous direction: a list
  // that fails open lets someone book a day that is not on offer.
  await t.mount('datepicker-modes', { todayISO: JAN, enabledDates: ['2026-01-05', '2026-01-06'] })

  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#stage button.fjs-dp-day')]
      .filter(b => !b.classList.contains('disabled'))
      .map(b => b.textContent.trim()).join(',');
  `), '5,6', 'with enabledDates set, only those days are selectable')

  await t.evaluate(`${dayNamed(12)}.click(); return true;`)
  await t.eventually(`document.querySelector('#payload').textContent`, '',
    'and a day outside the list refuses the click')
  await t.evaluate(`${dayNamed(5)}.click(); return true;`)
  await t.eventually(`document.querySelector('#payload').textContent`, '2026-01-05 00:00:00',
    'while one inside it selects')

  /* ── the form seam ────────────────────────────────────────────────────── */

  // `FJS-077` gave this component a <Field> wrapper and a hidden input, which
  // is what lets a picker sit in a form at all — a control with no `name`
  // submits nothing, and a label that points nowhere is not a label.
  await t.mount('datepicker-modes',
    { todayISO: JAN, name: 'dueOn', label: 'Due on', required: true, error: 'Pick a date' })

  t.is(await t.evaluate(`
    return document.querySelector('#stage input[type=hidden][name=dueOn]') !== null;
  `), true, 'a named picker carries a hidden input the form can read')
  t.ok(await t.evaluate(`
    return [...document.querySelectorAll('#stage label')].some(l => l.textContent.includes('Due on'));
  `), 'the label renders')
  t.ok(await t.evaluate(`
    return document.querySelector('#stage .fjs-dp').getAttribute('aria-invalid') === 'true';
  `), 'and an error marks the picker invalid')
  t.ok(await t.evaluate(`
    return [...document.querySelectorAll('#stage')].some(el => el.textContent.includes('Pick a date'));
  `), 'with the message on screen')

  await t.evaluate(`${dayNamed(9)}.click(); return true;`)
  await t.eventually(`document.querySelector('#stage input[type=hidden][name=dueOn]').value`, '2026-01-09',
    'and picking a day writes the value a form would submit')
}
