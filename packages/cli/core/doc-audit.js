// ─── doc-audit.js — the notes, graded against the tree ───────────────────────
//
// The rules over this repo's own markdown, all of them the same failure: a
// document that says something the tree does not say back. Prose is the one
// artefact here with no compiler, no test and no snapshot behind it, so it is
// the only place a claim can be wrong for months while everything runs green —
// and it is read first, by everyone, on the way in.
//
// `FJS-560` is the shape and it cost a session: `litestone/docs/roadmap.md`
// still proposed a way to express money four days after `@money` shipped, a
// reader took the roadmap for the current state, and a defect was filed against
// a settled ruling. `roadmap-shipped` closed that one page. These close the
// classes around it — a word that does not exist, a citation that resolves to
// nothing, a count that has moved, an invariant that has been renumbered, a
// question the register has ruled and the document still calls open, and a map
// that says what used to be true.
//
// ── What a rule here may grade ───────────────────────────────────────────────
//
// Only a claim with an AUTHORITY in the tree: a generated catalogue, a file
// path, a register id, a directory anyone can count. What a paragraph ARGUES is
// out of scope and must stay out — a rule that grades reasoning is a rule that
// fires on good prose, and the first thing anyone does with one of those is turn
// it off.
//
// ── Why the corpus excludes what it excludes ─────────────────────────────────
//
// `*.snapshot.md` is generated and gated by the `snapshots` CI phase already.
// `packages/cli/commands/**` is executable — a `.md` there is a command, and its
// prose is interpolated at run time. History is excluded from the citation rule
// alone: `CHANGES.md`, `ISSUES_ARCHIVE.md` and the handoff archive legitimately
// name files that were deleted afterwards, and that is what a history IS.

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join, dirname, relative, resolve, sep }           from 'path'

import { readRegisters } from './registers.js'

// ─── the corpus ───────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', 'coverage'])

// A `.md` under here is a command, not a document.
const NOT_DOCS = [join('packages', 'cli', 'commands')]

// Files whose job is to describe a tree that no longer exists.
const HISTORY = [/(^|[\\/])CHANGES\.md$/, /(^|[\\/])ISSUES_ARCHIVE\.md$/, /handoff-archive[\\/]/]

const isHistory = rel => HISTORY.some(re => re.test(rel))

// The registers argue about words that do not exist — that is what a gap report
// and a refusal ARE — so a rule grading vocabulary must not read them. They have
// a checker of their own: `fli register:check`.
const REGISTERS = [/^ISSUES\.md$/, /^DECISIONS\.md$/]
const isRegister = rel => REGISTERS.some(re => re.test(rel))

// `IDEAS/` is design records for work NOT STARTED, so every proposal in it names
// something the tree does not have. Grading it would report the whole directory
// for doing its job; the roadmap's version of that question is `roadmap-shipped`,
// which asks the opposite one — does this propose something that already ships.
const isProposal = rel => rel === 'IDEAS' || rel.startsWith('IDEAS' + sep)

function walkMd(dir, out, root) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walkMd(full, out, root)
    } else if (e.name.endsWith('.md') && !e.name.endsWith('.snapshot.md')) {
      const rel = relative(root, full)
      if (NOT_DOCS.some(p => rel.startsWith(p + sep))) continue
      out.push({ path: full, rel })
    }
  }
  return out
}

/**
 * Every document this repo asks a reader to believe, with its text.
 *
 * `history: false` drops the files whose whole purpose is to record what used to
 * be true. Read once per rule rather than cached, because a rule must be safe to
 * run twice and a cache keyed on a root that a test rewrites is a stale answer.
 */
export function docCorpus(root, { history = true, registers = true, proposals = true } = {}) {
  const dirs  = ['IDEAS', 'docs', 'packages', 'website']
  const files = []

  for (const name of readdirSyncSafe(root))
    if (name.endsWith('.md') && !name.endsWith('.snapshot.md')) files.push({ path: join(root, name), rel: name })

  for (const d of dirs) if (existsSync(join(root, d))) walkMd(join(root, d), files, root)

  const kept = files.filter(f =>
    (history   || !isHistory(f.rel)) &&
    (registers || !isRegister(f.rel)) &&
    (proposals || !isProposal(f.rel)))

  return kept.map(f => ({ ...f, text: readSafe(f.path) })).filter(f => f.text !== null)
}

function readdirSyncSafe(dir) { try { return readdirSync(dir) } catch { return [] } }
function readSafe(path)       { try { return readFileSync(path, 'utf8') } catch { return null } }

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/**
 * The document with every fenced block blanked out, offsets preserved.
 *
 * A fence is a sample, and a sample carries text that is not a claim about this
 * tree: an email in a factory (`u${seq}@x.com`), a destructure that reads as a
 * markdown link (`[...args](fn)`), a path inside the app being demonstrated.
 * Blanking rather than removing keeps every reported line number honest.
 */
export function maskFences(text) {
  return text.replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' '))
}

