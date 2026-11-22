/*
 * grammars.js — a line-at-a-time tokenizer and the grammars it reads.
 *
 * For an editor or a viewer that paints a window of a long file and must know,
 * at any line, whether it starts inside a block comment. `tokenizeLine` carries
 * a state from line to line, and `glow` paints through it.
 * A grammar is a plain object, and a region that hands its inside to another
 * language holds that grammar object, so nothing is looked up by name and an
 * app that wants a language this kit lacks writes the object and passes it.
 *
 * The states `initialState` and `tokenizeLine` answer are opaque tokens, equal
 * with `===` (see tokenize.js).
 */

import { css } from './css.js'
import { html } from './html.js'
import { js, ts } from './js.js'
import { json } from './json.js'
import { lite } from './lite.js'
import { markdown } from './markdown.js'
import { mesa } from './mesa.js'
import { yaml } from './yaml.js'

/**
 * @typedef {import('./tokenize.js').Grammar} Grammar
 * @typedef {import('./tokenize.js').Rule} Rule
 * @typedef {import('./tokenize.js').State} State
 */

export { ELEMENT, STRUCTURE, escapeLine, initialState, lineHTML, stateGrammar, stateStack, tokenizeLine } from './tokenize.js'
export { css, html, js, json, lite, markdown, mesa, ts, yaml }

/**
 * The grammar of text with no rules: every run is untyped.
 * @type {Grammar}
 */
export const plain = { name: 'plain', rules: [] }

const BY_EXTENSION = {
  js, mjs: js, cjs: js, jsx: js,
  ts, mts: ts, cts: ts, tsx: ts,
  json, jsonc: json, 'code-snippets': json,
  css,
  html, htm: html,
  md: markdown, markdown,
  lite,
  mesa,
  yaml, yml: yaml,
}

/**
 * The grammar a file's extension names, `plain` for one this kit has none for.
 * @param {string} path a path or URL
 * @returns {Grammar}
 */
export function grammarFor(path) {
  const name = path.split(/[?#]/)[0].split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return (dot > 0 && BY_EXTENSION[name.slice(dot + 1).toLowerCase()]) || plain
}
