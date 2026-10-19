// ─── archive.js — aging § Closed out to ISSUES_ARCHIVE.md ────────────────────
//
// The one writer behind `fli register:archive`. § Closed keeps the newest
// closures and the archive keeps the rest, verbatim — a COUNT rule rather than
// an age rule, because closures arrive in bursts and a date rule lets one busy
// day bury a month.
//
// ── What moves with a row ────────────────────────────────────────────────────
//
// Its anchor, and so every markdown link to it. A link to `ISSUES.md#fjs-706`
// resolves to the top of the wrong file once the row is archived, so each `.md`
// file in the tree whose link RESOLVES to this register's ISSUES.md — compared
// by absolute path, not by spelling, since the tree writes it six ways — is
// pointed at the archive. A link inside ISSUES.md (`#fjs-706`) is rewritten the
// same way in both directions. Code comments are left alone: a test fixture
// spells the same link on purpose.
//
// `register:check` runs over the result, and a write it finds a new error in is
// put back, every file of it.
//
// ── HANDOFF.md ages out the same way ─────────────────────────────────────────
//
// `rotateHandoff` keeps the two newest sessions by the date in their heading
// and moves the rest into `docs/handoff-archive/<YYYY-MM>.md`, newest first. A
// relative link written from the root breaks one directory down, so every link
// in a month file that does not resolve from there but does from HANDOFF.md's
// directory is rebased — the moved entries, and any older ones archived before
// this did it. A rewrite that leaves more links broken than it found is not
// written.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname, relative }                  from 'node:path'
import { execFileSync }                                      from 'node:child_process'

import { registerLayout }         from './registers.js'
import { errorKeys, newErrors, describeNewErrors } from './register-check.js'

export const KEEP = 40
export const KEEP_SESSIONS = 2

const ARCHIVE_HEAD = [
  '# Issues — archive',
  '',
  '0 rows · newest first.',
  '',
  '| Id | Title | Closed | How |',
  '| --- | --- | --- | --- |',
]

/**
 * Move every § Closed row past the newest `keep` into ISSUES_ARCHIVE.md.
 *
 * Answers `{ ok: true, moved, kept, archived, relinked }` or
 * `{ ok: false, reason }`. `moved: 0` is a success: there was nothing to trim.
 */
export function archiveClosed({ root, keep = KEEP, dry = false }) {
  const { dir, prefix } = registerLayout(root)
  if (!prefix) return refuse('package.json declares no usable registers.prefix, so no row can be read')
  if (!Number.isInteger(keep) || keep < 0) return refuse(`--keep must be a whole number, not ${keep}`)

  const issuesAbs  = join(dir, 'ISSUES.md')
  const archiveAbs = join(dir, 'ISSUES_ARCHIVE.md')
  if (!existsSync(issuesAbs)) return refuse(`${issuesAbs} does not exist`)

  const issuesBefore  = readFileSync(issuesAbs, 'utf8')
  const archiveBefore = existsSync(archiveAbs) ? readFileSync(archiveAbs, 'utf8') : null

  const issues = issuesBefore.split('\n')
  const body   = tableBody(issues, /^Closed/i)
  if (!body) return refuse('ISSUES.md has no § Closed table')

  const rows = issues.slice(body.start, body.end)
  if (rows.length <= keep) return { ok: true, moved: 0, kept: rows.length, archived: null, relinked: { files: 0, links: 0 } }
  if (dry) return { ok: true, dry: true, moved: rows.length - keep, kept: keep }

  const moving = rows.slice(keep)
  issues.splice(body.start + keep, moving.length)

  const moved = new Set(moving.flatMap(anchorsIn))
  const stays = new Set(issues.flatMap(anchorsIn))

  // A same-file link crosses a file boundary when one end moves and the other
  // does not.
  const issuesText = issues.join('\n').replace(/\]\(#([^)\s]+)\)/g, (m, id) =>
    moved.has(id) ? `](ISSUES_ARCHIVE.md#${id})` : m)
  const movingRows = moving.map(row => row.replace(/\]\(#([^)\s]+)\)/g, (m, id) =>
    stays.has(id) ? `](ISSUES.md#${id})` : m))

  const archive = (archiveBefore ?? ARCHIVE_HEAD.join('\n') + '\n').split('\n')
  const into    = tableBody(archive, null)
  if (!into) return refuse('ISSUES_ARCHIVE.md has no `| Id |` table to move the rows into')
  archive.splice(into.start, 0, ...movingRows)
  const archiveText = recount(archive).join('\n')

  const baseline = errorKeys(root)
  const written  = new Map([[issuesAbs, issuesBefore], [archiveAbs, archiveBefore]])
  writeFileSync(issuesAbs, issuesText)
  writeFileSync(archiveAbs, archiveText)

  const relinked = relink({ root, issuesAbs, moved, written })

  const added = newErrors(baseline, root)
  if (added.length) {
    putBack(written)
    return refuse(`the trim was put back: register:check found ${describeNewErrors(added)}`)
  }

  return { ok: true, moved: moving.length, kept: keep, archived: countRows(archive), relinked }
}

