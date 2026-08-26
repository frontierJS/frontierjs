// test/catalog.test.ts
//
// The catalog is a claim of COMPLETENESS about the .lite language — eighty-six
// words, and the whole reason to read it is that nothing is missing. A word the
// parser accepts and the catalog does not know makes the table a lie about the
// one thing it offers, and it goes wrong silently: nobody gets an error for a
// feature they never heard of.
//
// So the two are held together in both directions, and neither direction is a
// restatement of the table.
//
//   catalog → parser   every row's `example` is built into a probe schema and
//                      parsed. A row describing a form the parser does not
//                      accept fails here rather than in someone's editor.
//
//   parser → catalog   the `case` arms of parseFieldAttribute and
//                      parseModelAttribute, plus the nine names parseSchema
//                      throws about, are read off the parser SOURCE and
//                      compared. A new attribute ships with a row or the suite
//                      is red.
//
// Reading the source with a regex is the awkward half and it is deliberate: the
// alternative is a table the parser imports, which makes the parser's switch a
// restatement of this file and moves the drift rather than catching it.

import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from '../src/core/parser.js'
import { deriveAccess } from '../src/access.js'
import { CATALOG, TOP_LEVEL, FIELD_ATTRS, MODEL_ATTRS, lookup, typed, grouped, GROUPS,
         POSITIONS, POSITION_RULES, positionsOf, probeFor, DOCS, UNDOCUMENTED, docFor } from '../src/core/catalog.js'
import { TRAIT_FORBIDDEN_FIELD_ATTRS, TRAIT_FORBIDDEN_MODEL_ATTRS,
         TYPE_FORBIDDEN_FIELD_ATTRS, ALLOWED_TOKENIZERS, ON_DELETE_ACTIONS,
         DATABASE_DRIVERS } from '../src/core/parser.js'

const PARSER_SRC = readFileSync(fileURLToPath(new URL('../src/core/parser.js', import.meta.url)), 'utf8')

// ─── reading the parser's own inventory ───────────────────────────────────────

