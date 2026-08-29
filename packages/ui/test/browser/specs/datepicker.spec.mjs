/*
 * datepicker.spec.mjs — DatePicker, the kit's biggest unknown.
 *
 * 1200 lines, and until this file nothing had ever rendered it in a browser.
 * What that cost is on the record: both calendar panes are built with
 * `{#each { length: 6 }}`, mesa's `{#each}` called `.map()` on whatever it was
 * handed, and the component therefore threw on first render for as long as it
 * existed — while compiling cleanly the whole time (`FJS-147`). A component
 * this size with one entry point deserves a check that it produces a grid at
 * all, and that is the first assertion here.
 *
 * The month is pinned. `today` decides which cell is `.today`, what the header
 * reads and how many cells there are, so every assertion below is a fact about
 * January 2026 rather than about the day the suite happens to run.
 *
 * Note that `isFutureDate` compares against the real clock and not against
 * `today` — pinning the prop into the past does not make the grid clickable by
 * itself, it is the real date being later that does. The future case therefore
 * uses a month that is genuinely ahead.
 */
export const name = 'DatePicker'
export const covers = ['forms/DatePicker']

const JAN_2026 = '2026-01-15'

export async function run(t) {
  await t.mount('datepicker', { todayISO: JAN_2026 })

  /* ── it renders ──────────────────────────────────────────────────────── */

  t.ok(await t.evaluate(`return !!document.querySelector('#stage .fjs-dp .fjs-dp-cal');`),
    'a calendar renders')

  t.is(await t.evaluate(`return document.querySelectorAll('#stage .fjs-dp-grid .fjs-dp-dow').length;`), 7,
    'seven day-of-week labels')

  // The count is the real test of the six-week grid: January 2026 has 31 days
  // and the overflow cells are rendered as `.date.other`, not as buttons.
  t.is(await t.evaluate(`return document.querySelectorAll('#stage .fjs-dp-grid button.fjs-dp-day').length;`), 31,
    'January 2026 renders 31 day buttons')

  t.match(await t.evaluate(`return document.querySelector('#stage .fjs-dp-cal header span div').textContent;`),
    /January 2026/, 'the header names the pinned month')

  t.is(await t.evaluate(`
    return document.querySelector('#stage button.fjs-dp-day.today .fjs-dp-square')?.textContent.trim();
  `), '15', 'the 15th is marked as today')

  /* ── navigation ──────────────────────────────────────────────────────── */

  await t.clickAt('#stage .fjs-dp-cal header button[aria-label="Next month"]')
  await t.eventually(`document.querySelector('#stage .fjs-dp-cal header span div').textContent`,
    'February 2026', 'next month advances the header')
  t.is(await t.evaluate(`return document.querySelectorAll('#stage .fjs-dp-grid button.fjs-dp-day').length;`), 28,
    'February 2026 renders 28 day buttons')

  await t.clickAt('#stage .fjs-dp-cal header button[aria-label="Previous month"]')
  await t.eventually(`document.querySelector('#stage .fjs-dp-cal header span div').textContent`,
    'January 2026', 'previous month goes back')

  await t.clickAt('#stage .fjs-dp-cal header .fjs-dp-years button[aria-label="Previous year"]')
  await t.eventually(`document.querySelector('#stage .fjs-dp-cal header span div').textContent`,
    'January 2025', 'the year controls move a year at a time')
  await t.clickAt('#stage .fjs-dp-cal header .fjs-dp-years button[aria-label="Next year"]')
  await t.eventually(`document.querySelector('#stage .fjs-dp-cal header span div').textContent`,
    'January 2026', 'and back')

  /* ── picking a single date ───────────────────────────────────────────── */

  // A day is addressed by its label rather than by position — the grid's
  // leading blanks move with the month, so nth-child would pick a different
  // date every time the pinned month changed.
  await t.evaluate(`
    const b = [...document.querySelectorAll('#stage button.fjs-dp-day')]
      .find(x => x.querySelector('.fjs-dp-square').textContent.trim() === '20');
    b.click();
    return true;
  `)

  await t.eventually(`document.querySelector('#picked').textContent`, '2026-01-20',
    'clicking a day writes the date back through bind:startDate')
  t.ok(await t.evaluate(`
    const b = [...document.querySelectorAll('#stage button.fjs-dp-day')]
      .find(x => x.querySelector('.fjs-dp-square').textContent.trim() === '20');
    return b.classList.contains('start');
  `), 'the picked day is marked')

  /* ── a range ─────────────────────────────────────────────────────────── */

  await t.mount('datepicker', { todayISO: JAN_2026, isRange: true })

  const pick = (n) => t.evaluate(`
    const b = [...document.querySelectorAll('#stage button.fjs-dp-day')]
      .find(x => x.querySelector('.fjs-dp-square').textContent.trim() === ${JSON.stringify(String(n))});
    if (!b) throw new Error('no day ' + ${n});
    b.click();
    return true;
  `)

  await pick(10)
  await pick(14)
  await t.eventually(`document.querySelector('#picked').textContent`, '2026-01-10..2026-01-14',
    'two clicks make a range')
  await t.eventually(`document.querySelector('#changes').textContent`, '1',
    'onDateChange fires once a range is complete, not on the first click')

  t.ok(await t.evaluate(`
    const between = [...document.querySelectorAll('#stage button.fjs-dp-day')]
      .filter(x => ['11','12','13'].includes(x.querySelector('.fjs-dp-square').textContent.trim()));
    return between.every(b => b.classList.contains('range'));
  `), 'the days between the ends are marked as in-range')

  // The end of a range is the accent; the days between it are the band. Both
  // rules are equally specific and the band's comes first, so a rule that sets
  // only --bg-mix leaves the end painted in the BAND with the text colour of a
  // fill — pale on pale, which reads as a rendering fault rather than a CSS one.
  const bandVsEnd = await t.evaluate(`
    const at = (n) => [...document.querySelectorAll('#stage button.fjs-dp-day')]
      .find(x => x.querySelector('.fjs-dp-square').textContent.trim() === n)
      .querySelector('.fjs-dp-square');
    const cs = (el) => getComputedStyle(el);
    return { end: cs(at('10')).backgroundColor, mid: cs(at('12')).backgroundColor,
             accent: cs(document.querySelector('#stage .fjs-dp')).getPropertyValue('--dp-accent').trim() };
  `)
  t.ok(bandVsEnd.end !== bandVsEnd.mid,
    'a range end is painted in the accent, the days between it in the band')

  // Picking backwards is ordinary — the second click may be before the first,
  // and the component swaps them with a destructuring assignment to two
  // reactive lets, which is its own compiler path.
  await pick(20)
  await pick(17)
  await t.eventually(`document.querySelector('#picked').textContent`, '2026-01-17..2026-01-20',
    'picking backwards swaps the ends rather than making an empty range')

  /* ── days that must refuse a click ───────────────────────────────────── */

  await t.mount('datepicker', { todayISO: JAN_2026, disabledDates: ['2026-01-22'] })
  t.ok(await t.evaluate(`
    const b = [...document.querySelectorAll('#stage button.fjs-dp-day')]
      .find(x => x.querySelector('.fjs-dp-square').textContent.trim() === '22');
    return b.classList.contains('disabled');
  `), 'a date in disabledDates is marked')

  await t.evaluate(`
    const b = [...document.querySelectorAll('#stage button.fjs-dp-day')]
      .find(x => x.querySelector('.fjs-dp-square').textContent.trim() === '22');
    b.click();
    return true;
  `)
  await t.eventually(`document.querySelector('#picked').textContent`, '',
    'and clicking it selects nothing')

  // A month that is genuinely ahead of the real clock, so `future` is decided
  // by the component's own rule rather than by the pinned prop.
  const nextYear = `${new Date().getFullYear() + 1}-06-15`
  await t.mount('datepicker', { todayISO: nextYear })
  t.ok(await t.evaluate(`
    return [...document.querySelectorAll('#stage button.fjs-dp-day')].every(b => b.classList.contains('future'));
  `), 'with enableFutureDates off, a future month is entirely future')
  await t.evaluate(`
    const b = [...document.querySelectorAll('#stage button.fjs-dp-day')][10];
    b.click();
    return true;
  `)
  await t.eventually(`document.querySelector('#picked').textContent`, '',
    'and a future day refuses the click')

  await t.mount('datepicker', { todayISO: nextYear, enableFutureDates: true })
  t.ok(await t.evaluate(`
    return [...document.querySelectorAll('#stage button.fjs-dp-day')].every(b => !b.classList.contains('future'));
  `), 'enableFutureDates={true} clears the whole month')

  /* ── it is styled from the design system, not from its own scale ─────── */

  // FJS-128: this component used to declare 107 custom properties, 47 of them
  // defined without reading a single design token — its own six-rung radius
  // scale, its own font-size scale, `font-family: sans-serif`, eight literal
  // colours, and four black base64 PNGs for the nav arrows. It compiled, it
  // rendered, and a theme switch reached it partially at best. Each assertion
  // below is one of those failures, asked as a measurement.

  await t.mount('datepicker', { todayISO: JAN_2026 })

  // Compared against the token's own value, not against the body: the body may
  // never state a face at all, and `sans-serif` is what the UA falls back to —
  // so "same as the body" would have passed against the literal being replaced.
  t.is(await t.evaluate(`
    const dp    = document.querySelector('#stage .fjs-dp');
    const token = getComputedStyle(document.body).getPropertyValue('--font-primary').trim();
    return { same: getComputedStyle(dp).fontFamily === token, face: getComputedStyle(dp).fontFamily };
  `).then(r => r.same), true, 'the type face is the theme\'s --font-primary, not a hardcoded sans-serif')

  // A theme is nothing but tokens, so the only honest question is whether the
  // painted colours move when the tokens do.
  const themed = await t.evaluate(`
    const panel = document.querySelector('#stage .fjs-dp-panel');
    const before = getComputedStyle(panel).backgroundColor;
    document.body.className = 'theme-dark';
    await new Promise(r => setTimeout(r, 50));
    const after = getComputedStyle(panel).backgroundColor;
    document.body.className = 'theme-default';
    return { before, after };
  `)
  t.ok(themed.before !== themed.after,
    'the panel is painted from --surface-raised, so a theme switch reaches it')

  // Density is an inherited multiplier on the space ladder. A literal padding
  // cannot see it, which is what 47 untokened properties meant in practice.
  const dense = await t.evaluate(`
    const cal = document.querySelector('#stage .fjs-dp-cal');
    const loose = parseFloat(getComputedStyle(cal).paddingTop);
    document.querySelector('#stage').classList.add('dense');
    await new Promise(r => setTimeout(r, 50));
    const tight = parseFloat(getComputedStyle(cal).paddingTop);
    document.querySelector('#stage').classList.remove('dense');
    return { loose, tight };
  `)
  t.ok(dense.tight < dense.loose, '.dense on an ancestor reaches the calendar\'s padding')

  // One knob, and the geometry that has to follow it: the grid track, the disc
  // and the range band's bleed are all derived from --dp-cell. The bleed was a
  // literal 20px against a literal 40px cell.
  const sized = await t.evaluate(`
    const dp = document.querySelector('#stage .fjs-dp');
    dp.style.setProperty('--dp-cell', '4rem');
    await new Promise(r => setTimeout(r, 50));
    const square = document.querySelector('#stage .fjs-dp-square');
    const grid   = getComputedStyle(document.querySelector('#stage .fjs-dp-grid')).gridTemplateColumns;
    const box    = square.getBoundingClientRect();
    dp.style.removeProperty('--dp-cell');
    return { w: Math.round(box.width), track: grid.split(' ')[0] };
  `)
  t.is(sized.w, 64, 'overriding --dp-cell resizes the day disc')
  t.is(sized.track, '64px', 'and the grid track with it')

  // The band has to meet the disc exactly, so its bleed is half a cell —
  // derived, because a literal drifts the moment --dp-cell moves.
  await t.mount('datepicker', { todayISO: JAN_2026, isRange: true })
  const bleed = await t.evaluate(`
    const dp = document.querySelector('#stage .fjs-dp');
    const at = (n) => [...document.querySelectorAll('#stage button.fjs-dp-day')]
      .find(x => x.querySelector('.fjs-dp-square').textContent.trim() === n);
    at('10').click(); at('14').click();
    await new Promise(r => setTimeout(r, 60));
    const read = () => getComputedStyle(at('10')).boxShadow;
    const base = read();
    dp.style.setProperty('--dp-cell', '4rem');
    await new Promise(r => setTimeout(r, 60));
    const wide = read();
    dp.style.removeProperty('--dp-cell');
    return { base, wide };
  `)
  t.match(bleed.base, /-20px/, "the band's bleed is half a 2.5rem cell")
  t.match(bleed.wide, /-32px/, 'and half a 4rem one when the cell is overridden')

  // The arrows are inline SVG over currentColor. As base64 PNGs they were
  // black pixels: invisible on a dark theme, and unable to follow a tone.
  t.ok(await t.evaluate(`
    const btn = document.querySelector('#stage .fjs-dp-cal header button');
    const svg = btn.querySelector('svg');
    return !!svg && getComputedStyle(btn).backgroundImage === 'none';
  `), 'the nav arrows are inline SVG, not a background image')
}
