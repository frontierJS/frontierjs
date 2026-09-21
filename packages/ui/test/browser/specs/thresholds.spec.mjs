/*
 * thresholds.spec.mjs — the cuts, the push, and whether the picture agrees.
 *
 * Three things here cannot be seen by a compile, a render or an attribute
 * harness, and each was a live bug in the hand-rolled tuner this component was
 * generalized from:
 *
 *   • a NEIGHBOR pushed aside by a drag keeps its own DOM value. The reported
 *     numbers are then right and the handle under the person's hand is not, so
 *     the row disagrees with its own readout and nothing anywhere throws.
 *   • the bars and the handles are two renderings of ONE scale, and a
 *     half-bucket of drift between them is invisible on a linear axis. This
 *     fixture is log for that reason, and the check is a cross-read: the band a
 *     bar is COLORED is compared against the band its position falls in
 *     according to the cut MARKERS.
 *   • the counts are the only numbers on screen that are nowhere else, so a
 *     band that stopped being recounted when a cut moved would look correct.
 */
export const name = 'Thresholds — banded cuts over a distribution'
export const covers = ['forms/Thresholds']

const out  = `document.getElementById('out').textContent`
const held = (path) => `(() => { const v = JSON.parse(${out} || 'null') ?? []; return ${path} })()`

const readouts = `[...document.querySelectorAll('#tuner .fjs-th-value')].map(e => e.textContent).join(',')`
const handles  = `[...document.querySelectorAll('#tuner input[type="range"]')].map(e => e.value).join(',')`
const counts   = `[...document.querySelectorAll('#tuner .fjs-th-count')].map(e => Number(e.textContent))`

const setRange = (i, value) => `
  const el = document.querySelectorAll('#tuner input[type="range"]')[${i}];
  el.value = String(${value});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
`