// ─── HANDOFF.md ───────────────────────────────────────────────────────────────

const SESSION = /^# Handoff — (\d{4}-\d{2}-\d{2})\b/

/**
 * Move every HANDOFF.md session past the newest `keep` into its month's file
 * under `docs/handoff-archive/`.
 *
 * Answers `{ ok: true, moved, kept, months }` or `{ ok: false, reason }`. A
 * project with no HANDOFF.md has nothing to rotate, which is a success.
 */
export function rotateHandoff({ root, keep = KEEP_SESSIONS, dry = false }) {
  const { dir }      = registerLayout(root)
  const handoffAbs   = join(dir, 'HANDOFF.md')
  const archiveDir   = join(dir, 'docs', 'handoff-archive')
  if (!existsSync(handoffAbs)) return { ok: true, moved: 0, kept: 0, months: [] }

  const { head, entries } = splitSessions(readFileSync(handoffAbs, 'utf8'))
  // By date, not position: an entry written late lands wherever its author put it.
  const byDate = entries.map((e, i) => ({ ...e, i })).sort((a, b) => b.date.localeCompare(a.date) || a.i - b.i)
  const staying = new Set(byDate.slice(0, keep).map(e => e.i))
  const moving  = entries.filter((_, i) => !staying.has(i))
  if (!moving.length) return { ok: true, moved: 0, kept: entries.length, months: [] }

  const months = [...new Set(moving.map(e => e.date.slice(0, 7)))].sort().reverse()
  if (dry) return { ok: true, dry: true, moved: moving.length, kept: keep, months }

  const writes = new Map()
  let brokenBefore = 0, brokenAfter = 0
  for (const month of months) {
    const abs      = join(archiveDir, `${month}.md`)
    const existing = existsSync(abs) ? splitSessions(readFileSync(abs, 'utf8')) : { head: `# Handoff archive — ${month}\n`, entries: [] }
    const incoming = moving.filter(e => e.date.startsWith(month))

    brokenBefore += incoming.reduce((n, e) => n + brokenLinks(e.text, dir), 0)
                  + existing.entries.reduce((n, e) => n + brokenLinks(e.text, archiveDir), 0)

    // Moved entries are newer than anything archived on the same date.
    const all = [...incoming, ...existing.entries]
      .map((e, i) => ({ ...e, i, text: rebase(e.text, dir, archiveDir) }))
      .sort((a, b) => b.date.localeCompare(a.date) || a.i - b.i)
    brokenAfter += all.reduce((n, e) => n + brokenLinks(e.text, archiveDir), 0)

    writes.set(abs, joinSessions(existing.head, all))
  }
  if (brokenAfter > brokenBefore) return refuse(`the rotation was not written: it would leave ${brokenAfter - brokenBefore} more relative links broken`)

  mkdirSync(archiveDir, { recursive: true })
  for (const [abs, text] of writes) writeFileSync(abs, text)
  writeFileSync(handoffAbs, joinSessions(head, entries.filter((_, i) => staying.has(i))))

  return { ok: true, moved: moving.length, kept: keep, months }
}

