// ─── done.js — is the change in the working tree finished ────────────────────
//
// The steps that close out a change and fail in silence when skipped: a new
// module named where its package lists
// its siblings, a new command named where its namespace lists its siblings, a
// new test file in the script that runs tests, snapshots regenerated, registers
// agreeing with themselves. Most of those already have an engine; nothing asked
// them together about the diff in hand, so each was remembered or not.
//
// It grades the finishing steps and never the change. Whether the feature works
// is the drives' question, and the drives this diff needs are listed so they
// can be run — whether they WERE run is not something a tree records.
//
// ── Sibling rules ───────────────────────────────────────────────────────────
//
// *A new file must be documented* is a rule no directory keeps: most name some
// of their files and not others. So the rule is read off the document itself —
// where it already names most of a new file's siblings, it names the new one
// too. A directory whose document names a handful of its files asks nothing.
//
// Zero dependencies beyond its neighbors, plain ESM, node or bun.

import { gitOut }                                         from './git.js'
import { existsSync, readFileSync, statSync }             from 'node:fs'
import { basename, dirname, extname, join, resolve, sep }  from 'node:path'
import { safeRead }                         from './fs.js'

import { runChecks, findApps, readBaseline } from './checks.js'
import { checkSnapshots }                   from './snapshots.js'
import { runRegisterCheck }                 from './register-check.js'
import { registerSources }                  from './registers.js'
import { provesFor, changedTree }           from './proofs.js'
import { runnables }                        from './runnables.js'

const CODE        = new Set(['.js', '.mjs', '.ts', '.mesa'])
const SIBLING_MIN = 3

// ─── the diff ─────────────────────────────────────────────────────────────────

/**
 * What changed against HEAD, untracked files included. The diff is
 * `changedTree`'s, so the drives listed here are the ones `fli proves` names.
 */
export function collectChanges(root) {
  const git = argv => gitOut(root, argv) ?? ''
  const lines     = text => text.split('\n').map(l => l.trim()).filter(Boolean)
  const untracked = lines(git(['ls-files', '--others', '--exclude-standard']))
  const changed   = [...new Set([...lines(git(['diff', '--name-only', 'HEAD'])), ...untracked])].sort()
  const added     = [...new Set([...lines(git(['diff', '--name-only', '--diff-filter=A', 'HEAD'])), ...untracked])].sort()
  return { changed, added, untracked, diff: changedTree(root).diff }
}

// ─── the checks ───────────────────────────────────────────────────────────────
//
// Each answers a list of `{ check, subject, ok, message }`. `subject` is what
// the item is about, and `check:subject` is its identity across runs.