/** Inline code blanked out, offsets preserved — the sibling of `maskFences`. */
export function maskInline(text) {
  return text.replace(/(?<!`)`[^`\n]+`(?!`)/g, m => m.replace(/[^\n]/g, ' '))
}

/** The inline code spans of a document, with the offset each one starts at. */
function inlineSpans(text) {
  const out = []
  for (const m of text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) out.push({ body: m[1], index: m.index })
  return out
}

/** Fenced blocks carrying one of `langs`, joined with their offsets kept. */
function fences(text, langs) {
  const out = []
  for (const m of text.matchAll(/```([A-Za-z0-9_-]*)\n([\s\S]*?)```/g))
    if (langs.includes(m[1].toLowerCase())) out.push({ body: m[2], index: m.index })
  return out
}

// ─── doc-word-unknown ─────────────────────────────────────────────────────────
//
// The mirror of `roadmap-shipped`. That rule catches a roadmap proposing a word
// the language already has; this one catches any document USING a word the
// language does not have — which reads as a feature that exists, is copied into
// a schema, and is refused by the parser with the reader's confidence intact.
//
// Graded against `catalog.snapshot.md`, which is generated from the parser and
// gated, and read WHOLE rather than by its first column: `@gate(N)` is legal
// only inside `@@transitions(…)` and appears in that row's argument cell, so a
// rule reading the word column alone would report the repo's own syntax.
//
// Two suppressions, both about a `@word` that is not a schema word at all. A
// token preceded by `{` is Mesa (`{@const}`, `{@attach}`); a token followed by
// `/` is an npm scope. And a line NAMING another ORM is comparative prose —
// `README.md`'s `@@ignore` is Prisma's, correctly cited, and a rule that cannot
// tell that one from a stale claim would make the comparison unwritable.

const NOT_SCHEMA_WORDS = new Set([
  '@media', '@layer', '@import', '@supports', '@keyframes', '@container', '@charset',
  '@font-face', '@property', '@page', '@namespace', '@scope', '@apply',
  '@param', '@returns', '@return', '@type', '@typedef', '@example', '@see', '@throws',
  '@todo', '@deprecated', '@internal', '@override', '@license', '@module',
  // Mesa's template words. They are written `{@const …}` in markup, and the
  // brace is what this rule reads — but prose names them bare.
  '@const', '@html', '@render', '@attach', '@debug',
  '@rule',   // CSS's own noun for `@media` and its kind — an at-rule
])

const OTHER_ORMS = /\b(Prisma|Rails|ActiveRecord|Django|Ecto|Laravel|Eloquent|Sequelize|TypeORM|Drizzle|Hibernate|SQLAlchemy|Doctrine|Mongoose|Feathers|Svelte|Vue|Angular)\b/

// A sentence saying the word is absent is not a use of it. The narrow spellings
// only — a general negation guard would suppress the findings this rule is for.
const DENIES_IT = /(there is no|no such|does not (?:exist|carry|have)|never existed|is not a word|not supported|instead of|neither of which)/i

// Metasyntax. `@@name` stands for *whatever the attribute is called*, and a rule
// that cannot tell that from a claim reports the sentence teaching the notation.
// The cost is stated: an attribute genuinely named one of these would be missed
// here, and would be caught by the catalogue's own completeness test instead.
const PLACEHOLDERS = new Set(['@x', '@y', '@n', '@name', '@@name', '@attr', '@@attr',
  '@word', '@@word', '@anything', '@@anything', '@funcName', '@funcCall', '@attributes'])

/**
 * Every npm scope this workspace names, derived rather than listed — `@frontierjs`
 * is one, and so is every scoped dependency any package installs.
 */
export function npmScopes(root) {
  const out   = new Set()
  const files = [join(root, 'package.json')]
  for (const name of readdirSyncSafe(join(root, 'packages')))
    files.push(join(root, 'packages', name, 'package.json'))

  for (const file of files) {
    const raw = readSafe(file)
    if (raw === null) continue
    let pkg
    try { pkg = JSON.parse(raw) } catch { continue }
    const names = [pkg.name, ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })]
    for (const n of names) if (typeof n === 'string' && n.startsWith('@')) out.add(n.split('/')[0])
  }
  return out
}

/** Every `@word` the generated catalogues carry, in any column. */
export function catalogueWords(root) {
  const words = new Set()
  let found   = 0
  for (const name of readdirSyncSafe(join(root, 'packages'))) {
    const file = join(root, 'packages', name, 'catalog.snapshot.md')
    if (!existsSync(file)) continue
    found++
    const text = readSafe(file) ?? ''
    for (const m of text.matchAll(/(@@?[a-z][A-Za-z0-9]*)/g)) words.add(m[1])
  }
  return { words, found }
}

export function docWordUnknown({ root }) {
  const scopes = npmScopes(root)
  const { words, found } = catalogueWords(root)
  if (!found)      return { skipped: 'no packages/*/catalog.snapshot.md to grade a schema word against' }
  if (!words.size) return { skipped: 'the catalogue names no attributes' }

  const findings = []
  for (const doc of docCorpus(root, { history: false, registers: false, proposals: false })) {
    const seen = new Set()
    const sources = [
      ...inlineSpans(maskFences(doc.text)).map(s => ({ ...s, kind: 'inline' })),
      ...fences(doc.text, ['lite']).map(s => ({ ...s, kind: 'fence' })),
    ]

    for (const src of sources) {
      for (const m of src.body.matchAll(/(^|[^\w@/{.-])(@@?[a-z][A-Za-z0-9]*)/g)) {
        const word = m[2]
        const rest = src.body.slice(m.index + m[0].length)
        // `@frontierjs/x` a scope, `@starting-style` an at-rule, `u@x.com` an
        // address. None of the three is a word a `.lite` file could hold.
        if (/^[/.-]/.test(rest))         continue
        if (scopes.has(word))            continue
        if (NOT_SCHEMA_WORDS.has(word))  continue
        if (PLACEHOLDERS.has(word))      continue
        if (words.has(word))             continue
        if (seen.has(word))              continue

        const line = lineOf(doc.text, src.index)
        const at   = doc.text.split('\n')[line - 1] ?? ''
        if (OTHER_ORMS.test(at))         continue      // comparative prose, correctly cited
        if (DENIES_IT.test(at))          continue      // prose saying the word does NOT exist

        seen.add(word)
        findings.push({
          file: doc.path, line,
          message: `\`${word}\` is not a word the schema language has — the generated catalogue does not carry it, ` +
                   `so a reader copying this line gets a parse error the document has already told them to expect ` +
                   `to work. Fix the spelling, or say which register the gap is filed in.`,
        })
      }
    }
  }
  return { findings }
}