/** The `case '<word>':` arms of one method, at the switch's own indent. */
function caseArms(method: string): string[] {
  const start = PARSER_SRC.indexOf(`\n  ${method}() {`)
  expect(start).toBeGreaterThan(-1)
  const rest = PARSER_SRC.slice(start + 1)
  // The next method declared at the class's own indent ends this body. Arms are
  // matched at the switch's indent alone, so the nested switches inside
  // parseFrom and parseDefault do not leak in as attributes.
  const next = rest.slice(1).search(/\n  [a-zA-Z$_][\w$]*\(\) \{/)
  const body = next > 0 ? rest.slice(0, next + 1) : rest
  return [...body.matchAll(/^      case '([A-Za-z]+)'/gm)].map(m => m[1])
}

/** The nine words parseSchema names in the error it throws for an unknown one. */
function topLevelWords(): string[] {
  const m = PARSER_SRC.match(/expected (database, tenancy, [^`]*?), or (\w+)`/)
  expect(m).not.toBeNull()
  return [...m![1].split(',').map(s => s.trim()), m![2]]
}

// ─── building a probe schema out of a row ─────────────────────────────────────

// `probeFor` is the catalog's own, because the reference page prints the same
// text this parses. A renderer assembling its own would publish a snippet no
// test has ever seen.

// ─── catalog → parser ─────────────────────────────────────────────────────────

describe('every catalog example parses', () => {
  for (const row of CATALOG) {
    test(`${typed(row)}`, () => {
      if (row.removed) {
        // A word the parser keeps only to refuse: the example must FAIL, and
        // the refusal must name the replacement. Asserting the throw is the
        // only way a removed word stays covered instead of quietly dropping
        // out of the table.
        const out = parse(probeFor(row))
        expect(out.valid).toBe(false)
        expect(out.errors.join(' ')).toContain(row.replacedBy)
        return
      }
      const src = probeFor(row)
      // parse() reports rather than throws — a test that only guarded against a
      // throw would pass on `@nosuchthing`, which is the whole class it exists
      // to catch.
      let out: any
      try {
        out = parse(src)
      } catch (e: any) {
        throw new Error(`${typed(row)} example threw: ${e.message}\n\n${src}\n`)
      }
      if (!out.valid)
        throw new Error(`${typed(row)} example is invalid: ${out.errors.join(' · ')}\n\n${src}\n`)
      expect(out.schema).not.toBeNull()

      // parse() is more permissive than the layers above it: it accepts a gate
      // string it will not run with, so an example can be `valid` here and
      // throw the moment anything reads the access surface. It cost a shipped
      // @@gate row whose levels ran the wrong way round.
      try {
        deriveAccess(out.schema)
      } catch (e: any) {
        throw new Error(`${typed(row)} example parses but the access layer rejects it: ${e.message}\n\n${src}\n`)
      }
    })
  }
})

// ─── parser → catalog ─────────────────────────────────────────────────────────

describe('the catalog covers the parser', () => {
  test('every top-level word has a row', () => {
    const words = topLevelWords()
    // A floor, not a count: the two set diffs below are the real check, and a
    // literal here is a number someone has to hand-edit to add a word.
    expect(words.length).toBeGreaterThan(5)
    const have = new Set(TOP_LEVEL.map(r => r.word))
    expect(words.filter(w => !have.has(w))).toEqual([])
    expect([...have].filter(w => !words.includes(w))).toEqual([])
  })

  test('every field attribute has a row', () => {
    const arms = caseArms('parseFieldAttribute')
    expect(arms.length).toBeGreaterThan(50)
    const have = new Set(FIELD_ATTRS.map(r => r.word))
    expect(arms.filter(a => !have.has(a))).toEqual([])
    expect([...have].filter(w => !arms.includes(w))).toEqual([])
  })

  test('every model attribute has a row', () => {
    const arms = caseArms('parseModelAttribute')
    expect(arms.length).toBeGreaterThan(20)
    const have = new Set(MODEL_ATTRS.map(r => r.word))
    expect(arms.filter(a => !have.has(a))).toEqual([])
    expect([...have].filter(w => !arms.includes(w))).toEqual([])
  })
})

// ─── the third position ───────────────────────────────────────────────────────
//
// `level` says which switch PARSES a word; it is not the same question as where
// the word is LEGAL. An enum member may carry `@label("…")`, and the parser gets
// there by calling parseFieldAttribute and refusing everything that is not a
// label — so the arm the coverage test above scrapes is the FIELD arm, and no
// amount of source-reading can see the third position.
//
// This asks the parser instead: every field attribute is tried on a member, and
// what it accepts must equal what the catalog declares.

describe('where a word is legal, not just which switch parses it', () => {
  // Four positions narrower than the switch that parses them, and the parser
  // reaches every one by calling parseFieldAttribute or parseModelAttribute and
  // refusing afterwards. So the arms the coverage test above scrapes are the
  // HOME arms, and no amount of source-reading can see the other four.
  //
  // Two checks, and they answer different questions. The first binds the
  // catalog's rule block to the parser's own Sets — exact, no probing. The
  // second drives the parser for the one position that is not a Set at all,
  // because an enum member's rule is written as a throw inside parseEnum.

  test('POSITION_RULES is the parser own forbidden sets, restated', () => {
    const known = (level: string, words: Iterable<string>) =>
      [...words].filter(w => CATALOG.some(r => r.level === level && r.word === w)).sort()

    expect([...POSITION_RULES.typeField.excludes].sort())
      .toEqual(known('field', TYPE_FORBIDDEN_FIELD_ATTRS))
    expect([...POSITION_RULES.traitField.excludes].sort())
      .toEqual(known('field', TRAIT_FORBIDDEN_FIELD_ATTRS))
    expect([...POSITION_RULES.traitBlock.excludes].sort())
      .toEqual(known('model', TRAIT_FORBIDDEN_MODEL_ATTRS))
  })

  // @deny is in the parser's type-forbidden set and is a MODEL attribute here,
  // so it is filtered out above rather than silently dropped. Asserting it
  // keeps that filter honest: if @deny ever becomes a field attribute, the
  // exclusion list has to grow and this says so.
  test('a word the parser forbids at a level it does not exist at is filtered, not ignored', () => {
    expect(TYPE_FORBIDDEN_FIELD_ATTRS.has('deny')).toBe(true)
    expect(CATALOG.some(r => r.level === 'field' && r.word === 'deny')).toBe(false)
    expect(CATALOG.some(r => r.level === 'model' && r.word === 'deny')).toBe(true)
  })

  const onEnumMember = (row: any) => {
    const marker = '@' + row.word
    const i = row.example.indexOf(marker)
    if (i < 0) return false
    const attr = row.example.slice(i).replace(/\n\s*/g, ' ')
    const src  = (row.context ? row.context + '\n' : '')
      + `enum CatalogEnum { alpha ${attr} }\nmodel Example { id Int @id  e CatalogEnum }`
    try { return parse(src).valid } catch { return false }
  }

  for (const row of FIELD_ATTRS) {
    test(`@${row.word} on an enum member`, () => {
      const declared = positionsOf(row).includes('enumMember')
      expect({ word: row.word, acceptedOnAMember: onEnumMember(row) })
        .toEqual({ word: row.word, acceptedOnAMember: declared })
    })
  }

  test('every position a row computes to is one the table names', () => {
    for (const row of CATALOG)
      for (const p of positionsOf(row))
        expect(Object.keys(POSITIONS).concat(['schema'])).toContain(p)
  })

  test('every word is legal somewhere', () => {
    for (const row of CATALOG)
      expect({ word: typed(row), positions: positionsOf(row).length > 0 })
        .toEqual({ word: typed(row), positions: true })
  })
})

// ─── what an argument accepts ─────────────────────────────────────────────────
//
// `arity` is prose and nothing checks prose, so a value that stops being
// accepted — or starts — leaves the catalog confidently wrong with no test to
// fail. Two checks again, for the same reason as positions: bind where the
// parser states a Set, and DRIVE where it does not.

describe('enumerated argument values', () => {
  const withValues = CATALOG.filter(r => r.values)

  test('there are rows carrying them at all', () => {
    expect(withValues.length).toBeGreaterThan(5)
  })

  test('the sets the parser states as data are restated exactly', () => {
    const of = (word: string, level: string, arg: string) =>
      CATALOG.find(r => r.word === word && r.level === level)!.values!.find((v: any) => v.arg === arg)!.of
    const names = (list: any[]) => list.map(e => typeof e === 'string' ? e : e.value).sort()
    expect(names(of('fts', 'model', 'tokenize'))).toEqual([...ALLOWED_TOKENIZERS].sort())
    expect(names(of('relation', 'field', 'onDelete'))).toEqual([...ON_DELETE_ACTIONS].sort())
    expect(names(of('database', 'schema', 'driver'))).toEqual([...DATABASE_DRIVERS].sort())
  })

  const probeWith = (row: any, v: any, entry: any) => {
    const value = typeof entry === 'string' ? entry : entry.value
    const line  = (typeof entry === 'string' ? v.probe : entry.probe).replaceAll('%s', value)
    const ctx  = row.context ? row.context + '\n\n' : ''
    if (row.level === 'schema') return parse(ctx + line + '\nmodel Example { id Int @id }')
    const extra = row.extraFields ? `  ${row.extraFields}\n` : ''
    return parse(`${ctx}model Example {\n  id Int @id\n${extra}  ${line}\n}`)
  }

  for (const row of withValues)
    for (const v of row.values!) {
      test(`${typed(row)}(${v.arg}) accepts exactly what it declares`, () => {
        for (const entry of v.of) {
          const value = typeof entry === 'string' ? entry : entry.value
          const out   = probeWith(row, v, entry)
          if (!out.valid)
            throw new Error(`${typed(row)}(${v.arg}: ${value}) is declared and refused: ${out.errors.join(' · ')}`)
        }
        // The half that catches a set which has GROWN: an invented value must
        // still be refused, or the list is a description rather than a rule.
        const bogus = probeWith(row, v, 'zzNotAValue')
        expect({ arg: v.arg, inventedAccepted: bogus.valid }).toEqual({ arg: v.arg, inventedAccepted: false })
      })
    }
})

// ─── the table's own shape ────────────────────────────────────────────────────

// ─── where to read more ───────────────────────────────────────────────────────
//
// A pointer out of the catalog is the only thing here that can rot without
// anything failing: `seeAlso` names another row and is checked by construction,
// but a docs filename is a string about the filesystem. Renaming a page under
// `docs/` leaves eighty-five readers pointing at nothing, in four tools.

describe('every word says where to read more', () => {
  const DOC_DIR = fileURLToPath(new URL('../docs/', import.meta.url))

  test('every page named is a page that is there', () => {
    for (const [key, file] of Object.entries(DOCS))
      expect({ key, file, exists: existsSync(DOC_DIR + file) })
        .toEqual({ key, file, exists: true })
  })

  test('every key names a row — including the nine words that exist at two levels', () => {
    for (const key of [...Object.keys(DOCS), ...Object.keys(UNDOCUMENTED)]) {
      const [level, word] = key.split(':')
      expect({ key, row: CATALOG.some(r => r.level === level && r.word === word) })
        .toEqual({ key, row: true })
    }
    // The trap this catches: the key is the word as TYPED, so @@unique is
    // `model:unique` and never `model:uniqueIndex`, which is its parse kind.
    expect(docFor(lookup('@@unique')!)).toBe('docs/performance.md')
    expect(docFor(lookup('@unique')!)).toBe('docs/schema.md')
  })

  test('a word with no page says why, so an omission is a decision', () => {
    const orphans = CATALOG
      .filter(r => !r.removed && !docFor(r) && !UNDOCUMENTED[`${r.level}:${r.word}`])
      .map(typed)
    expect(orphans).toEqual([])
    for (const reason of Object.values(UNDOCUMENTED))
      expect(reason.length).toBeGreaterThan(20)
  })

  test('a removed word is not sent anywhere', () => {
    for (const row of CATALOG.filter(r => r.removed))
      expect({ word: typed(row), doc: docFor(row) }).toEqual({ word: typed(row), doc: null })
  })
})

describe('catalog shape', () => {
  test('every row is complete', () => {
    for (const row of CATALOG) {
      expect(typeof row.word).toBe('string')
      expect(['schema', 'field', 'model']).toContain(row.level)
      expect(Object.keys(GROUPS)).toContain(row.group)
      expect(row.blurb.length).toBeGreaterThan(0)
      expect(row.blurb[0]).toBe(row.blurb[0].toUpperCase())
      expect(row.example.length).toBeGreaterThan(0)
    }
  })

  test('a word is unique within its level', () => {
    const seen = new Set<string>()
    for (const row of CATALOG) {
      const key = `${row.level}:${row.word}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  test('seeAlso and excludes name real rows', () => {
    const words = new Set(CATALOG.map(r => r.word))
    for (const row of CATALOG)
      for (const ref of [...(row.seeAlso ?? []), ...(row.excludes ?? [])])
        expect({ row: typed(row), ref, known: words.has(ref) }).toEqual({ row: typed(row), ref, known: true })
  })

  test('excludes is symmetric — a pair that cannot coexist says so on both sides', () => {
    for (const row of CATALOG)
      for (const ref of row.excludes ?? []) {
        const other = lookup(ref, row.level)
        expect({ pair: `${row.word}/${ref}`, back: other?.excludes?.includes(row.word) ?? false })
          .toEqual({ pair: `${row.word}/${ref}`, back: true })
      }
  })
})

// ─── the readers' entry points ────────────────────────────────────────────────

describe('lookup and grouping', () => {
  test('lookup takes the word as typed, and the prefix picks the level', () => {
    expect(lookup('@unique')!.level).toBe('field')
    expect(lookup('@@unique')!.level).toBe('model')
    expect(lookup('@@unique')!.kind).toBe('uniqueIndex')   // written word ≠ node kind
    expect(lookup('model')!.level).toBe('schema')
    expect(lookup('@nosuchthing')).toBeNull()
  })

  test('grouped covers every row of a level exactly once', () => {
    for (const level of ['schema', 'field', 'model']) {
      const flat = grouped(level).flatMap(g => g.rows)
      expect(flat.length).toBe(CATALOG.filter(r => r.level === level).length)
    }
  })
})
