// src/paint.js — draw a stage in its palette, and keep it moving, in the
// terminal. `#paint` resolves here; a browser takes `paint.browser.js`.
//
// The terminal paints no CSS and mesa's terminal tags lower to text and boxes
// only, so color per cell goes through the engine's own frame buffer: this
// attach puts one inside the box it is attached to, sized to the stage, and
// draws every cell from `stage.look()`. Figures and bubbles are `at()` boxes
// over it, a layer up, so they cover the art without the art knowing they
// are there.
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
  const width  = stage.width
  const height = stage.height
  const fb = new FrameBufferRenderable(box.ctx, { width, height, respectAlpha: true, flexShrink: 0 })
  box.add(fb)

  const draw = () => {
    const ms  = Date.now()
    const buf = fb.frameBuffer
    buf.clear(CLEAR)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const { ch, fg, bg } = stage.look(x, y, ms)
        if (ch === ' ' && !bg) continue
        buf.setCell(x, y, ch, rgba(fg) ?? INK, rgba(bg) ?? CLEAR)
      }
    }
    for (const p of stage.pacers) {
      const { x, y, text } = pacerAt(p, ms)
      ;[...text].forEach((ch, i) => { if (ch !== ' ') buf.setCell(x + i, y, ch, rgba(p.fg) ?? INK, CLEAR) })
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
    box.remove(fb)
    fb.destroy()
  }
}
