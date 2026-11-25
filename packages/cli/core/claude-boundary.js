// ─── claude-boundary.js — who may start the `claude` program, and hold its login ──
//
// Three rules about `@frontierjs/claude` (`IDEAS/claude-calls.md` 2.3, 5.2):
//
//   1. The package imports nothing from `@frontierjs/cli`. The cli depends on
//      it, so a reverse import is a cycle that only shows when a consumer
//      installs the published pair.
//   2. Nothing outside the package starts the program. Every caller that builds
//      its own command line is one more place the flags, the budget and the
//      stream reader can drift, which is what the package was extracted to end.
//   3. Nothing outside the package reads the claude.ai login. Its token is in
//      `.credentials.json` and its one use is the `oauth/usage` endpoint; a
//      second reader is a second chance to refresh the token, which signs out
//      every running `claude`, or to print it.
//
// What counts as starting it: a process-start call (`spawn`, `execFile`,
// `Bun.spawn`, a tagged `$` template) whose command is the literal `claude` or
// `CLAUDE_BIN`, or a variable named `bin` in a file that also names the claude
// binary. A test's fake `claude` is written to disk and found on PATH, never
// named in a start call, so no fake reads as a starter.

import { join, relative, resolve, dirname, sep } from 'path'
import { readdirSync, readFileSync, statSync } from 'fs'

export const CLAUDE_PACKAGE   = 'packages/claude'
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

/** Root-relative paths of every file outside packages/claude whose code `test` holds. */
function outside(root, test) {
  const own = join(root, CLAUDE_PACKAGE) + sep
  const found = []
  for (const top of SCAN_ROOTS) for (const file of sourceFiles(join(root, top))) {
    if (file.startsWith(own)) continue
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    if (test(text)) found.push(relative(root, file).split(sep).join('/'))
  }
  return found.sort()
}

/** Root-relative paths of every file outside packages/claude that starts the program. */
export const claudeStarters = root => outside(root, startsClaude)

/** `{ file, message }` for each file outside the package that starts `claude`. */
export function claudeSpawnFindings(root) {
  return claudeStarters(root).map(rel => ({ file: join(root, rel),
    message: 'starts the `claude` program itself. Go through `@frontierjs/claude` ' +
             '(`runAsk`, `sessionArgv`, `claudeDoor`, `runClaude`).' }))
}

// ─── rule 3: nothing outside the package reads the login ─────────────────────

const LOGIN = /\.credentials\.json|oauth\/usage/

/** Does this source name the login's file or its usage endpoint in code? */
export const readsLogin = text => LOGIN.test(code(text))

/** `{ file, message }` for each file outside the package that names the login's file or endpoint. */
export function claudeLoginFindings(root) {
  return outside(root, readsLogin).map(rel => ({ file: join(root, rel),
    message: 'reads the claude.ai login: its credentials file or its usage endpoint. Go through `@frontierjs/claude`\'s ' +
             '`fetchUsage` or `countContext`, which read the token and never refresh it.' }))
}
