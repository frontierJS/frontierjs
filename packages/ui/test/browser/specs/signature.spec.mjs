/*
 * signature.spec.mjs — a signature drawn with a real pointer.
 *
 * A pad is a canvas, so a compile or a render shows nothing: what matters is
 * that a pointer stroke becomes path data in the pad's own pixels, that Clear
 * empties it, that a resize keeps the strokes in proportion, and that the
 * read-only view draws the same value back.
 */
export const name = 'SignaturePad / SignatureView — a drawn signature'
export const covers = ['forms/SignaturePad', 'display/SignatureView']

const out = `document.getElementById('out').textContent`

export async function run(t) {
  await t.mount('signature')

  t.is(await t.evaluate(`return ${out};`), 'null', 'an untouched pad holds no value')
  t.is(await t.evaluate(`return document.querySelector('[data-clear]').disabled;`), true, 'and Clear has nothing to clear')

  /* ── a stroke becomes one path in the pad's pixels ─────────────────── */

  const r = await t.evaluate(`const b = document.querySelector('canvas').getBoundingClientRect(); return { x: b.left + 20, y: b.top + 20, w: Math.round(b.width), h: Math.round(b.height) };`)
  await t.drag({ x: r.x, y: r.y }, { x: r.x + 100, y: r.y + 40 })
  await t.eventually(`${out} !== 'null'`, true, 'a stroke reports a value')
  const v = await t.evaluate(`return JSON.parse(${out});`)
  t.is(v.paths.length, 1, 'one stroke, one path')
  t.match(v.paths[0], /^M20 20 L/, 'starting where the pointer went down, in pad pixels')
  t.match(v.paths[0], /L120 60$/, 'and ending where it was released')
  t.is(v.width, r.w, 'sized to the pad when the first stroke began')
  t.is(v.height, r.h, 'both ways')
  t.is(await t.evaluate(`return window.tally;`), 1, 'one onchange per stroke')

  const inked = `(() => { const c = document.querySelector('canvas'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((b, i) => i % 4 === 3 && b > 0) })()`
  t.is(await t.evaluate(`return ${inked};`), true, 'and the canvas has ink')

  /* ── a second stroke joins the first ───────────────────────────────── */

  await t.drag({ x: r.x, y: r.y + 30 }, { x: r.x + 50, y: r.y + 30 })
  await t.eventually(`JSON.parse(${out}).paths.length`, 2, 'a second stroke adds a path')

  /* ── a resize keeps what was drawn, in proportion ──────────────────── */

  await t.evaluate(`document.getElementById('box').style.width = '200px'; return true;`)
  await t.evaluate(`return await waitSettled('canvas');`)
  t.is(await t.evaluate(`return ${inked};`), true, 'a narrower pad is still inked')
  t.is(await t.evaluate(`return JSON.parse(${out}).width;`), r.w, 'and the value still names the size it was drawn at')

  /* ── Clear ─────────────────────────────────────────────────────────── */

  await t.clickAt('[data-clear]')
  await t.eventually(out, 'null', 'Clear empties the value')
  t.is(await t.evaluate(`return ${inked};`), false, 'and the canvas')
  t.is(await t.evaluate(`return document.querySelector('[data-clear]').disabled;`), true, 'and Clear is spent')

  /* ── the view ──────────────────────────────────────────────────────── */

  const view = await t.evaluate(`return {
    paths: document.querySelectorAll('#view svg path').length,
    box:   document.querySelector('#view svg').getAttribute('viewBox'),
    name:  document.querySelector('#view [data-signed-name]').textContent,
    bare:  document.querySelectorAll('#bare svg').length,
    bareName: document.querySelector('#bare [data-signed-name]').textContent,
  };`)
  t.is(view.paths, 1, 'the view draws each stroke')
  t.is(view.box, '0 0 200 80', 'in the pixels they were drawn in')
  t.is(view.name, 'Ada Lovelace', 'with the signer under them')
  t.is(view.bare, 0, 'a value with no strokes draws no picture')
  t.is(view.bareName, 'No Strokes', 'only the name')
}