// ─── doc-cites-dead ───────────────────────────────────────────────────────────
//
// A citation is a promise that something is there. Three kinds are decidable and
// all three are advice that fails at the moment somebody takes it: a relative
// link, a repo path written as inline code, and a register id.
//
// The fragment half is graded only for `#fjs-…`, which is this repo's one
// explicit anchor convention (`<a id="fjs-123">`). A heading slug is a GitHub
// rendering detail and grading it would report punctuation.
//
// A path is resolved three ways — against the repo root, the document's own
// directory, and the package the document lives in — because all three spellings
// are in use and none of them is wrong.

const PATH_LIKE = /^[A-Za-z0-9_@.][A-Za-z0-9_@.\-/]*\.(js|mjs|cjs|ts|tsx|json|md|mesa|lite|css|html|sql|sh|yml|yaml)(:\d+(-\d+)?)?$/

function packageRootOf(root, docPath) {
  let dir = dirname(docPath)
  while (dir.startsWith(root) && dir !== root) {
    if (existsSync(join(dir, 'package.json'))) return dir
    dir = dirname(dir)
  }
  return null
}

/**
 * Is this path even ABOUT this repo?
 *
 * Half the paths in these documents are app-relative — `db/schema.lite`,
 * `api/src/services/orders.service.ts`, `web/config/sierra.config.js` — because
 * half of what is written here is written about the app a reader is building.
 * None of them resolves from the repo root and every one of them is correct, so
 * a rule that graded them would report 900 findings and be switched off inside a
 * day. What IS addressed at this repo starts at a directory this repo has, or
 * says explicitly that it is relative.
 */
// A directory name that means one thing at this root and another inside every
// app and every package. `db/schema.lite` is the shape: it appears in 19 places
// here and in every one of them it means *the app you are building*, not a file
// this repo has. Ungraded rather than guessed at — the cost is that a genuinely
// dead `packages/x/db/…` goes unseen, which is the cheaper of the two errors.
const AMBIGUOUS = new Set(['db', 'docs', 'src', 'test', 'tests', 'config', 'dist',
  'api', 'web', 'site', 'widgets', 'extension', 'public', 'components', 'commands'])

function addressesThisRepo(top, path) {
  // An explicitly relative path in prose is almost always a quoted IMPORT
  // SPECIFIER — `'./money.js'`, `'../src/runtime.js'` — and is indistinguishable
  // from a citation as text. A markdown LINK is the other half of this question
  // and is graded, because a link is navigation and nothing else.
  if (path.startsWith('./') || path.startsWith('../')) return false
  const first = path.split('/')[0]
  if (!top.has(first)) return false
  return !AMBIGUOUS.has(first)
}

function resolvesAnywhere(root, doc, target) {
  const bare  = target.replace(/:\d+(-\d+)?$/, '')
  const pkg   = packageRootOf(root, doc.path)
  const bases = [root, dirname(doc.path), pkg].filter(Boolean)
  return bases.some(b => existsSync(resolve(b, bare)))
}

