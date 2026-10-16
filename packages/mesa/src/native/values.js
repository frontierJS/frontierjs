/**
 * The value language a phone cannot evaluate, computed at build time
 * (`IDEAS/mesa-ir.md` § 12, 4.3). Run by `lowerSheet` after the token graph is
 * literal (`tokens.js`), so a color function's arguments are literals by now.
 *
 * - **Colors.** The device paints nothing for any `oklch()`, literal or
 *   relative, and nothing for a `color-mix()` it cannot read (§ 11). Every
 *   `oklch()`, `oklab()`, `color()` and `color-mix()` whose arguments are
 *   literal is computed by CSS Color 4's formulas and written as
 *   `rgb()`/`rgba()`, which the device paints. A color outside sRGB is clipped per channel, as Chrome
 *   paints it. One that reads `currentColor` or an unknown name cannot be
 *   computed here, and comes back on `kept` by line.
 * - **Logical properties.** Each is written as its physical property for
 *   horizontal, left-to-right text, and so is `text-align: start | end`.
 *   Right-to-left is lost: the bundler's `:lang()` copies were the only RTL
 *   the kit had, and 4.1 drops them.
 * - **Display.** The device lays out `block` as a row and ignores
 *   `inline-flex`, which then stacks; an element with no `display` stacks as a
 *   block does, because the engine's default is `linear` (§ 12, 4.7). There is
 *   no inline flow on a device, so a value is lowered by its inner display
 *   alone: flow becomes `linear`, and `flex` and `grid` stay. A value with any
 *   other inner display (`-webkit-box`, `table`, `contents`) comes back on
 *   `kept`, since the device would ignore it and stack.
 *
 * A two-value logical shorthand whose value is one `var()` is written to both
 * sides, which is wrong when the token itself holds two values.
 */

