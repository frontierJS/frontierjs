/*
 * slider.spec.mjs — Slider, driven by a real pointer and real keys.
 *
 * The slider pattern takes more than the horizontal arrows, a press anywhere
 * on the track (the handle included) moves the value there and carries on as a
 * drag, and a handle with no visible label still has a name its caller wrote.
 * A dispatched event proves none of it: the press has to land on pixels.
 */
export const name = 'Slider — keys, press and drag on the track, an accessible name'
export const covers = []

const volume = `document.getElementById('vol-out').textContent`
const range  = `document.getElementById('range-out').textContent`
const handle = (i) => `document.querySelectorAll('[role=slider]')[${i}]`

// The x of a value on the first track, 0..100 across its width.
const xOf = (v) => `
  const r = document.querySelector('.fjs-slider-track').getBoundingClientRect();
  return { x: r.left + r.width * ${v} / 100, y: r.top + r.height / 2 };
`

export async function run(t) {
  await t.mount('slider')

  /* ── the name ─────────────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return ${handle(0)}.getAttribute('aria-label');`), 'Volume',
    'an unlabelled handle takes the aria-label its caller wrote')
  t.is(await t.evaluate(`return ${handle(1)}.getAttribute('aria-label');`), 'Price minimum',
    'a range handle is named for the slider and its end')

  /* ── keys ─────────────────────────────────────────────────────────────── */

  await t.evaluate(`${handle(0)}.focus(); return true;`)
  for (const [key, want] of [
    ['ArrowUp', '30'], ['ArrowDown', '20'], ['PageUp', '100'], ['PageDown', '0'],
    ['End', '100'], ['Home', '0'], ['ArrowRight', '10'], ['ArrowLeft', '0'],
  ]) {
    await t.press(key)
    await t.eventually(volume, want, `${key} → ${want}`)
  }

  /* ── oninput per value, onchange once at the end of the gesture ───────── */

  const tally = () => t.evaluate(`return { ...window.tally };`)
  await t.evaluate(`window.tally = { input: 0, change: 0 }; ${handle(0)}.focus(); return true;`)
  await t.press('ArrowRight')
  await t.eventually(volume, '10', 'ArrowRight steps once')
  t.is(JSON.stringify(await tally()), '{"input":1,"change":1}', 'a key press is one input and one change')
  t.is(JSON.stringify(await t.evaluate(`return { input: window.got.input, change: window.got.change };`)), '{"input":10,"change":10}', 'both callbacks receive the bare number, not { value } (FJS-2491)')

  const dragFrom = await t.evaluate(xOf(10))
  await t.evaluate(`window.tally = { input: 0, change: 0 }; return true;`)
  await t.drag(dragFrom, await t.evaluate(xOf(90)), { steps: 8 })
  await t.eventually(volume, '90', 'a drag across the track lands')
  const dragged = await tally()
  t.ok(dragged.input > 1, 'a drag reports every value it passes through (' + dragged.input + ')')
  t.is(dragged.change, 1, 'and commits once, at release')

  await t.evaluate(`window.tally = { input: 0, change: 0 }; return true;`)
  const grab = await t.evaluate(xOf(90))
  await t.drag(grab, grab, { steps: 1 })
  t.is(JSON.stringify(await tally()), '{"input":0,"change":0}', 'a press on the handle that moves nothing commits nothing')

  /* ── a press on the track jumps there, and a drag carries on ──────────── */

  const to70 = await t.evaluate(xOf(70))
  await t.drag(to70, to70, { steps: 1 })
  await t.eventually(volume, '70', 'a press 7 steps away jumps there')

  const on70 = await t.evaluate(xOf(72))
  const at20 = await t.evaluate(xOf(20))
  await t.drag(on70, at20)
  await t.eventually(volume, '20', 'a press on the handle drags it, and the jump does not move it first')

  const from50 = await t.evaluate(xOf(50))
  await t.drag(from50, await t.evaluate(xOf(90)))
  await t.eventually(volume, '90', 'a press on the bare track then drags')

  /* ── range: the nearest handle takes the press ────────────────────────── */

  await t.eventually(range, '20,80', 'the range starts where it was told')
  const rt = await t.evaluate(`
    const r = document.querySelectorAll('.fjs-slider-track')[1].getBoundingClientRect();
    return { l: r.left, w: r.width, y: r.top + r.height / 2 };
  `)
  const at = (v) => ({ x: rt.l + rt.w * v / 100, y: rt.y })
  await t.drag(at(60), at(60), { steps: 1 })
  await t.eventually(range, '20,60', 'a press nearer the high end moves the high handle')
  await t.drag(at(40), at(40), { steps: 1 })
  await t.eventually(range, '40,60', 'and one nearer the low end moves the low one')
  t.is(JSON.stringify(await t.evaluate(`return window.got.range;`)), '[40,60]', 'a range hands back [start, end] (FJS-2491)')

  await t.evaluate(`${handle(2)}.focus(); return true;`)
  await t.press('End')
  await t.eventually(range, '40,100', 'End takes the high handle to max')
  await t.press('Home')
  await t.eventually(range, '40,40', 'Home takes it only to the low handle')

  /* ── the value label stays inside the control at either end (FJS-2515) ── */

  // A label centred on a handle at min or max hangs half outside the track,
  // and a scrolling parent clips it.
  const hung = await t.evaluate(`
    const out = []
    for (const id of ['ends', 'ends-lo', 'ends-range']) {
      const root = document.getElementById(id)
      const tr = root.querySelector('.fjs-slider-track').getBoundingClientRect()
      for (const p of root.querySelectorAll('.fjs-slider-pip')) {
        const r = p.getBoundingClientRect()
        if (r.left < tr.left - 0.5 || r.right > tr.right + 0.5) out.push(id + ':' + p.textContent)
      }
    }
    return out.join(',')
  `)
  t.is(hung, '', 'a value label at min or max does not hang outside the track')

  /* ── a hue that is the data (FJS-3233) ────────────────────────────────── */

  const fillOf = (id) => `
    const el = document.getElementById('${id}');
    return getComputedStyle(el.querySelector('.fjs-slider-fill')).backgroundColor;
  `
  const handleOf = (id) => `
    const el = document.getElementById('${id}');
    return getComputedStyle(el.querySelector('[role=slider]')).backgroundColor;
  `
  t.is(await t.evaluate(fillOf('hue')), 'rgb(26, 162, 230)', 'a --data-accent on the slider fills the track in that hue')
  t.is(await t.evaluate(handleOf('hue')), 'rgb(26, 162, 230)', 'and the handle takes the same hue')
  t.ok(await t.evaluate(fillOf('plain')) !== 'rgb(26, 162, 230)', 'a slider with no --data-accent keeps its tone')
}
