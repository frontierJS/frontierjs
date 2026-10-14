// src/paint.browser.js — draw a stage in its palette, in a browser, and keep
// it moving. `#paint` resolves here under the `browser` condition and to
// `paint.js` in the terminal; both draw `stage.look()` and `pacerAt()`, so
// the two targets cannot disagree about which glyph and color a cell has at
// a tick.
//
// The art is a `<pre>` of spans, one span per run of cells sharing a color,
// inside the box this is attached to. The box is laid out in cells — `1ch`
// by `1lh` in a monospace font — so `at()` (`cell.browser.js`) places a
// figure in the same units and a figure's cell is the stage's cell less the
// view's corner. The box is `stage.view`'s size at every window size — the
// slice a terminal shows, panning as the figure walks (6.1): a bigger window
// is a bigger font, never more cells, or a browser would see a world a
// terminal cannot. The editor asks the stage for the whole of it instead.
//
// The clock is the wall's, as in the terminal, so a terminal and a tab in one
// room draw the cat on the same cell.
import { pacerAt, VIEW } from './stage.js'

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

export const paint = (stage) => (box) => {
  const b = box.style
  b.position   = 'relative'
  b.fontFamily = 'ui-monospace, Menlo, Consolas, monospace'
  // A monospace column is about 0.6em, so this fills the width the window
  // has with the view's columns, inside the page's gutter. Set once: the
  // editor sets its own size after mounting, and a redraw must not take it back.
  b.fontSize   = `clamp(10px, calc((100vw - 2rem) / ${Math.round(VIEW.w * 0.6)}), 22px)`
  b.lineHeight = '1.2'
  b.whiteSpace = 'pre'
  let size = { w: 0, h: 0 }

  const pre = document.createElement('pre')
  pre.setAttribute('aria-hidden', 'true')
  pre.dataset.art = stage.slug
  Object.assign(pre.style, { margin: '0', padding: '0', font: 'inherit', lineHeight: 'inherit', background: 'none', border: '0' })
  box.prepend(pre)

  const draw = () => {
    const ms = Date.now()
    const v  = stage.view
    if (size.w !== v.w || size.h !== v.h) {
      size = { w: v.w, h: v.h }
      b.width  = `${v.w}ch`
      b.height = `${v.h}lh`
    }
    const grid = []
    for (let row = 0; row < v.h; row++) {
      const cells = []
      for (let col = 0; col < v.w; col++) cells.push(stage.look(v.x + col, v.y + row, ms))
      grid.push(cells)
    }
    // A pacer's spaces are not drawn, as in the terminal, and neither is a
    // pacer on a cell the figure cannot see: the art shows through.
    for (const p of stage.pacers) {
      const { x, y, text } = pacerAt(p, ms)
      ;[...text].forEach((ch, i) => {
        const cell = grid[y - v.y]?.[x + i - v.x]
        if (cell && ch !== ' ' && stage.light(x + i, y) === 'lit') grid[y - v.y][x + i - v.x] = { ch, fg: p.fg, bg: cell.bg }
      })
    }
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
      if (i < v.h - 1) frag.append('\n')
    })
    pre.replaceChildren(frag)
  }
  draw()

  const tick = stage.tickOf()
  const timer = tick ? setInterval(draw, tick) : null
  const unsubscribe = stage.subscribe(draw)

  return () => {
    unsubscribe()
    if (timer) clearInterval(timer)
    pre.remove()
  }
}
