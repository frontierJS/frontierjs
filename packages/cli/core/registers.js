// ─── registers.js — the three registers, read as one document ────────────────
//
// `ISSUES.md` is what is wrong, `DECISIONS.md` is what is settled, `IDEAS/` is
// what is not started. Three files in three shapes, and until now each reader
// re-derived its own: `repo-map.js` carried a regex per register, and a row it
// failed to match rendered a SMALLER register rather than an error.
//
// This is the one owner of "what does a register record look like". Everything
// that wants the registers — the map, the atlas, `register:check`, an editor —
// asks here and gets the same JSON.
//
// ── Source form, and the migration ───────────────────────────────────────────
//
// The registers are moving from three hand-parsed shapes to one: a markdown
// file per record, frontmatter for what must be typed, prose for the argument.
// `IDEAS/` is already file-per-record and reads its frontmatter here; issues and
// decisions are still a table and a run of bold paragraphs, and are read in
// their CURRENT form. Each record carries `form` — `frontmatter` or the legacy
// shape it came from — so a half-migrated tree is legible rather than silently
// mixed, and so parity between the two can be asserted while both exist.
//
// ── What is derived and what is declared ─────────────────────────────────────
//
// Declared: id, status, dates, severity, package. Those cannot be read out of
// prose without guessing, which is what frontmatter is for.
//
// Derived: `refs` (every `FJS-###` and `[[id]]` the body cites) and `files`
// (every repo-relative markdown link). A record does not restate them, because
// a declared list and the prose that already names them drift, and the prose is
// the half somebody reads.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative }                        from 'node:path'

import { splitFrontmatter } from './compiler.js'

export const REGISTERS_VERSION = 1

// ─── vocabularies ─────────────────────────────────────────────────────────────
//
// A register field is only worth typing if a value outside the set is an error
// rather than a shrug. These are the sets; `register:check` is what enforces
// them. Anything unrecognised is kept verbatim and reported, never coerced —
// silently mapping an unknown status onto a known one is how a register starts
// lying.

// `ruled` and `needs a ruling` are the two a decision-shaped row carries; the
// register writes neither of them down, they are read off whether the claim has
// been struck through.
export const ISSUE_STATUS = ['open', 'stale?', 'contested', 'ruled', 'needs a ruling', 'closed']
export const SEVERITY     = ['S1', 'S2', 'S3', 'S4']

// `idea` nothing built · 'proposal' idea has been designed and just not started  · `partial` some of it ships and the rest is the design
// · `shipped` built, kept for the argument · `argued` reasoned and not adopted
// · `assessment` a reading of the tree rather than a idea · `index` derived
// from the others.
export const IDEA_STATUS = [
  'idea',
  'proposal',
  'partial',
  'shipped',
  'argued',
  'assessment',
  'index'
]

// ─── the document ─────────────────────────────────────────────────────────────

/**
 * Every register, read off `root`. Missing files are absent rather than fatal —
 * a consuming app has no `IDEAS/`, and a reader that invents one is worse than
 * a reader that reports none.
 */
export function readRegisters(root) {
  const issues    = readIssues(root)
  const decisions = readDecisions(root)
  const ideas     = readIdeas(root)

  return {
    version: REGISTERS_VERSION,
    root,
    issues,
    decisions,
    ideas,
    ids: indexById([...issues, ...decisions, ...ideas]),
  }
}

/**
 * `id → record`, and the duplicates alongside it. An id is the register's
 * primary key and the rule is that it resolves in exactly one place — which
 * until now was prose at the top of `ISSUES.md` and enforced by nobody.
 */
function indexById(records) {
  const byId  = new Map()
  const byKind = new Map()
  const duplicates = []

  for (const r of records) {
    if (!r.id) continue
    const key = r.id.toLowerCase()
    if (!byId.has(key)) byId.set(key, r)

    // An alias resolves to the same record. A merged row retires both ids at
    // once, and a comment written against either one is still a live citation.
    for (const alias of r.aliases ?? []) {
      const a = alias.toLowerCase()
      if (!byId.has(a)) byId.set(a, r)
    }

    // A collision only means an id was REUSED when both records are the same
    // kind. An `FJS-D##` legitimately appears twice across kinds — as the
    // question, filed in `ISSUES.md`, and as the ruling that answers it — and
    // grading that pair would fire on every decision the project has taken.
    const kindKey = `${r.kind}:${key}`
    if (byKind.has(kindKey)) duplicates.push({ id: r.id, kind: r.kind, at: place(r), also: place(byKind.get(kindKey)) })
    else byKind.set(kindKey, r)
  }

  return { byId, duplicates }
}

/** Where a record is, for a message somebody has to act on. */
function place(r) {
  return { file: r.file, line: r.line ?? null }
}

