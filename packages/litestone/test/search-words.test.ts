// FJS-1440 — `search()`'s text is the words a person typed, never FTS5 syntax.
//
// It reached MATCH as written, so the ordinary text of a search box was query
// language: `mini-redis` a column filter (*no such column: redis*), `c++` and a
// formatted phone a syntax error, `.net` and an email address the same. Over
// HTTP each was a 500 whose message named a word of the search, and four apps
// wrote the same quoting by hand to get past it. The corpus below is what those
// apps measured, and every term is asserted to FIND its row, not merely not to
// throw: an encoder that answered every query with nothing would pass a
// no-throw check.
//
// Run under all three tokenizers, because what a quoted phrase matches is the
// tokenizer's answer and `prefix` reads differently under each.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createClient } from '../src/index.js'
import { ftsWords } from '../src/core/query.js'

const NAMES = [
  'mini-redis', 'web-01', 'c++ guide', 'someone@gmail.com', 'acme.net',
  'rust: the book', '(512) 555-1234', "o'brien", 'Ruth Ames', 'redis cache',
  'NOT spam', 'running jobs',
]

// [typed, the names it must find, exactly]
const CORPUS: Array<[string, string[]]> = [
  ['mini-redis',        ['mini-redis']],
  ['web-01',            ['web-01']],
  ['c++',               ['c++ guide']],
  ['someone@gmail.com', ['someone@gmail.com']],
  ['acme.net',          ['acme.net']],
  ['rust:',             ['rust: the book']],
  ['(512) 555-1234',    ['(512) 555-1234']],
  ["o'brien",           ["o'brien"]],
  ['Ruth "Ames',        ['Ruth Ames']],     // a quote left open separates
  ['"ruth ames"',       ['Ruth Ames']],     // a quoted phrase is one phrase
  ['NOT',               ['NOT spam']],      // an operator's spelling is a word
  ['redis cache',       ['redis cache']],   // every word is required
]

const TOKENIZERS = ['unicode61', 'porter', 'trigram'] as const

for (const tokenize of TOKENIZERS) {
  describe(`search() under tokenize: ${tokenize}`, () => {
    let db: any
    beforeAll(async () => {
      db = await createClient({ db: ':memory:', schema: `
        model Box {
          id   Int    @id @default(autoincrement())
          name String
          @@fts([name], tokenize: ${tokenize})
        }
      ` })
      await db.box.createMany({ data: NAMES.map(name => ({ name })) })
    })
    afterAll(() => db.$close())

    const names = async (q: string, opts?: object) =>
      (await db.box.search(q, { limit: 50, ...opts })).map((r: any) => r.name).sort()

    for (const [typed, want] of CORPUS) {
      it(`finds ${JSON.stringify(typed)}`, async () => {
        expect(await names(typed)).toEqual([...want].sort())
      })
    }

    it('a text with no word left answers no rows', async () => {
      for (const typed of ['', '   ', '"', '""', '" "']) expect(await names(typed)).toEqual([])
    })

    it('prefix widens the last word, so a box searched as it is typed finds mid-word', async () => {
      expect(await names('mini-re', { prefix: true })).toEqual(['mini-redis'])
      expect(await names('redis cach', { prefix: true })).toEqual(['redis cache'])
    })

    it('prefix leaves a last word ending in punctuation whole — `c++*` is `c*`', async () => {
      expect(await names('c++', { prefix: true })).toEqual(['c++ guide'])
    })

    it('raw passes FTS5 syntax through, operators and all', async () => {
      expect(await names('redis OR guide', { raw: true })).toEqual(['c++ guide', 'mini-redis', 'redis cache'])
      expect(await names('redis OR guide')).toEqual([])   // as words, all three are required
    })
  })
}

describe('search() refuses by name', () => {
  let db: any
  beforeAll(async () => {
    db = await createClient({ db: ':memory:', schema: 'model Box {\n  id   Int    @id\n  name String\n  @@fts([name])\n}' })
  })
  afterAll(() => db.$close())

  it('raw with prefix — the * is the raw query\'s to write', async () => {
    await expect(db.box.search('redis', { raw: true, prefix: true })).rejects.toThrow(/prefix widens the last WORD/)
  })

  it('a query that is not text', async () => {
    await expect(db.box.search(undefined)).rejects.toThrow(/takes the words to find as a string, got undefined/)
  })
})

