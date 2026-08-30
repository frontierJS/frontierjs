// import.test.ts — `litestone import`, and the one guard the corpus cannot give.
//
// `corpus.test.ts` beside this runs the four readers over seven real
// applications and proves the OUTPUT builds. This file covers the seam that
// makes the output usable: format detection, the three tiers, and the marker
// that puts a `changed` construct on the line somebody will actually read.
//
// **The totality check is the substantive one.** A reader that learns a new
// refusal and is not graded would file it under whatever the fallback is — so
// every `gap('…')` literal in the readers is read out of the source and matched
// against the table. The fallback (`changed`, fail-closed) stays as a backstop
// for a kind built at runtime, and is never the mechanism.

import { describe, test, expect } from 'bun:test'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '../src/core/parser.js'
import { READERS, FORMATS, TIERS, tierOf, gradedKinds, summarise,
         detectFormat, loadSource, convert, annotate, fileHeader } from '../src/import/index.js'

const src = new URL('../src/import/', import.meta.url).pathname

// Every producer that grades by the table, not just the four readers.
// `tools/introspect.js` reads a live SQLite database and is graded the same way
// — one table for both, or two answers to *how bad is this*. Leaving it off the
// list is how a kind it emits ends up ungraded and therefore `changed`.
const PRODUCERS = ['prisma.js', 'rails.js', 'sql.js', 'frappe.js', 'polymorphic.js']
  .map(f => join(src, f))
  .concat([new URL('../src/tools/introspect.js', import.meta.url).pathname])

