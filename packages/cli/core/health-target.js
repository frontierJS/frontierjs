// ─── health-target.js — where an app answers health, and whether it does ─────
//
// Two questions, asked by `fli make:deploy` and `fli deploy:doctor`, and
// answered separately by each until a scaffold graded itself broken: `fli new`
// declares the plugin in `api/config/junction.config.js` under
// `plugins: { health: true }`, and both readers only ever looked at the API
// SOURCE — so the command that wrote the config warned, in its own output, that
// the app it had just written answers nothing at /api/health.
//
// Being wrong here is not loud. The deploy polls the configured path for twenty
// seconds and then rolls back an API that was running, and a doctor that warns
// on a working app teaches everyone to skip the line.
//
// Both questions read the same two places, so they are one module.

import { existsSync, readFileSync } from 'fs'
import { resolve }                  from 'path'

// The composition root first: `fli new` configures plugins in `api/src/app.ts`
// and the layout calls that file the assembly. `api/index.*` is the ENTRY and
// assembles nothing, but an app is free to configure there, and `api/src/index.*`
// is the shape of an app that made the entry and the assembly one file.
// `api/src/server.*` is deliberately absent: no scaffold has ever written it, and
// a hedge in this list reads as a layout somebody supports.
const CODE_FILES = [
  'api/src/app.ts',   'api/src/app.js',
  'api/index.ts',     'api/index.js',
  'api/src/index.ts', 'api/src/index.js',
]

const CONFIG_FILES = [
  'api/config/junction.config.js',
  'api/config/junction.config.ts',
]

const present = (root, names) => names
  .map(rel => ({ rel, abs: resolve(root, rel) }))
  .filter(c => existsSync(c.abs))

const read = (abs) => { try { return readFileSync(abs, 'utf8') } catch { return '' } }

// ─── resolveHealthPath ───────────────────────────────────────────────────────
//
// `healthPlugin()` registers through `app.get()`, which is the one owner of
// apiPrefix — so an app with a prefix serves health at `{prefix}/health` and
// NOTHING a caller writes through the shortcuts can answer at a bare `/health`.
//
// createApp() merges opts.config over config/junction.config.js, so app.ts wins
// where it states a prefix. Read in that order, then fall back to no prefix.
export function resolveHealthPath(root) {
  const sources = [
    resolve(root, 'api/src/app.ts'),
    resolve(root, 'api/src/app.js'),
    resolve(root, 'api/config/junction.config.js'),
  ]
  for (const file of sources) {
    if (!existsSync(file)) continue
    const found = read(file).match(/apiPrefix\s*:\s*['"`]([^'"`]*)['"`]/)
    if (found) return { path: `${found[1]}/health`, from: file, prefix: found[1] }
  }
  return { path: '/health', from: null, prefix: '' }
}

// ─── declaresHealth ──────────────────────────────────────────────────────────
//
// Answers both *does anything serve this path* and *is it served twice*, because
// junction refuses a plugin configured by hand AND declared in config at
// start() — one owner per route — and that refusal is a boot crash the deploy
// finds rather than the doctor.
//
// Returns { declared, sources: [{ how, file }], clash }.
//   how: 'plugin-call'   — app.configure(healthPlugin()) in the API source
//        'config'        — plugins: { health: … } in junction.config
//        'route-literal' — the configured path written out as a string
export function declaresHealth(root, healthPath = '/health') {
  const sources = []

  // A literal anywhere in the API source answers whatever path it spells, so it
  // is graded against the CONFIGURED path rather than against '/health' — an app
  // with a prefix writes the prefixed path and the bare form matches nothing.
  const literal = new RegExp(`['"\`]${healthPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`)

  // The plugin serves `{apiPrefix}{opts.path}/health`, so it satisfies any
  // configured path ending in /health and no other.
  const servesPlugin = healthPath.endsWith('/health')

  for (const c of present(root, CODE_FILES)) {
    const src = read(c.abs)
    if (servesPlugin && /healthPlugin\s*\(/.test(src)) sources.push({ how: 'plugin-call', file: c.rel })
    else if (literal.test(src))                        sources.push({ how: 'route-literal', file: c.rel })
  }

  if (servesPlugin) {
    for (const c of present(root, CONFIG_FILES)) {
      if (configDeclaresHealth(read(c.abs))) sources.push({ how: 'config', file: c.rel })
    }
  }

  const clash = sources.some(s => s.how === 'plugin-call') && sources.some(s => s.how === 'config')
  return { declared: sources.length > 0, sources, clash }
}

// ─── configDeclaresHealth ────────────────────────────────────────────────────
//
// `plugins: { health: true }` or `plugins: { health: { … } }`, and NOT
// `health: false` — a key written to turn the plugin off reads identically to
// one turning it on under a substring search.
//
// The block is found by balancing braces rather than by a lazy `[^}]*`, since
// `health: { path: '/_internal' }` closes the outer match at the inner brace and
// every option shape then grades as absent.
export function configDeclaresHealth(src) {
  const block = pluginsBlock(strip(src))
  if (block === null) return false
  return /(^|[\s,{])health\s*:\s*(true|\{)/.test(block)
}

// Comments only. A brace inside a string literal would fool the scan, and the
// values in this block are paths and tokens — stripping strings as well costs an
// escape-aware pass for a shape nothing writes.
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

function pluginsBlock(src) {
  const m = /\bplugins\s*:\s*\{/.exec(src)
  if (!m) return null
  const open = m.index + m[0].length - 1
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
  }
  return null
}
