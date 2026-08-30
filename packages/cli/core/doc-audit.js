// ─── doc-audit.js — the notes, graded against the tree ───────────────────────
//
// Four rules over this repo's own markdown, all of them the same failure: a
// document that says something the tree does not say back. Prose is the one
// artefact here with no compiler, no test and no snapshot behind it, so it is
// the only place a claim can be wrong for months while everything runs green —
// and it is read first, by everyone, on the way in.
//
// `FJS-560` is the shape and it cost a session: `litestone/docs/roadmap.md`
// still proposed a way to express money four days after `@money` shipped, a
// reader took the roadmap for the current state, and a defect was filed against
// a settled ruling. `roadmap-shipped` closed that one page. These four close the
// classes around it — a word that does not exist, a citation that resolves to
// nothing, a count that has moved, and an invariant that has been renumbered.
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
        findings.push({
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
        if (text && !text.includes(`id="${frag}"`)) findings.push({
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
      findings.push({
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
