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
// they are there. The buffer is the view's size, made again when that
// changes: the editor asking for the whole stage, or a piece mounted past
// the edge of a stage smaller than the view.
//
// A stage with a cycling palette entry or a pacer is redrawn on the shortest
// step, and on any claim changing — a piece moved. The clock is the wall's
// rather than the mount's, so two terminals in one room draw the cat on the
// same cell. The timer is unref'd, so a `--frame` render exits when its work
// is done rather than when the water stops.
import { FrameBufferRenderable, RGBA } from '@opentui/core'
import { pacerAt } from './stage.js'

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
const INK   = RGBA.fromHex('#c8c8c8')

const colors = new Map()
const rgba = (hex) => {
  if (!hex) return null
  let c = colors.get(hex)
  if (!c) colors.set(hex, c = RGBA.fromHex(hex))
  return c
}

export const paint = (stage) => (box) => {
  let fb = null
  let size = { w: 0, h: 0 }
  const buffer = (w, h) => {
    if (fb && size.w === w && size.h === h) return fb
    if (fb) { box.remove(fb); fb.destroy() }
    size = { w, h }
    fb = new FrameBufferRenderable(box.ctx, { width: w, height: h, respectAlpha: true, flexShrink: 0 })
    box.add(fb)
    return fb
  }

  const draw = () => {
    const ms = Date.now()
    const v  = stage.view
    if (!v.w || !v.h) return
    const buf = buffer(v.w, v.h).frameBuffer
    buf.clear(CLEAR)
    for (let row = 0; row < v.h; row++) {
      for (let col = 0; col < v.w; col++) {
        const { ch, fg, bg } = stage.look(v.x + col, v.y + row, ms)
        if (ch === ' ' && !bg) continue
        buf.setCell(col, row, ch, rgba(fg) ?? INK, rgba(bg) ?? CLEAR)
      }
    }
    for (const p of stage.pacers) {
      const { x, y, text } = pacerAt(p, ms)
      const row = y - v.y
      if (row < 0 || row >= v.h) continue
      ;[...text].forEach((ch, i) => {
        const col = x + i - v.x
        if (ch !== ' ' && col >= 0 && col < v.w) buf.setCell(col, row, ch, rgba(p.fg) ?? INK, CLEAR)
      })
    }
    fb.requestRender()
  }
  draw()

  const tick = stage.tickOf()
  const timer = tick ? setInterval(draw, tick) : null
  timer?.unref?.()
  const unsubscribe = stage.subscribe(draw)

  return () => {
    unsubscribe()
    if (timer) clearInterval(timer)
    if (fb) { box.remove(fb); fb.destroy() }
  }
}