const COLOR_FN = /(?<![\w-])(oklch|oklab|color-mix|color)\(/g

/** `{ rules, kept }`: the same rules with colors computed and logical properties physical; `kept` is `{ what, line }` per color left as written. */
export function lowerValues(rules) {
  const kept = []
  const out = rules.map((r) => {
    if (!r.decls) return r
    const decls = []
    for (const d of r.decls) {
      const keep = (what) => {
        if (!kept.some(k => k.what === what && k.line === r.line)) kept.push({ what, line: r.line })
      }
      let value = colors(d.value, keep)
      if (d.prop.toLowerCase() === 'display') value = display(value, keep)
      for (const [prop, v] of physical(d.prop, value)) decls.push({ ...d, prop, value: v })
    }
    return { ...r, decls }
  })
  return { rules: out, kept }
}

// ── Colors ─────────────────────────────────────────────────────────────

/** `v` with every computable color function replaced by `rgb()`/`rgba()`. */
export function colors(v, keep = () => {}) {
  if (!v.includes('(')) return v
  let out = '', at = 0
  for (const m of v.matchAll(COLOR_FN)) {
    if (m.index < at) continue
    const end = close(v, m.index + m[1].length)
    const text = v.slice(m.index, end + 1)
    const c = parseColor(text)
    out += v.slice(at, m.index) + (c ? serialize(c) : text)
    if (!c) keep(`the color ${text.length > 60 ? text.slice(0, 57) + '...' : text}`)
    at = end + 1
  }
  return out + v.slice(at)
}

/** `{ r, g, b, alpha }` in sRGB, unclipped, or null when `text` is not a color this pass can compute. */
export function parseColor(text) {
  const t = text.trim()
  const lower = t.toLowerCase()
  if (lower === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 }
  if (NAMED[lower]) return hex(NAMED[lower])
  if (t[0] === '#') return hex(t.slice(1))
  const m = t.match(/^([a-z-]+)\(/i)
  if (!m || close(t, m[1].length) !== t.length - 1) return null
  const name = m[1].toLowerCase()
  const inner = t.slice(m[1].length + 1, -1).trim()
  if (name === 'color-mix') return mix(inner)
  if (name === 'rgb' || name === 'rgba') return rgbFn(inner)
  if (name === 'oklch' || name === 'oklab') return okFn(name, inner)
  if (name === 'color') return colorFn(inner)
  return null
}

function hex(h) {
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return null
  const full = h.length <= 4 ? [...h].map(c => c + c).join('') : h
  const n = (i) => parseInt(full.slice(i, i + 2), 16) / 255
  return { r: n(0), g: n(2), b: n(4), alpha: full.length === 8 ? n(6) : 1 }
}

function rgbFn(inner) {
  const { channels, alpha } = args(inner)
  if (channels.length !== 3) return null
  const ch = channels.map(s => s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s) / 255)
  const a = alpha === undefined ? 1 : num(alpha, 1)
  if (ch.some(Number.isNaN) || Number.isNaN(a)) return null
  return { r: ch[0], g: ch[1], b: ch[2], alpha: a }
}

// The percentage reference of each channel (CSS Color 4 § 9.3, § 9.4).
const REF = { oklch: [1, 0.4, 1], oklab: [1, 0.4, 0.4] }

function okFn(name, inner) {
  let base = null
  if (/^from\s/i.test(inner)) {
    const rest = inner.slice(4).trim()
    const end = colorEnd(rest)
    base = parseColor(rest.slice(0, end))
    if (!base) return null
    inner = rest.slice(end).trim()
  }
  const { channels, alpha } = args(inner)
  if (channels.length !== 3) return null
  const env = {}
  if (base) {
    const lab = toOklab(base)
    // A gray's hue is missing, and a missing channel reads as 0 here.
    if (name === 'oklch') Object.assign(env, { l: lab.L, c: Math.hypot(lab.a, lab.b), h: hueOf(lab) || 0 })
    else Object.assign(env, { l: lab.L, a: lab.a, b: lab.b })
    env.alpha = base.alpha
  }
  const vals = channels.map((s, i) => expr(s, env, REF[name][i]))
  const a = alpha === undefined ? (base ? base.alpha : 1) : expr(alpha, env, 1)
  if (vals.some(x => x === null || Number.isNaN(x)) || a === null) return null
  const [L, x, y] = vals
  const lab = name === 'oklch' ? { L, a: x * Math.cos(y * Math.PI / 180), b: x * Math.sin(y * Math.PI / 180) } : { L, a: x, b: y }
  return { ...fromOklab(lab), alpha: clamp01(a) }
}

// `color()`'s spaces (CSS Color 4 § 10) as linear-light or gamma sRGB.
// The chip fill reads luminance off xyz-d65's y and branches on it.
const SPACES = {
  'srgb':        { keys: 'rgb', to: (c) => [c.r, c.g, c.b], from: ([r, g, b]) => ({ r, g, b }) },
  'srgb-linear': { keys: 'rgb', to: (c) => [lin(c.r), lin(c.g), lin(c.b)], from: (v) => { const [r, g, b] = v.map(gam); return { r, g, b } } },
  'xyz-d65':     { keys: 'xyz', to: (c) => mul(TO_XYZ, [lin(c.r), lin(c.g), lin(c.b)]), from: (v) => { const [r, g, b] = mul(FROM_XYZ, v).map(gam); return { r, g, b } } },
}
SPACES.xyz = SPACES['xyz-d65']
const TO_XYZ = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
]
const FROM_XYZ = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
]
const mul = (m, v) => m.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])