export function docCitesDead({ root }) {
  const docs = docCorpus(root, { history: false })
  if (!docs.length) return { skipped: 'no documents outside history' }

  const top = new Set(readdirSyncSafe(root))

  // `ids.byId` is keyed lowercase and carries the archive, so a closed row is a
  // live citation. No registers at all is an app, not a repo: the half is
  // dropped rather than reporting every id in the tree as unknown.
  let ids = null
  try {
    const byId = readRegisters(root).ids?.byId
    if (byId?.size) ids = byId
  } catch { ids = null }

  const findings = []
  for (const doc of docs) {
    const prose = maskFences(doc.text)
    const pkg   = packageRootOf(root, doc.path)

    // `ISSUES.md` is two tiers in one file: the rows above § Closed are the open
    // register and the rows below it are history that has not aged out to
    // `ISSUES_ARCHIVE.md` yet. A closed row legitimately names a file that was
    // deleted BY closing it — *`app-ref.ts` is deleted* is the fix, written down
    // — so the section is read the way the archive is, and an open row citing a
    // path that has moved is still the finding this rule exists for.
    const closedAt = /^##\s+Closed\b/m.exec(prose)
    const cutoff   = doc.rel === 'ISSUES.md' && closedAt ? closedAt.index : Infinity

    // (a) a relative link. Inline code is masked as well as fences: a
    // destructure quoted in prose — `[...args](fn)` — is a markdown link to a
    // regex and to nothing else.
    for (const m of maskInline(prose).matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      const raw = m[1]
      if (/^(https?:|mailto:|tel:|#|<|\{)/.test(raw)) continue
      const [target, frag] = raw.split('#')
      if (!target) continue
      if (target.includes('*') || target.includes('{')) continue

      if (!resolvesAnywhere(root, doc, target)) {
        if (m.index < cutoff) findings.push({
          file: doc.path, line: lineOf(doc.text, m.index),
          message: `links to \`${target}\`, which is not in the tree from the repo root, from this file's own ` +
                   `directory, or from its package. A link that resolves to nothing is advice that fails the ` +
                   `moment somebody follows it.`,
        })
        continue
      }

      if (frag && /^fjs-/i.test(frag)) {
        const bare = resolve(dirname(doc.path), target)
        const at   = existsSync(bare) ? bare : resolve(root, target)
        const text = readSafe(at) ?? ''
        if (text && !text.includes(`id="${frag}"`)) if (m.index < cutoff) findings.push({
          file: doc.path, line: lineOf(doc.text, m.index),
          message: `links to \`${target}#${frag}\` and that anchor is not in the target — the row was renumbered, ` +
                   `retired, or never had an \`<a id>\`. The link lands at the top of the register and the reader ` +
                   `reads whichever row is there.`,
        })
      }
    }

    // (b) a repo path written as inline code
    for (const span of inlineSpans(prose)) {
      const body = span.body.trim()
      if (!body.includes('/') || !PATH_LIKE.test(body))    continue
      if (body.startsWith('node_modules/'))                continue
      if (!addressesThisRepo(top, body))                   continue
      if (resolvesAnywhere(root, doc, body))               continue
      if (span.index < cutoff) findings.push({
        file: doc.path, line: lineOf(doc.text, span.index),
        message: `cites \`${body}\`, which is not in the tree. A path in prose is the fastest way anybody navigates ` +
                 `this repo, and one that has moved sends them looking for a file that is somewhere else.`,
      })
    }

    // (c) a register id
    if (ids) for (const m of doc.text.matchAll(/\bFJS-(D?\d+)\b/g)) {
      if (ids.has(m[0].toLowerCase())) continue
      findings.push({
        file: doc.path, line: lineOf(doc.text, m.index),
        message: `cites \`${m[0]}\`, which is in neither register nor the archive. An id resolves in exactly one ` +
                 `place or it resolves nowhere, and a reader who cannot find it assumes they are looking in the ` +
                 `wrong file.`,
      })
    }
  }
  return { findings }
}

// ─── doc-claims-count ─────────────────────────────────────────────────────────
//
// A number in prose is a claim with an authority behind it, and it is the one
// kind of staleness a reader cannot detect: *69 components* reads exactly as
// true as *70 components*, and the tree answers in one command.
//
// Each countable names what counts it. `near` is what keeps a common noun
// usable — *rules* means five different things across this repo, so the claim is
// graded only where the sentence around it is already talking about the thing.
// A countable whose authority is absent is dropped rather than guessed at.
//
// Graded in the OWNING package's own documents plus the root map, because those
// are the two places the fact is stated as current. A number inside a history
// file is a record of what was true and is left alone.
//
// `marker` is required only OUTSIDE the owning package. Inside it the noun is
// unambiguous — *components* in `packages/ui/` is this kit's — and in the root
// map it is not, because that file carries a row for every package and two of
// them ship components.

const WORD_NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

/** `thirty-eight` → 38, `69` → 69, anything else → null. */
export function readNumber(raw) {
  const s = String(raw).trim().toLowerCase()
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split('-')
  if (parts.length === 1) return WORD_NUMBERS[parts[0]] ?? null
  if (parts.length === 2) {
    const [tens, units] = parts.map(p => WORD_NUMBERS[p])
    if (tens >= 20 && tens % 10 === 0 && units >= 1 && units <= 9) return tens + units
  }
  return null
}

const NUMBER_RE = Object.keys(WORD_NUMBERS).join('|')

// Below this fraction of the truth, a number is read as a subset.
const PART_OF = 0.5

function countFiles(dir, ext) {
  if (!existsSync(dir)) return null
  let n = 0
  const walk = d => {
    for (const e of readdirSyncSafe(d)) {
      const full = join(d, e)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full)
      else if (e.endsWith(ext)) n++
    }
  }
  walk(dir)
  return n
}

function countMatches(file, re) {
  const text = readSafe(file)
  if (text === null) return null
  return [...text.matchAll(re)].length
}

/** One catalogue section's rows — the table under a `## <heading>`. */
function catalogueSection(root, heading) {
  const file = join(root, 'packages', 'litestone', 'catalog.snapshot.md')
  const text = readSafe(file)
  if (text === null) return null
  const from = text.indexOf(`## ${heading}`)
  if (from < 0) return null
  const rest = text.slice(from + 3)
  const to   = rest.indexOf('\n## ')
  const body = to < 0 ? rest : rest.slice(0, to)
  return [...body.matchAll(/^\| `[^`]+`/gm)].length
}

export const COUNTABLES = [
  { id:     'ui-components',
    count:  root => countFiles(join(root, 'packages', 'ui', 'components'), '.mesa'),
    what:   'components',
    owner:  'packages/ui/',
    marker: /Mesa component kit|@frontierjs\/ui\b|components? (?:compile|are opened)/i,
    also:   ['CLAUDE.md'],
    authority: 'the `.mesa` files under packages/ui/components/' },

  { id:     'litestone-words',
    count:  root => {
      const parts = ['Declarations', 'Field attributes', 'Model attributes'].map(h => catalogueSection(root, h))
      return parts.every(p => p !== null) ? parts.reduce((a, b) => a + b, 0) : null
    },
    what:   'words',
    owner:  'packages/litestone/',
    marker: /catalog|\.lite|schema language|language surface/i,
    also:   ['CLAUDE.md'],
    authority: 'packages/litestone/catalog.snapshot.md' },

  { id:     'litestone-field-attrs',
    count:  root => catalogueSection(root, 'Field attributes'),
    what:   'field attributes',
    owner:  'packages/litestone/',
    marker: /catalog|\.lite|attribute/i,
    also:   ['CLAUDE.md'],
    authority: 'packages/litestone/catalog.snapshot.md § Field attributes' },

  { id:     'litestone-model-attrs',
    count:  root => catalogueSection(root, 'Model attributes'),
    what:   'model attributes',
    owner:  'packages/litestone/',
    marker: /catalog|\.lite|attribute/i,
    also:   ['CLAUDE.md'],
    authority: 'packages/litestone/catalog.snapshot.md § Model attributes' },

  // The rule count is not here and cannot be: this module would have to import
  // `checks.js`, which imports this one. `checks.js` passes it in — see
  // `checkRulesCountable` below, which it calls with its own table.

  // `basecamp-models` was here and was removed rather than repaired. A schema
  // IMPORTS — basecamp's own file declares 42 and pulls four more out of
  // `@frontierjs/auth` — so the honest number needs the parser that resolves
  // imports, which is litestone's and is on the other side of the dependency
  // direction. A countable this rule cannot count correctly reports drift where
  // there is none, which is worse than not asking.
]

/**
 * *How many rules does `fli check` have* — the claim most likely to rot, because
 * every session that adds a rule moves it. The table is the authority and it is
 * handed in rather than imported: `checks.js` imports this module, so reaching
 * back for `RULES` would be a cycle.
 */
export function checkRulesCountable(rules) {
  return {
    id:     'check-rules',
    count:  () => rules.length,
    what:   'rules',
    owner:  'packages/cli/',
    marker: /fli check|architecture rule|arch-test/i,
    also:   ['CLAUDE.md'],
    authority: 'the rule table in packages/cli/core/checks.js',
  }
}

export function docClaimsCount({ root, countables = COUNTABLES }) {
  const live = countables
    .map(c => ({ ...c, n: c.count(root) }))
    .filter(c => Number.isFinite(c.n))
  if (!live.length) return { skipped: 'no countable authority in this tree' }

  const findings = []
  for (const doc of docCorpus(root, { history: false })) {
    for (const c of live) {
      const owned = doc.rel === c.owner || doc.rel.startsWith(c.owner)
      const cited = (c.also ?? []).some(p => doc.rel === p || doc.rel.startsWith(p))
      if (!owned && !cited) continue

      const re = new RegExp(`\\b((?:${NUMBER_RE})(?:-(?:${NUMBER_RE}))?|\\d+)\\s+${c.what}\\b`, 'gi')

      // The LARGEST claim in a document is the one purporting to be the whole;
      // every smaller one is a subset — *fourteen `@@tenant(none)` models*, *six
      // components in the overlay tier* — and grading those reports a document
      // for describing its own parts. One finding per document per countable.
      let top = null
      for (const m of maskFences(doc.text).matchAll(re)) {
        const said = readNumber(m[1])
        if (said === null) continue

        // `1,377 models of input` is one number, not a claim of 377.
        if (/[\d,]/.test(doc.text[m.index - 1] ?? '')) continue

        const line = lineOf(doc.text, m.index)
        const at   = doc.text.split('\n')[line - 1] ?? ''
        if (!owned && !c.marker.test(at)) continue

        if (!top || said > top.said) top = { said, line, raw: m[1] }
      }

      // A document that never states the total states only parts, and its
      // largest part is not a claim about the whole — `packages/cli/README.md`
      // says *Eleven rules* about one family of them. A claim under half the
      // truth is read as a part. The cost is stated: a count that has fallen by
      // more than half is missed, and a count that has grown is not.
      if (top && top.said < c.n * PART_OF) top = null

      if (top && top.said !== c.n) findings.push({
        file: doc.path, line: top.line,
        message: `says ${top.raw} ${c.what}; the tree has ${c.n} — counted from ${c.authority}. ` +
                 `A stale count reads exactly as true as a live one, which is why it is the number nobody checks.`,
      })
    }
  }
  return { findings }
}

// ─── doc-invariant-ref ────────────────────────────────────────────────────────
//
// The invariants are a NUMBERED list, and a number is the worst possible key for
// a citation that lives somewhere else: inserting one renumbers every rule and
// every paragraph that cites the ones below it, silently and all at once. Two
// hundred citations across this repo point at that list by number, and the rule
// table in `checks.js` points at it from code.
//
// This does not grade whether a citation points at the RIGHT invariant — nothing
// can — only that it points at one that exists. That is the half that goes wrong
// when the list grows.

export function invariantCount(root) {
  const text = readSafe(join(root, 'CLAUDE.md'))
  if (text === null) return null
  const from = text.search(/^#+ Invariants\s*$/m)
  if (from < 0) return null
  const rest = text.slice(from)
  const to   = rest.slice(1).search(/^---\s*$/m)
  const body = to < 0 ? rest : rest.slice(0, to + 1)
  const nums = [...body.matchAll(/^(\d+)\. \*\*/gm)].map(m => Number(m[1]))
  return nums.length ? Math.max(...nums) : null
}

export function docInvariantRef({ root, rules = [] }) {
  const n = invariantCount(root)
  if (n === null) return { skipped: 'no numbered Invariants section in CLAUDE.md' }

  const findings = []
  const claude   = join(root, 'CLAUDE.md')

  for (const rule of rules) {
    if (!Number.isFinite(rule.invariant)) continue
    if (rule.invariant >= 1 && rule.invariant <= n) continue
    findings.push({
      file: claude,
      message: `the rule \`${rule.id}\` cites Invariant ${rule.invariant} and CLAUDE.md declares ${n}. ` +
               `A rule reporting an invariant nobody can read is a finding with no argument behind it.`,
    })
  }

  for (const doc of docCorpus(root, { history: false })) {
    for (const m of doc.text.matchAll(/\bInvariant (\d+)\b/g)) {
      const k = Number(m[1])
      if (k >= 1 && k <= n) continue
      findings.push({
        file: doc.path, line: lineOf(doc.text, m.index),
        message: `cites Invariant ${k}; CLAUDE.md declares ${n}. The list is numbered, so inserting one renumbers ` +
                 `every citation below it at once — this is what that looks like from the other end.`,
      })
    }
  }
  return { findings }
}

