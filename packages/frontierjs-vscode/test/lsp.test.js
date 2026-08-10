// Litestone language server — behavioural tests over real LSP/stdio.
//
// Run:  npm test           (builds first — a stale out/ tests the previous fix)
//
// Every case here corresponds to a defect that shipped. See CLAUDE.md
// § What bites here before adding one.

const path = require('path')
const fs   = require('fs')
const { LspClient, labels, hoverText } = require('./lsp-client')

const ROOT   = path.resolve(__dirname, '..')
const SERVER = path.join(ROOT, 'out', 'litestone', 'server.js')

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
    ok(`${name} parses clean`, diags.length === 0,
      diags.slice(0, 2).map(d => d.message).join(' | '))

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
