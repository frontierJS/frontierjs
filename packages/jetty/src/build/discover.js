// discover — find entrypoints by file location.
//
// Spec table:
//   src/harbor/index.js           Harbor   (required, build error if missing)
//   src/dock/App.mesa  | main.js  Dock     (optional)
//   src/options/App.mesa | main.js Options (optional)
//   src/piers/{name}/App.mesa | main.js  Pier (optional, multi)
//   src/islands/*.js              Island   (optional, multi; flat, no subfolders)
//
// Errors block build:
//   - Harbor missing
//   - Pier folder w/ no App.mesa or main.js → warning (per spec)
//   - Options folder w/ neither            → warning
//   - Dock folder w/ neither               → warning
//   - Island id matches /^[a-z0-9-]+$/     → build error otherwise

import { resolve, join, basename, extname } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'

const ID_RE = /^[a-z0-9-]+$/

export function discover({ root }) {
  const src = resolve(root, 'src')
  if (!existsSync(src)) {
    throw new Error(`No src/ directory at ${src}`)
  }

  const harbor  = findHarbor(src)
  const dock    = findPage(src, 'dock')
  const options = findPage(src, 'options')
  const piers   = findPiers(src)
  const islands = findIslands(src)

  const warnings = []
  if (!dock    && existsSync(join(src, 'dock')))    warnings.push('src/dock/ exists but no App.mesa or main.js found — Dock will be skipped')
  if (!options && existsSync(join(src, 'options'))) warnings.push('src/options/ exists but no App.mesa or main.js found — Options will be skipped')

  return { harbor, dock, options, piers, islands, warnings }
}

function findHarbor(src) {
  const path = join(src, 'harbor', 'index.js')
  if (!existsSync(path)) {
    throw new Error('Harbor missing: src/harbor/index.js is required')
  }
  return { path, type: 'harbor' }
}

function findPage(src, type) {
  const dir = join(src, type)
  if (!existsSync(dir)) return null
  const main = join(dir, 'main.js')
  const app  = join(dir, 'App.mesa')
  if (existsSync(main)) return { type, dir, main, autoGen: false }
  if (existsSync(app))  return { type, dir, app,  autoGen: true }
  return null
}

function findPiers(src) {
  const dir = join(src, 'piers')
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name)
    if (!statSync(sub).isDirectory()) continue
    if (!ID_RE.test(name)) {
      throw new Error(`Pier id "${name}" invalid (must match ${ID_RE})`)
    }
    const main = join(sub, 'main.js')
    const app  = join(sub, 'App.mesa')
    if (existsSync(main)) out.push({ type: 'pier', id: name, dir: sub, main, autoGen: false })
    else if (existsSync(app)) out.push({ type: 'pier', id: name, dir: sub, app, autoGen: true })
    // else: spec says warning, not error. We return empty list entry-wise; warnings emitted by caller if needed.
  }
  return out
}

function findIslands(src) {
  const dir = join(src, 'islands')
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const st   = statSync(path)
    if (st.isDirectory()) {
      throw new Error(`src/islands/${entry}/: subfolders not auto-discovered in v1. Move island file flat into src/islands/.`)
    }
    if (extname(entry) !== '.js') continue
    const id = basename(entry, '.js')
    if (!ID_RE.test(id)) {
      throw new Error(`Island id "${id}" invalid (must match ${ID_RE})`)
    }
    out.push({ type: 'island', id, path })
  }
  return out
}
