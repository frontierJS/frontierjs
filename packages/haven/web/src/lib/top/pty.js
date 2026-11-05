// src/lib/top/pty.js — `fli top` in the bottom pane (`TopPane.mesa`): the
// process runs in a Bun pty sized to the pane, `@xterm/headless` keeps the
// screen it draws, and every cell of that screen is set in the engine's frame
// buffer, as `paint.js` draws a stage — mesa's terminal tags lower to text and
// boxes only, so a color per cell has no other way onto the screen.
//
// Terminal only. `fli` is the one on PATH, as a person at this terminal would
// run it.
import { FrameBufferRenderable, RGBA, TextAttributes } from '@opentui/core'
import xterm from '@xterm/headless'
import { paneBoxOf } from '@frontierjs/mesa/runtime/terminal'
import { bottomToggle } from '#top'
import { INK as INK_HEX } from '../scene/stage.js'

const { Terminal } = xterm

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
const INK   = RGBA.fromHex(INK_HEX)
// Inverse text over the terminal's own ground: a cleared fg would draw nothing.
const PAPER = RGBA.fromValues(0, 0, 0, 1)

// `fli top` refuses to draw in a screen smaller than this.
const MIN = { cols: 30, rows: 10 }

// A burst of output is drawn once, at a frame's pace.
const FRAME_MS = 16

// xterm's 256: the sixteen, a 6×6×6 cube, then 24 grays.
const SIXTEEN = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff']
const LEVEL = [0, 95, 135, 175, 215, 255]
const PALETTE = Array.from({ length: 256 }, (_, i) => {
  if (i < 16) return RGBA.fromHex(SIXTEEN[i])
  if (i < 232) {
    const n = i - 16
    return RGBA.fromInts(LEVEL[Math.floor(n / 36)], LEVEL[Math.floor(n / 6) % 6], LEVEL[n % 6], 255)
  }
  const g = 8 + (i - 232) * 10
  return RGBA.fromInts(g, g, g, 255)
})

const truecolor = new Map()
const rgbOf = (n) => {
  let c = truecolor.get(n)
  if (!c) truecolor.set(n, c = RGBA.fromInts((n >> 16) & 255, (n >> 8) & 255, n & 255, 255))
  return c
}
const fgOf = (c) => c.isFgRGB() ? rgbOf(c.getFgColor()) : c.isFgPalette() ? PALETTE[c.getFgColor()] ?? INK : null
const bgOf = (c) => c.isBgRGB() ? rgbOf(c.getBgColor()) : c.isBgPalette() ? PALETTE[c.getBgColor()] ?? CLEAR : null

/** Every cell of `term`'s screen, set in `buf`. */
function drawScreen(buf, term) {
  buf.clear(CLEAR)
  const screen = term.buffer.active
  const cell = screen.getNullCell()
  for (let row = 0; row < term.rows; row++) {
    const line = screen.getLine(screen.viewportY + row)
    if (!line) continue
    for (let col = 0; col < term.cols; col++) {
      if (!line.getCell(col, cell)) continue
      // The right half of a wide character, drawn by its left.
      if (cell.getWidth() === 0) continue
      let fg = fgOf(cell) ?? INK
      let bg = bgOf(cell) ?? CLEAR
      if (cell.isInverse()) [fg, bg] = [bgOf(cell) ?? PAPER, fgOf(cell) ?? INK]
      buf.setCell(col, row, cell.getChars() || ' ', fg, bg, cell.isBold() ? TextAttributes.BOLD : 0)
    }
  }
}

/**
 * The pane's three handles: `attach` puts the frame buffer in the box,
 * `start` runs `fli top` when none is running, and `key` hands a key's bytes
 * to it. The process ending — its own `q`, a crash — hides the pane, and the
 * box going away kills it.
 */
export function topScreen() {
  let box = null      // the attached box the buffer is drawn in
  let pane = null     // the shell's bottom pane, whose size the process takes
  let fb = null
  let proc = null
  let term = null
  let queued = false

  // The pane's top rule takes one of its rows.
  const size = () => ({
    cols: Math.max(MIN.cols, pane?.width || box.ctx.width),
    rows: Math.max(MIN.rows, (pane?.height || 0) - 1),
  })

  const buffer = (cols, rows) => {
    if (fb && fb.width === cols && fb.height === rows) return fb
    release()
    fb = new FrameBufferRenderable(box.ctx, { width: cols, height: rows, respectAlpha: true, flexShrink: 0 })
    box.add(fb)
    return fb
  }
  const release = () => {
    if (!fb) return
    box?.remove(fb)
    fb.destroy()
    fb = null
  }

  const paint = () => {
    queued = false
    if (!term || !box || box.isDestroyed) return
    const f = buffer(term.cols, term.rows)
    drawScreen(f.frameBuffer, term)
    f.requestRender()
  }
  const soon = () => {
    if (queued) return
    queued = true
    setTimeout(paint, FRAME_MS)
  }

  const stop = () => {
    const p = proc
    proc = null
    if (p && p.exitCode === null) p.kill()
    p?.terminal?.close()
    term?.dispose()
    term = null
  }

  const start = () => {
    if (proc || !box) return
    const { cols, rows } = size()
    const t = term = new Terminal({ cols, rows, allowProposedApi: true })
    t.onWriteParsed(soon)
    const p = proc = Bun.spawn(['fli', 'top'], {
      env: { ...process.env, TERM: 'xterm-256color' },
      terminal: { cols, rows, data(_pty, bytes) { t.write(bytes) } },
    })
    p.exited.then(() => {
      if (proc !== p) return
      stop()
      bottomToggle()?.(false)
    })
  }

  // A key the terminal sent as bytes goes to the process as those bytes; the
  // shell took its own (Ctrl+O) before the pane hears any.
  const key = (e) => {
    if (!proc || !e.sequence) return
    e.preventDefault()
    proc.terminal.write(e.sequence)
  }

  const attach = (node) => {
    box = node
    pane = paneBoxOf(node.ctx, 'bottom')
    const fit = () => {
      if (!proc) return
      const { cols, rows } = size()
      if (cols === term.cols && rows === term.rows) return
      proc.terminal.resize(cols, rows)
      term.resize(cols, rows)
      soon()
    }
    pane?.on('resize', fit)
    // The shell focuses the pane as it first shows, and an attachment runs
    // after that focus, when \`start\` had no box to draw in.
    if (node.focused) start()
    return () => {
      pane?.off('resize', fit)
      stop()
      release()
      box = pane = null
    }
  }

  return { attach, start, key }
}