// ─── doc-status-stale ─────────────────────────────────────────────────────────
//
// A guiding document whose OPEN section lists something the register has ruled.
//
// This is the class the other four cannot see. `doc-cites-dead` grades a
// citation that resolves to nothing, `doc-word-unknown` a word the language does
// not have, `doc-claims-count` a number that has moved — all of them a claim that
// is WRONG. This one grades a claim that is out of DATE: the citation resolves,
// the word exists, the number is right, and the section around them says the
// question is still open. `ARCHITECT.md` §5 called tenancy and the context shape
// unsettled after `FJS-D05` and `FJS-D03` had ruled them, and every artefact in
// the tree agreed with the file (`FJS-D187`).
//
// ── Two authorities, and both are the SECTION ───────────────────────────────
//
// The authority for *this is presented as open* is the HEADING, never a
// sentence. A first cut graded any sentence pairing an id with an openness word
// and reported three lines that were correct prose — `FJS-D06 §7` beside
// *deferred* is a true statement about a ruling that settled one section and
// deferred another, and a rule that fires on good prose is one somebody turns
// off.
//
// The escape is the section too, and that is the part worth arguing. A section
// that names what a ruling DECIDED anywhere in its body is a section whose
// author had the register in hand, and the open question under it is the
// narrower one the ruling left — which is what an open-questions section is FOR.
// A section that cites an id and never says it was ruled is the failure: the
// reader takes the heading at its word. Coarse on purpose, because the finer
// version cannot tell those apart without reading what the paragraph argues,
// which is `doc-audit.js`'s standing limit.
//
// A ruling struck in place is not settled for this purpose, so a document is
// right to call it open. `ISSUES.md` ids are out of scope entirely: an open
// defect under a heading that says *open* is a register doing its job.

