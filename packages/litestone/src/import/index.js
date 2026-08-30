// index.js — read a foreign schema into .lite, and say where it stopped being
// faithful.
//
// Four front-ends, one contract: **the output is not the whole answer, the
// refusal list is.** Every construct a reader cannot express is recorded with
// its model, its field, what the source said and what was emitted instead — so
// the person holding the result is told what it cost, rather than finding out
// from a migration months later. A converter that quietly repairs its input is
// one that cannot report anything, which is why none of these repair.
//
// The grading below is what makes that list readable at all: seven real schemas
// produced 2,178 records, and reading them undifferentiated is the same as not
// reading them.
//
//   changed  the output says something the SOURCE DOES NOT.
//   lost     the source says something the output does not.
//   noted    a decision only the author can make, or a translation that is exact.
//
// The table itself is `./tiers.js`, because `tools/introspect.js` grades by it
// too — a live SQLite database is a source like any other, and two tables would
// be two answers to *how bad is this*. Re-exported here so a caller reaching for
// the importer gets the grading with it.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename, extname }             from 'node:path'

import { convert as prisma } from './prisma.js'
import { convert as rails }  from './rails.js'
import { convert as sql }    from './sql.js'
import { convert as frappe } from './frappe.js'

export const READERS = { prisma, rails, sql, frappe }
export const FORMATS = Object.keys(READERS)

// ─── grading ─────────────────────────────────────────────────────────────────
//
// Re-exported AND imported: `export … from` re-publishes without binding, and
// `convert`/`annotate` below call both of these.

export { TIERS, tierOf, gradedKinds, summarise } from './tiers.js'
import  { tierOf, summarise }                    from './tiers.js'

// ─── reading a source off disk ───────────────────────────────────────────────

// The format is a fact about the file, so it is detected rather than demanded —
// but `--from` always wins, because a dump named `.txt` is still a dump.
export function detectFormat(path) {
  const name = basename(path)
  const ext  = extname(name).toLowerCase()
  if (ext === '.prisma')                        return 'prisma'
  if (name === 'schema.rb' || ext === '.rb')    return 'rails'
  if (ext === '.sql')                           return 'sql'
  if (isDirectory(path))                        return 'frappe'
  return null
}

const isDirectory = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

// A Frappe app keeps one JSON per doctype, so its source is a DIRECTORY and the
// reader is handed parsed documents rather than a string. Every other reader
// takes the file's text.
export function loadSource(path, format = detectFormat(path)) {
  if (!format) throw new Error(
    `cannot tell what kind of schema ${basename(path)} is — name the format with --from=${FORMATS.join('|')}`)
  if (format !== 'frappe') return { format, source: readFileSync(path, 'utf8') }

  if (!isDirectory(path)) throw new Error(
    `--from=frappe wants a DIRECTORY of DocType JSON, not a file: ${path}`)
  const docs = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (isDirectory(p)) { walk(p); continue }
      if (!entry.endsWith('.json')) continue
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'))
        if (j && j.doctype === 'DocType') docs.push(j)
      } catch { /* a .json that is not a doctype */ }
    }
  }
  walk(path)
  if (!docs.length) throw new Error(`no DocType JSON under ${path} — is this a Frappe app?`)
  return { format, source: docs }
}

// ─── converting ──────────────────────────────────────────────────────────────

export function convert({ source, format, label = 'schema' }) {
  const read = READERS[format]
  if (!read) throw new Error(`unknown format '${format}' — one of ${FORMATS.join(', ')}`)
  const { lite, gaps, models } = read(source, label)
  return { lite, gaps, models, format, summary: summarise(gaps) }
}

// ─── saying it in the file itself ────────────────────────────────────────────

// The terminal scrolls away and the .lite file does not, so the warning has to
// live where the person will be reading six months from now. Two halves: a
// header carrying the counts, and a marker on the LINE a `changed` gap is about
// — which is the only place a reader is looking when the value turns out wrong.
export function annotate(lite, gaps) {
  const changed = gaps.filter(g => tierOf(g.kind) === 'changed')
  if (!changed.length) return lite

  const byModel = new Map()
  for (const g of changed) {
    if (!g.model) continue
    const list = byModel.get(g.model) ?? []
    list.push(g)
    byModel.set(g.model, list)
  }

  const camel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase())
  const out   = lite.split('\n')
  let model = null, pending = null

  for (let i = 0; i < out.length; i++) {
    const open = out[i].match(/^model (\w+) \{/)
    if (open) {
      model   = open[1]
      pending = (byModel.get(model) ?? []).slice()
      // A model-level gap (an invented key) belongs on the declaration line.
      mark(out, i, pending.filter(g => !g.field))
      pending = pending.filter(g => g.field)
      continue
    }
    if (!model) continue
    if (/^\}/.test(out[i])) { model = null; pending = null; continue }

    const field = out[i].match(/^  (\w+) /)?.[1]
    if (!field || !pending?.length) continue
    const hits = pending.filter(g => g.field === field || camel(g.field) === field)
    if (!hits.length) continue
    mark(out, i, hits)
    pending = pending.filter(g => !hits.includes(g))
  }
  return out.join('\n')
}

const mark = (out, i, hits) => {
  if (!hits.length) return
  out[i] += '  // ⚠ imported: ' + hits.map(h => `${h.detail} → ${h.emitted}`).join(' · ')
}

export function fileHeader({ format, path, models, summary }) {
  const lines = [
    `// Imported from ${path ?? `a ${format} schema`}.`,
    `//`,
    `// Read mechanically by \`litestone import --from ${format}\`. ${models} models.`,
  ]
  if (!summary.total) {
    lines.push(`// Nothing in the source went unexpressed.`)
  } else {
    lines.push(
      `//`,
      `// **${summary.total} constructs did not survive the reading**, and the counts are`,
      `// the point rather than the total:`,
      `//`,
      `//   ${String(summary.changed).padStart(4)} changed  the schema below says something the source does not`,
      `//   ${String(summary.lost).padStart(4)} lost     the source says something the schema below does not`,
      `//   ${String(summary.noted).padStart(4)} noted    a decision for you, not a defect`,
      `//`,
      summary.changed
        ? `// Every \`changed\` one is marked on its own line with \`// ⚠ imported:\`.\n` +
          `// Read those before trusting a column. Re-run with --report for the rest.`
        : `// Re-run with --report=<path> for the whole list.`,
    )
  }
  return lines.join('\n') + '\n\n'
}
