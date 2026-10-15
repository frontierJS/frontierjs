// src/pieces/halves.js — half-cell art (`IDEAS/haven.md` 14.5): a piece drawn
// at twice the rows, two pixels to a cell. A terminal app cannot set its font
// size, so the detail comes from the glyph: `▀` with the top pixel its `fg`
// and the bottom its `bg`, `▄` where only the bottom is drawn, `█` where both
// are one color. Art only — text and figures stay one cell.
//
// Every pair of colors a piece uses is a palette entry of its own, carried on
// the piece, so its paint letters are minted here from the private-use plane:
// a scene's palette names ASCII letters and can never shadow one.
import { piece } from './index.js'

let next = 0xe000

/**
 * @param {string} name
 * @param {string} pixels  rows of color letters, an even number of them; `.` or a space is no pixel
 * @param {Record<string, string | { fg: string | string[], ms?: number, wave?: boolean, flicker?: boolean, light?: number }>} colors
 * @param {Parameters<typeof piece>[3]} [options]
 */
export function halves(name, pixels, colors, options = {}) {
  const rows = pixels.replace(/^\n/, '').replace(/\n$/, '').split('\n')
  if (rows.length % 2) throw new Error(`${name} has ${rows.length} pixel rows, and half-cell art pairs them`)
  const width = Math.max(...rows.map((r) => r.length))
  const entry = (p) => typeof colors[p] === 'string' ? { fg: colors[p] } : colors[p]
  const keys = new Map()
  const palette = {}
  const keyFor = (top, bottom) => {
    const id = `${top}${bottom}`
    if (!keys.has(id)) {
      const key = String.fromCodePoint(next++)
      const t = top && entry(top), b = bottom && entry(bottom)
      const lead = t ?? b
      palette[key] = {
        ...lead,
        fg: (t ?? b).fg,
        ...(t && b && top !== bottom && { bg: b.fg }),
        light: Math.max(t?.light ?? 0, b?.light ?? 0) || undefined,
      }
      keys.set(id, key)
    }
    return keys.get(id)
  }
  const pixel = (row, x) => {
    const p = row?.[x]
    if (!p || p === '.' || p === ' ') return null
    if (!colors[p]) throw new Error(`${name} draws ${p}, and its colors name no ${p}`)
    return p
  }
  const art = [], paint = []
  for (let y = 0; y < rows.length; y += 2) {
    let a = '', k = ''
    for (let x = 0; x < width; x++) {
      const top = pixel(rows[y], x), bottom = pixel(rows[y + 1], x)
      if (!top && !bottom) { a += ' '; k += ' '; continue }
      a += !bottom ? '▀' : !top ? '▄' : top === bottom ? '█' : '▀'
      k += keyFor(top, bottom)
    }
    art.push(a); paint.push(k)
  }
  return piece(name, art.join('\n'), paint.join('\n'), { ...options, palette: { ...palette, ...options.palette } })
}
