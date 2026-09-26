// ─── done.js — is the change in the working tree finished ────────────────────
//
// The steps that close out a change and fail in silence when skipped: a history
// entry for every package touched, a new module named where its package lists
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

import { execFileSync }                                   from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve }       from 'node:path'

import { runChecks }                        from './checks.js'
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
  const git = argv => {
    try { return execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) }
    catch { return '' }
  }
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

/** Every package touched has a new heading in its own CHANGES.md. */
export function changesEntries({ root, changed, untracked = [], diff }) {
  const owners = new Map()
  for (const file of changed) {
    if (/\.snapshot\./.test(file) || basename(file) === 'CHANGES.md') continue
    const owner = nearestWith(root, file, 'CHANGES.md')
    if (owner) owners.set(owner, (owners.get(owner) ?? 0) + 1)
  }

  const added = addedLines(diff)
  return [...owners].map(([owner, n]) => {
    const log = join(owner, 'CHANGES.md')
    const ok  = untracked.includes(log) || (added.get(log) ?? []).some(l => /^##\s/.test(l))
    return {
      check: 'changes-entry', subject: owner, ok,
      message: ok
        ? `${log} has a new entry`
        : `${n} file(s) changed under ${owner} and ${log} gained no \`## \` heading`,
    }
  })
}

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
  const siblings = safeList(join(root, dir))
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

/** The engines that already exist, asked about this tree. */
export function engineItems(root) {
  const out = []

  for (const f of runChecks({ root, only: ['test-files-run'], scope: 'both' }).findings) {
    out.push({ check: 'test-files-run', subject: rel(root, f.file), ok: false, message: f.message })
  }

  if (registerSources(root).length) {
    const { errors } = runRegisterCheck({ root })
    if (!errors.length) out.push({ check: 'registers', subject: 'registers', ok: true, message: 'every register agrees with itself' })
    for (const e of errors) out.push({ check: 'registers', subject: `${e.rule}:${e.id ?? e.file}`, ok: false, message: `${e.file ?? ''}${e.line ? `:${e.line}` : ''} ${e.message}` })
  }

  const snaps = checkSnapshots({ root })
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
export function runDone(root, { changes = null, engines = true } = {}) {
  root = resolve(root)
  const c = changes ?? collectChanges(root)
  if (!c.changed.length) return { root, changed: 0, items: [], drives: [], unfinished: 0 }

  const items = [
    ...changesEntries({ root, ...c }),
    ...layoutNamed({ root, ...c }),
    ...moduleNamed({ root, ...c }),
    ...(engines ? engineItems(root) : []),
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

/**
 * `{ run, block, reason, state }`. `run: false` means the tree has not moved
 * and the report need not be built; call again with `report` when it is true.
 */
export function stopVerdict({ state = {}, head, fingerprint, report = null }) {
  const fresh = state.head === head ? state : { head, shown: [] }
  if (fresh.fingerprint === fingerprint) return { run: false, block: false, reason: null, state: fresh }
  if (!report) return { run: true, block: false, reason: null, state: fresh }

  const shown   = new Set(fresh.shown ?? [])
  const pending = report.items.filter(i => !i.ok)
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

// `git diff -U0` → `file → lines it adds`.
function addedLines(diff) {
  const out = new Map()
  let file  = null
  for (const line of String(diff ?? '').split('\n')) {
    const head = line.match(/^\+\+\+ b\/(.+)$/)
    if (head) { file = head[1]; out.set(file, []); continue }
    if (file && line.startsWith('+') && !line.startsWith('+++')) out.get(file).push(line.slice(1))
  }
  return out
}

function titleOf(path) {
  try { return readFileSync(path, 'utf8').match(/^title:\s*(.+)$/m)?.[1].trim() ?? null }
  catch { return null }
}

function safeList(dir) { try { return readdirSync(dir) } catch { return [] } }
function isFile(path)  { try { return statSync(path).isFile() } catch { return false } }
function rel(root, file) { return file?.startsWith(root) ? file.slice(root.length + 1) : file }
