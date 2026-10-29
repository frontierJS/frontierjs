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
  const toggles = []
  const styles = []
  let liveClass
  const set = (name, value, live) => {
    if (name === '...') { for (const k in value) set(k, value[k], true); return }
    if (name.startsWith('class:')) { if (value) toggles.push(name.slice(6)); return }
    if (name.startsWith('style:')) { if (value != null && value !== false) styles.push(`${name.slice(6)}: ${value};`); return }
    if (live && name === 'class') { liveClass = value; return }
    if (live && refusedURL(name, value)) { out.delete(name); return }
    if (live && (PROPS.has(name) || (name === 'value' && tag !== 'input'))) return
    if (value === false && ARIA_FALSE.has(name)) { out.set(name, 'false'); return }
    if (value == null || value === false) { out.delete(name); return }
    if (value === true) { out.set(name, BOOL.has(name) || !live ? '' : 'true'); return }
    out.set(name, '' + value)
  }
  for (const [name, value, live] of entries) set(name, value, live)
  const classes = [out.get('class'), scope, liveClass, ...toggles].filter((c) => c != null && c !== false && c !== '')
  if (classes.length) out.set('class', classes.join(' '))
  if (styles.length) {
    const base = out.get('style')
    out.set('style', [base && cssText(base), ...styles].filter(Boolean).join(' '))
  }
  let s = ''
  for (const [name, value] of out) {
    s += ` ${name}="${ATTR.test(value) ? value.replace(ATTR, (c) => ATTR_MAP[c]) : value}"`
  }
  return s
}
