// ─── diagram.js — the digest `project:diagram` hands Claude, and the page back
//
// `project:map` and `app:atlas` print ~600 KB between them for a mid-sized app;
// sent whole, a run took sixteen minutes and its first page was cut off at the
// output limit. The picture is of what the app EXISTS to do, so the digest is
// what finds that: the state machines and their moves, who points at whom, the
// verbs beyond CRUD, and the app's own words. Field lists, gates and plugins
// are boilerplate to this question and stay out.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The prompt every app gets unless it keeps its own at `cli/prompts/diagram.md`. */
export const DIAGRAM_PROMPT = resolve(here, 'diagram-prompt.md')
export const APP_PROMPT     = 'cli/prompts/diagram.md'
export const APP_NOTES      = 'AGENTS.project.md'

const UI_SURFACES = ['web', 'site', 'widgets', 'extension', 'desktop', 'mobile']

/** The app's own prompt when it keeps one, else the package's. */
export function diagramPrompt(root, asked = null) {
  if (asked) return resolve(root, asked)
  const own = resolve(root, APP_PROMPT)
  return existsSync(own) ? own : DIAGRAM_PROMPT
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? countFiles(resolve(dir, e.name)) : 1), 0)
}

/** Each UI surface beside `db/`, with how many route files it has. */
export function surfacePages(root) {
  return UI_SURFACES.filter(s => existsSync(resolve(root, s)))
    .map(name => ({ name, pages: countFiles(resolve(root, name, 'src/routes')) }))
}

/**
 * The digest from `buildProjectMap`'s model (`map`) and `readAppAtlas`'s
 * (`atlas`). `notes` is the app's description of itself, or null.
 */
export function diagramDigest({ name, map, atlas, notes = null, surfaces = [] }) {
  const defs   = map?.schema?.$defs ?? {}
  const models = Object.keys(defs).filter(n => defs[n]['x-litestone-kind'] === 'model').sort()

  const machines = (map?.access?.models ?? []).filter(m => m.transitions?.length).map(m => ({
    model: m.name,
    moves: m.transitions.map(t => `${t.name}: ${[t.from].flat().join('|')}→${t.to}`),
  }))

  return {
    app: { name },
    machines,
    models: models.map(n => ({
      name:   n,
      refs:   [...new Set((defs[n]['x-relations'] ?? []).filter(r => r.type === 'belongsTo').map(r => r.model))],
      fields: Object.keys(defs[n].properties ?? {}).length,
    })),
    services: (atlas?.app?.services ?? []).filter(s => s.customMethods?.length)
      .map(s => ({ name: s.name, model: s.model, verbs: s.customMethods })),
    rawRoutes: (atlas?.app?.routes ?? []).filter(r => r.kind === 'raw').map(r => `${r.method} ${r.path}`),
    surfaces,
    ...(notes ? { notes } : {}),
  }
}

/** The app's notes file, read, or null when it has none. */
export function readNotes(root, file = APP_NOTES) {
  if (!file) return null
  const path = resolve(root, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/**
 * The last whole page in a reply. A reply that reaches the output limit
 * starts the page over in the same message, so the first doctype can open a
 * page that never closes.
 */
export function pageOf(text) {
  const lower = String(text ?? '').toLowerCase()
  const end   = lower.lastIndexOf('</html>')
  const start = lower.lastIndexOf('<!doctype html', end)
  return start >= 0 && end > start ? text.slice(start, end + 7) : null
}

/** Whether the reply started a page more than once. */
export const restarted = text => String(text ?? '').toLowerCase().split('<!doctype html').length > 2