const OPEN_HEADING = [
  'unsettled', 'not yet adopted', 'not adopted', 'under review', 'undecided',
  'open question', 'not ruled', 'unruled', 'parked', 'to be decided',
  'not settled', 'needs a ruling', 'awaiting a ruling', 'not yet named',
]

// A word that says a decision was TAKEN. Three things about the match are the
// rule rather than tidiness. `settled` and `adopted` are absent on purpose:
// *do not use them as settled vocabulary yet* and *not yet adopted* are how a
// stale section describes itself, so either one as an escape reads the failure
// as the fix. The left boundary is a NON-LETTER, because `unruled` and `unbuilt`
// contain `ruled` and `built` and each is the opposite claim — `unbuilt` alone
// silenced this rule against the section it was written for. And a negation in
// front of the word is not an escape either.
const SETTLED_RE =
  /(?<![a-z])(?<!not )(?<!never )(?<!yet )(?:ruled|shipped|built|closed|decided|defers?|deferred|supersed\w*|withdrawn|refused|waits for)\b/i

// Each ATX heading and the body under it, to the next heading of any level.
// Setext headings are not read: nothing in this corpus uses them, and a reader
// that guessed would call a table row a heading.
function sections(text) {
  const out = []
  let cur   = null

  text.split('\n').forEach((line, i) => {
    const m = /^#{1,6}\s+(.*)$/.exec(line)
    if (m) {
      if (cur) out.push(cur)
      cur = { heading: m[1], line: i + 2, body: '' }
    } else if (cur) {
      cur.body += line + '\n'
    }
  })
  if (cur) out.push(cur)
  return out
}

