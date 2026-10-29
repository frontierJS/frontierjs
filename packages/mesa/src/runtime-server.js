/**
 * The server target's runtime (`target: 'server'`, `FJS-D1634`): what a
 * module the host emitter's string mode writes imports as `$$host`. The one
 * escaper, the one attribute serializer and the one island marker, and
 * nothing else — because every byte the string mode cannot write at compile
 * time passes through one of them, and a second owner of any is a second
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

// ── Islands — the marker a client loader reads ────────────────────────────────
//
// The payload lives here and not in runtime.js because both paths write it:
// the DOM path's `island()` wraps a comment node around it and the string
// mode pushes it as text, and a loader parses one shape. Why the marker is a
// pair of comments and not an element, and what `mount` does with it, is
// runtime.js § Islands.
export const ISLAND_OPEN  = 'mesa-island '
export const ISLAND_CLOSE = '/mesa-island'

export function islandPayload(props, meta) {
  const payload = {
    component: meta?.component ?? null,
    directive: meta?.directive ?? 'load',
  }
  if (meta?.media) payload.media = meta.media
  if (props && typeof props === 'object' && Object.keys(props).length) payload.props = props

  const dropped = []
  const retyped = []
  // Holder object -> the path that reached it, so a warning can name
  // `nested.inner` rather than `inner`: the walk is depth-first over the whole
  // payload and a bare key from it is indistinguishable from a top-level prop
  // (an array index arrives as `0`).
  const paths = new WeakMap()
  let json
  try {
    // A `function`, not an arrow, and that is the whole mechanism: JSON.stringify
    // calls a replacer with `this` bound to the HOLDER, so `this[key]` is the
    // value before `toJSON` ran. `value` is what will be written. The two
    // disagreeing is the class of bug JSON reports nothing about — a Date
    // prerenders as a Date and mounts as a string, a Map and a Set arrive as
    // `{}` — and the loader cannot recover it, because by then a Date IS a
    // string and a Map IS `{}`.
    json = JSON.stringify(payload, function (key, value) {
      if (typeof value === 'function' || typeof value === 'symbol') { dropped.push(key); return undefined }
      const raw = this?.[key]
      const at = key === '' ? '' : Array.isArray(this) ? `${paths.get(this) ?? ''}[${key}]`
        : paths.get(this) ? `${paths.get(this)}.${key}` : key
      if (value && typeof value === 'object') paths.set(value, at)
      // Map and Set are their own case: they carry no `toJSON`, so the replacer
      // is handed the collection itself and the retype test below cannot see
      // them — `raw === value` right up to the point JSON writes `{}`, because
      // neither has an enumerable own property to write.
      if (raw instanceof Map || raw instanceof Set) retyped.push(`${at} (${raw.constructor.name} -> {})`)
      else if (raw && typeof raw === 'object' && raw !== value) retyped.push(`${at} (${raw.constructor?.name ?? 'object'} -> ${typeof value})`)
      return value
    })
  } catch (e) {
    // Circular reference, BigInt, or a throwing toJSON. The island is still
    // worth marking — a loader can mount it with its own defaults — so degrade
    // to identity only rather than losing the marker altogether.
    console.warn(
      `[Mesa island] <${payload.component}> props could not be serialized (${e.message}). ` +
      `The marker is emitted without props; a client loader will mount this island with none.`
    )
    delete payload.props
    json = JSON.stringify(payload)
  }
  if (dropped.length) {
    console.warn(
      `[Mesa island] <${payload.component}> — ${dropped.join(', ')} dropped from the island marker. ` +
      `Functions and symbols do not survive JSON, so a client loader remounts this island without them. ` +
      `Pass serializable props to an island, or mount it from the client instead.`
    )
  }
  if (retyped.length) {
    console.warn(
      `[Mesa island] <${payload.component}> — ${retyped.join(', ')} changed type in the island marker. ` +
      `The server render holds the original value and the client mounts the JSON one, so this island's ` +
      `text changes when it wakes up — which reads as the component being wrong. ` +
      `Convert at the call site (a Date to \`.toISOString()\`, a Map or Set to an array or object), ` +
      `or mount this island from the client.`
    )
  }
  // Escape every `-` and `>` out of the payload.
  //
  // Only `-->` (and `--!>`) actually terminates a comment per the HTML spec, so
  // escaping `--` is enough for a conforming parser, and both parsers this
  // marker crosses are conforming today — happy-dom ended a comment at the
  // FIRST `>` in 14.12.3, which truncated a marker carrying one and made
  // `JSON.parse` throw on the fragment, and 20 does not. The `>` escape stays
  // anyway: the payload is written once for two parsers, only one of which this
  // package pins, and six bytes per occurrence is cheaper than finding out
  // again from a broken island.
  //
  // Both substitutions are inside JSON strings by construction — a number
  // cannot contain `-` except a leading minus or an exponent, neither of which
  // can produce `--`, and `>` occurs nowhere else in JSON — so `-` and
  // `>` parse back to exactly the original characters.
  return json.replace(/--/g, '\\u002d\\u002d').replace(/>/g, '\\u003e')
}


/**
 * The string mode's `client:*` call: the markers around the child's pushes.
 * A module compiled for the server never runs in a browser, so there is no
 * client branch here, where the DOM path's `island()` has one.
 */