/** A new module is named in its package's CLAUDE.md where that names most of its siblings. */
export function layoutNamed({ root, added }) {
  const out = []
  for (const file of added) {
    if (!CODE.has(extname(file)) || /(^|\/)(tests?|__tests__)\//.test(file) || /\.snapshot\./.test(file)) continue
    const owner = nearestWith(root, file, 'CLAUDE.md')
    if (!owner) continue
    const doc = readFileSync(join(root, owner, 'CLAUDE.md'), 'utf8')
    const verdict = siblingVerdict({
      root, file, added,
      nameOf:   f => basename(f),
      filter:   f => extname(f) === extname(file),
      named:    name => doc.includes(name),
    })
    if (verdict) out.push({ check: 'layout-named', subject: file, ...verdictMessage(verdict, `${owner}/CLAUDE.md`) })
  }
  return out
}

/** A new command is named in its namespace's _module.md where that names most of its siblings. */
export function moduleNamed({ root, added }) {
  const out = []
  for (const file of added) {
    const m = file.match(/(^|\/)commands\/[^/]+\/([^_/][^/]*)\.md$/)
    if (!m) continue
    const module = join(dirname(file), '_module.md')
    if (!existsSync(join(root, module))) continue
    const doc = readFileSync(join(root, module), 'utf8')
    const verdict = siblingVerdict({
      root, file, added,
      nameOf:   f => titleOf(join(root, f)) ?? basename(f, '.md'),
      filter:   f => extname(f) === '.md' && !basename(f).startsWith('_'),
      named:    name => doc.includes(name),
    })
    if (verdict) out.push({ check: 'module-named', subject: file, ...verdictMessage(verdict, module) })
  }
  return out
}

function siblingVerdict({ root, file, added, nameOf, filter, named }) {
  const dir      = dirname(file)
  const siblings = safeRead(join(root, dir))
    .map(n => join(dir, n))
    .filter(f => f !== file && !added.includes(f) && filter(f) && isFile(join(root, f)))
  if (siblings.length < SIBLING_MIN) return null
  const namedCount = siblings.filter(f => named(nameOf(f))).length
  if (namedCount * 2 <= siblings.length) return null
  return { name: nameOf(file), ok: named(nameOf(file)), namedCount, siblings: siblings.length }
}

function verdictMessage(v, doc) {
  return {
    ok: v.ok,
    message: v.ok
      ? `${doc} names ${v.name}`
      : `${doc} names ${v.namedCount} of the ${v.siblings} files beside it and not ${v.name}`,
  }
}

/**
 * The error rules of `fli check`, asked about the files that changed. The tree
 * already holds findings CI answers with an allowance or a baseline, so only a
 * finding in a changed file counts, minus the allowances CI itself reads.
 */
export function checkItems({ root, changed }) {
  const hit = new Set(changed)
  if (!hit.size) return []

  let allowances = {}
  try { allowances = JSON.parse(readFileSync(join(root, 'scripts', 'ci-allowances.json'), 'utf8')).structure ?? {} } catch { /* none */ }

  const out  = []
  const runs = findApps(root)
    .filter(app => [...hit].some(f => join(root, f).startsWith(app + sep)))
    .map(app => ({ app, scope: 'app', allow: { ...readBaseline(app).allow, ...allowances[rel(root, app) || '.'] } }))
  if (existsSync(join(root, 'packages'))) runs.push({ app: root, scope: 'repo', allow: allowances['.'] ?? {} })

  for (const { app, scope, allow } of runs) {
    for (const f of runChecks({ root: app, scope, allow }).findings) {
      const file = rel(root, f.file)
      if (f.severity !== 'error' || !hit.has(file)) continue
      out.push({ check: 'fli-check', subject: `${f.rule}:${file}`, ok: false, message: `${file}${f.line ? `:${f.line}` : ''} ${f.rule}: ${f.message}` })
    }
  }
  return out
}

/**
 * A changed `.gitignore` is graded by what its new rules hide: `git status`
 * stops listing a file the moment a rule matches it, so a rule written to hide
 * a build directory hides an untracked source file just as quietly.
 */
export function ignoreHides({ root, changed }) {
  const git = argv => gitOut(root, argv) ?? ''
  const out = []
  for (const file of changed.filter(f => basename(f) === '.gitignore')) {
    const diff    = git(['diff', '--no-color', '-U0', 'HEAD', '--', file])
    const text    = diff || (isFile(join(root, file)) ? readFileSync(join(root, file), 'utf8').split('\n').map(l => `+${l}`).join('\n') : '')
    const added   = new Set(text.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1).trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('!')))
    if (!added.size) continue

    const ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', dirname(file)]).split('\0').filter(Boolean)
    if (!ignored.length) continue

    const hidden = new Map()
    const verdict = gitOut(root, ['check-ignore', '-v', '-z', '--stdin'], { input: ignored.join('\0') })
    if (verdict === null) continue
    const cells = verdict.split('\0')
    for (let i = 0; i + 3 < cells.length; i += 4) {
      const [source, , pattern, path] = cells.slice(i, i + 4)
      if (source !== file || !added.has(pattern)) continue
      hidden.set(pattern, [...(hidden.get(pattern) ?? []), path])
    }
    for (const [pattern, paths] of hidden) {
      const shown = paths.slice(0, 5).join(', ') + (paths.length > 5 ? `, and ${paths.length - 5} more` : '')
      out.push({ check: 'gitignore', subject: `${file}:${pattern}`, ok: false,
        message: `${file} \`${pattern}\` now hides ${shown} — compare git status --porcelain before it, and keep the file or say why it stays hidden` })
    }
  }
  return out
}

/** The engines that already exist, asked about this tree. */
export async function engineItems(root) {
  const out = []

  for (const f of runChecks({ root, only: ['test-files-run'], scope: 'both' }).findings) {
    out.push({ check: 'test-files-run', subject: rel(root, f.file), ok: false, message: f.message })
  }

  if (registerSources(root).length) {
    const { errors } = runRegisterCheck({ root })
    if (!errors.length) out.push({ check: 'registers', subject: 'registers', ok: true, message: 'every register agrees with itself' })
    for (const e of errors) out.push({ check: 'registers', subject: `${e.rule}:${e.id ?? e.file}`, ok: false, message: `${e.file ?? ''}${e.line ? `:${e.line}` : ''} ${e.message}` })
  }

  const snaps = await checkSnapshots({ root })
  if (snaps.checked && !snaps.failed) out.push({ check: 'snapshots', subject: 'snapshots', ok: true, message: `${snaps.checked} snapshot(s) current` })
  for (const r of snaps.results.filter(r => !r.ok)) {
    out.push({
      check: 'snapshots', subject: r.file, ok: false,
      message: `${r.file} ${r.error}${r.argv ? ` — cd ${r.dir} && bunx ${r.argv.join(' ')}` : ''}`,
    })
  }

  return out
}

// ─── the report ───────────────────────────────────────────────────────────────

/**
 * Everything, over the working tree. `changes` is handed in by a test; the
 * engines and the drives read the real tree and are skipped with `engines:
 * false`.
 */
