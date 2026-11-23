// ─── claude-boundary.js — who may start the `claude` program ──────────────────
//
// Two rules about `@frontierjs/claude` (`IDEAS/claude-calls.md` Phase 2.3):
//
//   1. The package imports nothing from `@frontierjs/cli`. The cli depends on
//      it, so a reverse import is a cycle that only shows when a consumer
//      installs the published pair.
//   2. Nothing outside the package starts the program. Every caller that builds
//      its own command line is one more place the flags, the budget and the
//      stream reader can drift, which is what the package was extracted to end.
//
// Rule 2 is not yet true: Phases 3-5 move the remaining callers. So it is a
// ratchet, `scripts/claude-spawners.json`, one entry per file that still starts
// `claude`, each naming the plan step that removes it. An unlisted starter fails,
// and so does a listed file that stopped, which keeps the list shrinking.
//
// What counts as starting it: a process-start call (`spawn`, `execFile`,
// `Bun.spawn`, a tagged `$` template) whose command is the literal `claude` or
// `CLAUDE_BIN`, or a variable named `bin` in a file that also names the claude
// binary. A test's fake `claude` is written to disk and found on PATH, never
// named in a start call, so no fake reads as a starter.

import { join, relative, resolve, dirname, sep } from 'path'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'

export const CLAUDE_PACKAGE   = 'packages/claude'
export const SPAWNERS_FILE    = 'scripts/claude-spawners.json'
export const SCAN_ROOTS       = ['packages', 'scripts', 'example', 'website']

const SOURCE     = /\.(m?js|cjs|ts|tsx|jsx|mesa)$/
const NOT_SOURCE = /\.d\.ts$|\.snapshot\./
const SKIP_DIRS  = new Set(['node_modules', 'dist', 'build'])

function* sourceFiles(dir) {
  let names
  try { names = readdirSync(dir).sort() } catch { return }    // an absent root reads as empty
  for (const name of names) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    let st
    try { st = statSync(path) } catch { continue }
    if (st.isDirectory()) yield* sourceFiles(path)
    else if (SOURCE.test(name) && !NOT_SOURCE.test(name)) yield path
  }
}

/** Source with block comments and whole-line comments blanked, so prose about a spawn is not one. */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .split('\n').map(l => (/^\s*\/\//.test(l) ? '' : l)).join('\n')
}

// ─── rule 1: the package imports nothing from the cli ────────────────────────

const SPECIFIER = [
  /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g,
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** Every `{ file, line, spec }` in packages/claude that reaches the cli by name or by path. */
export function claudeImportFindings(root) {
  const pkg = join(root, CLAUDE_PACKAGE)
  const cli = join(root, 'packages', 'cli')
  const out = []
  for (const file of sourceFiles(pkg)) {
    const src = code(readFileSync(file, 'utf8'))
    for (const re of SPECIFIER) for (const m of src.matchAll(re)) {
      const spec = m[1]
      const named = spec === '@frontierjs/cli' || spec.startsWith('@frontierjs/cli/')
      const path = spec.startsWith('.') && (resolve(dirname(file), spec) + sep).startsWith(cli + sep)
      if (named || path) out.push({ file, line: src.slice(0, m.index + m[0].indexOf(spec)).split('\n').length, spec })
    }
  }
  try {
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
      if (manifest[field]?.['@frontierjs/cli']) out.push({ file: join(pkg, 'package.json'), line: 0, spec: `${field}: @frontierjs/cli` })
  } catch { /* no manifest: nothing to grade */ }
  return out
}

// ─── rule 2: nothing outside the package starts claude ───────────────────────

const START = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\(\s*(?:\[\s*)?(?:['"`]claude['"`]|(?:\w+\.)*CLAUDE_BIN\b|(bin)\b)|\b(?:exec|execSync)\(\s*['"`]claude\s|\$`\s*claude\s/
const BINDS = /['"`]claude['"`]|\bCLAUDE_BIN\b|\bCLAUDE_ENV\b/

/** Does this source start the `claude` program itself? */
export function startsClaude(text) {
  const src = code(text)
  const m = START.exec(src)
  if (!m) return false
  // A bare `bin` is anybody's binary; it is claude's only in a file that names it.
  return m[1] ? BINDS.test(src) : true
}

/** Root-relative paths of every file outside packages/claude that starts the program. */
export function claudeStarters(root) {
  const own = join(root, CLAUDE_PACKAGE) + sep
  const found = []
  for (const top of SCAN_ROOTS) for (const file of sourceFiles(join(root, top))) {
    if (file.startsWith(own)) continue
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    if (startsClaude(text)) found.push(relative(root, file).split(sep).join('/'))
  }
  return found.sort()
}

/** The ratchet: `{ '<path>': '<plan step that removes it>' }`; the `//` key is the file's own note. */
export function readSpawners(root) {
  try {
    const { '//': _note, ...list } = JSON.parse(readFileSync(join(root, SPAWNERS_FILE), 'utf8'))
    return list
  } catch { return {} }
}

/** `{ file, message }` for an unlisted starter and for a listed file that no longer starts it. */
export function claudeSpawnFindings(root) {
  const listed  = readSpawners(root)
  const found   = new Set(claudeStarters(root))
  const out = []
  for (const rel of found) {
    if (rel in listed) continue
    out.push({ file: join(root, rel),
      message: 'starts the `claude` program itself. Go through `@frontierjs/claude` (`runAsk`, `sessionArgv`), ' +
               'or, if this caller is moving in a later phase, list it in `scripts/claude-spawners.json` with the plan step that removes it.' })
  }
  for (const [rel, step] of Object.entries(listed)) {
    if (found.has(rel)) continue
    out.push({ file: join(root, SPAWNERS_FILE),
      message: `lists ${rel} (${step}), which no longer starts \`claude\` ` +
               (existsSync(join(root, rel)) ? '' : '(the file is gone) ') + '-- delete the entry so the list only shrinks.' })
  }
  return out
}
