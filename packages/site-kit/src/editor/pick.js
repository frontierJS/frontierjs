// src/editor/pick.js — what a click on a draft's preview edits.
//
// A preview build stamps each element with the file line that wrote it
// (`FJS-D838`): prose names its own `.md` line, and a value a block reads off a
// loaded file names that file's line (`FJS-D1231`). A `.md` the draft lists is
// a field at that line. Anything else a block drew (a prop passed whole, a
// value it worked out) names the block's template, a developer's file, so the
// owner is offered the files it could have come from, this page's own first.

export const LOC = 'data-fjs-loc'

/** `content/routes/x.md:12:3` as `{ path, line, column }`, or null. */
export function parseLoc(loc) {
  const m = /^(.+):(\d+):(\d+)$/.exec(loc ?? '')
  return m ? { path: m[1], line: Number(m[2]), column: Number(m[3]) } : null
}

/** The editor's own elements. They are stamped too, and a click there is the editor's. */
export const OURS = '[data-fjs-editor-ui]'

/**
 * The nearest stamped element at or above `node`, or null inside the editor.
 * @param {Node | null} node
 */
export function stampedFrom(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement
  return !el || el.closest(OURS) ? null : el.closest(`[${LOC}]`)
}

/**
 * A stamp as what the editor opens: `{ path, line }` for a file the draft lets
 * the owner edit, or `{ template, files }` naming the file that drew it and the
 * editable files, this page's route first.
 * @param {string} loc
 * @param {string[]} files — the draft's editable files (`drafts.files`)
 * @param {string} pathname — this page's address
 */
export function fieldFor(loc, files, pathname) {
  const at = parseLoc(loc)
  if (!at) return null
  if (files.includes(at.path)) return { path: at.path, line: at.line }
  const own = routeFile(pathname, files)
  return { template: at.path, files: own ? [own, ...files.filter((f) => f !== own)] : files }
}

/**
 * The route file a page's address was built from, or null. Sierra writes
 * `x.md` and `x/index.md` both to `/x/`.
 */
export function routeFile(pathname, files) {
  const p = decodeURIComponent(pathname).replace(/(\/index)?\.html$/, '').replace(/^\/+|\/+$/g, '')
  const tries = p ? [`content/routes/${p}.md`, `content/routes/${p}/index.md`] : ['content/routes/index.md']
  return tries.find((t) => files.includes(t)) ?? null
}

/**
 * The block a body line opens, as character offsets into the body: from that
 * line to the next blank one. Null when the line is outside the body, as a
 * front-matter line is.
 * @param {string} body
 * @param {number} index — 0-based line of the body
 */
export function blockAt(body, index) {
  const lines = body.split('\n')
  if (index < 0 || index >= lines.length) return null
  let start = 0
  for (let i = 0; i < index; i++) start += lines[i].length + 1
  let end = start
  for (let i = index; i < lines.length && (i === index || lines[i].trim()); i++) end += lines[i].length + 1
  return { start, end: Math.min(end - 1, body.length) }
}
