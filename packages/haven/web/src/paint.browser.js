// src/paint.browser.js — draw a stage in its palette, in a browser, and keep
// it moving. `#paint` resolves here under the `browser` condition and to
// `paint.js` in the terminal; both draw `stage.grid()`, `stage.pacerNow()` and `stage.riders()`, so
// the two targets cannot disagree about which glyph and color a cell has at
// a tick.
//
// The art is a `<pre>` of spans, one span per run of cells sharing a color,
// inside the box this is attached to. The box is laid out in cells — `1ch`
// by `1lh` in a monospace font — so `at()` (`cell.browser.js`) places a
// figure in the same units and a figure's cell is the stage's cell less the
// view's corner. The box is `stage.view`'s size at every window size — the
// slice a terminal shows, panning as the figure walks (6.1): a bigger window
// is a bigger font, never more cells. A scene's `scale` (14.7) is the one way
// a browser shows more: the stage is fitted to VIEW over the scale and the
// font multiplied by it, so 0.5 draws twice the cells each way in the same
// box. The editor asks the stage for the whole of it instead.
//
// A cell of a piece that is `overhead` is drawn in a second `<pre>` above the
// figures, so a figure walks behind a canopy: z-index 12 is over a figure's
// (10, 11) and, being earlier in the box than a speech bubble's, under it.
//
// The clock is the wall's, as in the terminal, so a terminal and a tab in one
// room draw the cat on the same cell.
import { VIEW } from './stage.js'

/**
 * The rows under a browser's box are the page's, not the screen's: the stage's
 * `size` is VIEW over the scene's `scale`, so a scene shorter than that would
 * read as rows left for the foot (9.9) and draw it at the page's font, wider
 * than the window.
 */
export const FOOT = false

/** Runs of one color along a row, so a row is a handful of spans, not 96. */
function runs(cells) {
  const out = []
  for (const c of cells) {
    const last = out[out.length - 1]
    if (last && last.fg === c.fg && last.bg === c.bg) last.text += c.ch
    else out.push({ text: c.ch, fg: c.fg, bg: c.bg })
  }
  return out
}

const BLANK = { ch: ' ', fg: undefined, bg: undefined }

/** A grid of cells as a fragment: a handful of spans a row, a newline between rows. */
function fragment(grid) {
  const frag = document.createDocumentFragment()
  grid.forEach((row, i) => {
    for (const r of runs(row)) {
      if (!r.fg && !r.bg) { frag.append(r.text); continue }
      const span = document.createElement('span')
      if (r.fg) span.style.color = r.fg
      if (r.bg) span.style.background = r.bg
      span.textContent = r.text
      frag.append(span)
    }
    if (i < grid.length - 1) frag.append('\n')
  })
  return frag
}

export const paint = (stage, scale = 1) => (box) => {
  const b = box.style
  b.position   = 'relative'
  b.fontFamily = 'ui-monospace, Menlo, Consolas, monospace'
  // A monospace column is about 0.6em, so this fills the width the window
  // has with VIEW's columns, inside the page's gutter. Set once: the
  // editor sets its own size after mounting, and a redraw must not take it back.
  b.fontSize   = `calc(clamp(10px, calc((100vw - 2rem) / ${Math.round(VIEW.w * 0.6)}), 22px) * ${scale})`
  stage.fit({ w: Math.round(VIEW.w / scale), h: Math.round(VIEW.h / scale) })
  b.lineHeight = '1.2'
  b.whiteSpace = 'pre'
  let size = { w: 0, h: 0 }

  const pre = document.createElement('pre')
  pre.setAttribute('aria-hidden', 'true')
  pre.dataset.art = stage.slug
  const bare = { margin: '0', padding: '0', font: 'inherit', lineHeight: 'inherit', background: 'none', border: '0' }
  Object.assign(pre.style, bare)
  box.prepend(pre)
  const top = document.createElement('pre')
  top.setAttribute('aria-hidden', 'true')
  Object.assign(top.style, bare, { position: 'absolute', top: '0', left: '0', zIndex: '12', pointerEvents: 'none' })
  pre.after(top)

  const draw = (ms) => {
    const v  = stage.view
    if (size.w !== v.w || size.h !== v.h) {
      size = { w: v.w, h: v.h }
      b.width  = `${v.w}ch`
      b.height = `${v.h}lh`
    }
    const grid = stage.grid(v, ms), overhead = []
    for (const cells of grid) {
      const high = []
      for (let col = 0; col < cells.length; col++) {
        const look = cells[col]
        high.push(look.overhead ? look : BLANK)
        if (look.overhead) cells[col] = BLANK
      }
      overhead.push(high)
    }
    // A pacer's spaces are not drawn, as in the terminal, and neither is a
    // pacer on a cell the figure cannot see: the art shows through.
    for (const p of stage.pacers) {
      const at = stage.pacerNow(p, ms)
      if (!at) continue
      const { x, y, text } = at
      ;[...text].forEach((ch, i) => {
        const cell = grid[y - v.y]?.[x + i - v.x]
        if (cell && ch !== ' ' && stage.light(x + i, y) === 'lit') grid[y - v.y][x + i - v.x] = { ch, fg: stage.tint(p.fg, x + i, y, ms), bg: cell.bg }
      })
    }
    for (const { x, y, ch, fg } of stage.riders(ms)) {
      const cell = grid[y - v.y]?.[x - v.x]
      if (cell && stage.light(x, y) === 'lit') grid[y - v.y][x - v.x] = { ch, fg: stage.tint(fg, x, y, ms), bg: cell.bg }
    }
    pre.replaceChildren(fragment(grid))
    top.replaceChildren(fragment(overhead))
  }
  // A paint task on the stage's clock (`stage.js`): run on any change and on
  // the look's next tick, at the frame's own ms. Keyed by the box, since the
  // editor paints one stage into more than one.
  const stop = stage.task(box, draw, { phase: 'paint' })

  return () => {
    stop()
    pre.remove()
    top.remove()
  }
}

/**
 * A grid of cells `{ ch, fg, bg }` — the map's (`map.js`) — as a `<pre>` of
 * spans in the box it is attached to. A factory the template calls with the
 * grid, so a new grid runs it again, as `at()` is.
 */
export const paintGrid = (grid) => (box) => {
  const pre = document.createElement('pre')
  pre.setAttribute('aria-hidden', 'true')
  Object.assign(pre.style, { margin: '0', padding: '0', font: 'inherit', lineHeight: 'inherit', background: 'none', border: '0' })
  pre.replaceChildren(fragment(grid))
  box.prepend(pre)
  return () => pre.remove()
}