describe('ftsWords', () => {
  const match = (text: string, opts?: object) => ftsWords(text, opts)?.match
  it('quotes each word, keeps a typed phrase, drops a lone quote', () => {
    expect(match('mini-redis c++')).toBe('"mini-redis" "c++"')
    expect(match('"new york" pizza')).toBe('"new york" "pizza"')
    expect(match('Ruth "Ames')).toBe('"Ruth" "Ames"')
    expect(ftsWords(' " ')).toBeNull()
  })

  it('prefix marks only an open last word', () => {
    expect(match('mini re', { prefix: true })).toBe('"mini" "re"*')
    expect(match('c++', { prefix: true })).toBe('"c++"')
    expect(match('"mini re"', { prefix: true })).toBe('"mini re"')
  })

  it('under trigram a word under three characters is a scan, and its letters a case class each', () => {
    expect(ftsWords('jo smith', { trigram: true })).toEqual({ match: '"smith"', scan: ['*[jJ][oO]*'] })
    expect(ftsWords('Ö', { trigram: true })).toEqual({ match: null, scan: ['*[Öö]*'] })
    expect(ftsWords('*? [', { trigram: true })).toEqual({ match: null, scan: ['*[*][?]*', '*[[]*'] })
    expect(ftsWords('jo', { trigram: false })).toEqual({ match: '"jo"', scan: [] })
  })

  it('under trigram prefix does not move to the word before a short last word', () => {
    expect(match('smith jo', { trigram: true, prefix: true })).toBe('"smith"')
  })
})

// FJS-2332 — under `tokenize: trigram` an index entry is three characters, so
// `jo`, `Li` or a state code matched nothing and answered an empty list, 200,
// where the LIKE the index replaced found hundreds. A short word is now a GLOB
// over every indexed column. The email column is @map'd because the GLOB names
// the index's columns, and those are column names, not field names.
describe('search() under trigram, a word shorter than three characters', () => {
  let db: any
  beforeAll(async () => {
    db = await createClient({ db: ':memory:', schema: `
      model Contact {
        id        Int       @id @default(autoincrement())
        name      String
        email     String    @map("email_address")
        deletedAt DateTime?
        @@softDelete
        @@fts([name, email], tokenize: trigram)
      }
    ` })
    await db.contact.createMany({ data: [
      { name: 'Jo Smith',   email: 'jo@x.com'  },
      { name: 'John Li',    email: 'jl@y.org'  },
      { name: 'Anne Ng',    email: 'a_n@z.com' },
      { name: 'Bob Stars',  email: 'b*b@q.com' },
      { name: 'Émile Jöns', email: 'e@x.com'   },
      { name: 'Joan Gone',  email: 'jg@x.com'  },
    ] })
    await db.contact.remove({ where: { name: 'Joan Gone' } })
  })
  afterAll(() => db.$close())

  const names = async (q: string, opts?: object) =>
    (await db.contact.search(q, { limit: 50, ...opts })).map((r: any) => r.name).sort()

  it('finds what a substring search finds, in any indexed column', async () => {
    expect(await names('jo')).toEqual(['Jo Smith', 'John Li'])
    expect(await names('Li')).toEqual(['John Li'])
    expect(await names('ng')).toEqual(['Anne Ng'])
    expect(await names('jl')).toEqual(['John Li'])        // the @map'd column alone
  })

  it('a soft-deleted row is not found', async () => {
    expect(await names('jg')).toEqual([])
    expect(await names('jg', { withDeleted: true })).toEqual(['Joan Gone'])
  })

  it('folds case beyond ASCII, as the tokenizer does', async () => {
    expect(await names('JÖ')).toEqual(['Émile Jöns'])
    expect(await names('é')).toEqual(['Émile Jöns'])
  })

  it('a wildcard typed is a character to find', async () => {
    expect(await names('_')).toEqual(['Anne Ng'])
    expect(await names('*')).toEqual(['Bob Stars'])
    expect(await names('?')).toEqual([])
  })

  it('is required alongside the longer words, which still rank', async () => {
    expect(await names('jo smith')).toEqual(['Jo Smith'])
    expect(await names('li john')).toEqual(['John Li'])
    const [hit] = await db.contact.search('smith jo')
    expect(typeof hit._rank).toBe('number')
  })

  it('alone it has no rank, and pages in row order without repeating a row', async () => {
    const all = await db.contact.search('o', { limit: 50 })
    expect(all.map((r: any) => r._rank)).toEqual(all.map(() => null))
    expect(all.map((r: any) => r.name)).toEqual(['Jo Smith', 'John Li', 'Anne Ng', 'Bob Stars', 'Émile Jöns'])   // every .com and .org
    const paged = []
    for (let offset = 0; offset < all.length; offset++)
      paged.push(...(await db.contact.search('o', { limit: 1, offset })).map((r: any) => r.name))
    expect(paged).toEqual(all.map((r: any) => r.name))
  })
})
