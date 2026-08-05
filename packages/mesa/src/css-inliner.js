/**
 * @frontierjs/mesa — CSS inliner
 *
 * Inlines CSS rules into element `style` attributes.
 * Designed for email (where <style> blocks are stripped by clients)
 * and fragment rendering (where isolated HTML must carry its own styles).
 *
 * Pipeline:
 *   1. Parse CSS with css-tree
 *   2. Extract CSS custom property values from :root
 *   3. Collect inlineable rules (skip @media, @keyframes, @font-face etc.)
 *   4. Match each rule against the DOM with querySelectorAll
 *   5. Sort matched declarations by specificity — higher wins
 *   6. Resolve var() references against collected custom properties
 *   7. Write merged declarations as inline style="" attributes
 *   8. Optionally keep non-inlineable rules in a <style> block
 *      (for @media queries in clients that support them)
 *
 * Usage:
 *   import { inlineCSS } from './css-inliner.js'
 *   const html = await inlineCSS(htmlString, cssString, options)
 */

import * as csstree from 'css-tree'
import { Window }   from 'happy-dom'

// ── Specificity ────────────────────────────────────────────────────────────────
// Calculates [a, b, c] specificity from a selector string.
// a = id selectors, b = class/attr/pseudo-class, c = type/pseudo-element
// Returns a single integer for easy comparison: a*10000 + b*100 + c

function calcSpecificity(selector) {
  let a = 0, b = 0, c = 0
  // Strip pseudo-elements and :not() internals for counting
  const s = selector
    .replace(/::[a-z-]+/gi, '')           // pseudo-elements
    .replace(/:not\(([^)]*)\)/gi, '$1')   // :not() — count contents
  const idMatches    = s.match(/#[a-z_-][a-z0-9_-]*/gi)    ?? []
  const classMatches = s.match(/\.[a-z_-][a-z0-9_-]*/gi)   ?? []
  const attrMatches  = s.match(/\[[^\]]*\]/gi)              ?? []
  const pseudoMatches = s.match(/:[a-z-]+/gi)               ?? []
  const typeMatches  = s.match(/(?:^|[\s>~+])([a-z][a-z0-9-]*)/gi) ?? []
  a = idMatches.length
  b = classMatches.length + attrMatches.length + pseudoMatches.length
  c = typeMatches.length
  return a * 10000 + b * 100 + c
}

// ── CSS parsing ────────────────────────────────────────────────────────────────

/**
 * Parse a CSS string into two buckets:
 *   - inlineableRules: { selector, specificity, declarations[] }
 *     (top-level rules only — these get inlined as style="" attributes)
 *   - preservedCSS: string
 *     (at-rules that email clients with partial CSS support can use:
 *      @media, @supports — NOT @keyframes or @font-face which are useless inlined)
 */
function parseCSS(cssString) {
  if (!cssString?.trim()) return { inlineableRules: [], preservedCSS: '', customProps: {} }

  let ast
  try {
    ast = csstree.parse(cssString, { parseValue: true, parseCustomProperty: false })
  } catch {
    return { inlineableRules: [], preservedCSS: '', customProps: {} }
  }

  const inlineableRules = []
  const preservedBlocks = []   // @media/@supports blocks kept verbatim
  const customProps     = {}   // --name → value (from :root)

  csstree.walk(ast, {
    visit: 'Rule',
    enter(node) {
      const inAtRule = !!this.atrule

      if (inAtRule) {
        // Only @media and @supports are worth preserving for partial clients.
        // @keyframes, @font-face etc. are useless when there's no <style> block.
        // The parent @atrule block itself is collected separately below.
        return
      }

      const selector = csstree.generate(node.prelude).trim()
      const declarations = []

      csstree.walk(node.block, (d) => {
        if (d.type !== 'Declaration') return
        declarations.push({
          prop:      d.property.trim(),
          value:     csstree.generate(d.value).trim(),
          important: !!d.important,
        })
      })

      if (!declarations.length) return

      // :root — extract custom properties, don't inline as style=""
      if (selector === ':root') {
        for (const { prop, value } of declarations) {
          if (prop.startsWith('--')) customProps[prop] = value.trim()
        }
        return
      }

      // Comma-separated selectors — split and register each independently
      const selectors = splitSelectors(selector)
      for (const sel of selectors) {
        inlineableRules.push({
          selector:    sel.trim(),
          specificity: calcSpecificity(sel),
          declarations,
        })
      }
    },
  })

  // Collect @media and @supports blocks verbatim for preservation
  csstree.walk(ast, {
    visit: 'Atrule',
    enter(node) {
      const name = node.name?.toLowerCase()
      if (name === 'media' || name === 'supports') {
        preservedBlocks.push(csstree.generate(node))
      }
    },
  })

  return {
    inlineableRules,
    preservedCSS: preservedBlocks.join('\n'),
    customProps,
  }
}

// Splits "a, b, .c" respecting brackets: "a:not(.x, .y), b" → ["a:not(.x,.y)", "b"]
function splitSelectors(selector) {
  const parts = []
  let depth = 0, current = ''
  for (const ch of selector) {
    if (ch === '(' || ch === '[') { depth++; current += ch }
    else if (ch === ')' || ch === ']') { depth--; current += ch }
    else if (ch === ',' && depth === 0) { parts.push(current.trim()); current = '' }
    else { current += ch }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

// ── var() resolution ─────────────────────────────────────────────────────────

function resolveVars(value, customProps, _depth = 0) {
  if (_depth > 10 || !value.includes('var(')) return value
  return value.replace(/var\(\s*(--[^,)]+?)(?:\s*,\s*([^)]*))?\s*\)/g, (_, name, fallback) => {
    const resolved = customProps[name.trim()]
    if (resolved !== undefined) return resolveVars(resolved, customProps, _depth + 1)
    if (fallback !== undefined) return resolveVars(fallback.trim(), customProps, _depth + 1)
    return ''
  })
}