describe('the tier table is total over what the readers can emit', () => {
  test('every gap kind in every reader is graded', () => {
    const emitted = new Set<string>()
    for (const f of PRODUCERS)
      for (const m of readFileSync(f, 'utf8').matchAll(/\bgap\(\s*'([a-z0-9-]+)'/g))
        emitted.add(m[1])

    expect(emitted.size).toBeGreaterThan(40)
    const graded = new Set(gradedKinds())
    expect([...emitted].filter(k => !graded.has(k))).toEqual([])
  })

  test('nothing is graded that no reader emits', () => {
    const emitted = new Set<string>()
    for (const f of PRODUCERS)
      for (const m of readFileSync(f, 'utf8').matchAll(/\bgap\(\s*'([a-z0-9-]+)'/g))
        emitted.add(m[1])
    expect(gradedKinds().filter(k => !emitted.has(k))).toEqual([])
  })

  test('every kind grades to one of the three tiers', () => {
    for (const k of gradedKinds()) expect(TIERS).toContain(tierOf(k))
  })

  // Fail-closed: a kind nobody has graded must not be filed under "ignore me".
  test('an unknown kind grades changed', () => {
    expect(tierOf('a-kind-invented-after-this-table')).toBe('changed')
  })
})

describe('detecting the format', () => {
  test('by extension and by name', () => {
    expect(detectFormat('/x/schema.prisma')).toBe('prisma')
    expect(detectFormat('/x/db/schema.rb')).toBe('rails')
    expect(detectFormat('/x/db/structure.sql')).toBe('sql')
    expect(detectFormat('/x/notes.txt')).toBe(null)
  })

  test('a directory is a Frappe app', () => {
    const dir = join(tmpdir(), `litestone-import-detect-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    try { expect(detectFormat(dir)).toBe('frappe') } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('every declared format has a reader', () => {
    for (const f of FORMATS) expect(typeof READERS[f]).toBe('function')
  })
})

describe('reading a source', () => {
  test('--from=frappe against a file is refused by name', () => {
    const file = join(tmpdir(), `litestone-import-${process.pid}.json`)
    writeFileSync(file, '{}')
    try {
      expect(() => loadSource(file, 'frappe')).toThrow(/DIRECTORY of DocType JSON/)
    } finally { rmSync(file, { force: true }) }
  })

  test('a directory holding no doctype is refused rather than read as empty', () => {
    const dir = join(tmpdir(), `litestone-import-empty-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"not-a-doctype"}')
    try {
      expect(() => loadSource(dir, 'frappe')).toThrow(/no DocType JSON/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a doctype directory is walked to any depth', () => {
    const dir = join(tmpdir(), `litestone-import-frappe-${process.pid}`)
    mkdirSync(join(dir, 'mod', 'doctype', 'task'), { recursive: true })
    writeFileSync(join(dir, 'mod', 'doctype', 'task', 'task.json'), JSON.stringify({
      doctype: 'DocType', name: 'Task',
      fields: [{ fieldname: 'subject', fieldtype: 'Data', reqd: 1 }],
    }))
    try {
      const { format, source } = loadSource(dir)
      expect(format).toBe('frappe')
      expect((source as any[]).length).toBe(1)
      expect(convert({ source, format }).models).toEqual(['Task'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('an unknown format is refused by name', () => {
    expect(() => convert({ source: '', format: 'graphql' })).toThrow(/unknown format/)
  })
})

// A Prisma schema carrying one construct of each tier — the surrogate key is
// `changed`, the dropped index name is `lost`, and the string `type` column is
// an STI candidate, which is `noted`.
const PRISMA = `
model Reading {
  key    String
  action String
  type   String
  taken  Int
  @@id([key, action])
  @@index([taken], map: "idx_reading_taken")
}
`

describe('converting, grading and marking', () => {
  const { lite, gaps, models, summary } = convert({ source: PRISMA, format: 'prisma', label: 'fixture' })

  test('it reads the models', () => {
    expect(models).toEqual(['Reading'])
    expect(parse(lite).valid).toBe(true)
  })

  test('the three tiers are counted separately', () => {
    expect(summary.changed).toBe(1)   // the composite primary key
    expect(summary.lost).toBe(1)      // the index name
    expect(summary.noted).toBe(1)     // the string `type` column — an STI candidate
    expect(summary.total).toBe(3)
    expect(summary.worst).toBe('changed')
  })

  test('summarise groups by kind, worst tier first', () => {
    expect(summary.byKind[0].tier).toBe('changed')
    expect(summary.byKind.map(r => r.kind)).toContain('composite-primary-key')
  })

  // The terminal scrolls away; the file does not.
  test('a changed construct is marked on the line it is about', () => {
    const marked = annotate(lite, gaps)
    const line   = marked.split('\n').find(l => l.startsWith('model Reading'))
    expect(line).toContain('⚠ imported:')
    expect(line).toContain('@@id([key, action])')
  })

  test('a lost or noted construct is not marked', () => {
    const marked = annotate(lite, gaps)
    expect(marked.split('\n').filter(l => l.includes('⚠ imported:')).length).toBe(1)
  })

  test('the marked output still parses', () => {
    const r = parse(annotate(lite, gaps))
    expect(r.errors).toEqual([])
    expect(r.valid).toBe(true)
  })

  test('the header carries the counts, and the whole file parses with it', () => {
    const body = fileHeader({ format: 'prisma', path: 'schema.prisma', models: models.length, summary }) +
                 annotate(lite, gaps)
    expect(body).toContain('1 changed')
    expect(body).toContain('Read mechanically by `litestone import --from prisma`')
    expect(parse(body).valid).toBe(true)
  })
})

describe('a clean source says so', () => {
  const { gaps, summary } = convert({
    source: 'model Note {\n  id Int @id\n  body String\n}\n', format: 'prisma' })

  test('nothing unexpressed', () => {
    expect(gaps).toEqual([])
    expect(summary.total).toBe(0)
    expect(summary.worst).toBe(null)
  })

  test('the header says nothing went unexpressed', () => {
    expect(fileHeader({ format: 'prisma', path: 'x.prisma', models: 1, summary }))
      .toContain('Nothing in the source went unexpressed')
  })

  test('annotate leaves a clean schema alone', () => {
    expect(annotate('model Note {\n  id Int @id\n}\n', [])).toBe('model Note {\n  id Int @id\n}\n')
  })
})

describe('a 64-bit column — which ones are worth saying (`FJS-583`)', () => {
  // The COLUMN is fine: SQLite's INTEGER is 64-bit too. The boundary is not,
  // because the value crosses a JS number at both ends. Graded `changed`, and
  // it used to be graded `noted` on the claim that "the range holds".
  const bigints = (src: string, format = 'prisma') =>
    convert({ source: src, format, label: 'fx' }).gaps
      .filter(g => g.kind === 'bigint').map(g => `${g.model}.${g.field}`)

  test('a supplied value is reported', () => {
    expect(bigints(`model E {
  id        Int    @id @default(autoincrement())
  startTime BigInt
}`)).toEqual(['E.startTime'])
  })

  test('a generated key and a foreign key are not', () => {
    expect(bigints(`model A {
  id      BigInt @id @default(autoincrement())
  ownerId BigInt
  owner   B      @relation(fields: [ownerId], references: [id])
}
model B {
  id BigInt @id @default(autoincrement())
  as A[]
}`)).toEqual([])
  })

  test('an id somebody else generated IS reported — the case a name rule would skip', () => {
    // GitHub hands this out; it is not counted from 1 here, and it is exactly
    // the shape that overflows. A rule keyed on the `Id` suffix misses it.
    expect(bigints(`model G {
  id                 Int    @id @default(autoincrement())
  appInstallationId  BigInt
}`)).toEqual(['G.appInstallationId'])
  })

  test('a BigInt key with no generator is reported — nothing counts it from 1', () => {
    expect(bigints(`model K {
  id BigInt @id
}`)).toEqual(['K.id'])
  })

  test('a Postgres dump reports the value columns and not the keys', () => {
    const sql = `
CREATE TABLE public.wallets (
    id bigint NOT NULL,
    account_id bigint NOT NULL,
    balance_cents bigint DEFAULT 0 NOT NULL
);
ALTER TABLE ONLY public.wallets ADD CONSTRAINT wallets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.wallets ADD CONSTRAINT fk_acc FOREIGN KEY (account_id) REFERENCES public.accounts(id);
CREATE TABLE public.accounts (
    id bigint NOT NULL
);
ALTER TABLE ONLY public.accounts ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);
`
    expect(bigints(sql, 'sql')).toEqual(['Wallet.balance_cents'])
  })

  test('a Rails schema reports the value columns and not the foreign keys', () => {
    const rb = `
ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do
  create_table "statuses", force: :cascade do |t|
    t.bigint "account_id", null: false
    t.bigint "reblogs_count", default: 0, null: false
  end
  create_table "accounts", force: :cascade do |t|
    t.string "username"
  end
  add_foreign_key "statuses", "accounts"
end
`
    // The table's own `id` is emitted from the create_table line and never
    // reaches the column loop, so the foreign key is the only exemption left.
    expect(bigints(rb, 'rails')).toEqual(['Status.reblogs_count'])
  })

  test('it grades `changed`, so --strict fails on it', () => {
    expect(tierOf('bigint')).toBe('changed')
  })
})

describe('summarise', () => {
  test('an empty list has no worst tier', () => {
    expect(summarise([])).toMatchObject({ changed: 0, lost: 0, noted: 0, total: 0, worst: null })
  })

  test('lost is the worst when nothing changed', () => {
    expect(summarise([{ kind: 'view' }, { kind: 'sti-candidate' }] as any).worst).toBe('lost')
  })
})
