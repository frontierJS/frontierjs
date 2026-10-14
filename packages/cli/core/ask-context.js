// ─── ask-context.js — what a pick's source says that its HTML does not ──────
//
// The ask panel sends each pick's `data-fjs-loc` and the `data-fjs-loc`s under
// it. Read against the source, those say which `{#each}` draws the element,
// which loops sit inside it, which files wrote what is under it, and which
// resources those files read — what Claude otherwise opens three files to find.
//
// A pick on a layout's slot wrapper carries the LAYOUT's loc, and the page's
// own route is only reachable through the locs under it, so `files` is the
// line that points at the file the person was looking at.
//
// Everything here is a text scan over source the dev server already serves.
// A file that cannot be read contributes nothing, never an error: this is
// context for a prompt, and a missing line costs less than a refused ask.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { appSchemaModels } from './app-schema.js'

const LOC_PARTS  = /^(.+\.(mesa|md)):(\d+):(\d+)$/
const MAX_FILES  = 12
const MAX_LOOPS  = 8
const MAX_DATA   = 8
const MAX_FIELDS = 24

/**
 * The `{#each}` blocks open at `line`:`col` of a `.mesa` source, outermost
 * first, each with the line it opens on. HTML comments are blanked first: a
 * comment quoting a block is not one.
 */
export function enclosingLoops(src, line, col) {
  const text  = src.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
  const lines = text.split('\n')
  if (!(line >= 1 && line <= lines.length)) return []
  let end = col - 1
  for (let i = 0; i < line - 1; i++) end += lines[i].length + 1

  const open = []
  const re = /\{#each\s+([^}]*)\}|\{\/each\}/g
  let at = 0, row = 1
  for (let m; (m = re.exec(text)) && m.index < end;) {
    for (; at < m.index; at++) if (text[at] === '\n') row++
    if (m[1] != null) open.push({ head: m[1].trim().replace(/\s+/g, ' '), line: row })
    else open.pop()
  }
  return open
}

/**
 * The resources a source imports — `import { a } from '…/resources/A.mesa'` —
 * each with the file it resolves to (relative to `root`) and the model its
 * filename names (Invariant 19).
 */
export function resourceImports(src, file, root) {
  const out = []
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]*\/resources\/([A-Z][A-Za-z0-9_]*)\.mesa)['"]/g
  for (const m of src.matchAll(re)) {
    const names = m[1].split(',').map(n => n.trim().split(/\s+as\s+/).pop()).filter(Boolean)
    const path  = m[2].startsWith('.') ? relative(root, resolve(root, dirname(file), m[2])) : m[2]
    out.push({ names, file: path, model: m[3] })
  }
  return out
}

/** The app root above a Vite root — the first of it and two parents holding `db/schema.lite`. */
export function findAppRoot(root) {
  for (let dir = root, i = 0; i < 3; i++, dir = dirname(dir))
    if (existsSync(join(dir, 'db', 'schema.lite'))) return dir
  return null
}

// The framework packages whose AGENTS.md an edit may need, and when. An app's
// node_modules sits at the app root, outside the Vite root the session edits,
// so without these the model styles by guessing from the file it is in.
export const GUIDES = {
  css:       'the styling language: what a thing is, then a tone and a treatment, never a color',
  ui:        'the component kit (buttons, fields, cards) over @frontierjs/css',
  mesa:      'the .mesa language: markup, script, signals and events',
  sierra:    'routes, layouts, resources and forms',
  junction:  'services and the client a resource calls',
  litestone: 'db/schema.lite: models, fields, gates',
}

/** `[{ pkg, file, dir, about }]`, each guide's AGENTS.md as installed above `root`, symlinks resolved. */
export function findGuides(root) {
  const out = []
  for (const pkg of Object.keys(GUIDES)) {
    for (let dir = root, i = 0; i < 4; i++, dir = dirname(dir)) {
      const file = join(dir, 'node_modules', '@frontierjs', pkg, 'AGENTS.md')
      if (!existsSync(file)) continue
      const real = realpathSync(file)
      out.push({ pkg, file: real, dir: dirname(real), about: GUIDES[pkg] })
      break
    }
  }
  return out
}

/**
 * Each pick with `loops`, `inner` and `files` added, and `data`, one line per
 * resource the looping files import. Locs are relative to `root`, the Vite
 * root; `absolute` writes every path as one, for a prompt read from elsewhere.
 *
 * @param {string} root
 * @param {{loc: string|null, inner?: string[]}[]} picks
 * @param {{absolute?: boolean, models?: Function}} [opts]  `models(appRoot)` is `appSchemaModels` unless a test hands one
 */
export function askContext(root, picks, { absolute = false, models = appSchemaModels } = {}) {
  const name  = path => absolute ? resolve(root, path) : path
  const texts = new Map()
  const read  = file => {
    if (!texts.has(file)) {
      let text = null
      try { text = readFileSync(resolve(root, file), 'utf8') } catch {}
      texts.set(file, text)
    }
    return texts.get(file)
  }
  const looping = []
  const loopsAt = loc => {
    const m = LOC_PARTS.exec(loc ?? '')
    if (!m || m[2] !== 'mesa') return []
    const src = read(m[1])
    if (src == null) return []
    const found = enclosingLoops(src, +m[3], +m[4])
    if (found.length && !looping.includes(m[1])) looping.push(m[1])
    return found.map(l => ({ head: l.head, at: `${name(m[1])}:${l.line}` }))
  }

  const out = picks.map(p => {
    const loops = loopsAt(p.loc)
    const seen  = new Set(loops.map(l => l.at))
    const inner = []
    for (const loc of p.inner ?? []) {
      for (const l of loopsAt(loc)) if (!seen.has(l.at)) { seen.add(l.at); inner.push(l) }
    }
    // The first loc of each file, in the page's order: where that file's part starts.
    const own   = LOC_PARTS.exec(p.loc ?? '')?.[1]
    const first = new Map()
    for (const loc of p.inner ?? []) {
      const m = LOC_PARTS.exec(loc)
      if (m && m[1] !== own && !first.has(m[1])) first.set(m[1], `${name(m[1])}:${m[3]}`)
    }
    const { inner: _, ...rest } = p
    return {
      ...rest,
      loc:   p.loc && name(p.loc),
      loops,
      inner: inner.slice(0, MAX_LOOPS),
      files: [...first.values()].slice(0, MAX_FILES),
    }
  })

  const data = []
  if (looping.length) {
    const app = findAppRoot(root)
    let declared = []
    try { declared = app ? models(app) : [] } catch {}
    const listed = new Set()
    for (const file of looping) {
      for (const r of resourceImports(read(file), file, root)) {
        if (listed.has(r.file)) continue
        listed.add(r.file)
        const model = declared.find(d => d.name === r.model)
        const where = model && name(relative(root, resolve(app, model.file)))
        const cols  = model?.fields ?? []
        const shown = cols.slice(0, MAX_FIELDS).join(', ') + (cols.length > MAX_FIELDS ? `, +${cols.length - MAX_FIELDS} more` : '')
        data.push(`${r.names.map(n => '`' + n + '`').join(', ')} from ${name(r.file)} — ` +
          (model ? `model ${model.name} at ${where}:${model.line}: ${shown}` : `no model named ${r.model} in the schema`))
      }
    }
  }
  return { picks: out, data: data.slice(0, MAX_DATA) }
}
