// src/paint.js — draw a stage in its palette, and keep it moving, in the
// terminal. `#paint` resolves here; a browser takes `paint.browser.js`.
//
// The terminal paints no CSS and mesa's terminal tags lower to text and boxes
// only, so color per cell goes through the engine's own frame buffer: this
// attach puts one inside the box it is attached to, sized to the stage, and
// draws every cell of `stage.view` from `stage.look()` — the slice the screen
// shows, which pans as the figure walks (6.1) — so a figure's cell on screen
// is its stage cell less the view's corner. Figures and bubbles are `at()`
// boxes over it, a layer up, so they cover the art without the art knowing
// they are there. A pacer is drawn on lit cells only: the cat in a dark
// corner is not seen. The buffer is the view's size, made again when that
// changes: the editor asking for the whole stage, or a piece mounted past
// the edge of a stage smaller than the view.
//
// The drawing is a paint task on the stage's one clock (`stage.js`): run on
// any change — a piece moved — and on the look's shortest step. The clock is
// the wall's rather than the mount's, so two terminals in one room draw the
// cat on the same cell.
//
// A cell of a piece that is `overhead` (a canopy, a lamp's head) is drawn in a
// second buffer above the figures, so a figure walks behind it. That buffer
// sits between the figures' layer (10, 11) and the speech bubbles' (12),
// which a canopy must not hide.
import { FrameBufferRenderable, RGBA } from '@opentui/core'
import { INK as INK_HEX, pacerAt } from './stage.js'
import { at } from './cell.js'

/** The layer of what is overhead: over a figure, under a bubble. */
const OVERHEAD = 11.5

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
const INK   = RGBA.fromHex(INK_HEX)

const colors = new Map()
const rgba = (hex) => {
  if (!hex) return null
  let c = colors.get(hex)
  if (!c) colors.set(hex, c = RGBA.fromHex(hex))
  return c
}

export const paint = (stage) => (box) => {
  let fbs = null   // [the art, what is overhead]
  let size = { w: 0, h: 0 }
  const release = () => { for (const f of fbs ?? []) { box.remove(f); f.destroy() } }
  const buffers = (w, h) => {
    if (fbs && size.w === w && size.h === h) return fbs
    release()
    size = { w, h }
    fbs = [0, 1].map(() => new FrameBufferRenderable(box.ctx, { width: w, height: h, respectAlpha: true, flexShrink: 0 }))
    at(0, 0, OVERHEAD)(fbs[1])
    fbs.forEach((f) => box.add(f))
    return fbs
  }

  const draw = (ms) => {
    const v  = stage.view
    if (!v.w || !v.h) return
    const [art, top] = buffers(v.w, v.h)
    const buf = art.frameBuffer
    buf.clear(CLEAR)
    top.frameBuffer.clear(CLEAR)
    for (let row = 0; row < v.h; row++) {
      for (let col = 0; col < v.w; col++) {
        const { ch, fg, bg, overhead } = stage.look(v.x + col, v.y + row, ms)
        if (ch === ' ' && !bg) continue
        ;(overhead ? top.frameBuffer : buf).setCell(col, row, ch, rgba(fg) ?? INK, rgba(bg) ?? CLEAR)
      }
    }
    for (const p of stage.pacers) {
      const { x, y, text } = pacerAt(p, ms)
      const row = y - v.y
      if (row < 0 || row >= v.h) continue
      ;[...text].forEach((ch, i) => {
        const col = x + i - v.x
        if (ch !== ' ' && col >= 0 && col < v.w && stage.light(x + i, y) === 'lit') buf.setCell(col, row, ch, rgba(stage.tint(p.fg, x + i, y, ms)) ?? INK, CLEAR)
      })
    }
    art.requestRender()
    top.requestRender()
  }
  // A paint task on the stage's clock (`stage.js`): run on any change and on
  // the look's next tick, at the frame's own ms. Keyed by the box, since the
  // editor paints one stage into more than one.
  const stop = stage.task(box, draw, { phase: 'paint' })

  return () => {
    stop()
    release()
  }
}
