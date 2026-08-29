// ─── preflight.js — what a drive needs started before it ─────────────────────
//
// `CLAUDE.md`'s drive table carries a *Start first* column — `verify:live` needs
// `db:seed`, then `api` and `web`; `verify:cart` needs nothing because it starts
// and stops both servers itself — and until this module nothing read it. So the
// dashboard offered a start button that ran a drive into an exit 1, and the only
// machine-readable form of the answer was that exit 1.
//
// ── Why the table and not a declaration ─────────────────────────────────────
//
// `IDEAS/control-surface.md` §7 weighed two ways out: declare the preamble
// beside the script (`"fli": { "needs": [...] }`), or make the drive's own
// refusal structured (`verify:live --preflight`). It preferred the second and
// rejected the first as a THIRD copy that can drift.
//
// This is neither, and it dominates the first on exactly that argument: reading
// the prose table adds no copy at all. It is the copy people already maintain,
// finally read — the same move `proofs.js` made on the table beside it. What it
// does not close is drift against the drive's own check, which no parse can
// reach; `--preflight` is still the way to close that half, and the `check` rule
// below closes the half that actually bites, which is a renamed script.
//
// ── The order is the content ────────────────────────────────────────────────
//
// The cell is ordered prose — *`db:seed`, then `api` + `web`* — and the order is
// the whole of what a caller needs. Grouping is deliberately dropped: `+` means
// two things that may run at once, and running them in sequence instead is
// always safe, so a flat ordered list loses nothing but concurrency nobody asked
// for. Two rows say `api` + `build:site`, where the second genuinely needs the
// first, and a parser that honoured the `+` would race them.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbours.

import { readFileSync } from 'node:fs'
import { join }         from 'node:path'

import { resolveWhere, splitRow } from './proofs.js'

// ─── the parse ────────────────────────────────────────────────────────────────

/**
 * The rows of `CLAUDE.md`'s drive table, as written.
 *
 * `[]` where the file or the table is absent, which is correct for any project
 * that is not this one. Each row is `{ dir, script, cell, line, needs }`, and
 * `needs` is an ordered list of `{ script, run }` — the SCRIPT this drive's
 * directory must run first, in the order the cell states it.
 */
export function readPreambles(root) {
  const src = read(join(root, 'CLAUDE.md'))
  if (!src) return []

  const out = []
  let inTable = false
  let lineNo  = 0

  for (const line of src.split('\n')) {
    lineNo++
    if (/^\|\s*Drive\s*\|\s*Start first\s*\|/i.test(line)) { inTable = true; continue }
    if (inTable && !line.startsWith('|')) break
    if (!inTable || /^\|\s*-+/.test(line)) continue

    const cells = splitRow(line)
    if (cells.length < 2) continue

    const drive = parseDrive(cells[0], root)
    if (!drive) continue

    out.push({ ...drive, cell: cells[1].trim(), line: lineNo, needs: parseNeeds(cells[1]) })
  }

  return out
}

/**
 * `` `example`: `verify` `` → `{ dir: 'example', script: 'verify' }`.
 *
 * `bun run ` is stripped, because one row writes the target that way and the
 * rest write the bare script — two spellings of one thing, and the key has to
 * be one of them.
 */
function parseDrive(cell, root) {
  const m = cell.match(/`([^`]+)`\s*:\s*`([^`]+)`/)
  if (!m) return null
  const dir = resolveWhere(m[1], root)
  if (dir === null) return null
  return { dir, script: m[2].replace(/^bun run /, '').trim() }
}

/**
 * The ordered scripts a *Start first* cell names.
 *
 * `nothing` is the explicit empty answer and every row that has no preamble
 * says it — a blank cell would read as *nobody has written this down yet*,
 * which is a different fact.
 *
 * Backticks after an em-dash are prose (*`bun run build:site` — it starts the
 * API and the storefront itself*), so the scan stops there: a naive one turns
 * every parenthetical into a step that resolves to nothing, which is the shape
 * of the failure the rule below exists to report.
 */
function parseNeeds(cell) {
  const text = cell.split('—')[0]
  if (/^\s*nothing\b/i.test(cell)) return []

  const out  = []
  const seen = new Set()
  for (const m of text.matchAll(/`bun run ([^`]+)`/g)) {
    const script = m[1].trim()
    if (seen.has(script)) continue
    seen.add(script)
    out.push({ script, run: `bun run ${script}` })
  }
  return out
}

// ─── resolving it against what can run ────────────────────────────────────────

/**
 * The preambles, keyed `<dir>/<script>` — the same key `runnables()` builds a
 * drive id from, so attaching one to the other is a lookup rather than a match.
 */
export function preambleIndex(root) {
  const out = new Map()
  for (const p of readPreambles(root)) out.set(`${p.dir}/${p.script}`, p)
  return out
}

/**
 * A preamble's steps against the rows that could run them.
 *
 * A step resolves to the row in the drive's OWN directory whose start command
 * is that script — `bun run api` is `example`'s API surface, `bun run db:seed`
 * its seed task. `id: null` is the finding: the table names a script that
 * directory does not declare, which reads exactly like a step that is right.
 */
export function resolveNeeds(needs, dir, rows) {
  return needs.map(n => {
    const row = rows.find(r => r.dir === dir && r.start === n.run)
    return {
      ...n,
      id:   row?.id   ?? null,
      kind: row?.kind ?? null,
      port: row?.port ?? null,
    }
  })
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function read(path) { try { return readFileSync(path, 'utf8') } catch { return null } }

// Kept for a caller that wants to know whether the table is there at all before
// grading anything against it.
export function hasPreambleTable(root) {
  const src = read(join(root, 'CLAUDE.md'))
  return Boolean(src && /^\|\s*Drive\s*\|\s*Start first\s*\|/im.test(src))
}
