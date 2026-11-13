// src/editor/live.js — a change shown on the page before it is saved (`FJS-D1399`).
//
// Words only: the preview carries no compiler, so an element changes only when
// the new words render as plain text the way the old ones did, and only an
// element that already shows the old words. Anything else waits for the preview
// to rebuild, and is counted as waiting so the editor can say so rather than
// show a guess.

import { isKickerText, marksText } from '../../config/prose.js'
import { LOC, OURS } from './pick.js'

// Markdown that makes something other than plain words: inline syntax anywhere
// (emphasis, code, a link, raw HTML, a Mesa expression, an entity, an
// autolink), or a block's opening marker at the start of a line.
const INLINE = /[*_`[\]<{}\\~]|&#?\w+;|https?:\/\/|www\./
const OPENS  = /^(?: {4}|\t|\s*(?:[#=|>]|[-+*](?:\s|$)|\d+[.)](?:\s|$)))/m

/** Text as a page shows it: whitespace collapsed. */
export const words = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** Whether prose `next` renders as plain words in the element `old` rendered as. */
export const plainSwap = (old, next) =>
  !INLINE.test(next) && !OPENS.test(next) && !marksText(next) && isKickerText(words(old)) === isKickerText(words(next))

const quoted = (v) => v.replace(/["\\]/g, '\\$&')

// The leaves a change is shown in: stamped by `loc` exactly, or at `path:line`,
// and showing the old words now. The preview is the draft as of its last
// build, so a line a save has since moved still lands when one element in the
// file shows those words.
function leaves({ loc, path, line, old }) {
  const all = (sel) => [...document.querySelectorAll(sel)]
    .filter((el) => !el.children.length && !el.closest(OURS) && words(el.textContent) === old)
  if (loc) return all(`[${LOC}="${quoted(loc)}"]`)
  const at = all(`[${LOC}^="${quoted(`${path}:${line}:`)}"]`)
  if (at.length) return at
  const anywhere = all(`[${LOC}^="${quoted(`${path}:`)}"]`)
  return anywhere.length === 1 ? anywhere : []
}

/**
 * What the page shows of the changes being typed. `show` replaces whatever it
 * showed before; `keep` lets the shown words stay once they are saved;
 * `restore` puts the page back.
 */
export function liveWords() {
  const was = new Map()
  const restore = () => {
    for (const [el, text] of was) el.textContent = text
    was.clear()
  }
  return {
    /**
     * @param {{ loc?: string, path?: string, line?: number, old: string, next: string, plain?: boolean }[]} changes
     * @returns {number} how many wait for the rebuild
     */
    show(changes) {
      restore()
      let waiting = 0
      for (const c of changes) {
        const els = c.plain === false ? [] : leaves(c)
        if (!els.length) waiting++
        for (const el of els) { was.set(el, el.textContent); el.textContent = c.next }
      }
      return waiting
    },
    keep() { was.clear() },
    restore,
  }
}

// A front-matter line: the page shows its value, not the key.
const KEYED   = /^\s*[\w-]+:\s+(.*)$/
const unquote = (v) => /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v

function lineChange(path, was, now) {
  const a = KEYED.exec(was.text)
  const b = KEYED.exec(now)
  const [old, next] = a && b ? [unquote(a[1]), unquote(b[1])] : [was.text, now]
  return { path, line: was.line, old: words(old), next: words(next), plain: plainSwap(old, next) }
}

/**
 * The lines a file's diff changed, each placed at its line in the file the
 * preview was built from. A run of removed lines followed by as many added
 * ones pairs line for line; any other run (a line added or removed alone) is
 * one change the page cannot place.
 * @param {string} path
 * @param {string} hunks the file's unified diff from its first `@@`
 * @returns {{ changes: { path: string, line: number, old: string, next: string, plain: boolean }[], unplaced: number }}
 */
export function hunkChanges(path, hunks) {
  const changes = []
  let unplaced = 0
  let line = 0
  let dels = []
  let adds = []
  const flush = () => {
    if (dels.length && dels.length === adds.length) dels.forEach((d, i) => changes.push(lineChange(path, d, adds[i])))
    else if (dels.length || adds.length) unplaced++
    dels = []; adds = []
  }
  for (const l of String(hunks ?? '').split('\n')) {
    const at = /^@@ -(\d+)/.exec(l)
    if (at) { flush(); line = Number(at[1]); continue }
    if (!line || l.startsWith('\\')) continue
    if (l[0] === '-') { if (adds.length) flush(); dels.push({ line, text: l.slice(1) }); line++ }
    else if (l[0] === '+') adds.push(l.slice(1))
    else { flush(); line++ }
  }
  flush()
  return { changes, unplaced }
}

/** A body's blocks, the runs of non-blank lines, each with the 0-based line it opens on. */
export function blocks(body) {
  const out = []
  body.split('\n').forEach((text, index) => {
    if (!text.trim()) return
    const last = out.at(-1)
    if (last && last.end === index - 1) { last.text += '\n' + text; last.end = index }
    else out.push({ index, end: index, text })
  })
  return out
}

/**
 * The blocks that changed between two bodies. The blocks the two share at the
 * start and at the end are the same ones; between them, equal counts pair
 * block for block, and anything else (a block added, removed, split or joined)
 * is one change the page cannot place.
 * @returns {{ changes: { index: number, old: string, next: string }[], unplaced: number }}
 */
export function changedBlocks(before, after) {
  const a = blocks(before)
  const b = blocks(after)
  let head = 0
  while (head < a.length && head < b.length && a[head].text === b[head].text) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail].text === b[b.length - 1 - tail].text) tail++
  const was = a.slice(head, a.length - tail)
  const now = b.slice(head, b.length - tail)
  if (was.length !== now.length) return { changes: [], unplaced: 1 }
  return { changes: was.map((w, i) => ({ index: w.index, old: w.text, next: now[i].text })), unplaced: 0 }
}