/** `color([from <color>] <space> c1 c2 c3 [/ alpha])`. */
function colorFn(inner) {
  let base = null
  if (/^from\s/i.test(inner)) {
    const rest = inner.slice(4).trim()
    const end = colorEnd(rest)
    base = parseColor(rest.slice(0, end))
    if (!base) return null
    inner = rest.slice(end).trim()
  }
  const sp = inner.match(/^([a-z\d-]+)\s+/i)
  const space = sp && SPACES[sp[1].toLowerCase()]
  if (!space) return null
  const { channels, alpha } = args(inner.slice(sp[0].length))
  if (channels.length !== 3) return null
  const env = {}
  if (base) {
    space.to(base).forEach((v, i) => { env[space.keys[i]] = v })
    env.alpha = base.alpha
  }
  const vals = channels.map(s => expr(s, env, 1))
  const a = alpha === undefined ? (base ? base.alpha : 1) : expr(alpha, env, 1)
  if (vals.some(x => x === null || Number.isNaN(x)) || a === null || Number.isNaN(a)) return null
  return { ...space.from(vals), alpha: clamp01(a) }
}

/** `color-mix(in <space>, c1 [p1], c2 [p2])` (CSS Color 5 § 2), premultiplied. */
function mix(inner) {
  const parts = list(inner)
  if (parts.length !== 3) return null
  const space = parts[0].match(/^in\s+(srgb|srgb-linear|oklab|oklch)(?:\s+(shorter|longer|increasing|decreasing)\s+hue)?$/i)
  if (!space) return null
  const items = parts.slice(1).map((p) => {
    const words = split(p)
    const pct = words.find(w => /^-?[\d.]+%$/.test(w))
    const color = parseColor(words.filter(w => w !== pct).join(' '))
    return color && { color, p: pct === undefined ? undefined : parseFloat(pct) / 100 }
  })
  if (items.some(x => !x)) return null
  let [p1, p2] = items.map(x => x.p)
  if (p1 === undefined && p2 === undefined) p1 = p2 = 0.5
  else if (p1 === undefined) p1 = 1 - p2
  else if (p2 === undefined) p2 = 1 - p1
  const sum = p1 + p2
  if (sum <= 0) return null
  const w = p2 / sum
  const sp = space[1].toLowerCase()
  const [A, B] = items.map(x => into(sp, x.color))
  const alpha = A.alpha * (1 - w) + B.alpha * w
  const lerp = (k) => alpha === 0 ? 0 : (A[k] * A.alpha * (1 - w) + B[k] * B.alpha * w) / alpha
  let c
  if (sp === 'oklch') {
    let [h1, h2] = [A.h, B.h]
    if (Number.isNaN(h1)) h1 = h2
    if (Number.isNaN(h2)) h2 = h1
    if (Number.isNaN(h1)) h1 = h2 = 0
    const d = ((h2 - h1) % 360 + 540) % 360 - 180
    c = { l: lerp('l'), c: lerp('c'), h: h1 + d * w }
  } else c = { x: lerp('x'), y: lerp('y'), z: lerp('z') }
  return { ...out(sp, c), alpha: alpha * Math.min(sum, 1) }
}

// A color in a mixing space, and back to sRGB.
function into(sp, c) {
  if (sp === 'srgb') return { x: c.r, y: c.g, z: c.b, alpha: c.alpha }
  if (sp === 'srgb-linear') return { x: lin(c.r), y: lin(c.g), z: lin(c.b), alpha: c.alpha }
  const lab = toOklab(c)
  if (sp === 'oklab') return { x: lab.L, y: lab.a, z: lab.b, alpha: c.alpha }
  return { l: lab.L, c: Math.hypot(lab.a, lab.b), h: hueOf(lab), alpha: c.alpha }
}
function out(sp, c) {
  if (sp === 'srgb') return { r: c.x, g: c.y, b: c.z }
  if (sp === 'srgb-linear') return { r: gam(c.x), g: gam(c.y), b: gam(c.z) }
  if (sp === 'oklab') return fromOklab({ L: c.x, a: c.y, b: c.z })
  return fromOklab({ L: c.l, a: c.c * Math.cos(c.h * Math.PI / 180), b: c.c * Math.sin(c.h * Math.PI / 180) })
}

