/**
 * The server target's runtime (`target: 'server'`, `FJS-D1634`): what a
 * module the host emitter's string mode writes imports as `$$host`. Two
 * functions and nothing else — the one escaper and the one attribute
 * serializer — because every byte the string mode cannot write at compile
 * time passes through one of them, and a second owner of either is a second
 * place to get XSS wrong. The emitter imports both and calls them at compile
 * time on static text, so a static and a live value escape identically.
 *
 * The output is graded against happy-dom's serializer, since parity with the
 * DOM path is what makes the mode admissible: text escapes `&`, `<`, `>` and
 * the non-breaking space, an attribute value escapes `&` and `"`.
 */

const TEXT = /[&<>\u00A0]/g
const TEXT_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\u00A0': '&nbsp;' }
const ATTR = /[&"]/g
const ATTR_MAP = { '&': '&amp;', '"': '&quot;' }

/** Text content: `null` and `undefined` are empty, as `set_text` reads them. */
export function esc(value) {
  const s = value == null ? '' : '' + value
  return TEXT.test(s) ? s.replace(TEXT, (c) => TEXT_MAP[c]) : s
}

// What `set_attribute` writes as the DOM path writes it, read from the same
// sets so the two paths serialize alike. A boolean attribute is written as
// `name=""` for any truthy value; a property (`checked`, `selected`, a
// `<select>`'s `value`) is set on the node and never serialized, while an
// `<input>`'s live `value` is reflected to its attribute. A URL naming a
// scheme that executes is refused, as on the DOM path.
const BOOL = new Set([
  'disabled', 'readonly', 'required', 'checked', 'multiple', 'open',
  'hidden', 'selected', 'autofocus', 'autoplay', 'controls', 'default',
  'defer', 'formnovalidate', 'ismap', 'loop', 'muted', 'nomodule',
  'novalidate', 'playsinline', 'reversed', 'scoped',
])
const PROPS = new Set([
  'checked', 'selected', 'indeterminate', 'scrollTop', 'scrollLeft', 'selectedIndex',
  'defaultValue', 'defaultChecked', 'volume', 'currentTime', 'playbackRate', 'muted',
  'loop', 'autoplay', 'controls', 'open',
])
const ARIA_FALSE = new Set(['aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed'])
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'formAction'])
const refusedURL = (name, value) => URL_ATTRS.has(name) && value != null &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what this pattern removes or refuses
  /^(?:javascript:|data:text\/html)/.test(('' + value).replace(/[\u0000-\u0020]/g, '').toLowerCase())

// happy-dom re-serializes a style the moment a `style:` directive touches it.
const cssText = (s) => ('' + s).split(';').map((d) => d.trim()).filter(Boolean)
  .map((d) => { const i = d.indexOf(':'); return i < 0 ? d + ';' : `${d.slice(0, i).trim()}: ${d.slice(i + 1).trim()};` }).join(' ')

// Where the DOM path writes a live `value` as a property: `<textarea>` and
// `<select>` always, `<input>` unless its type is one of VALUE_ATTR_INPUTS.
const VALUE_PROP = new Set(['textarea', 'select', 'output'])
const VALUE_ATTR_INPUTS = new Set(['checkbox', 'radio', 'hidden', 'submit', 'button', 'reset', 'image'])

/**
 * The attributes of one element as ` name="value"…`, in the DOM path's order:
 * the template's static attributes with `class` last, then each live one as
 * its effect first ran. `entries` is `[name, value, live?]` in that order: a
 * plain attribute, `class:name` and `style:prop` directives, or `['...', obj]`
 * for a spread, which overrides an earlier name in place and appends a new
 * one. `scope` is the component's CSS class, written after the authored
 * classes and before any live one. `null`, `undefined` and `false` write
 * nothing; `true` writes the empty string on a boolean attribute and the word
 * on any other. `tag` decides whether a live `value` is a property.
 */
export function attrs(tag, entries, scope) {
  const out = new Map()
  // `class` and `style` are serialized where the FIRST write put them, and a
  // `class:` or a live `class=` adds its tokens in the order they ran.
  const classes = []
  const styles = []
  // happy-dom drops a `style=""` the moment a `style:` runs after the write
  // that put it there, and re-serializes a non-empty one the moment a
  // `style:` runs anywhere, even one that writes nothing.
  let styleDirective = false, styleTouchedAfter = false, liveValue = false
  const reserve = (name) => { if (!out.has(name)) out.set(name, '') }
  const set = (name, value, live, spread) => {
    // The scope class is in the DOM path's template, so with no authored
    // class it sits after the statics and ahead of the first live write.
    if (live && scope) reserve('class')
    if (name === '...') { for (const k in value) set(k, value[k], true, true); return }
    // A handler a spread carries is listened to on the DOM path, never written.
    if (live && typeof value === 'function') return
    if (name.startsWith('class:')) { reserve('class'); if (value) classes.push(name.slice(6)); return }
    // A directive that writes nothing creates no attribute, so a later
    // write decides where `style` sits.
    if (name.startsWith('style:')) { styleDirective = styleTouchedAfter = true; if (value != null && value !== false) { reserve('style'); styles.push(`${name.slice(6)}: ${value};`) }; return }
    // A live `style` replaces the whole attribute, every directive before it
    // included; from a spread it is the CSSOM's text.
    if (name === 'style') {
      styleTouchedAfter = false
      if (live) styles.length = 0
      if (spread) { out.set('style', cssText(value ?? '')); return }
    }
    if (live && name === 'class') { reserve('class'); if (value != null && value !== false && value !== '') classes.push('' + value); return }
    if (live && refusedURL(name, value)) { out.delete(name); return }
    if (live && (PROPS.has(name) || (name === 'value' && VALUE_PROP.has(tag)))) return
    if (live && name === 'value' && tag === 'input') liveValue = true
    if (value === false && ARIA_FALSE.has(name)) { out.set(name, 'false'); return }
    if (value == null || value === false) { out.delete(name); return }
    if (value === true) { out.set(name, BOOL.has(name) || !live ? '' : 'true'); return }
    out.set(name, '' + value)
  }
  for (const [name, value, live] of entries) set(name, value, live)
  // A text-like input's value is a property on the DOM path, so no attribute;
  // a checkbox, radio, hidden or button input keeps it as HTML does.
  if (liveValue && !VALUE_ATTR_INPUTS.has(('' + (out.get('type') ?? 'text')).toLowerCase())) out.delete('value')
  // A class anything touched — a live write, a toggle, the scope — is the
  // DOM path's token list, each token once; a lone static class is the
  // template's text.
  const touched = scope || classes.length || out.has('class') && entries.some(([n, , l]) => (l && n === 'class') || n.startsWith('class:'))
  const cls = [out.get('class'), scope, ...classes].filter((c) => c)
  const tokens = touched ? [...new Set(cls.flatMap((c) => ('' + c).split(/\s+/)).filter(Boolean))] : cls
  if (tokens.length) out.set('class', tokens.join(' '))
  else out.delete('class')
  if (styles.length) out.set('style', [out.get('style') && cssText(out.get('style')), ...styles].filter(Boolean).join(' '))
  else if (out.get('style') === '') { if (styleTouchedAfter) out.delete('style') }
  else if (styleDirective && out.has('style')) out.set('style', cssText(out.get('style')))
  let s = ''
  for (const [name, value] of out) {
    s += ` ${name}="${ATTR.test(value) ? value.replace(ATTR, (c) => ATTR_MAP[c]) : value}"`
  }
  return s
}