// `head` is everything above the first session heading; each entry runs to the
// next one, its trailing rule and blank lines dropped so the join restates them.
function splitSessions(text) {
  const lines = text.split('\n')
  const starts = lines.flatMap((l, i) => SESSION.test(l) ? [i] : [])
  if (!starts.length) return { head: text, entries: [] }
  const head = trimTail(lines.slice(0, starts[0])).join('\n') + '\n'
  const entries = starts.map((s, k) => ({
    date: lines[s].match(SESSION)[1],
    text: trimTail(lines.slice(s, starts[k + 1] ?? lines.length)).join('\n'),
  }))
  return { head, entries }
}

function trimTail(lines) {
  let end = lines.length
  while (end > 0 && /^\s*(---)?\s*$/.test(lines[end - 1])) end--
  return lines.slice(0, end)
}

function joinSessions(head, entries) {
  return [head.trimEnd(), ...entries.map(e => e.text)].join('\n\n---\n\n') + '\n'
}

// A relative markdown link's file part, resolved from `from`.
const LINK = /\]\((?!https?:|mailto:|#|\/)([^)\s#]+)(#[^)\s]*)?\)/g

function rebase(text, from, to) {
  return text.replace(LINK, (m, path, hash = '') => {
    if (existsSync(resolve(to, path)) || !existsSync(resolve(from, path))) return m
    return `](${relative(to, resolve(from, path))}${hash})`
  })
}

function brokenLinks(text, from) {
  return [...text.matchAll(LINK)].filter(m => !existsSync(resolve(from, m[1]))).length
}

// ─── the table ────────────────────────────────────────────────────────────────

// `{ start, end }` of the row lines under the first `| Id |` table in the
// section whose heading matches `section` (any section when null) — `end` is
// the first line after the table.
function tableBody(lines, section) {
  let inSection = section === null
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^##\s+(.+?)\s*$/)
    if (heading && section) { inSection = section.test(heading[1]); continue }
    if (!inSection) continue
    if (/^\|\s*Id\s*\|/i.test(lines[i]) && /^\|\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      let end = i + 2
      while (end < lines.length && /^\|/.test(lines[end])) end++
      return { start: i + 2, end }
    }
  }
  return null
}

// The archive's `N rows · closed A → B · newest first.` line, restated from
// the rows it now holds. A header without the line is left as it is.
function recount(lines) {
  const at = lines.findIndex(l => /^\d+ rows · /.test(l))
  if (at === -1) return lines
  const body  = tableBody(lines, null)
  const dates = lines.slice(body.start, body.end)
    .map(row => splitRow(row)[2])
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d ?? ''))
    .sort()
  const span = dates.length ? ` · closed ${dates[0]} → ${dates.at(-1)}` : ''
  lines[at] = `${body.end - body.start} rows${span} · newest first.`
  return lines
}

function countRows(lines) {
  const body = tableBody(lines, null)
  return body ? body.end - body.start : 0
}

// ─── the links ────────────────────────────────────────────────────────────────

// Every markdown file git sees (tracked or not, ignored excluded). A tree that
// is not a repository relinks nothing and says so through `files: 0`.
function markdownFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\0').filter(Boolean).map(f => join(root, f))
  } catch { return [] }
}

function relink({ root, issuesAbs, moved, written }) {
  let files = 0, links = 0
  for (const abs of markdownFiles(root)) {
    if (!existsSync(abs)) continue
    const src = readFileSync(abs, 'utf8')
    if (!src.includes('ISSUES.md#')) continue

    let n = 0
    const out = src.replace(/\]\(([^)\s#]*?)ISSUES\.md#([^)\s]+)\)/g, (m, path, id) => {
      if (!moved.has(id) || resolve(dirname(abs), `${path}ISSUES.md`) !== issuesAbs) return m
      n++
      return `](${path}ISSUES_ARCHIVE.md#${id})`
    })
    if (!n) continue

    if (!written.has(abs)) written.set(abs, src)
    writeFileSync(abs, out)
    files++
    links += n
  }
  return { files, links }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function refuse(reason) { return { ok: false, reason } }

function putBack(written) {
  for (const [abs, text] of written) if (text !== null) writeFileSync(abs, text)
}

function anchorsIn(line) {
  return [...line.matchAll(/<a\s+id="([^"]+)"/g)].map(m => m[1])
}

// Unescaped pipes only, the same split `registers.js` reads the row with.
function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map(c => c.trim())
}
