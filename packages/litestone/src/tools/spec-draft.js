// spec-draft.js — litestone as built, filed under the spec entries it would fill
//
// A working draft, not a ruling. `IDEAS/specifications.md` lists the entries a
// specification would hold; this collects, for each one litestone holds, what the
// code does today: the catalog rows that belong to it, the JSON form it already
// emits, the places it still names its host, and the tests that pin it.
//
// Every list is read from the module that owns it. A list retyped here would be
// a second copy that agrees until the day it does not, and a draft that
// disagrees with the code is worse than no draft.
//
// The one check that matters is in `sectionOf`: a catalog row that lands in no
// section, or in two, throws. A word silently dropped from the page is the
// failure this page exists to prevent, and a new `.lite` word has no section
// until somebody places it.
//
// Rendered by `litestone spec`. NOT gated: no `--check`, nothing in CI reruns it.
// Never imported by production code.

import { execSync }                 from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CATALOG, POSITIONS, positionsOf, typed } from '../core/catalog.js'
import { ANNOUNCE_MODES } from '../core/hooks.js'
import { WRITE_EVENT_KINDS, WRITE_EVENT_SCOPES } from '../core/write-events.js'
import { REFUSED_BY } from '../core/policy.js'
import { buildLogEntry } from '../core/audit-log.js'
import { trailMarksOf, markOf } from '../core/trail-entries.js'
import { PIVOT_RANK, ACCESS_RANK } from '../release.js'

const TEST_DIR = resolve(import.meta.dirname, '../../test')
const SRC_DIR  = resolve(import.meta.dirname, '..')

const keyOf = row => `${row.level}/${row.word}`

// Words that belong to an entry the catalog's groups do not name. A group says
// what a word does to a row; these say which lifecycle, tenancy or audit rule it
// is part of.
const PLACED = new Map([
  ...['model/transitions', 'field/version', 'field/sealed', 'model/softDelete',
      'field/hardDelete', 'field/keep'].map(k => [k, 'lifecycle']),
  ...['schema/tenancy', 'schema/claim', 'model/tenant'].map(k => [k, 'tenancy']),
  ...['field/trail', 'model/trail'].map(k => [k, 'audit']),
])

const inGroups = (...groups) => row => !PLACED.has(keyOf(row)) && row.level !== 'transition' && groups.includes(row.group)

// Host terms, case-sensitive where the word is also English.
const HOST_TERMS = [
  [/\bsqlite-vec\b/i, 'sqlite-vec'], [/\bsqlite\b/i, 'SQLite'], [/\bBun\b/, 'Bun'], [/\bFTS5\b/, 'FTS5'],
  [/\bWAL\b/, 'WAL'], [/\bPRAGMA\b/, 'PRAGMA'], [/\bjson_extract\b/i, 'json_extract'],
  [/\bSTRICT\b/, 'STRICT'], [/\browid\b/i, 'rowid'],
]

const mdText = text =>
  String(text).split(/(`[^`]*`)/).map((p, i) => i % 2 ? p : p.replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('')

const firstSentence = text => {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.split(/(?<=[.!?])\s(?=[A-Z`@(])/)[0]
}

const cell = text => String(text).replace(/\|/g, '\\|')

// ─── JSON-form readers ─────────────────────────────────────────────────────────

// jsonschema.js builds its keywords inline and exports no list, so this reads the
// quoted names out of the source. A keyword assembled from a variable is missed.
function jsonSchemaKeywords() {
  const src = readFileSync(resolve(SRC_DIR, 'jsonschema.js'), 'utf8')
  return [...new Set([...src.matchAll(/'(x-[a-z][a-z-]*)'/g)].map(m => m[1]))].sort()
}

// The entry's field list is whatever buildLogEntry returns for the smallest call
// it accepts, so a field added there appears here.
function trailEntryFields() {
  const entry = buildLogEntry({ operation: 'create', model: 'M', records: [] },
                              { auth: null, isSystem: false, _logContext: null }, undefined)
  return Object.keys(entry)
}

function redactionMarks() {
  const marks = trailMarksOf({ a: { encrypted: true }, b: { personal: true }, c: { opaque: true } })
  return [...marks.values()].map(m => markOf(m, 'x').replace(/^(\[opaque:).*\]$/, '$1<digest>]'))
}

const code = list => list.map(w => `\`${w}\``).join(' · ')

// ─── the entries ───────────────────────────────────────────────────────────────