// ─── issues ───────────────────────────────────────────────────────────────────
//
// Read in the legacy table form: `## S1 — blockers` sections over rows whose
// first cell is the id. Half the rows lead with their own `<a id>` anchor so a
// ruling can cite them, which is why the id is stripped rather than matched
// whole — a bare `| FJS-` test skipped every anchored row.
//
// § Closed rows and `ISSUES_ARCHIVE.md` are read too, marked `closed: true`.
// The map only ever wanted the open ones, but "does this id exist anywhere" is
// the question a check asks, and it cannot be answered from a file that stops
// at the first closed row.

const ISSUE_ROW = /^\|\s*(<a\s[^>]*>\s*<\/a>\s*)?`?FJS-/

function readIssues(root) {
  const out = []

  for (const name of ['ISSUES.md', 'ISSUES_ARCHIVE.md']) {
    const file = join(root, name)
    if (!existsSync(file)) continue

    const src     = readFileSync(file, 'utf8')
    const archive = name === 'ISSUES_ARCHIVE.md'
    let section   = null
    let lineNo    = 0
    let fence     = false
    // Which column of the table in hand holds the DATE, read off that table's
    // own header rather than assumed — the open tables and § Closed put it in
    // different places, and the header is where each says so. `null` until a
    // header has been seen, so a stray row above one is not graded.
    let dateColumn = null
    // How wide the table in hand is. A row with MORE cells than this renders
    // truncated — the excess is dropped, silently, which for § Closed took the
    // citations off 137 rows.
    let headWidth  = null

    for (const line of src.split('\n')) {
      lineNo++
      // Same rule as the rulings: a fenced block is content, never a record.
      if (/^\s*```/.test(line)) { fence = !fence; continue }
      if (fence) continue

      const heading = line.match(/^##\s+(.+?)\s*$/)
      if (heading) { section = heading[1]; dateColumn = null; headWidth = null; continue }

      // A table header. Every issue table names its date column, and which one
      // it is IS the table's shape: `Verified` while a row is open, `Closed`
      // once it is not.
      if (/^\|\s*Id\s*\|/i.test(line)) {
        const head = splitRow(line).map(c => c.toLowerCase())
        const at   = head.findIndex(c => c === 'verified' || c === 'closed')
        dateColumn = at === -1 ? null : at
        headWidth  = head.length
        continue
      }

      if (!ISSUE_ROW.test(line)) continue

      const cells = splitRow(line)
      if (cells.length < 4) continue

      const closed = archive || /^Closed/i.test(section ?? '')
      // A ruled row keeps its place and is rewritten AROUND its answer: the
      // claim struck through, the ruling bold after it. Reading the row whole
      // publishes the name that lost as if it were the live question.
      const live  = cells[2].replace(/~~[\s\S]*?~~/g, ' ')
      const ruled = live !== cells[2] || /\*\*Ruled\b/i.test(cells[2])
      const wide  = cells.length >= 6
      const body  = cells.slice(2).join(' ')

      // An id cell may hold more than one — `FJS-029 · FJS-137` is one row that
      // two defects were merged into, and the row says so: *one defect, not
      // two*. The first is the record's id and the rest are ALIASES for it, so
      // a comment citing either still resolves and neither becomes a dangling
      // reference to a record that was never split out.
      const ids = splitPkg(cells[0].replace(/<a\s[^>]*>\s*<\/a>/g, '').replace(/`/g, ''))

      out.push({
        kind:     'issue',
        id:       ids[0] ?? '',
        aliases:  ids.slice(1),
        pkg:      splitPkg(plain(cells[1])),
        title:    firstClaim(live.trim() ? live : cells[2]),
        status:   closed ? 'closed' : wide ? plain(cells[3]) : ruled ? 'ruled' : 'needs a ruling',
        severity: severityOf(section ?? ""),
        verified: wide ? plain(cells[4]) : '',
        closed,
        body:     plain(body),
        refs:     refsIn(body),
        files:    linkedFiles(cells[cells.length - 1]),
        form:     'table',
        file:     relative(root, file),
        line:     lineNo,
        anchor:   anchorIn(cells[0]),
        // Does this row line up with the table it is in? The header declares the
        // shape and these three answer it. Both failures are silent: a row
        // NARROWER than its header is a row from another table, and the reader
        // below infers a shape from the cell count and hands it a status nobody
        // wrote; a row WIDER has every excess cell dropped when the file is
        // rendered, which for § Closed is where the citations live.
        dateColumn,
        headWidth,
        columns:  cells.length,
      })
    }
  }

  return out
}

// ─── decisions ────────────────────────────────────────────────────────────────
//
// A ruling is a `###` heading under its section's `##`:
//
//     ### <a id="fjs-d06"></a>2026-08-16 · `FJS-D06` — the claim
//
// which is what gives a ruling an exact end, a deep link and an id a code
// comment can cite. Before that it was a bold run with no boundary at all and
// an id one time in three, so a body ran to whatever started next and four
// fifths of the settled register could not be named.
//
// **The legacy form is still read.** A project that has not migrated has its
// rulings as bold leads, and the id — where it has one — is written in one of
// three places: before the claim, in a parenthetical after it, or as `Closes
// <id>` on the line below. A ruling with no id at all is recorded with
// `id: null` and a slug for an anchor rather than skipped, because reporting
// the gap is the parser's job and minting an id is a decision.

const HEADING = /^###\s+(?:<a\s+id="[^"]*"><\/a>)?\s*(\d{4}-\d{2}-\d{2})\s*·\s*`?(FJS-D\d+)`?\s*[—–-]\s*(.*)$/
const RULING  = /^\*\*(\d{4}-\d{2}-\d{2})\s*·\s*(?:`?(FJS-D\d+)`?\s*[—–-]\s*)?/

function readDecisions(root) {
  const file = join(root, 'DECISIONS.md')
  if (!existsSync(file)) return []

  const lines = readFileSync(file, 'utf8').split('\n')
  const out   = []
  let section = null
  let open    = null
  let fence   = false

  const close = (endLine) => {
    if (!open) return
    const body = lines.slice(open.line, endLine).join('\n')
    open.record.body  = plain(body).trim()
    open.record.refs  = refsIn(body)
    open.record.files = linkedFiles(body)
    out.push(open.record)
    open = null
  }

  lines.forEach((line, i) => {
    // A register documents its own format, and the example is a ruling in every
    // way but being one. A fenced block is content, never a record.
    if (/^\s*```/.test(line)) { fence = !fence; return }
    if (fence) return

    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) { close(i); section = heading[1]; return }

    const ruled = line.match(HEADING)
    if (ruled) {
      close(i)
      const [, date, id, claim] = ruled
      open = {
        line: i,
        record: {
          kind: 'decision', id, date, section,
          title:   plain(claim).trim(),
          amended: /\*\*Amended\b|~~/.test(line),
          form:    'heading',
          file:    relative(root, file),
          line:    i + 1,
          anchor:  id.toLowerCase(),
        },
      }
      return
    }

    const ruling = line.match(RULING)
    if (!ruling) return
    close(i)

    const [, date, inlineId] = ruling
    // The claim runs to the end of the bold run, which may wrap several lines —
    // read off the joined text rather than off this line, which is usually only
    // its opening clause.
    const opening = lines.slice(i, i + 8).join(' ')
    const title   = firstClaim(`**${opening.slice(ruling[0].length)}`)
    const id = inlineId ?? trailingId(opening)

    open = {
      line: i,
      record: {
        kind:    'decision',
        id:      id ?? null,
        date,
        section,
        title,
        amended: /\*\*Amended\b|~~/.test(line),
        form:    'prose',
        file:    relative(root, file),
        line:    i + 1,
        anchor:  id ? id.toLowerCase() : slug(`${date}-${title}`),
      },
    }
  })

  close(lines.length)
  return out
}

/**
 * A ruling's own id where it is written AFTER the claim rather than before it.
 * Three spellings are in use and all three mean the same thing:
 *
 *     **…claim.** (`FJS-D36`, closing `FJS-047`.)
 *     **…claim.** (`FJS-D30`.)
 *     **…claim.**
 *     Closes `FJS-D07`; fixes `FJS-004`.
 *
 * Only a `FJS-D` id can be the ruling's own — the issue ids beside it are what
 * the ruling FIXES — and only the first one, because the rest are what it
 * closes. `Closes` names a decision-QUESTION filed in `ISSUES.md`, and the
 * question and the ruling that answers it share an id by design.
 */
function trailingId(opening) {
  const after = opening.match(/\*\*\s*(?:\(|Closes\b)[^*]{0,80}/)
  if (!after) return null
  return (after[0].match(/`?(FJS-D\d+)`?/) || [])[1] ?? null
}

// ─── ideas ────────────────────────────────────────────────────────────────────
//
// The only register that is already a file per record, and now the only one
// whose typed fields are declared rather than read out of prose. The `**Status:
// …**` line stays in the body — it says WHAT was built and what was not, which
// no enum can carry — and `status:` in the frontmatter is the normalised half
// a filter and a check can use.
//
// A file with no frontmatter is still read: title off the `# ` heading, status
// and dates left empty. Migration is therefore additive, and a paper somebody
// drops in without frontmatter appears in the register rather than vanishing.

function readIdeas(root) {
  const dir = join(root, 'IDEAS')
  if (!existsSync(dir)) return []

  const ranks = ideaRanks(dir)
  const out   = []

  for (const name of readdirSync(dir).filter(n => n.endsWith('.md')).sort()) {
    const raw          = readFileSync(join(dir, name), 'utf8')
    const { meta, body } = splitFrontmatter(raw)
    const id           = meta.id || name.replace(/\.md$/, '')

    out.push({
      kind:    'idea',
      id,
      title:   headingTitle(body) || id,
      status:  meta.status || '',
      dated:   meta.dated   || '',
      revised: meta.revised || '',
      // What the overview ranks it, where it ranks it at all. The overview is
      // itself declared derived, so a paper it has never heard of is normal.
      rank:    ranks.get(name) ?? null,
      body:    plain(body),
      refs:    refsIn(body),
      files:   linkedFiles(body),
      form:    Object.keys(meta).length ? 'frontmatter' : 'heading',
      file:    join('IDEAS', name),
      line:    1,
      anchor:  id,
    })
  }

  return out
}

/**
 * `overview.md`'s ranked rows, keyed by the paper each cites. The rank is the
 * first cell (`0.1`, `4.12`) and the source is the last — a backticked
 * filename, sometimes with a section number after it.
 */
function ideaRanks(dir) {
  const file = join(dir, 'overview.md')
  const out  = new Map()
  if (!existsSync(file)) return out

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const cells = splitRow(line)
    if (cells.length < 3) continue
    if (!/^\d+\.\d+[a-z]?$/.test(cells[0].trim())) continue

    const source = cells[cells.length - 1].match(/`([\w-]+\.md)`/)
    if (source && !out.has(source[1])) out.set(source[1], cells[0].trim())
  }

  return out
}

// ─── reading markdown ─────────────────────────────────────────────────────────

/**
 * A table row's cells. Splits on unescaped pipes only — a `\|` inside a cell is
 * content, and an inline code span may legitimately hold one.
 */
function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map(c => c.trim())
}

/** The first `# ` heading's text, which is where a paper states its title. */
function headingTitle(body) {
  const m = body.match(/^#\s+(.+?)\s*$/m)
  if (!m) return ''
  // `# Idea — Live queries: …` — the prefix is the register's own word for the
  // file, not part of what the paper is called.
  return plain(m[1]).replace(/^(Idea|Oracle)\s*[—–-]\s*/, '')
}

/**
 * The claim a record opens with: the first bold run, which is how every row and
 * every ruling is written — a claim in bold, then the measurement.
 */
function firstClaim(text = '') {
  const bold = text.match(/\*\*([\s\S]+?)\*\*/)
  const claim = bold ? bold[1] : text
  return plain(claim).replace(/\s+/g, ' ').trim()
}

/**
 * Every register id a body cites, `[[FJS-011]]` and bare `FJS-011` alike. The
 * graph is derived from where the prose actually names an id, so there is no
 * declared list to keep in sync with the sentence that already says it.
 */
function refsIn(text = '') {
  const out = new Set()
  for (const [, id] of text.matchAll(/\[\[\s*(FJS-D?\d+)\s*\]\]/gi)) out.add(id.toUpperCase())
  for (const [, id] of text.matchAll(/\b(FJS-D?\d+)\b/gi))          out.add(id.toUpperCase())
  return [...out].sort()
}

/**
 * Repo-relative paths out of markdown links. A `#fjs-d04` anchor is a
 * cross-reference to another record, an `http` link is somebody else's tree,
 * and a `#L134` fragment is a line inside a file that is still the same file.
 */
function linkedFiles(text = '') {
  const out = new Set()

  for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
    const path = target.split('#')[0].trim()
    if (!path || /^[a-z]+:/i.test(path)) continue
    out.add(path)
  }

  return [...out].sort()
}

/** The `<a id="…">` a row leads with, where it has one. */
function anchorIn(cell = '') {
  return (cell.match(/<a\s+id="([^"]+)"/) || [])[1] ?? ''
}

/** `cli · repo` is two packages written for a person to read. */
function splitPkg(text = '') {
  return text.split(/\s*·\s*/).map(s => s.trim()).filter(Boolean)
}

function severityOf(section = '') {
  const m = section.match(/^(S[1-4])/)
  if (m) return m[1]
  if (/decision/i.test(section)) return 'decision'
  return 'other'
}

/**
 * A stable anchor for a record that has no id of its own. Derived from what the
 * record says, so it survives the file being reordered and changes when the
 * claim does — which is the honest behaviour for a record nobody has named.
 */
function slug(text = '') {
  return plain(text).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

/** Markdown stripped to its text, for a title, a search corpus or a diff. */
function plain(md = '') {
  return md
    .replace(/<a\s[^>]*>\s*<\/a>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