export async function runDone(root, { changes = null, engines = true } = {}) {
  root = resolve(root)
  const c = changes ?? collectChanges(root)
  if (!c.changed.length) return { root, changed: 0, items: [], drives: [], unfinished: 0 }

  const items = [
    ...layoutNamed({ root, ...c }),
    ...moduleNamed({ root, ...c }),
    ...ignoreHides({ root, ...c }),
    ...(engines ? checkItems({ root, ...c }) : []),
    ...(engines ? await engineItems(root) : []),
  ]

  let drives = []
  if (engines) {
    try {
      drives = provesFor(root, { files: c.changed, diff: c.diff, rows: runnables(root) })
        .map(r => ({ changed: r.changed, tier: r.match?.tier ?? null, on: r.match?.on ?? [], run: r.targets.map(t => t.command ? `cd ${t.dir ?? t.where} && ${t.command}` : `${t.dir ?? t.where}/${t.name}`) }))
    } catch { drives = [] }
  }

  return { root, changed: c.changed.length, items, drives, unfinished: items.filter(i => !i.ok).length }
}

/** An item's identity across runs, which the Stop hook keys what it has shown on. */
export function itemKey(item) { return `${item.check}:${item.subject}` }

// ─── the Stop hook's verdict ─────────────────────────────────────────────────
//
// `.claude/hooks/fli-done-stop.mjs` runs this when an agent is about to stop.
// Blocking hands the agent the report and keeps it working, which costs a turn,
// so it blocks only on an unfinished item the agent has NOT been shown since
// HEAD last moved. An item it was shown and left is a choice, and another
// session's edits in a shared tree would otherwise block every stop forever.
// Nothing is run at all while the tree is exactly as it was last time.
//
// With `edited` — the files the session's own transcript shows it editing — an
// item blocks only when it is that session's: its subject is a file it edited,
// or a derived file (a snapshot) in a package it edited. The tree is shared, so
// without this a session was held on another session's new files.

/**
 * `{ run, block, reason, state }`. `run: false` means the tree has not moved
 * and the report need not be built; call again with `report` when it is true.
 */
export function stopVerdict({ state = {}, head, fingerprint, report = null, edited = null }) {
  const fresh = state.head === head ? state : { head, shown: [] }
  if (fresh.fingerprint === fingerprint) return { run: false, block: false, reason: null, state: fresh }
  if (!report) return { run: true, block: false, reason: null, state: fresh }

  const shown   = new Set(fresh.shown ?? [])
  const pending = report.items.filter(i => !i.ok && (edited === null || ownedBy(i, edited)))
  const unseen  = pending.filter(i => !shown.has(itemKey(i)))
  const next    = { head, fingerprint, shown: [...new Set([...shown, ...pending.map(itemKey)])] }

  if (!unseen.length) return { run: true, block: false, reason: null, state: next }
  return {
    run: true, block: true, state: next,
    reason: [
      `fli done — ${unseen.length} unfinished item(s) in the working tree:`,
      ...unseen.map(i => `  ✗ ${i.check}: ${i.message}`),
      '',
      'Clear the ones this change caused before finishing. One that belongs to other work in the tree, or that should stay, needs only a sentence saying so — this is not repeated for an item already shown.',
    ].join('\n'),
  }
}

// A snapshot goes stale from an edit anywhere in its package, so its subject is
// never the file that was edited.
const DERIVED = new Set(['snapshots'])

const unitOf = file => String(file).match(/^(packages\/[^/]+|example)\//)?.[1] ?? null

function ownedBy(item, edited) {
  const unit = DERIVED.has(item.check) ? unitOf(item.subject) : null
  return edited.some(f => f === item.subject || (unit !== null && unitOf(f) === unit))
}

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/**
 * The files under `root`, repo-relative, that a session's transcript (its
 * JSONL text) shows it editing. A Read names a `file_path` too, so only the
 * editing tools count; a line that does not parse is skipped. An edit made
 * through Bash, or by a subagent in its own transcript, is not seen.
 */
export function editedIn(transcript, root) {
  const prefix = resolve(root) + sep
  const out    = new Set()
  for (const line of String(transcript ?? '').split('\n')) {
    if (!line.includes('"tool_use"')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const content = entry?.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c?.type !== 'tool_use' || !EDITS.has(c.name)) continue
      const path = c.input?.file_path ?? c.input?.notebook_path
      if (typeof path === 'string' && path.startsWith(prefix)) out.add(path.slice(prefix.length))
    }
  }
  return [...out].sort()
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// The nearest directory above `file`, below the root, that holds `name`.
function nearestWith(root, file, name) {
  let dir = dirname(file)
  while (dir && dir !== '.' && dir !== '/') {
    if (existsSync(join(root, dir, name))) return dir
    dir = dirname(dir)
  }
  return null
}

function titleOf(path) {
  try { return readFileSync(path, 'utf8').match(/^title:\s*(.+)$/m)?.[1].trim() ?? null }
  catch { return null }
}

function isFile(path)  { try { return statSync(path).isFile() } catch { return false } }
function rel(root, file) { return file?.startsWith(root) ? file.slice(root.length + 1) : file }