export async function run(t) {
  await t.mount('thresholds')

  /* ── what it drew ─────────────────────────────────────────────────────── */

  const shape = await t.evaluate(`return ({
    rows:     document.querySelectorAll('#tuner .fjs-th-row').length,
    bars:     document.querySelectorAll('#tuner .fjs-th-bars i').length,
    marks:    document.querySelectorAll('#tuner .fjs-th-mark').length,
    counts:   document.querySelectorAll('#tuner .fjs-th-count').length,
    readouts: ${readouts},
    note:     document.querySelector('#tuner .fjs-th-note')?.textContent,
    labeled: document.querySelector('#tuner .fjs-th-plot')?.getAttribute('aria-label') ?? '',
  })`)

  t.is(shape.rows, 3, 'three cuts, three rows')
  // N cuts make N+1 bands, and the count row is the only place the last one is
  // spoken for — an off-by-one here drops the open-ended band silently.
  t.is(shape.counts, 4, 'and four bands, the last one open-ended')
  t.is(shape.marks, 3, 'a marker per cut')
  t.ok(shape.bars > 8, `the distribution drew bars (${shape.bars})`)
  t.is(shape.readouts, '10,30,100', 'the readouts are the cuts themselves')
  t.is(shape.note, 'the shipped cuts', 'and the note is the resting one')
  t.match(shape.labeled, /600 values in 4 bands/, 'the plot is named, not hidden')

  /* ── the picture agrees with the handles ──────────────────────────────── */
  //
  // Read twice from the DOM and compared: the band a bar is COLORED, as a rank
  // among the distinct ramp steps, against the band its own center falls in
  // according to the markers. Neither side is told the other's answer, and a
  // scale applied differently to the two would not survive a log axis.

  const picture = await t.evaluate(`
    const bars  = [...document.querySelectorAll('#tuner .fjs-th-bars i')];
    const marks = [...document.querySelectorAll('#tuner .fjs-th-mark')].map(m => parseFloat(m.style.left));
    const mixOf = (el) => parseFloat(getComputedStyle(el).getPropertyValue('--fjs-th-mix'));
    const ramp  = [...new Set(bars.map(mixOf))].sort((a, b) => a - b);
    let wrong = 0;
    bars.forEach((el, i) => {
      const center   = ((i + 0.5) / bars.length) * 100;
      const byMarker = marks.filter(m => m < center).length;
      const byColor = ramp.indexOf(mixOf(el));
      if (byMarker !== byColor) wrong++;
    });
    return { steps: ramp.length, wrong };
  `)

  // The step count is the control: with one color on every bar the comparison
  // above passes for a band-0 reading of everything.
  t.is(picture.steps, 4, 'the ramp has a step per band')
  t.is(picture.wrong, 0, 'and every bar is colored the band its position falls in')

  const tally = await t.evaluate(`return ${counts}`)
  t.is(tally.reduce((a, b) => a + b, 0), 600, 'the band counts account for every value')
  t.ok(tally.every(n => n > 0), `and no band is empty at the defaults (${tally.join(' · ')})`)

  /* ── the keyboard moves one ───────────────────────────────────────────── */
  //
  // A native range input, so this is the platform's own path — and on a log
  // scale one tick is a conversion, not an increment.

  await t.evaluate(`document.querySelectorAll('#tuner input[type="range"]')[2].focus(); return true;`)
  await t.press('ArrowRight')
  await t.eventually(held(`v[2] > 100`), true, 'an arrow key moves the cut it is on')
  await t.eventually(held(`v[0] + ',' + v[1]`), '10,30', 'and leaves the others where they were')

  /* ── a push carries its neighbors, handles included ──────────────────── */

  const before = (await t.evaluate(`return ${counts}`))[0]
  await t.evaluate(setRange(0, 1000))

  await t.eventually(held(`v.every((n, i) => i === 0 || n > v[i - 1])`), true,
    'a cut driven past its neighbors pushes them rather than crossing them')
  await t.eventually(held(`v[0] > 4000`), true, 'and lands where it was dragged')

  // The trap. The reported numbers above can be perfect while the two handles
  // that were pushed sit where they started.
  const after = await t.evaluate(`return ({
    handles:  ${handles},
    readouts: ${readouts},
    counts:   ${counts},
    note:     document.querySelector('#tuner .fjs-th-note')?.textContent,
  })`)
  const positions = after.handles.split(',').map(Number)
  t.ok(positions.every((p, i) => i === 0 || p >= positions[i - 1]),
    `the pushed handles moved with the numbers (${after.handles})`)
  t.ok(positions[1] > 900, 'a neighbor pushed to the top of the scale has a handle at the top')

  t.ok(after.counts[0] > before,
    `band 0 was recounted when its cut moved (${before} → ${after.counts[0]})`)
  t.is(after.counts.reduce((a, b) => a + b, 0), 600, 'and the counts still account for everything')
  t.match(after.note, /^moved from 10 · 30 · 100$/, 'the note says what it was moved from')

  /* ── a drag the component REFUSES still has to leave the handle true ──── */
  //
  // The stall, and the only reason this component syncs handles by hand: Mesa
  // writes the input back whenever the numbers CHANGE, and a drag held against
  // a bound changes nothing after the first event. The model says 3, the person
  // is still holding the handle at 0, and every further event agrees with the
  // last one — so without the sync the handle stays at the end of the track
  // with a readout beside it saying something else.

  await t.evaluate(setRange(2, 0))
  await t.evaluate(setRange(2, 0))
  const bounded = await t.evaluate(`return ({ handles: ${handles}, readouts: ${readouts} })`)
  t.is(bounded.readouts, '1,2,3', 'a cut dragged off the bottom takes its neighbors down to the floor')
  t.ok(Number(bounded.handles.split(',')[2]) > 100,
    `and the handle is put back where that value IS, not where the drag ended (${bounded.handles})`)

  /* ── Reset ────────────────────────────────────────────────────────────── */

  await t.clickAt('#tuner button.btn')
  await t.eventually(readouts, '10,30,100', 'Reset puts the cuts back')
  await t.eventually(`document.querySelector('#tuner .fjs-th-note').textContent`, 'the shipped cuts',
    'and the note goes back to resting')
  // Same trap as the push, on the other path: the readouts can be right while
  // three handles stay where the drag left them.
  const back = await t.evaluate(`return ${handles}`)
  t.is(back.split(',').map(Number).every(p => p < 900), true,
    `and the handles came back with them (${back})`)
}
