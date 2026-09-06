/**
 * html.js — the one escape for everything the toolbar renders.
 *
 * Every value in this toolbar arrives over the devtools WebSocket, which is
 * unauthenticated, and the toolbar sits at `z-index: 2147483647` on the page
 * where the app's own tokens live. Dev-only is why it is not worse; it is not
 * why it is safe.
 *
 * A per-interpolation `esc()` helper is what was here — defined four times, once
 * per tab file, and applied to six of the eight places that needed it, which is
 * how `transport` reached a `class=""` attribute whole. A helper that has to be
 * remembered at each site is one that will be forgotten, so the tag escapes by
 * default and there is nothing left to remember.
 *
 * Composition is the one thing a default-escaping tag has to answer: a fragment
 * built by another `html` call carries a marker and passes through raw, so
 * markup can be assembled in pieces without an opt-out a plain string could
 * reach by accident.
 */

class Html {
  constructor(value) { this.value = value }
  toString() { return this.value }
}

function escapeValue(v) {
  if (v instanceof Html) return v.value
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Tagged template. Every `${}` is escaped unless it is itself an `html` result. */
export function html(strings, ...values) {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) out += escapeValue(values[i]) + strings[i + 1]
  return new Html(out)
}

/**
 * A class-name suffix taken from caller data, constrained to a stated set.
 *
 * Escaping alone would keep the markup intact and still let an arbitrary string
 * become a class name; a class is a selector other code matches on, so the value
 * is chosen from a list rather than sanitised toward one.
 */
export function classSuffix(value, allowed, fallback) {
  const v = String(value ?? '').toLowerCase()
  return allowed.includes(v) ? v : fallback
}

/** A number a caller supplied, for a position where only a number is legible. */
export function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