// OKLab (Ottosson), through linear sRGB.
const lin = (v) => { const a = Math.abs(v); return Math.sign(v) * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4) }
const gam = (v) => { const a = Math.abs(v); return Math.sign(v) * (a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055) }
function toOklab({ r, g, b }) {
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  }
}
function fromOklab({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  return {
    r: gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: gam(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  }
}
// An achromatic color's hue is missing, so a mix takes the other's.
const hueOf = ({ a, b }) => Math.hypot(a, b) < 1e-6 ? NaN : (Math.atan2(b, a) * 180 / Math.PI + 360) % 360

function serialize({ r, g, b, alpha }) {
  const n = (v) => Math.round(clamp01(v) * 255)
  const a = Math.round(clamp01(alpha) * 1000) / 1000
  return a === 1 ? `rgb(${n(r)}, ${n(g)}, ${n(b)})` : `rgba(${n(r)}, ${n(g)}, ${n(b)}, ${a})`
}
const clamp01 = (v) => Math.min(1, Math.max(0, v))

/** A channel expression: a number, a percentage, a channel keyword, `none`, or `calc()`/`clamp()`/`min()`/`max()` over them. */
function expr(src, env, ref) {
  const toks = src.match(/(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?(?:%|deg)?|[a-z-]+\(|[a-z]+|[()+*/,-]/gi)
  if (!toks || toks.join('') !== src.replace(/\s+/g, '')) return null
  let i = 0
  const peek = () => toks[i]
  const atom = () => {
    const t = toks[i++]
    if (t === undefined) throw 0
    if (t === '-') return -atom()
    if (t === '(') { const v = sum(); if (toks[i++] !== ')') throw 0; return v }
    if (t.endsWith('(')) {
      const fn = t.slice(0, -1).toLowerCase()
      const xs = [sum()]
      while (peek() === ',') { i++; xs.push(sum()) }
      if (toks[i++] !== ')') throw 0
      if (fn === 'calc' && xs.length === 1) return xs[0]
      if (fn === 'min') return Math.min(...xs)
      if (fn === 'max') return Math.max(...xs)
      if (fn === 'clamp' && xs.length === 3) return Math.max(xs[0], Math.min(xs[1], xs[2]))
      throw 0
    }
    if (/^[a-z]+$/i.test(t)) {
      const k = t.toLowerCase()
      if (k === 'none') return 0
      if (k === 'infinity') return Infinity
      if (k in env) return env[k]
      throw 0
    }
    if (t.endsWith('%')) return parseFloat(t) / 100 * ref
    return parseFloat(t)
  }
  const product = () => {
    let v = atom()
    while (peek() === '*' || peek() === '/') v = toks[i++] === '*' ? v * atom() : v / atom()
    return v
  }
  const sum = () => {
    let v = product()
    while (peek() === '+' || peek() === '-') v = toks[i++] === '+' ? v + product() : v - product()
    return v
  }
  try {
    const v = sum()
    return i === toks.length ? v : null
  } catch { return null }
}

/** `channels / alpha` split at the top level, commas or spaces. */
function args(inner) {
  const slash = topIndex(inner, '/')
  const head = slash < 0 ? inner : inner.slice(0, slash)
  let channels = list(head)
  if (channels.length === 1) channels = split(head)
  let alpha = slash < 0 ? undefined : inner.slice(slash + 1).trim()
  if (slash < 0 && channels.length === 4) alpha = channels.pop()
  return { channels, alpha }
}

function num(s, ref) {
  return s.endsWith('%') ? parseFloat(s) / 100 * ref : parseFloat(s)
}

/** Where the origin color of a relative color ends in `s`. */
function colorEnd(s) {
  const m = s.match(/^[#\w-]+/)
  if (!m) return 0
  return s[m[0].length] === '(' ? close(s, m[0].length) + 1 : m[0].length
}

const NAMED = { white: 'fff', black: '000' }

// ── Display ────────────────────────────────────────────────────────────

const DEVICE_DISPLAY = new Set(['none', 'linear', 'flex', 'grid', 'relative'])
const OUTER = /^(block|inline|run-in|list-item)$/
const INNER = { flow: 'linear', 'flow-root': 'linear', flex: 'flex', grid: 'grid' }

/** `value` as the device's `display`: the outer display dropped, the inner one mapped (CSS Display 3 § 2). */
export function display(value, keep = () => {}) {
  const v = value.trim().toLowerCase()
  if (DEVICE_DISPLAY.has(v) || v.includes('(') || /^(inherit|initial|unset|revert|revert-layer)$/.test(v)) return value
  const words = v.split(/\s+/).flatMap(w => w.startsWith('inline-') ? ['inline', w.slice(7)] : [w])
  const inner = words.find(w => !OUTER.test(w)) ?? 'flow'
  if (INNER[inner]) return INNER[inner]
  keep(`the display ${value.trim()}`)
  return value
}

// ── Logical properties ─────────────────────────────────────────────────

const SIDE = { 'inline-start': 'left', 'inline-end': 'right', 'block-start': 'top', 'block-end': 'bottom' }
const SIZE = { 'inline-size': 'width', 'block-size': 'height' }
const CORNER = { start: { start: 'top-left', end: 'top-right' }, end: { start: 'bottom-left', end: 'bottom-right' } }
const BOX = /^(margin|padding|scroll-margin|scroll-padding|inset|border)-(inline|block)(?:-(start|end))?(-(?:width|style|color))?$/

/** `[prop, value]` pairs: a logical property as its physical ones, horizontal and left to right. */
export function physical(prop, value) {
  if (prop.startsWith('--')) return [[prop, value]]
  const p = prop.toLowerCase()
  const size = p.match(/^(min-|max-)?(inline-size|block-size)$/)
  if (size) return [[(size[1] ?? '') + SIZE[size[2]], value]]
  if (p === 'overflow-inline' || p === 'overflow-block') return [[p === 'overflow-inline' ? 'overflow-x' : 'overflow-y', value]]
  const corner = p.match(/^border-(start|end)-(start|end)-radius$/)
  if (corner) return [[`border-${CORNER[corner[1]][corner[2]]}-radius`, value]]
  if (p === 'text-align' && /^(start|end)$/i.test(value.trim())) return [[p, value.trim().toLowerCase() === 'start' ? 'left' : 'right']]
  const box = p.match(BOX)
  if (!box) return [[prop, value]]
  const [, kind, axis, end, suffix = ''] = box
  const name = (side) => kind === 'inset' ? side : kind === 'border' ? `border-${side}${suffix}` : `${kind}-${side}`
  if (end) return [[name(SIDE[`${axis}-${end}`]), value]]
  // `border-inline` itself is one value for both sides, not a pair.
  const pair = kind === 'border' && !suffix ? [value, value] : twoValues(value)
  return [[name(SIDE[`${axis}-start`]), pair[0]], [name(SIDE[`${axis}-end`]), pair[1]]]
}

function twoValues(value) {
  const important = value.match(/\s*!important\s*$/i)?.[0] ?? ''
  const words = split(important ? value.slice(0, -important.length) : value)
  return words.length === 2 ? [words[0] + important, words[1] + important] : [value, value]
}

// ── Scanning ───────────────────────────────────────────────────────────

function close(s, open) {
  for (let i = open, depth = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i
  }
  return s.length
}

function topIndex(s, ch) {
  for (let i = 0, depth = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    else if (s[i] === ch && depth === 0) return i
  }
  return -1
}

/** `s` split at top-level commas. */
function list(s) {
  const out = []
  let depth = 0, cur = ''
  for (const c of s) {
    if (c === '(') depth++
    else if (c === ')') depth--
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = '' }
    else cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** `s` split at top-level whitespace. */
function split(s) {
  const out = []
  let depth = 0, cur = ''
  for (const c of s.trim()) {
    if (c === '(') depth++
    else if (c === ')') depth--
    if (/\s/.test(c) && depth === 0) { if (cur) out.push(cur); cur = '' }
    else cur += c
  }
  if (cur) out.push(cur)
  return out
}