export function docStatusStale({ root }) {
  // Guiding documents only. A register argues with itself by design, an
  // assessment is dated and says so, and history is a record of what WAS open.
  const GUIDING = new Set(['PHILOSOPHY.md', 'ARCHITECT.md', 'CLAUDE.md', 'VERIFYING.md'])

  let decisions = null
  try { decisions = readRegisters(root).decisions } catch { decisions = null }
  if (!decisions?.length) return { skipped: 'no DECISIONS.md to grade a citation against' }

  // Settled means the register holds it and has not struck it. `amended` is the
  // register's own mark for a ruling reversed or withdrawn in place.
  const settled = new Map()
  for (const d of decisions) if (d.id && !d.amended) settled.set(d.id.toLowerCase(), d)

  const findings = []
  for (const doc of docCorpus(root, { history: false, registers: false, proposals: false })) {
    if (!GUIDING.has(doc.rel.split(sep).pop())) continue

    for (const sec of sections(maskFences(doc.text))) {
      const open = OPEN_HEADING.find(w => sec.heading.toLowerCase().includes(w))
      if (!open) continue
      if (SETTLED_RE.test(sec.body)) continue

      for (const m of sec.body.matchAll(/\bFJS-D\d+\b/g)) {
        const hit = settled.get(m[0].toLowerCase())
        if (!hit) continue
        findings.push({
          file: doc.path, line: sec.line + lineOf(sec.body, m.index) - 1,
          message: `sits under "${sec.heading.trim().slice(0, 44)}" and DECISIONS.md holds \`${m[0]}\` as ` +
                   `ruled — "${hit.title.slice(0, 64)}". Nothing in that section says so, so a reader takes ` +
                   `the heading at its word and relitigates a settled question, and the argument that ` +
                   `settled it is the one thing nobody reads twice. Move the row into what is ruled, or say ` +
                   `in the section what the ruling decided and what it left open.`,
        })
      }
    }
  }

  return { findings }
}

// ─── doc-map-narration ────────────────────────────────────────────────────────
//
// A map that tells you what USED to be true.
//
// `PHILOSOPHY.md` §VII gives the map tier one job — live facts, each backed by a
// generator or a check — and puts history in the registers. The rule is not
// taste: a map is what a reader consults to decide what to do in the next hour,
// and a paragraph that opens by describing the old behavior costs that reader
// the same attention as one describing the current behavior, while ageing at a
// rate nothing measures.
//
// ── What it does NOT fire on, and why that is the whole design ───────────────
//
// House style names one narrow exception and it is real: *a past bug stated
// because the shape still invites it* — `it used to land silently while the read
// strip made it look refused* is the failure mode, written the only way it can
// be written. Measured across the root and package maps, that shape accounts for
// 81 of the 91 mid-sentence uses of `used to`. A rule matching the phrase
// anywhere would report all 81, and the first thing anybody does with a rule
// like that is turn it off.
//
// So it matches only where the history is the SUBJECT rather than the
// explanation: a sentence that OPENS with it, which §VII already says, and a
// calendar date, which a map has no use for at all. Ten and sixteen against 81,
// and every one of them is a sentence a register already holds.
//
// It grades the whole map tier — `mapTier()` below, the same set
// `doc-unchecked-count` reads — rather than `CLAUDE.md` alone. A package README
// is in that tier (§VII), and grading only the CLAUDE.md half left a README
// carrying a struck-through defect record, two *fixed on <date>* parentheticals
// and a `## Breaking changes` section doing `CHANGES.md`'s job.
//
// A date inside a code span is a VALUE (`datetime('now')` answers one) and a
// date inside quotation marks is a quoted example — House style quotes the bad
// form in order to ban it, which a rule reading its own instruction must not
// report. The span mask here allows ONE newline inside the backticks, which
// `maskInline` does not: these files are hard-wrapped, so a span carrying a
// timestamp wraps as often as not, and the strict mask reported the wrapped
// half of a value as narration.

