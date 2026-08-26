// ─── doc-commands.js — every `fli <command>` a doc names, resolved ────────────
//
// The CLI's own file has said for months that several documented commands do
// not do what the prose says, and that three packages advertise commands which
// do not exist. That is a class, not a list: prose is written beside a command
// and outlives the rename, and nothing reads prose.
//
// So this resolves the mentions instead. `fli ws-add` — the spelling this
// repo's own `workspace/add.md` put in its examples and in the message an empty
// workspace prints — is not a command; the alias is `ws:add`. Nothing could
// have said so.
//
// ── What counts as a mention ─────────────────────────────────────────────────
//
// A backticked `fli <token>`. Backticked, because prose says "the fli check
// command" and a rule that read that would be grading English.
//
// ── What counts as resolved ──────────────────────────────────────────────────
//
// Three things, and the second two are why this is not simply a set lookup:
//
//   1. a title or an alias — `workspace:add`, `ws:add`
//   2. a NAMESPACE — `fli make`, `fli ws`, `fli db`. A writer naming the family
//      is not naming a command that is missing, and a rule that reported it
//      would be answered by deleting the rule.
//   3. a BUILT-IN — `fli list`, `fli help`, `fli init`. Those are in bin/fli.js
//      rather than in a command file, so the registry has never heard of them.
//      Read from the entry point rather than restated here, so a new one is not
//      a false positive nobody can explain.
//
// ── What is NOT graded ───────────────────────────────────────────────────────
//
// `IDEAS/` names commands that deliberately do not exist — that is what an idea
// paper IS — and the registers and CHANGES files are history and argument. The
// surface graded is the one that tells you what to run: a README, a CLAUDE.md,
// and a command file naming a sibling.

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join, relative, basename }                        from 'path'

/**
 * `fli <token>` in backticks, one per match.
 *
 * The trailing lookahead refuses a LABEL rather than a command: a command file's own
 * `log.info(\`fli root:   ${fliRoot}\`)` opens a template literal with exactly
 * the same six characters, and reporting it would have this rule grading the
 * output of the tool it is checking. It excludes every token character, not
 * just the colon: a lookahead that refuses only `:` BACKTRACKS, matching `roo`
 * and reporting a command one letter short of a real one.
 */
const MENTION = /`fli ([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?)(?![a-z0-9:-])/g

/** A doc that tells you what to run, as opposed to one that argues about it. */
export function isReferenceDoc(path) {
  const rel = path.split('\\').join('/')
  if (/(^|\/)(IDEAS|docs\/handoff-archive)\//.test(rel)) return false
  if (/(^|\/)(ISSUES|ISSUES_ARCHIVE|DECISIONS|HANDOFF|CHANGES)\.md$/.test(rel)) return false
  return /(^|\/)(README|CLAUDE)\.md$/.test(rel) || /(^|\/)commands\/.*\.md$/.test(rel)
}

/**
 * Commands the entry point answers without a command file.
 *
 * Parsed rather than listed: `NO_PROJECT_NEEDED` in `bin/fli.js` is the one
 * place they are enumerated, and a copy here would report the next one as
 * missing.
 */
export function builtinCommands(fliRoot) {
  const path = join(fliRoot, 'bin', 'fli.js')
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return new Set() }

  const set = new Set(['help', 'version'])
  const m = text.match(/NO_PROJECT_NEEDED\s*=\s*new Set\(\[([^\]]*)\]/)
  if (m) for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) set.add(q[1])
  return set
}

/** Every markdown file under `root`, skipping the directories nothing tracks. */
export function markdownFiles(root, depth = 6) {
  const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.output'])
  const out  = []
  const walk = (dir, left) => {
    if (left < 0) return
    let entries = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (SKIP.has(name) || name.startsWith('.')) continue
      const full = join(dir, name)
      let stat
      try { stat = statSync(full) } catch { continue }
      if (stat.isDirectory()) walk(full, left - 1)
      else if (name.endsWith('.md')) out.push(full)
    }
  }
  if (existsSync(root)) walk(root, depth)
  return out
}

/**
 * Grade every mention in the reference docs under `root`.
 *
 * @param {object} o
 * @param {string} o.root      repo or app root
 * @param {string[]} o.names   every command title and alias the registry holds
 * @param {Set<string>} o.builtins
 * @returns {{ checked: number, mentions: number, unresolved: Array<{command,file,line}> }}
 */
export function checkDocCommands({ root, names, builtins = new Set() }) {
  const known      = new Set(names)
  const namespaces = new Set()
  for (const name of known) {
    const at = name.indexOf(':')
    if (at > 0) namespaces.add(name.slice(0, at))
  }

  const resolves = (token) =>
    known.has(token) || known.has(`fli:${token}`) ||
    namespaces.has(token) || builtins.has(token)

  const unresolved = []
  let checked = 0, mentions = 0

  for (const file of markdownFiles(root)) {
    if (!isReferenceDoc(file)) continue
    checked++
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }

    for (const m of text.matchAll(MENTION)) {
      mentions++
      if (resolves(m[1])) continue
      unresolved.push({
        command: m[1],
        file:    relative(root, file).split('\\').join('/'),
        line:    text.slice(0, m.index).split('\n').length,
      })
    }
  }

  return { checked, mentions, unresolved }
}
