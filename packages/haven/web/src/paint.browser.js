// src/paint.browser.js — draw a stage in its palette, in a browser, and keep
// it moving. `#paint` resolves here under the `browser` condition and to
// `paint.js` in the terminal; both draw `stage.look()` and `pacerAt()`, so
// the two targets cannot disagree about which glyph and color a cell has at
// a tick.
//
// The art is a `<pre>` of spans, one span per run of cells sharing a color,
// inside the box this is attached to. The box is laid out in cells — `1ch`
// by `1lh` in a monospace font — so `at()` (`cell.browser.js`) places a
// figure in the same units and a figure's cell is the stage's cell. The box
// is the stage's size at every window size: a bigger window is a bigger
// font, never more cells, or a browser would see a world a terminal cannot.
//
// The clock is the wall's, as in the terminal, so a terminal and a tab in one
// room draw the cat on the same cell.
import { pacerAt } from './stage.js'

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
  const width  = stage.width
  const height = stage.height

  const b = box.style
  b.position   = 'relative'
  b.fontFamily = 'ui-monospace, Menlo, Consolas, monospace'
  // About 58em is 96 columns of a monospace font, so this fills the width
  // the window has, inside the page's gutter.
  b.fontSize   = 'clamp(10px, calc((100vw - 2rem) / 58), 22px)'
  b.lineHeight = '1.2'
  b.width      = `${width}ch`
  b.height     = `${height}lh`
  b.whiteSpace = 'pre'

  const pre = document.createElement('pre')
  pre.setAttribute('aria-hidden', 'true')
  pre.dataset.art = stage.slug
  Object.assign(pre.style, { margin: '0', padding: '0', font: 'inherit', lineHeight: 'inherit', background: 'none', border: '0' })
  box.prepend(pre)

  const draw = () => {
    const ms = Date.now()
    const grid = []
    for (let y = 0; y < height; y++) {
      const row = []
      for (let x = 0; x < width; x++) row.push(stage.look(x, y, ms))
      grid.push(row)
    }
    // A pacer's spaces are not drawn, as in the terminal: the art shows through.
    for (const p of stage.pacers) {
      const { x, y, text } = pacerAt(p, ms)
      ;[...text].forEach((ch, i) => {
        const cell = grid[y]?.[x + i]
        if (cell && ch !== ' ') grid[y][x + i] = { ch, fg: p.fg, bg: cell.bg }
      })
    }
    const frag = document.createDocumentFragment()
    grid.forEach((row, y) => {
      for (const r of runs(row)) {
        if (!r.fg && !r.bg) { frag.append(r.text); continue }
        const span = document.createElement('span')
        if (r.fg) span.style.color = r.fg
        if (r.bg) span.style.background = r.bg
        span.textContent = r.text
        frag.append(span)
      }
      if (y < height - 1) frag.append('\n')
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
