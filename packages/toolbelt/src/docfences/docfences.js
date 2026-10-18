/*
 * docfences.js — the fenced blocks of a markdown page, as the doc-example
 * contract reads them (`FJS-D860`, `FJS-D909`).
 *
 * Three readers each carried their own fence regex (litestone's runner, `fli
 * check`'s `doc-examples-run`, the doc audit) and disagreed on indentation, on
 * `~~~`, and on what closes a block, so a page could be graded runnable by one
 * and skipped by another. The words on the info string are the contract:
 *
 *   fragment   a sliver — runs nothing
 *   throws     passes only when it throws
 *   failing    pinned to a filed defect; passes while it fails
 *
 * What a package runs a block UNDER (its prelude) is the package's own.
 */

/** The fence tags a doc-example runner executes; `prisma` is absent on purpose, a block in that language is unverified. */
export const RUNNABLE_LANGS = new Set(['lite', 'js', 'javascript', 'mjs', 'ts', 'typescript', 'mesa'])

const OPEN = /^[ \t]*(`{3,}|~{3,})([\w+-]*)[ \t]*(.*)$/

/**
 * Every fenced block of `text`, in order. `line` is the 1-based line of the
 * opener, `index` the offset of that line. `schema` is the body of the nearest
 * preceding block of `schemaLang` that is not a `fragment`, or null — the
 * schema an example below it runs against. A fence closes on a line holding
 * only the same character at least as many times, so a four-backtick block can
 * show a three-backtick one.
 */
export function docFences(text, { schemaLang = 'lite' } = {}) {
  const lines = text.split('\n')
  const out = []
  let schema = null
  let index = 0
  for (let i = 0; i < lines.length; i++) {
    const at = index
    index += lines[i].length + 1
    const m = lines[i].match(OPEN)
    if (!m) continue
    const [, fence, rawLang, info] = m
    const close = new RegExp(`^[ \\t]*${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`)
    let j = i + 1
    while (j < lines.length && !close.test(lines[j])) j++
    const lang = rawLang.toLowerCase()
    const words = new Set(info.split(/\s+/).filter(Boolean))
    const body = lines.slice(i + 1, j).join('\n')
    out.push({ lang, info, words, line: i + 1, index: at, body, schema })
    if (lang === schemaLang && !words.has('fragment')) schema = body
    for (let k = i + 1; k <= j && k < lines.length; k++) index += lines[k].length + 1
    i = j
  }
  return out
}

/** A block a doc-example runner executes: a runnable tag not marked `fragment`. */
export const isRunnable = fence => RUNNABLE_LANGS.has(fence.lang) && !fence.words.has('fragment')
