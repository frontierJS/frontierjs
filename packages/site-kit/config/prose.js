// config/prose.js — what a Markdown author's plain text turns into, as a rehype
// pass over every page and block.
//
//   WELCOME               a paragraph in capitals is a Kicker: <p class="kicker">
//   ==quiet==             <mark>quiet</mark>
//   (512) 555-0134        a tel: link; an email address, a mailto: link
//
// Each is the element or css term an author would have written by hand
// (FJS-D614), so a site styles `.kicker` and `mark` the way any app does.
// Code, preformatted text and an existing link are left as written.

import { telHref } from '../src/tel.js'

const VERBATIM = new Set(['code', 'pre', 'script', 'style', 'textarea'])
const INLINE = new Set(['strong', 'b', 'em', 'i'])
const ACCENT = /==([^=]+)==/g
const PHONE = /(?<![\w+.-])(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})(?![\w-])/g
const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w-])/g

const isElement = (node) => node?.type === 'element'

const addClass = (node, name) => {
  node.properties ??= {}
  const cls = node.properties.className
  const list = Array.isArray(cls) ? cls : cls ? String(cls).split(/\s+/) : []
  if (!list.includes(name)) node.properties.className = [...list, name]
}

// The text of the paragraph and of its strong/em, nothing else: a line that is
// only a link or a component is not a kicker, and neither is one of digits.
function isKicker(node) {
  if (node.tagName !== 'p') return false
  const text = (node.children ?? [])
    .map((c) => (c.type === 'text' ? c.value : isElement(c) && INLINE.has(c.tagName) ? c.children.map((g) => g.value ?? '').join('') : ''))
    .join('')
    .trim()
  return isKickerText(text)
}

/** Whether a paragraph of these words is a Kicker. */
export const isKickerText = (text) => /\p{Lu}/u.test(text) && text === text.toUpperCase()

/** Whether the dialect turns any of these plain words into an element: a mark, an email or a phone link. */
export const marksText = (text) => [ACCENT, EMAIL, PHONE].some((re) => text.search(re) !== -1)

/** Split a text node on `re`, each match becoming `make(match)`; null when nothing matched. */
function splitText(node, re, make) {
  const out = []
  let last = 0
  for (const m of node.value.matchAll(re)) {
    if (m.index > last) out.push({ type: 'text', value: node.value.slice(last, m.index) })
    out.push(make(m))
    last = m.index + m[0].length
  }
  if (!out.length) return null
  if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) })
  return out
}

const accent = (m) => ({ type: 'element', tagName: 'mark', properties: {}, children: [{ type: 'text', value: m[1] }] })

const telOf = (m) => ({ type: 'element', tagName: 'a', properties: { href: telHref(`${m[1]}${m[2]}${m[3]}`) }, children: [{ type: 'text', value: m[0] }] })

const mailto = (m) => ({ type: 'element', tagName: 'a', properties: { href: `mailto:${m[0]}` }, children: [{ type: 'text', value: m[0] }] })

function rewriteText(parent, inLink) {
  parent.children = parent.children.flatMap((node) => {
    if (node.type !== 'text') return [node]
    let parts = [node]
    const pass = (re, make) => {
      parts = parts.flatMap((p) => (p.type === 'text' ? splitText(p, re, make) ?? [p] : [p]))
    }
    pass(ACCENT, accent)
    if (!inLink) {
      pass(EMAIL, mailto)
      pass(PHONE, telOf)
    }
    return parts
  })
}

function walk(node, inLink) {
  if (isElement(node) && VERBATIM.has(node.tagName)) return
  const linked = inLink || (isElement(node) && node.tagName === 'a')
  if (node.children?.some((c) => c.type === 'text')) rewriteText(node, linked)
  for (const child of node.children ?? []) {
    if (isElement(child) && isKicker(child)) addClass(child, 'kicker')
    walk(child, linked)
  }
}

export default function rehypeProse() {
  return (tree) => walk(tree, false)
}
