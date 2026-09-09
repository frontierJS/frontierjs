// `x-search` — whether `$search` will answer for this model, and over which
// columns.
//
// A Litestone table serves `search()` only under `@@fts` and refuses by name
// below it, so a browser without this key offers a search box on every model —
// where nearly all of them answer with a 400 — or on none. `example` declares
// `@@fts` on one model of about fifty, which is the ratio that decides it.
//
// The substance here is the POLARITY. The `x-` keys come in two kinds and
// reading one by the other's rule is silent both ways: `x-sortable` and
// `x-filterable` are refusals, where absent means permitted; this is a fact,
// where absent means there is none. So every assertion is a PAIR over ONE
// schema — the model that declares it and the model that does not — because an
// emit that fires always and an emit that never fires each satisfy a one-sided
// test, and those are the two ways this key goes wrong.

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { generateJsonSchema } from '../src/jsonschema.js'

/** Two models, one searchable, one not — the pair every assertion needs. */
const PAIR = `model Article {
  id          Int    @id
  title       String
  body        String
  @@fts([body, title])
}

model Tag {
  id   Int    @id
  name String
}`

const defs = (src: string, mode?: 'create' | 'update' | 'full') =>
  (generateJsonSchema(parse(src).schema, mode ? { mode } : undefined) as any).$defs

describe('x-search', () => {
  it('names the indexed columns, and is absent on the model beside it', () => {
    const d = defs(PAIR)
    expect(d.Article['x-search']).toEqual(['body', 'title'])
    expect('x-search' in d.Tag).toBe(false)
  })

  it('keeps the DECLARED order, which is not the schema order', () => {
    // `@@fts([body, title])` over a model whose fields are title-then-body. A
    // box saying what it searches reads this list out, and an emit that walked
    // the model's fields instead would answer the same set in the wrong words
    // on every model whose declaration is not in file order.
    expect(defs(PAIR).Article['x-search']).toEqual(['body', 'title'])
  })

  it('is on every mode, so a read schema and a write one agree', () => {
    // Whether a model is searchable does not depend on whether you are writing
    // one, and the read schema ships as a DELTA against create — a key emitted
    // in one mode only is a key that travels twice or not at all.
    for (const mode of ['create', 'update', 'full'] as const) {
      const d = defs(PAIR, mode)
      expect(d.Article['x-search']).toEqual(['body', 'title'])
      expect('x-search' in d.Tag).toBe(false)
    }
  })

  it('is a FACT key and not a refusal, unlike the two it sits between', () => {
    // The whole reason the name is not `x-searchable`. On the unsearchable
    // model the refusal keys are silent — silence there means PERMITTED — while
    // this one is silent to mean the opposite. A consumer reading them by one
    // rule is wrong about one of the two, and only this pair can see it.
    const d = defs(PAIR, 'full')
    expect('x-search' in d.Tag).toBe(false)                       // not searchable
    expect('x-sortable' in d.Tag.properties.name).toBe(false)     // IS sortable
    expect('x-filterable' in d.Tag.properties.name).toBe(false)   // IS filterable
  })

  it('a searchable model still carries a column the boundary refuses', () => {
    // The two keys live at different LEVELS — the model and the column — so a
    // model that answers `$search` can hold a column that answers no `orderBy`.
    // Neither may be read as the other's answer, which is the mistake a single
    // polarity would invite.
    const d = defs(`model Doc {
  id      Int    @id
  title   String
  summary String @computed
  @@fts([title])
}`, 'full')
    expect(d.Doc['x-search']).toEqual(['title'])
    expect(d.Doc.properties.summary['x-sortable']).toBe('computed')
  })
})
