// Litestone language server — behavioral tests over real LSP/stdio.
//
// Run:  npm test           (builds first — a stale out/ tests the previous fix)
//
// Every case here corresponds to a defect that shipped. See CLAUDE.md
// § What bites here before adding one.

const path = require('path')
const fs   = require('fs')
const os   = require('os')
const { LspClient, labels, hoverText } = require('./lsp-client')

const ROOT = path.resolve(__dirname, '..')

// FJS_LSP_SERVER points the whole suite at another copy of the server — which is
// how the UNPACKED .vsix is tested (scripts/verify-package.js), where node_modules
// is absent and a missed bundle would fail at spawn rather than in the marketplace.
const SERVER = process.env.FJS_LSP_SERVER || path.join(ROOT, 'out', 'litestone', 'server.js')

// ─── Tiny harness ─────────────────────────────────────────────────────────────

let pass = 0, fail = 0, group = ''
const failures = []

function section(name) { group = name; console.log(`\n${name}`) }

function ok(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ok    ${name}`) }
  else {
    fail++
    failures.push(`${group} › ${name}${detail ? `\n        ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** Assert a completion list contains all of `has` and none of `hasNot`. */
function completion(name, list, { has = [], hasNot = [] }) {
  const missing = has.filter(x => !list.includes(x))
  const present = hasNot.filter(x => list.includes(x))
  ok(name, !missing.length && !present.length,
    (missing.length ? `missing [${missing}] ` : '') +
    (present.length ? `unexpected [${present}] ` : '') +
    `— got ${list.length}: ${list.slice(0, 8).join(',')}`)
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// Kept VALID on purpose: schema-derived names (models, enums) only reach the
// completion list when the whole document parses. A half-typed field anywhere
// means schema:null and scalar types only — which is the null guard working,
// not a bug. BROKEN below is the deliberate exception.

// A model using words that had no hover before the catalog was wired in.
// @@tenant needs a tenancy block or the document does not parse, and hover on a
// document with a parse error is a different code path — which is what the first
// version of this fixture accidentally tested.
const NEW_WORDS = [
  'tenancy {',
  '  strategy row',
  '  column   workspaceId',
  '}',
  '',
  'model Thing {',
  '  id      Int      @id',
  '  code    String   @system',
  '  overdue Boolean  @derived(id > 0)',
  '  @@gate("2.4.4.5")',
  '  @@tenant(none)',
  '}',
].join('\n')

/** Column of `needle` on `lineNo` of a multi-line fixture. */
function col2(text, lineNo, needle) {
  return text.split('\n')[lineNo].indexOf(needle)
}

const VALID = [
  'database audit {',                                                 // 0
  '  driver logger',
  '  path   "./audit.jsonl"',
  '}',
  '',
  'function slug(text: String): String {',                            // 5
  '  @@expr("lower(trim({text}))")',
  '}',
  '',
  'enum Plan {',                                                      // 9
  '  free',
  '  pro',
  '}',
  '',
  'model Owner {',                                                    // 14
  '  id        Int    @id',
  '  leads     Lead[]',
  '  leadCount Int    @from(Lead, count: true)',                      // 17
  '}',
  '',
  'model Lead {',                                                     // 20
  '  id      Int    @id',
  '  status  Plan   @default(free)',                                  // 22
  '  ownerId Int',
  '  owner   Owner  @relation(fields: [ownerId], references: [id])',  // 24
  '  @@gate("4.4.4.4")',                                              // 25
  '  @@log(audit)',                                                   // 26
  '}',
  '',
].join('\n')

const V = VALID.split('\n')
/** Column of `needle` on line `l`, plus an offset. */
const col = (l, needle, off = 0) => V[l].indexOf(needle) + off

// Deliberately unparseable — the normal state while a schema is being typed.
const BROKEN = 'model {{{ broken'

// One-line block: opens and closes on the same line, so it must neither open
// nor close the block stack. Real schemas write enums this way.
const ONELINE = 'enum Plan { free pro }\n\nmodel Lead {\n  id   Int @id\n  plan Plan\n}\n'

// A commented-out block must not be counted.
const COMMENTED = '// model Ghost {\n//   id Int\n// }\n\nmodel Lead {\n  id   Int @id\n  plan String\n}\n'

// The model comes first here — the shape that accidentally worked before the
// block-stack fix, kept so a regression can't hide behind it.
const MODEL_FIRST = 'model Lead {\n  id   Int @id\n  plan Plan\n}\n\nenum Plan {\n  free\n}\n'

const u = name => `file:///${name}.lite`

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(SERVER)) {
    console.error(`\nServer not built: ${SERVER}\nRun: npm run build\n`)
    process.exit(1)
  }

  const c = new LspClient(SERVER)
  const caps = await c.start()

  section('server')
  const p = caps?.capabilities ?? {}
  ok('initialize returns completion provider', !!p.completionProvider)
  ok('initialize returns hover provider',      p.hoverProvider === true)
  ok('initialize returns formatting provider', p.documentFormattingProvider === true)

  // ── Diagnostics ────────────────────────────────────────────────────────────
  section('diagnostics')
  const validDiags = await c.openDoc(u('valid'), VALID)
  ok('a valid schema reports none', validDiags.length === 0, JSON.stringify(validDiags))

  const brokenDiags = await c.openDoc(u('broken'), BROKEN)
  ok('a broken schema reports the parser error',
    brokenDiags.some(d => /Expected IDENT/.test(d.message)),
    JSON.stringify(brokenDiags))
  ok('the error is severity Error', brokenDiags[0]?.severity === 1)

  // ── Null schema — parse() returns schema:null on ANY syntax error, which is
  //    the normal mid-keystroke state. These used to take the server down.
  section('null schema (mid-keystroke)')
  const bc = await c.completion(u('broken'), 0, 8)
  ok('completion answers instead of crashing', Array.isArray(bc), JSON.stringify(bc))
  const bh = await c.hover(u('broken'), 0, 2)
  ok('hover answers instead of crashing', bh === null || typeof bh === 'object')
  ok('server still alive afterwards', c.alive)

  // ── Block detection — a per-keyword depth counter that decremented on every
  //    `}` went negative after any earlier block, so `inModel` was false for the
  //    rest of the file. An enum above the models is every real schema.
  section('block detection')
  completion('types inside a model preceded by other blocks',
    labels(await c.completion(u('valid'), 22, col(22, 'Plan'))),
    { has: ['Int', 'String', 'Plan', 'Owner', 'Lead'], hasNot: ['model', 'enum'] })

  await c.openDoc(u('oneline'), ONELINE)
  completion('one-line enum above the model',
    labels(await c.completion(u('oneline'), 4, 7)), { has: ['Int', 'Plan'] })

  await c.openDoc(u('modelfirst'), MODEL_FIRST)
  completion('model declared first',
    labels(await c.completion(u('modelfirst'), 2, 7)), { has: ['Int', 'Plan'] })

  await c.openDoc(u('commented'), COMMENTED)
  completion('a commented-out block is not counted',
    labels(await c.completion(u('commented'), 6, 7)), { has: ['Int'] })

  completion('inside a database block',
    labels(await c.completion(u('valid'), 1, 9)),
    { has: ['sqlite', 'jsonl', 'logger'], hasNot: ['Int'] })

  completion('at top level',
    labels(await c.completion(u('valid'), 13, 0)),
    { has: ['model', 'enum', 'function', 'database'], hasNot: ['Int'] })

  // ── Caret-aware attributes — `includes('@')` over the whole line meant that
  //    on any field that already carried an attribute (i.e. most of them) the
  //    type list was replaced by the attribute list.
  section('attributes follow the caret')
  completion('caret on the TYPE of a line that has an attribute',
    labels(await c.completion(u('valid'), 22, col(22, 'Plan') + 4)),
    { has: ['Int', 'String', 'Plan', 'Owner'], hasNot: ['@id', '@unique'] })

  completion('caret on the ATTRIBUTE of that same line',
    labels(await c.completion(u('valid'), 22, col(22, '@default') + 8)),
    { has: ['@id', '@unique'], hasNot: ['Int', 'Plan'] })

  completion('@@ on a line that also contains @',
    labels(await c.completion(u('valid'), 25, col(25, '@@gate') + 2)),
    { has: ['@@gate', '@@index'], hasNot: ['@id'] })

  // ── The catalog is what the language contains ──────────────────────────────
  //
  // These lists used to be written out in server.ts, and were wrong: 50 field
  // attributes against 55, 15 model attributes against 22, and four top-level
  // declarations never offered at all. A hand-written inventory has no way to be
  // wrong out loud, so the assertion is against the catalog itself rather than
  // against a count copied into this file.
  section('catalog-derived completion')
  {
    const catalog = require(path.join(ROOT, 'out', 'litestone', 'catalog-bundle.js'))
    const at = (level, prefix) =>
      catalog.CATALOG.filter(r => r.level === level && !r.removed).map(r => prefix + r.word)

    // Caret on an ATTRIBUTE, not on the type — a type position answers types,
    // which is why the first version of this reported all 55 missing.
    const fieldOffered = labels(await c.completion(u('valid'), 22, col(22, '@default') + 8))
    const missingField = at('field', '@').filter(w => !fieldOffered.includes(w))
    ok(`every field attribute is offered (${at('field', '@').length})`,
      missingField.length === 0, `missing: ${missingField.join(' ')}`)

    const modelOffered = labels(await c.completion(u('valid'), 25, col(25, '@@gate') + 2))
    const missingModel = at('model', '@@').filter(w => !modelOffered.includes(w))
    ok(`every model attribute is offered (${at('model', '@@').length})`,
      missingModel.length === 0, `missing: ${missingModel.join(' ')}`)

    // A word the parser keeps only to refuse must not be suggested.
    const removed = catalog.CATALOG.filter(r => r.removed).map(r => '@@' + r.word)
    ok('a removed word is not offered',
      removed.every(w => !modelOffered.includes(w)), `offered: ${removed.join(' ')}`)
  }

  // ── Hover for the words that never had one ─────────────────────────────────
  //
  // ATTR_DOCS covers 57 spellings and wins where it has an entry. Everything
  // else hovered as nothing at all — @system, @transient, @@tenant among them —
  // which reads in an editor exactly like a word that does not exist.
  section('catalog-derived hover')
  {
    await c.openDoc(u('newwords'), NEW_WORDS)
    const h1 = hoverText(await c.hover(u('newwords'), 7, col2(NEW_WORDS, 7, '@system') + 2))
    ok('@system hovers', /readOnly|application|caller/i.test(h1 || ''), JSON.stringify(h1))

    const h2 = hoverText(await c.hover(u('newwords'), 10, col2(NEW_WORDS, 10, '@@tenant') + 3))
    ok('@@tenant hovers', /tenant/i.test(h2 || ''), JSON.stringify(h2))

    // The catalog contributes the two facts prose keeps getting wrong.
    const h3 = hoverText(await c.hover(u('newwords'), 8, col2(NEW_WORDS, 8, '@derived') + 3))
    ok('a catalog hover carries a worked example', /```lite/.test(h3 || ''), JSON.stringify(h3))

    // The example is `probeFor`, the catalog's own assembler and the same text
    // its suite parses — not a second assembly here, which is how a hover ends
    // up showing a snippet that does not compile.
    const catalog = require(path.join(ROOT, 'out', 'litestone', 'catalog-bundle.js'))
    const derived = catalog.CATALOG.find(r => r.level === 'field' && r.word === 'derived')
    ok('the example is the catalog probe verbatim',
       (h3 || '').includes(catalog.probeFor(derived)), JSON.stringify(h3))

    // And the one line that leads OUT of the catalog. Named, never linked: the
    // docs ship inside the package, not beside the file being edited.
    ok('a word with a docs page says which',
       /📖 `docs\/modeling\.md`/.test(h3 || ''), JSON.stringify(h3))

    // Every word either has a page or is named as having none, so a new word
    // arriving undocumented is a decision rather than an omission.
    const orphans = catalog.CATALOG
      .filter(r => !r.removed && !catalog.docFor(r) && !catalog.UNDOCUMENTED[r.level + ':' + r.word])
      .map(r => r.word)
    ok('every word has a page or a stated reason it has none', orphans.length === 0, orphans.join(' '))
  }

  completion('inside @relation(...)',
    labels(await c.completion(u('valid'), 24, col(24, '@relation(') + 10)),
    { has: ['Owner', 'Lead'], hasNot: ['@id', 'Int'] })

  // @from's first argument is the MODEL name — @from(lead, …) is "unknown
  // model". The list used to offer m.name.toLowerCase(), i.e. only unparseable
  // forms. litestone's own docs had the same error.
  completion('inside @from(...) — PascalCase model names',
    labels(await c.completion(u('valid'), 17, col(17, '@from(') + 6)),
    { has: ['Lead', 'Owner'], hasNot: ['lead', 'owner', 'Int'] })

  completion('inside @@gate(...)',
    labels(await c.completion(u('valid'), 25, col(25, '@@gate(') + 8)),
    { has: ['STRANGER', 'USER', 'SYSADMIN'], hasNot: ['Int', '@id'] })

  completion('inside @@log(...)',
    labels(await c.completion(u('valid'), 26, col(26, '@@log(') + 6)),
    { has: ['audit'], hasNot: ['Int', '@id'] })

  // ── Hover ──────────────────────────────────────────────────────────────────
  section('hover')
  ok('a model shows its fields',
    /model Lead/.test(hoverText(await c.hover(u('valid'), 20, col(20, 'Lead') + 1))))
  ok('an enum shows its values',
    /enum Plan/.test(hoverText(await c.hover(u('valid'), 22, col(22, 'Plan') + 1))))
  ok('a schema function shows its signature',
    /function slug/.test(hoverText(await c.hover(u('valid'), 5, col(5, 'slug') + 1))))
  ok('a scalar type is documented',
    hoverText(await c.hover(u('valid'), 21, col(21, 'Int') + 1)).length > 0)
  ok('an attribute is documented',
    /primary key/i.test(hoverText(await c.hover(u('valid'), 21, col(21, '@id') + 1))))

  // ── Formatting ─────────────────────────────────────────────────────────────
  section('formatting')
  const edits = await c.formatting(u('valid'))
  ok('returns edits for a valid document', Array.isArray(edits) && edits.length > 0,
    JSON.stringify(edits)?.slice(0, 120))

  // ── Imports ────────────────────────────────────────────────────────────────
  //
  // `parse()` resolves nothing, so until the server spliced imports itself, a
  // schema that imports a package's models was parsed as if those models did not
  // exist — and every reference to one was an error the author could not remove.
  // It went unseen for as long as it existed because the only real schema this
  // suite checked with imports is basecamp's, and basecamp had hand copies
  // instead of imports.
  section('imports')
  {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-import-'))
    const frag = path.join(dir, 'fragment.lite')
    const root = path.join(dir, 'schema.lite')
    fs.writeFileSync(frag, 'model Session {\n  id     String @id @default(uuid())\n  userId String\n}\n')

    const rootText = [
      'database main { path "./a.db" }',
      '',
      'import "./fragment.lite"',
      '',
      'model User {',
      '  id String @id @default(uuid())',
      '}',
      '',
      'extend model Session {',
      '  user User @relation(fields: [userId], references: [id])',
      '}',
    ].join('\n')
    fs.writeFileSync(root, rootText)

    const diags  = await c.openDoc(`file://${root}`, rootText)
    const errors = diags.filter(d => d.severity === 1)
    ok('a model reached through an import is not reported as missing',
       errors.length === 0, errors.map(d => d.message).join(' | '))

    // The other half: the splice must not swallow a real error. Without this the
    // rule above is satisfied by a server that reports nothing at all.
    const bustedText = rootText + '\n\nextend model Sesion {\n  x String?\n}\n'
    fs.writeFileSync(root, bustedText)
    const busted = (await c.openDoc(`file://${root}`, bustedText)).filter(d => d.severity === 1)
    ok('and a genuine error in the same file still is',
       busted.length > 0 && /Sesion/.test(busted.map(d => d.message).join(' ')),
       busted.map(d => d.message).join(' | '))

    // An unresolvable import is NOT reported: the package may simply not be
    // installed in this checkout, and a squiggle on a line the author cannot act
    // on is worse than a schema that describes less.
    const absentText = 'database main { path "./a.db" }\n\nimport "@nobody/nothing.lite"\n\nmodel Thing { id String @id }\n'
    fs.writeFileSync(root, absentText)
    const absent = (await c.openDoc(`file://${root}`, absentText)).filter(d => d.severity === 1)
    ok('an import that resolves to nothing is not an error squiggle',
       absent.length === 0, absent.map(d => d.message).join(' | '))

    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── The repo's own schemas ─────────────────────────────────────────────────
  section('real schemas')
  const real = [
    path.resolve(ROOT, '../../example/db/schema.lite'),
    path.resolve(ROOT, '../basecamp/db/schema.lite'),
  ].filter(fs.existsSync)
  ok('found at least one real schema to check', real.length > 0)

  for (const file of real) {
    const name  = path.relative(path.resolve(ROOT, '../..'), file)
    const text  = fs.readFileSync(file, 'utf8')
    const uri   = `file://${file}`
    const diags = await c.openDoc(uri, text)
    // A warning the author cannot remove without making the schema WORSE is not
    // a broken parse. basecamp's tenancy infers a scope through a parent for the
    // models carrying no column of their own and says so; declaring it narrows to
    // one relation and drops rules. So grade the errors, and print the warnings
    // rather than counting them — a standing warning that stops being reported is
    // the thing worth noticing here.
    const errors   = diags.filter(d => d.severity === 1)
    const warnings = diags.filter(d => d.severity !== 1)
    ok(`${name} parses with no errors`, errors.length === 0,
      errors.slice(0, 2).map(d => d.message).join(' | '))
    for (const w of warnings) console.log(`  note  ${name}: ${w.message}`)

    // A bare field line INSIDE a model — `driver logger` in a database block
    // matches the same shape, so track which block we are in rather than
    // pattern-matching the line alone.
    const lines = text.split('\n')
    let inModel = false
    const idx = lines.findIndex(l => {
      const t = l.trim()
      if (/^model\s+\w/.test(t) && t.endsWith('{')) { inModel = true;  return false }
      if (t.startsWith('}'))                        { inModel = false; return false }
      return inModel && /^\w+\s+\w+$/.test(t)
    })
    if (idx !== -1) {
      completion(`${name}: types offered inside a model (line ${idx + 1})`,
        labels(await c.completion(uri, idx, lines[idx].length)),
        { has: ['Int', 'String'], hasNot: ['model', 'sqlite'] })
    }
  }

  section('teardown')
  ok('server survived the whole suite', c.alive, `exit=${c.exitCode} stderr=${c.stderr}`)
  c.stop()

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) {
    console.log('\nFailures:')
    failures.forEach(f => console.log(`  - ${f}`))
  }
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('\nsuite crashed:', e); process.exit(1) })
