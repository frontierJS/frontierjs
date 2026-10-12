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
  it('quotes each word, keeps a typed phrase, drops a lone quote', () => {
    expect(ftsWords('mini-redis c++')).toBe('"mini-redis" "c++"')
    expect(ftsWords('"new york" pizza')).toBe('"new york" "pizza"')
    expect(ftsWords('Ruth "Ames')).toBe('"Ruth" "Ames"')
    expect(ftsWords(' " ')).toBeNull()
  })

  it('prefix marks only an open last word', () => {
    expect(ftsWords('mini re', { prefix: true })).toBe('"mini" "re"*')
    expect(ftsWords('c++', { prefix: true })).toBe('"c++"')
    expect(ftsWords('"mini re"', { prefix: true })).toBe('"mini re"')
  })
})
