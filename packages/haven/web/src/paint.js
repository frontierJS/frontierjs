// src/paint.js — draw a stage in its palette, and keep it moving, in the
// terminal. `#paint` resolves here; a browser takes `paint.browser.js`.
//
// The terminal paints no CSS and mesa's terminal tags lower to text and boxes
// only, so color per cell goes through the engine's own frame buffer: this
// attach puts one inside the box it is attached to, sized to the stage, and
// draws every cell of `stage.view` from `stage.grid()` — the slice the screen
// shows, which pans as the figure walks (6.1) — so a figure's cell on screen
// is its stage cell less the view's corner. The view is as big as the
// terminal less the lines under the art (`viewFor`, 14.6), so zooming the
// terminal out shows more of the scene, and a resize fits it again round the
// figure. A scene's `scale` (14.7) is ignored here: a terminal app cannot
// set its cell size, and zooming the terminal is the same thing done by the
// person at it. Figures and bubbles are `at()` boxes over it, a layer up, so they
// cover the art without the art knowing they are there. A pacer is drawn on
// lit cells only: the cat in a dark corner is not seen. The buffer is the
// view's size, made again when that changes: the terminal resized, or a piece
// mounted past the edge of a stage smaller than the view.
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
import { BloomEffect, FrameBufferRenderable, RGBA } from '@opentui/core'
import { INK as INK_HEX, viewFor } from './stage.js'
import { at } from './cell.js'

/** The terminal's rows under the art are the screen's, so the foot (9.9, `Profile.mesa`) is drawn there. */
export const FOOT = true

/** The layer of what is overhead: over a figure, under a bubble. */
const OVERHEAD = 11.5

/** The layer of a light's bloom: over the art, under every figure. */
const BLOOM_LAYER = 1

/**
 * What a `lamplight` scene's light sources are blurred through. Bloom reads
 * brightness and not emission, so run over the art it haloes a white cowhide
 * and a parchment poster as much as a flame: it is run over a buffer holding
 * the sources alone.
 */
const BLOOM = { threshold: 0.5, strength: 0.35, radius: 3 }

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
  let fbs = null   // [the art, what is overhead, and with a bloom the light sources]
  let size = { w: 0, h: 0 }
  const bloom = stage.layers.includes('lamplight') ? new BloomEffect(BLOOM.threshold, BLOOM.strength, BLOOM.radius) : null
  const release = () => { for (const f of fbs ?? []) { box.remove(f); f.destroy() } }
  const buffers = (w, h) => {
    if (fbs && size.w === w && size.h === h) return fbs
    release()
    size = { w, h }
    fbs = Array.from({ length: bloom ? 3 : 2 }, () => new FrameBufferRenderable(box.ctx, { width: w, height: h, respectAlpha: true, flexShrink: 0 }))
    at(0, 0, OVERHEAD)(fbs[1])
    if (bloom) at(0, 0, BLOOM_LAYER)(fbs[2])
    fbs.forEach((f) => box.add(f))
    return fbs
  }

  const draw = (ms) => {
    const v  = stage.view
    if (!v.w || !v.h) return
    const [art, top, glow] = buffers(v.w, v.h)
    const buf = art.frameBuffer
    buf.clear(CLEAR)
    top.frameBuffer.clear(CLEAR)
    const grid = stage.grid(v, ms)
    for (let row = 0; row < v.h; row++) {
      for (let col = 0; col < v.w; col++) {
        const { ch, fg, bg, overhead } = grid[row][col]
        if (ch === ' ' && !bg) continue
        ;(overhead ? top.frameBuffer : buf).setCell(col, row, ch, rgba(fg) ?? INK, rgba(bg) ?? CLEAR)
      }
    }
    for (const p of stage.pacers) {
      const at = stage.pacerNow(p, ms)
      if (!at) continue
      const { x, y, text } = at
      const row = y - v.y
      if (row < 0 || row >= v.h) continue
      ;[...text].forEach((ch, i) => {
        const col = x + i - v.x
        if (ch !== ' ' && col >= 0 && col < v.w && stage.light(x + i, y) === 'lit') buf.setCell(col, row, ch, rgba(stage.tint(p.fg, x + i, y, ms)) ?? INK, CLEAR)
      })
    }
    if (bloom) {
      const g = glow.frameBuffer
      g.clear(CLEAR)
      const sources = []
      for (const { x, y } of stage.lights) {
        const col = x - v.x, row = y - v.y
        if (col < 0 || col >= v.w || row < 0 || row >= v.h) continue
        const { ch, fg, bg } = stage.look(x, y, ms)
        g.setCell(col, row, ch, rgba(fg) ?? INK, rgba(bg) ?? CLEAR)
        sources.push([col, row])
      }
      bloom.apply(g)
      // The halo only: a source drawn again over its own art would be blown out.
      for (const [col, row] of sources) g.setCell(col, row, ' ', CLEAR, CLEAR)
      glow.requestRender()
    }
    art.requestRender()
    top.requestRender()
  }
  // A paint task on the stage's clock (`stage.js`): run on any change and on
  // the look's next tick, at the frame's own ms. Keyed by the box, since the
  // editor paints one stage into more than one.
  const stop = stage.task(box, draw, { phase: 'paint' })

  // The renderer's size rather than `process.stdout`'s: `--frame` and a test
  // render headless with no tty, at the 100×30 that is VIEW.
  const ctx = box.ctx
  const fit = () => stage.fit(viewFor(ctx.width, ctx.height))
  fit()
  ctx.on('resize', fit)

  return () => {
    ctx.off('resize', fit)
    stop()
    release()
  }
}

/**
 * A grid of cells `{ ch, fg, bg }` — the map's (`map.js`) — drawn into the box
 * it is attached to, over what the box shows. A factory the template calls
 * with the grid, so a new grid runs it again, as `at()` is.
 */
export const paintGrid = (grid) => (box) => {
  const h = grid.length, w = Math.max(1, ...grid.map((r) => r.length))
  const fb = new FrameBufferRenderable(box.ctx, { width: w, height: h, respectAlpha: true, flexShrink: 0 })
  at(0, 0, 14)(fb)
  box.add(fb)
  const buf = fb.frameBuffer
  buf.clear(CLEAR)
  grid.forEach((row, y) => row.forEach((c, x) => { if (c.ch !== ' ' || c.bg) buf.setCell(x, y, c.ch, rgba(c.fg) ?? INK, rgba(c.bg) ?? CLEAR) }))
  fb.requestRender()
  return () => { box.remove(fb); fb.destroy() }
}