const MAP_NARRATION =
  /^(?:it|they|that|this) used to\b|^until\s+\d{4}-\d{2}|^before\s+`?FJS-|^for its whole life\b|^it shipped\b|^it had been\b|^for as long as\b/i

const CALENDAR_DATE = /\b20\d{2}-\d{2}-\d{2}\b/

// A date the author is quoting rather than asserting. Straight and curly pairs,
// on one line: a quotation spanning a paragraph is not this shape.
function quotedSpans(line) {
  const out = []
  for (const m of line.matchAll(/"[^"\n]*"|“[^”\n]*”/g)) out.push([m.index, m.index + m[0].length])
  return out
}

/** The documents a reader acts on today: the maps, at the repo and package roots. */
function mapTier(root) {
  return docCorpus(root, { history: false, registers: false, proposals: false })
    .filter(d => /^(CLAUDE|README|ARCHITECT|PHILOSOPHY)\.md$/.test(d.rel.split(sep).pop()))
    .filter(d => !['test', 'tests', 'fixtures', 'docs', 'example', 'mockup', 'node_modules']
      .some(seg => d.rel.split(sep).includes(seg)))
}

export function docMapNarration({ root }) {
  const docs = mapTier(root)
  if (!docs.length) return { skipped: 'no map document to grade' }

  const findings = []
  for (const doc of docs) {
    // One newline allowed inside the span: see the note above.
    const text = maskFences(doc.text)
      .replace(/(?<!`)`[^`]{1,200}?`(?!`)/g, m =>
        (m.split('\n').length <= 2 ? m.replace(/[^\n]/g, ' ') : m))

    // The opening of a sentence, where a list marker, a heading hash and a bold
    // run all count as the start — the map writes most of its claims that way.
    for (const raw of splitSentences(text)) {
      const s = raw.text.replace(/^[\s\-*|#>]+/, '').replace(/^\*\*/, '')
      if (!MAP_NARRATION.test(s)) continue
      findings.push({
        file: doc.path, line: lineOf(text, raw.index),
        message: `opens with what used to be true — "${s.slice(0, 56).trim()}…". A map carries live facts, ` +
                 `and history belongs to \`CHANGES.md\`, \`DECISIONS.md\` and git (\`FJS-D187\`). State the ` +
                 `rule and cite the id. The one exception House style keeps is a past bug stated MID-sentence ` +
                 `because the shape still invites the mistake, which this does not report.`,
      })
    }

    text.split('\n').forEach((line, i) => {
      const m = CALENDAR_DATE.exec(line)
      if (!m) return
      if (quotedSpans(line).some(([a, b]) => m.index >= a && m.index < b)) return
      findings.push({
        file: doc.path, line: i + 1,
        message: `carries the date ${m[0]}. A map has no use for one: a fact that needs a date is history ` +
                 `and belongs in a register, and a ruling is cited by its id rather than by the day it was ` +
                 `made (\`FJS-D187\`). A date inside a code span or a quotation is a value or an example ` +
                 `and is not reported.`,
      })
    })
  }

  return { findings }
}

/** Sentences with the offset each one starts at. */
function splitSentences(text) {
  const out = []
  let at = 0
  for (const part of text.split(/(?<=[.!?])\s+|\n\n+/)) {
    out.push({ text: part, index: at })
    at += part.length + 1
  }
  return out
}

// ─── doc-unchecked-count ──────────────────────────────────────────────────────
//
// *A number in prose is generated or absent* (`FJS-D187`). `doc-claims-count`
// asks the other half of that — a stated number against the generator that owns
// it — and by construction it can only grade a count somebody wrote a countable
// for. Every count with no authority behind it went unread, which is where they
// all were: measured across the map tier, the ONE count backed by a generator
// was right and every count that was not had drifted, two of them by half.
//
// What separates a claim from prose is DIGITS and a countable artefact noun. The
// house spells a rhetorical number — *three realms*, *two owners*, *fourteen
// producing broken JavaScript* — and reaches for a numeral when it is reporting
// an inventory, so the discriminator is the one the writing already uses. That
// is why the fix for a number worth keeping in an example is to spell it, which
// is what `PHILOSOPHY.md` §VII does with its own.
//
// Three things are deliberately NOT reported. A count a countable owns, since
// `doc-claims-count` grades it against the tree and it is generated in exactly
// the sense §VII means. A count of ONE, which is a statement about singularity
// and not an inventory. And anything outside the map tier: a dated
// `PROJECT_STATE.md` is a measurement with a date on it, and the corpus README
// under `packages/litestone/test/fixtures/` counts models in schemas this repo
// did not write, where the number is the finding.

const ARTEFACT_NOUNS =
  'tests|assertions|components|commands|namespaces|models|enums|rules|checks|suites|drives'

// A `§`, a `#` or a decimal point in front means the digits are an address or a
// version rather than a quantity — `§11, rule 30` is a citation.
const UNCHECKED_COUNT =
  new RegExp(String.raw`(?<![\w.$§#-])(\d+(?:,\d{3})*)\s+(${ARTEFACT_NOUNS})\b`, 'gi')

export function docUncheckedCount({ root, countables = COUNTABLES }) {
  const docs = mapTier(root)
  if (!docs.length) return { skipped: 'no map document to grade' }

  const findings = []
  for (const doc of docs) {
    // The same ownership test `doc-claims-count` applies, so a countable exempts
    // its own count here rather than the two rules disagreeing about who owns it.
    const owns = noun => countables.some(c =>
      c.what.replace(/s$/, '') === noun.replace(/s$/, '') &&
      (doc.rel === c.owner || doc.rel.startsWith(c.owner) ||
       (c.also ?? []).some(p => doc.rel === p || doc.rel.startsWith(p))))

    const text = maskInline(maskFences(doc.text))
    for (const m of text.matchAll(UNCHECKED_COUNT)) {
      const said = Number(m[1].replace(/,/g, ''))
      if (said < 2) continue
      if (owns(m[2])) continue
      findings.push({
        file: doc.path, line: lineOf(text, m.index),
        message: `states "${m[0].replace(/\s+/g, ' ')}", and nothing regenerates it. A count with no ` +
                 `authority reads exactly as true as one with a generator behind it, and it is wrong by ` +
                 `the next commit (\`FJS-D187\`: a number in prose is generated or absent). Cut it and keep ` +
                 `the half of the sentence that changes what a reader does, give it a countable in ` +
                 `\`COUNTABLES\` so \`doc-claims-count\` grades it, or spell it if it is rhetoric.`,
      })
    }
  }
  return { findings }
}