// ── Style attribute merging ───────────────────────────────────────────────────

// Parse an existing inline style string into a property map
// preserving order and existing specificity-equivalent priority.
function parseInlineStyle(styleAttr) {
  const map = new Map()
  if (!styleAttr) return map
  for (const decl of styleAttr.split(';')) {
    const colon = decl.indexOf(':')
    if (colon === -1) continue
    const prop  = decl.slice(0, colon).trim().toLowerCase()
    const value = decl.slice(colon + 1).trim()
    if (prop) map.set(prop, { value, important: false, specificity: 99999 })
  }
  return map
}

function serializeInlineStyle(map) {
  return [...map.entries()]
    .map(([prop, { value }]) => `${prop}:${value}`)
    .join(';')
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Inline CSS into an HTML string.
 *
 * @param {string} html            — HTML string to process
 * @param {string} [extraCSS='']  — additional CSS to inline (e.g. from UnoCSS)
 * @param {object} [options={}]
 * @param {boolean} [options.preserveMediaQueries=true]
 *   Keep @media/@supports in a <style> block in <head> for clients that support it.
 * @param {boolean} [options.removeStyleTags=true]
 *   Strip <style> blocks from the output after inlining.
 * @param {boolean} [options.inlineStyleTags=true]
 *   Process <style> blocks found inside the HTML string.
 * @param {Record<string,string>} [options.customProps={}]
 *   Additional CSS custom properties to seed (merged with :root values).
 *
 * @returns {string} HTML with inlined styles
 */
export function inlineCSS(html, extraCSS = '', options = {}) {
  const {
    preserveMediaQueries = true,
    removeStyleTags       = true,
    inlineStyleTags       = true,
    customProps: seedProps = {},
  } = options

  // ── 1. Extract <style> blocks from the HTML ──────────────────────────────
  const styleTagCSS = []
  if (inlineStyleTags) {
    html = html.replace(/<style(?:[^>]*)>([\s\S]*?)<\/style>/gi, (_, content) => {
      styleTagCSS.push(content)
      return ''   // remove the tag — we'll re-add preserved @media below
    })
  }

  const allCSS = [...styleTagCSS, extraCSS].join('\n')

  // ── 2. Parse all CSS ─────────────────────────────────────────────────────
  const { inlineableRules, preservedCSS, customProps } = parseCSS(allCSS)
  const mergedCustomProps = { ...customProps, ...seedProps }

  if (!inlineableRules.length && !preservedCSS) return html

  // ── 3. Build a DOM from the HTML string ──────────────────────────────────
  const win = new Window({ url: 'http://localhost' })
  const doc = win.document
  doc.body.innerHTML = html

  // ── 4. For each rule, match elements and stage declarations ─────────────
  //
  // Per-element staging map:
  //   element → Map<property, { value, specificity, important }>
  const staged = new Map()

  for (const rule of inlineableRules) {
    let elements
    try {
      elements = doc.querySelectorAll(rule.selector)
    } catch {
      // Malformed or unsupported selector (e.g. :has() in older clients) — skip
      continue
    }
    if (!elements.length) continue

    for (const el of elements) {
      if (!staged.has(el)) staged.set(el, new Map())
      const elMap = staged.get(el)

      for (const { prop, value, important } of rule.declarations) {
        const existing = elMap.get(prop)
        // Higher specificity wins; !important always wins
        if (!existing
          || important && !existing.important
          || rule.specificity >= existing.specificity && (!existing.important || important)
        ) {
          elMap.set(prop, { value, specificity: rule.specificity, important })
        }
      }
    }
  }

  // ── 5. Apply staged declarations to elements ─────────────────────────────
  for (const [el, ruleMap] of staged) {
    // Merge with any existing inline style (inline always wins — treat as max specificity)
    const existing = parseInlineStyle(el.getAttribute('style') ?? '')
    const merged   = new Map(ruleMap)

    for (const [prop, entry] of existing) {
      merged.set(prop, entry)  // inline style overrides everything
    }

    // Resolve var() references in all values
    const resolved = new Map()
    for (const [prop, entry] of merged) {
      resolved.set(prop, {
        ...entry,
        value: resolveVars(entry.value, mergedCustomProps),
      })
    }

    el.setAttribute('style', serializeInlineStyle(resolved))
  }

  // ── 6. Serialize back to HTML ─────────────────────────────────────────────
  let result = doc.body.innerHTML

  // ── 7. Prepend preserved @media/@supports if requested ───────────────────
  if (preserveMediaQueries && preservedCSS.trim()) {
    result = `<style>\n${preservedCSS}\n</style>\n` + result
  }

  return result
}

/**
 * Extract all <style> block contents from an HTML string.
 * Useful when you want the CSS separately before inlining.
 */
export function extractStyles(html) {
  const blocks = []
  html.replace(/<style(?:[^>]*)>([\s\S]*?)<\/style>/gi, (_, content) => {
    blocks.push(content)
  })
  return blocks.join('\n')
}

/**
 * Resolve all CSS custom properties in a string.
 * Public utility — useful when you need to pre-process values
 * before passing to another renderer.
 */
export function resolveCSSVars(value, customProperties) {
  return resolveVars(value, customProperties)
}