const SECTIONS = [
  {
    id: 'model', n: 1, title: 'Model description',
    has: inGroups('declare', 'identity', 'relate', 'derive', 'stamp', 'transform', 'validate', 'shape'),
    json: () => ({
      name: '`generateJsonSchema` (`src/jsonschema.js`) and its `x-*` keywords, the nearest thing to a schema IR',
      lines: [`${jsonSchemaKeywords().length} keywords, read from the source text of \`src/jsonschema.js\`: ` +
              code(jsonSchemaKeywords())],
    }),
    tests: ['catalog.test.ts', 'reference.test.ts', 'identifying-keys.test.ts', 'queryability.test.ts',
            'messages.test.ts', 'valuesets.test.ts'],
  },
  {
    id: 'policy', n: 3, title: 'Row and field policy', also: '5. Field protection',
    has: inGroups('protect', 'access'),
    json: () => ({
      name: '`refusedBy` on `transitions()`, and the trail\'s redaction marks',
      lines: [`\`refusedBy\`: ${code(REFUSED_BY)} · \`null\` when allowed (\`REFUSED_BY\`, \`src/core/policy.js\`)`,
              `Redaction marks a protected, personal and opaque field takes: ${code(redactionMarks())} ` +
              '(`trailMarksOf`, `src/core/trail-entries.js`)'],
    }),
    tests: ['policy-interpreters.test.ts', 'field-policy-compose.test.ts', 'policy-delegation.test.ts',
            'policy-paths.test.ts', 'undeclared-access.test.ts', 'unique-redaction.test.ts', 'verbs-rules.test.ts'],
  },
  {
    id: 'announce', n: 8, title: 'Write announcement',
    has: () => false,
    json: () => ({
      name: 'the write event',
      lines: [`\`event\`: ${code(WRITE_EVENT_KINDS)} (\`WRITE_EVENT_KINDS\`, \`src/core/write-events.js\`)`,
              `\`scope\`: ${code(WRITE_EVENT_SCOPES)} (\`WRITE_EVENT_SCOPES\`)`,
              `bulk \`announce\`: ${code(ANNOUNCE_MODES)} (\`ANNOUNCE_MODES\`, \`src/core/hooks.js\`)`],
    }),
    tests: ['write-events.test.ts'],
  },
  {
    id: 'audit', n: 9, title: 'Audit trail',
    has: row => PLACED.get(keyOf(row)) === 'audit',
    json: () => ({
      name: 'the trail entry',
      lines: [`Entry fields: ${code(trailEntryFields())} (\`buildLogEntry\`, \`src/core/audit-log.js\`, called with the smallest input it accepts)`],
    }),
    tests: ['trail-batch.test.ts', 'trail-bytes.test.ts', 'trail-gate.test.ts', 'trail-json-decode.test.ts',
            'trail-model-name.test.ts', 'trail-scoped-redaction.test.ts', 'sql-audit-trail.test.ts'],
  },
  {
    id: 'evolution', n: 10, title: 'Schema evolution',
    has: () => false,
    json: () => ({
      name: 'the pivot verdict',
      lines: [`\`classifyPivot\` verdicts, mildest first: ${code(Object.keys(PIVOT_RANK))} (\`PIVOT_RANK\`, \`src/release.js\`)`,
              `\`classifyAccess\` verdicts, mildest first: ${code(Object.keys(ACCESS_RANK))} (\`ACCESS_RANK\`)`],
    }),
    tests: ['release.test.ts', 'migration-history.test.ts', 'migrations-fixes.test.ts', 'migration-residue.test.ts'],
  },
  {
    id: 'lifecycle', n: 6, title: 'Lifecycle semantics',
    has: row => PLACED.get(keyOf(row)) === 'lifecycle' || row.level === 'transition',
    json: () => null,
    tests: ['audit-transition.test.ts', 'bulk-transitions.test.ts', 'system-transitions.test.ts',
            'transition-visibility.test.ts', 'transitions-declared-by.test.ts', 'transition-entry.test.ts',
            'soft-delete-index.test.ts', 'soft-delete-self-relation.test.ts'],
  },
  {
    id: 'tenancy', n: 7, title: 'Tenancy',
    has: row => PLACED.get(keyOf(row)) === 'tenancy',
    json: () => null,
    tests: ['tenancy.test.ts', 'tenant-isolation.test.ts', 'tenant-create.test.ts', 'tenancy-delegation.test.ts'],
  },
]

const HOST = {
  id: 'host', title: 'Host wiring (stays implementation)',
  has: row => !PLACED.has(keyOf(row)) && row.group === 'operate',
}

/**
 * The section every catalog row lands in. Throws unless it is exactly one.
 */
function partition() {
  const all  = [...SECTIONS, HOST]
  const rows = new Map(all.map(s => [s.id, []]))
  for (const row of CATALOG) {
    const hits = all.filter(s => s.has(row))
    if (hits.length !== 1)
      throw new Error(`spec: catalog row ${keyOf(row)} (group ${row.group}) lands in ${hits.length} sections` +
                      `${hits.length ? ` (${hits.map(s => s.id).join(', ')})` : ''}. ` +
                      'Place it in SECTIONS or PLACED in src/tools/spec-draft.js.')
    rows.get(hits[0].id).push(row)
  }
  return rows
}

