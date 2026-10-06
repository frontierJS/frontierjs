// ─── command-parse.js — does every command in a routes tree parse ────────────
//
// A command is compiled when it is RUN, so one nobody has run yet is broken in
// silence — fourteen shipped that way before the parse sweep existed. This is
// the sweep made callable: `fli check`'s `command-parses` rule runs it over an
// app's `cli/src/routes/`, and `test/compiler.test.js` runs `commandFiles` over
// this package's own `commands/`.
//
// Each file is compiled the way the runtime compiles it — WITH its namespace
// module — because the module's script and the command's share one scope, and
// a helper named in both is a SyntaxError that only the pair can show. The
// sweep that compiled without it passed commands that could not load
// (`FJS-167`, `FJS-269`).
//
// The parser is `node --check`: bun loads the command (`FJS-D593`) but has no
// syntax-only check, and a shim imports nothing a node parser cannot read.
// `vm.SourceTextModule` parses in-process and reports no line, so it cannot say
// where.
//
// A parse is not a run: a free identifier (`join` with no import) parses clean
// and throws on the first call. That half is still the command's to prove.

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { compileCliWithMap, extractFrontmatter, SHIM_GLOBALS } from './compiler.js'
import { scopeProblems } from './scope.js'
import { loadModuleFile, moduleNamespace } from './registry.js'

const STEPS_DIR = /^_steps/

// ─── discovery ────────────────────────────────────────────────────────────────

function walkMd(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkMd(p))
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

const namespaceOf = (file) => extractFrontmatter(readFileSync(file, 'utf8'))?.title?.split(':')?.[0] ?? null

// A step runs with its command's module, and its command is the one in the
// directory holding the `_steps*` folder — `index.md` by default, or the file
// naming that folder in `steps:`. Every command in one directory is in one
// namespace, so any titled file there answers.
function stepNamespace(stepFile) {
  const home  = dirname(dirname(stepFile))
  const index = join(home, 'index.md')
  if (existsSync(index)) return namespaceOf(index)
  for (const name of readdirSync(home).sort()) {
    if (!name.endsWith('.md') || name === '_module.md') continue
    const ns = namespaceOf(join(home, name))
    if (ns) return ns
  }
  return null
}

/**
 * Every command and step file under `routesDir`, each with the namespace
 * module the runtime would compile it with. A `.md` with no `title:` that is
 * not a step is not a command, which is the registry's own reading.
 */
export function commandFiles(routesDir) {
  const files   = walkMd(routesDir)
  const modules = new Map()
  for (const file of files) {
    if (basename(file) !== '_module.md') continue
    const mod = loadModuleFile(file)
    if (mod) modules.set(moduleNamespace(mod), mod)
  }

  const out = []
  for (const file of files) {
    if (basename(file) === '_module.md') continue
    const template = readFileSync(file, 'utf8')
    const step     = STEPS_DIR.test(basename(dirname(file)))
    const ns       = step ? stepNamespace(file) : extractFrontmatter(template)?.title?.split(':')?.[0]
    if (!step && !extractFrontmatter(template)?.title) continue
    out.push({ file, template, module: (ns && modules.get(ns)) || null })
  }
  return out
}

// ─── parsing ──────────────────────────────────────────────────────────────────

// Under bun, `process.execPath` is bun, whose parser is not the one that loads
// the command.
const NODE = process.versions.bun ? 'node' : process.execPath

/**
 * `{ checked, problems }` — each problem `{ file, line, message }`, where
 * `file` is the `.md` the broken line was written in: the command, or its
 * `_module.md`. `line` is null for a line the compiler wrote.
 */
export function parseCommands(routesDir, { node = NODE } = {}) {
  const entries = commandFiles(routesDir)
  const scratch = mkdtempSync(join(tmpdir(), 'fli-parse-'))
  // Keyed by where, because a broken module breaks every command that shares
  // it and is one fix.
  const problems = new Map()
  try {
    entries.forEach((entry, i) => {
      const found = parseOne(entry, join(scratch, `c${i}.mjs`), node)
      if (found) problems.set(`${found.file}:${found.line}:${found.message}`, found)
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return { checked: entries.length, problems: [...problems.values()] }
}

function parseOne({ file, template, module }, shim, node) {
  const { code, locate } = compileCliWithMap(template, module?.script || '', file)
  writeFileSync(shim, code)
  const r = spawnSync(node, ['--check', shim], { encoding: 'utf8' })
  if (r.error) throw new Error(`command-parse: could not run \`${node} --check\` — ${r.error.message}`)
  if (r.status === 0) return null

  const genLine = Number(r.stderr.match(new RegExp(`^${escape(shim)}:(\\d+)`, 'm'))?.[1])
  const error   = r.stderr.match(/^\w*Error: .*$/m)?.[0] ?? r.stderr.trim().split('\n').pop()
  // An unclosed bracket is reported where V8 gave up, which can be a line the
  // compiler wrote — `export const metadata` after a broken module. The cause
  // is above it, so walk back to the last line somebody wrote.
  let at = null
  for (let n = genLine || 0; n > 0 && !at; n--) at = locate(n)

  const where = at?.in === 'module'
    ? { file: module.filePath, line: module.scriptLine == null ? null : module.scriptLine + at.line - 1 }
    : { file, line: at?.line ?? null }

  // The collision is between two files, and the line names only the second.
  const shared = module && /has already been declared/.test(error)
    ? ` \`${basename(dirname(module.filePath))}/_module.md\` shares this command's scope, so a name ` +
      `declared in both collides.`
    : ''
  return { ...where, message: error + shared }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ─── resolving ────────────────────────────────────────────────────────────────

/**
 * The other half of a parse: `{ checked, problems }` over the same units, each
 * problem a free identifier or a name declared twice, at the `.md` line it was
 * written. `ts` is the project's TypeScript (`typeScriptIn`); the caller
 * decides what no parser means.
 */
export function resolveCommands(routesDir, ts) {
  const entries  = commandFiles(routesDir)
  const problems = new Map()
  for (const { file, template, module } of entries) {
    const { code, locate } = compileCliWithMap(template, module?.script || '', file)
    const { free, duplicates } = scopeProblems(ts, code, { globals: SHIM_GLOBALS })
    const report = (line, message) => {
      const at    = locate(line)
      const where = at?.in === 'module'
        ? { file: module.filePath, line: module.scriptLine == null ? null : module.scriptLine + at.line - 1 }
        : { file, line: at?.line ?? null }
      problems.set(`${where.file}:${where.line}:${message}`, { ...where, message })
    }
    for (const { name, line } of free) report(line, `\`${name}\` is not defined — not declared, not imported, and not one of ${SHIM_GLOBALS.join(', ')}`)
    for (const { name, line } of duplicates) report(line, `\`${name}\` is declared twice in one scope, so the command never loads` +
      (module ? ` — \`${basename(dirname(module.filePath))}/_module.md\` shares this command's scope` : ''))
  }
  return { checked: entries.length, problems: [...problems.values()] }
}
