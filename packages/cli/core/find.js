// ─── find.js — searching the registers for a row ─────────────────────────────
//
// The reader behind `fli register:find`. Before it, *is this already filed?*
// was a grep over a 2.3 MB `ISSUES.md` whose rows are single lines of 1–3k
// characters, so one `grep -A` to see a match in context returned 29k — and a
// stressor asked it before every filing, 712 calls over 77 sessions (`FJS-1546`).
//
// ── What it answers ─────────────────────────────────────────────────────────
//
// The id, status, area, title and `file:line` of every issue row (open tables,
// § Closed, the archive) and every ruling whose text holds ALL the terms,
// case-folded. Never the body: the title is what decides whether to read the
// row, and the `file:line` is how to read just that one.
//
// A row whose id, area or title holds every term ranks above one where only the
// body does, and open above closed within each — the dedupe question is *is
// there an open row*, and the closed one is the regression's citation.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { readRegisters } from './registers.js'

/**
 * Search the registers.
 *
 * Answers `{ ok: true, total, hits: [{ kind, id, status, severity, area, title, file, line, where }] }`
 * — `where` is `title` or `body` — or `{ ok: false, reason }`.
 */
export function findRows({ root, terms, limit = 20 }) {
  const doc = readRegisters(root)
  if (!doc.prefix) return refuse('package.json declares no usable registers.prefix, so no row can be read')

  const want = String(terms ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!want.length) return refuse('name at least one term — an id, a word from the title, a package')

  const hits = []
  for (const r of [...doc.issues, ...doc.decisions]) {
    const head = [r.id, ...(r.aliases ?? []), ...(r.pkg ?? []), r.title].join(' ').toLowerCase()
    const all  = `${head} ${r.body ?? ''}`.toLowerCase()
    if (!want.every(t => all.includes(t))) continue
    hits.push({ record: r, where: want.every(t => head.includes(t)) ? 'title' : 'body' })
  }

  hits.sort((a, b) => rank(a) - rank(b))

  return {
    ok:    true,
    total: hits.length,
    hits:  hits.slice(0, limit).map(({ record: r, where }) => ({
      kind:     r.kind,
      id:       r.id ?? '(no id)',
      status:   statusOf(r),
      // § Closed has no severity to read; `other` is the reader saying so.
      severity: r.kind === 'issue' && r.severity !== 'other' ? r.severity : null,
      area:     (r.pkg ?? []).join(' · '),
      title:    r.title,
      file:     r.file,
      line:     r.line,
      where,
    })),
  }
}

// Title before body, then open issue · ruling · closed issue. Stable, so rows
// keep register order within a rank — the open tables and § Closed run newest
// first.
function rank({ record: r, where }) {
  const place = r.kind === 'decision' ? 1 : r.closed ? 2 : 0
  return (where === 'title' ? 0 : 3) + place
}

// A ruling's status is absent while it is in force (`FJS-D196`).
function statusOf(r) {
  if (r.kind === 'decision') return r.status ?? 'ruling'
  return r.status
}

function refuse(reason) { return { ok: false, reason } }