function hostLeaks(rows) {
  const out = []
  for (const row of rows) {
    const hay = [row.blurb, row.arity, row.note].filter(Boolean).join('\n')
    const hit = HOST_TERMS.filter(([re]) => re.test(hay)).map(([, name]) => name)
    if (hit.length) out.push({ row, terms: hit })
  }
  return out
}

function vocabulary(rows, push) {
  if (!rows.length) { push('*No catalog row belongs to this entry: it is stated by behavior, not by a `.lite` word.*', ''); return }
  push('| word | where legal | accepts | meaning |', '| --- | --- | --- | --- |')
  for (const row of rows)
    push(`| \`${typed(row)}\` | ${positionsOf(row).map(p => POSITIONS[p] ?? p).join(' · ')} | ` +
         `${row.arity ? `\`${cell(row.arity)}\`` : '—'} | ${cell(mdText(firstSentence(row.blurb)))} |`)
  push('')
  const valued = rows.filter(r => r.values)
  for (const row of valued)
    for (const v of row.values)
      push(`- \`${typed(row)}\` **\`${v.arg}\`** takes ${v.of.map(e => `\`${typeof e === 'string' ? e : e.value}\``).join(' · ')}`)
  if (valued.length) push('')
}

// An ungated page is read later than it was written, so it says which tree it describes.
function commitOf() {
  try {
    const sha   = execSync('git rev-parse --short HEAD', { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execSync('git status --porcelain -- .', { cwd: resolve(import.meta.dirname, '../..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return dirty ? `${sha} + uncommitted litestone changes` : sha
  } catch { return 'no git checkout' }
}

export function renderSpecDraft() {
  const out  = []
  const push = (...l) => out.push(...l)
  const rowsOf = partition()

  push('# Litestone — specification working draft', '')
  push('<!-- generated by: litestone spec -->', '')
  push('Generated by `litestone spec`. **Do not edit.** Not gated in CI; rebuilt when someone asks.', '')
  push(`Generated ${new Date().toISOString()} from \`${commitOf()}\`.`, '')
  push('This is litestone as it is implemented, grouped by the entries of',
       '`IDEAS/specifications.md`. A section drafts what a spec entry would state; it is not a ruling,',
       'and nothing here is frozen until a second implementation passes conformance vectors.',
       'The status line under each section is the four criteria of that file, answered from this tree.', '')
  push(`**${CATALOG.length} catalog rows** placed across ${SECTIONS.length} entries and host wiring.`, '')

  for (const s of SECTIONS) {
    const rows  = rowsOf.get(s.id)
    const leaks = hostLeaks(rows)
    const json  = s.json()
    const tests = s.tests.map(t => {
      const path = resolve(TEST_DIR, t)
      if (!existsSync(path)) throw new Error(`spec: entry ${s.n} names test/${t}, which does not exist`)
      return t
    })

    push(`## ${s.n}. ${s.title}${s.also ? ` (with ${s.also})` : ''}`, '')

    push('### Vocabulary', '', `${rows.length} catalog ${rows.length === 1 ? 'row' : 'rows'}.`, '')
    vocabulary(rows, push)

    push('### JSON form today', '')
    if (json) push(`${json.name}.`, '', ...json.lines.map(l => `- ${l}`), '')
    else push('*No module exports a shape for this entry.* A spec would have to author one.', '')

    push('### Host leaks', '')
    if (leaks.length)
      push(...leaks.map(l => `- \`${typed(l.row)}\` — ${l.terms.join(', ')}`), '')
    else push('*None found in a blurb, arity or note.*', '')

    push('### Vectors today', '', ...tests.map(t => `- \`test/${t}\``), '')

    push('### Status', '')
    push(`${leaks.length ? '[ ]' : '[x]'} neutral semantics${leaks.length ? ` (${leaks.length} host leaks)` : ''} · ` +
         `${json ? '[~]' : '[ ]'} JSON form${json ? ' (partial)' : ''} · ` +
         `[~] vectors (${tests.length} TypeScript test ${tests.length === 1 ? 'file' : 'files'}, not portable data) · ` +
         '[ ] second implementation (none)', '')
  }

  const host = rowsOf.get(HOST.id)
  push(`## ${HOST.title}`, '',
       'The `operate` group. These wire litestone to an app and a runtime, and are listed so that none is lost,',
       'not because a spec would state them.', '')
  push(`${host.length} catalog rows.`, '')
  vocabulary(host, push)
  const hostLeak = hostLeaks(host)
  if (hostLeak.length) push('Host terms here:', '', ...hostLeak.map(l => `- \`${typed(l.row)}\` — ${l.terms.join(', ')}`), '')

  push('## Held elsewhere', '')
  push('- **2. Gate ladder** — `@frontierjs/toolbelt` (`gate`).')
  push('- **4. Expression language** — `@frontierjs/toolbelt` (`predicate`).', '')

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