export function island(out, Comp, props, meta) {
  out.push(`<!--${ISLAND_OPEN}${islandPayload(props, meta)}-->`)
  const r = Comp(out, props)
  out.push(`<!--${ISLAND_CLOSE}-->`)
  return r
}

// ── What the emitter asks at run time ─────────────────────────────────────────

/** HTML's void elements: no close tag, and nothing a child could be. */
export const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

/*
 * Tag names `<mesa:element this={tag}>` may not take, on either path. Each of
 * these ACTS on insertion rather than rendering: a `<script>` built with
 * createElement is not parser-inserted, so appending the authored children and
 * inserting it EXECUTES them -- with a `{code}` interpolation inside, the pair
 * is eval with two data inputs, and it survives SSR into whatever public file
 * `target: 'static'` writes. `<style>` runs the children as CSS, `<base>` and
 * `<meta http-equiv>` redirect the whole page, and `<link>`, `<iframe>`,
 * `<object>` and `<embed>` fetch and run something the copied attributes name.
 */
const DYNAMIC_TAG_REFUSED = new Set(['script', 'style', 'base', 'link', 'meta', 'iframe', 'object', 'embed'])

/**
 * The tag a dynamic element is built from: the DOM path hands it to
 * `createElement`, the string mode writes it. Lowercased, as an HTML document
 * serializes any element it creates.
 */
export function dynamicTag(tag) {
  if (typeof tag === 'string' && DYNAMIC_TAG_REFUSED.has(tag.toLowerCase())) {
    throw new Error(
      `[Mesa] <mesa:element this={…}> — <${tag.toLowerCase()}> refused. A dynamic tag is ` +
      `markup, not a script host: this element acts when it is inserted, and the tag came ` +
      `from an expression. Write the element literally where it is the author's own.`
    )
  }
  if (typeof tag !== 'string' || !tag) {
    throw new Error(
      `[Mesa] <mesa:element this={…}> — expected a tag name, got ${
        typeof tag === 'string' ? "''" : String(tag)
      }. A dynamic element always has a tag; render nothing with {#if} instead.`
    )
  }
  return tag.toLowerCase()
}

/**
 * `<mesa:head>`'s buffer: the DOM path appends to `document.head`, which no
 * serializer reads, so the string mode keeps the head beside the body on
 * the one array a render owns and `wrapPage` splices it (`renderToHTML`
 * with `full`). Nested heads share the buffer.
 */
export function head(out) {
  return (out.head ??= [])
}

/**
 * The comment data Mesa owns: the root marker and every `$`-prefixed anchor
 * (`ANCHOR_DATA`). The static renderer strips these and nothing else, so an
 * `<!--[if mso]>` conditional and a comment an author wrote through `{@html}`
 * survive (`FJS-906`). One test, read by `render.js` for the DOM path and by
 * `html()` for the string one.
 */
export function isAnchorComment(data) {
  return data === 'mesa-root' || data.startsWith('$')
}

/**
 * `{@html expr}`: the DOM path parses the string through a `<template>`
 * (`setInnerHTML`) and the page is serialized from the parsed nodes, so a
 * malformed string comes out repaired and a `$`-anchor in it stripped.
 * Pushed verbatim the two paths would disagree on exactly those strings, so
 * the string mode parses it the same way and writes the parse — through the
 * document `initRenderer` installs, since the mode owns no window
 * (`IDEAS/server-render-without-dom.md` Q2 B, Q1 A).
 */
export function html(value) {
  if (value == null || value === '') return ''
  const doc = globalThis.document
  if (!doc) {
    throw new Error(
      '[Mesa] {@html} in string mode parses its markup through the document initRenderer() ' +
      'installs, and none is installed. Call initRenderer() before rendering, as renderToHTML does.'
    )
  }
  const tpl = doc.createElement('template')
  tpl.innerHTML = '' + value
  const box = doc.createElement('div')
  box.appendChild(tpl.content)
  dropAnchors(box)
  return box.innerHTML
}
// A hand walk, as `render.js` walks: happy-dom's TreeWalker changed what
// `SHOW_COMMENT` matches between the versions this package has pinned.
function dropAnchors(node) {
  for (let n = node.firstChild, next; n; n = next) {
    next = n.nextSibling
    if (n.nodeType === 8) { if (isAnchorComment(n.data)) n.remove() }
    else if (n.nodeType === 1) dropAnchors(n)
  }
}
