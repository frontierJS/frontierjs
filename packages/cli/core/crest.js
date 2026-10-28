// ─── crest.js ────────────────────────────────────────────────────────────────
// A member's crest: the eight words (`safetyWords` in tell.js) drawn as a
// picture, from the same 64 bits of the chain root, so the same words are
// always the same crest. A mirrored 5×5 grid as GitHub's identicons draw one,
// in two heraldic tinctures that keep the rule of tincture — a metal on a
// color or a color on a metal, never two of one kind — so the charge always
// stands off its field.
//
// It is for recognizing a member at a glance and proves nothing: the words are
// the check (IDEAS/frontier-network.md 2.10). Read by the cli and, for 2.7's
// badge, by the Worker, so nothing here may be node-only. A bit moved here
// redraws every member's crest on every newer fli.
// ─────────────────────────────────────────────────────────────────────────────

/** Gold and silver. */
export const METALS = [
  { name: 'or',      hex: '#e8b730' },
  { name: 'argent',  hex: '#c9ced6' },
]

/** No sable: black reads as an empty square on a dark terminal. */
export const COLORS = [
  { name: 'gules',   hex: '#c8262d' },
  { name: 'azure',   hex: '#2a5db0' },
  { name: 'vert',    hex: '#2f8f46' },
  { name: 'purpure', hex: '#7b3fa0' },
]

/**
 * The crest for a chain root (hex): `rows` is five rows of five cells, true
 * where the charge is, mirrored about the middle column.
 */
export const crest = (root) => {
  const hex = String(root).slice(0, 16)
  if (!/^[0-9a-f]{16}$/i.test(hex)) throw new Error('A crest is drawn from a chain root of at least 16 hex digits.')
  const bytes = hex.match(/../g).map(b => parseInt(b, 16))
  // Bytes 0-1: fifteen cells, three columns of five, read left to right.
  const bits = (bytes[0] << 8) | bytes[1]
  const rows = Array.from({ length: 5 }, (_, r) => {
    const half = [0, 1, 2].map(c => Boolean(bits & (1 << (r * 3 + c))))
    return [...half, half[1], half[0]]
  })
  const metal  = METALS[bytes[2] % METALS.length]
  const color  = COLORS[bytes[3] % COLORS.length]
  const metalField = Boolean(bytes[4] & 1)
  return {
    rows,
    field:  metalField ? metal : color,
    charge: metalField ? color : metal,
  }
}

// ─── the badge ───────────────────────────────────────────────────────────────

const CELL  = 4
const PAD   = 2
const SIDE  = 5 * CELL
const TALL  = SIDE + 2 * PAD
/** A monospace advance at 12px; `textLength` holds the label to it whatever font the reader has. */
const ADVANCE = 7.2
const FRAME = '#24292f'

const escapeXml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/**
 * The crest for `root` as an SVG badge, `label` (`#0042 sam`) written on its
 * frame — 2.7's `GET /badge/<number>.svg`. The label is not in the crest, so
 * the picture stays the words' picture; with none, the frame holds the crest
 * alone, as a file's page shows its sender.
 */
export const crestSvg = (root, label) => {
  const { rows, field, charge } = crest(root)
  const cells = rows.flatMap((row, r) => row.map((on, c) => on ? `M${PAD + c * CELL} ${PAD + r * CELL}h${CELL}v${CELL}h-${CELL}z` : '')).join('')
  const text  = label ? escapeXml(label) : ''
  const width = text ? Math.round(String(label).length * ADVANCE) : 0
  const wide  = text ? TALL + 6 + width + 8 : TALL
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${wide}" height="${TALL}" viewBox="0 0 ${wide} ${TALL}" role="img" aria-label="${text || 'crest'}">`,
    ...text ? [`<title>${text}</title>`] : [],
    `<rect width="${wide}" height="${TALL}" rx="3" fill="${FRAME}"/>`,
    `<g shape-rendering="crispEdges"><rect x="${PAD}" y="${PAD}" width="${SIDE}" height="${SIDE}" fill="${field.hex}"/><path d="${cells}" fill="${charge.hex}"/></g>`,
    ...text ? [`<text x="${TALL + 6}" y="${TALL / 2 + 4}" fill="#fff" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="12" textLength="${width}" lengthAdjust="spacingAndGlyphs">${text}</text>`] : [],
    '</svg>',
  ].join('')
}
