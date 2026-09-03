// ─── @seals / @sealed — the declaration ───────────────────────────────────────
//
// Phase 1 of FJS-D162's answer: what a schema WRITES to say a row becomes a
// document, and every shape refused before a client is ever built.
//
// The sealed set is COMPUTED — everything reachable from a `@seals` move's
// target — so most of these assertions are about the closure rather than about
// the syntax. A test that only parsed the attribute would pass against a walk
// that stops at the first hop, which is exactly the walk somebody writes first.

import { test, expect, describe } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { sealedStates, sealingModels } from '../src/core/seal.js'

const HEAD = `
enum DocState {
  draft
  issued
  paid
  void
}
`

const doc = (body: string, extra = '') => parse(`${HEAD}
model Invoice {
  id     Int      @id
  state  DocState @default(draft)
  number String   @immutable
  lines  InvoiceLine[] ${body}
  @@transitions(state,
    issue:  draft  -> issued @seals,
    settle: issued -> paid @system,
    void:   issued -> void @gate(5))
}

model InvoiceLine {
  id        Int     @id
  invoice   Invoice @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  invoiceId Int
  amount    Int
}
${extra}`)

describe('the declaration', () => {
  test('@seals parses beside @gate and @system, and composes with both', () => {
    const { schema, errors } = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState @default(draft)
  n     String   @immutable
  @@transitions(state,
    issue: draft -> issued @seals @gate(5),
    void:  draft -> void @system @seals)
}`)
    expect(errors).toEqual([])
    const attr = schema.models[0].attributes.find((a: any) => a.kind === 'transitions')
    expect(attr.transitions.issue).toMatchObject({ seals: true, gate: 5, system: false })
    expect(attr.transitions.void).toMatchObject({ seals: true, gate: null, system: true })
  })

  // Two ways out of one draft is a real machine — an invoice is issued or it is
  // abandoned — and both are the end of editing it.
  test('two seals from the same unsealed state are both kept', () => {
    const { schema } = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState @default(draft)
  n     String   @immutable
  @@transitions(state,
    issue: draft -> issued @seals,
    void:  draft -> void @seals)
}`)
    const seal = sealedStates(schema.models[0].attributes.find((a: any) => a.kind === 'transitions'))!
    expect([...seal.states].sort()).toEqual(['issued', 'void'])
    expect(seal.moves.sort()).toEqual(['issue', 'void'])
  })

  test('a move that does not seal says so, rather than leaving the key absent', () => {
    const { schema } = doc('@sealed')
    const attr = schema.models[0].attributes.find((a: any) => a.kind === 'transitions')
    expect(attr.transitions.settle.seals).toBe(false)
  })

  test('@sealed lands on the relation field', () => {
    const { schema, errors } = doc('@sealed')
    expect(errors).toEqual([])
    const lines = schema.models[0].fields.find((f: any) => f.name === 'lines')
    expect(lines.attributes.some((a: any) => a.kind === 'sealed')).toBe(true)
  })

  test('@seals takes no argument, and the refusal says where the argument it wanted goes', () => {
    const { errors } = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState
  n     String   @immutable
  @@transitions(state, issue: draft -> issued @seals(lines))
}`)
    expect(errors.join('\n')).toContain('@seals takes no argument')
    expect(errors.join('\n')).toContain('@sealed')
  })

  test('@seals stated twice on one move is refused', () => {
    const { errors } = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState
  n     String   @immutable
  @@transitions(state, issue: draft -> issued @seals @seals)
}`)
    expect(errors.join('\n')).toContain('@seals stated twice')
  })

  test('an unknown transition attribute names all three that exist', () => {
    const { errors } = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState
  @@transitions(state, issue: draft -> issued @freezes)
}`)
    expect(errors.join('\n')).toContain('@gate, @system and @seals')
  })

  test('the enum shared block still refuses it, because WHICH children is a model concern', () => {
    const { errors } = parse(`
enum DocState {
  draft
  issued
  transitions {
    issue: draft -> issued @seals
  }
}`)
    expect(errors.join('\n')).toContain('@seals cannot go on the enum')
  })
})

// The set is derived, and deriving it wrong is silent: a one-hop walk seals
// `issued` and leaves `void` and `paid` writable, which is a document with two
// states in which its own lines can be edited.
describe('the sealed set is a closure, not a target', () => {
  test('everything reachable from the seal is sealed, and nothing restated it', () => {
    const { schema } = doc('@sealed')
    const seal = sealedStates(schema.models[0].attributes.find((a: any) => a.kind === 'transitions'))!
    expect([...seal.states].sort()).toEqual(['issued', 'paid', 'void'])
  })

  test('the state the row seals FROM stays outside it', () => {
    const { schema } = doc('@sealed')
    const seal = sealedStates(schema.models[0].attributes.find((a: any) => a.kind === 'transitions'))!
    expect(seal.states.has('draft')).toBe(false)
    expect([...seal.entries]).toEqual(['draft'])
  })

  test('a machine with no @seals move answers null rather than an empty set', () => {
    const { schema } = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState
  @@transitions(state, settle: issued -> paid)
}`)
    expect(sealedStates(schema.models[0].attributes.find((a: any) => a.kind === 'transitions'))).toBeNull()
  })

  test('sealingModels carries the state column and the sealed relations together', () => {
    const { schema } = doc('@sealed')
    const m = sealingModels(schema).get('Invoice')!
    expect(m.field).toBe('state')
    expect(m.relations).toEqual(['lines'])
    expect(m.moves).toEqual(['issue'])
  })
})

describe('what the parser refuses', () => {
  test('a reopen move makes one value mean sealed and unsealed', () => {
    const { errors } = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState
  n     String   @immutable
  @@transitions(state,
    issue:  draft -> issued @seals,
    reopen: issued -> draft)
}`)
    expect(errors.join('\n')).toContain("'draft' is both the state this move seals FROM")
    expect(errors.join('\n')).toContain('A document that unseals is not a document')
  })

  // The near-miss of the reopen: the row is already a document when the second
  // seal runs, so the declaration says nothing and the reader believes it does.
  test('a seal from an already-sealed state names the seal that got there first', () => {
    const { errors } = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState
  n     String   @immutable
  @@transitions(state,
    issue: draft  -> issued @seals,
    void:  issued -> void @seals)
}`)
    expect(errors.join('\n')).toContain("already sealed by 'issue' before this move runs")
    expect(errors.join('\n')).not.toContain('unseals')
  })

  test('@sealed with nothing that seals the model names the missing half', () => {
    const { errors } = parse(`${HEAD}
model Invoice {
  id    Int @id
  lines InvoiceLine[] @sealed
}

model InvoiceLine {
  id        Int     @id
  invoice   Invoice @relation(fields: [invoiceId], references: [id])
  invoiceId Int
}`)
    expect(errors.join('\n')).toContain('nothing seals')
    expect(errors.join('\n')).toContain('@seals')
  })

  test('a @seals move with nothing to seal is a typo, not a no-op', () => {
    const { errors } = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState
  total Int
  @@transitions(state, issue: draft -> issued @seals)
}`)
    expect(errors.join('\n')).toContain('nothing to seal')
  })

  test('an @immutable column alone is enough to seal — no relation required', () => {
    const { errors } = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState
  n     String   @immutable
  @@transitions(state, issue: draft -> issued @seals)
}`)
    expect(errors).toEqual([])
  })

  test('@sealed on a scalar points at @immutable', () => {
    const { errors } = doc('@sealed', '')
    expect(errors).toEqual([])
    const bad = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState
  n     String   @immutable
  total Int      @sealed
  @@transitions(state, issue: draft -> issued @seals)
}`)
    expect(bad.errors.join('\n')).toContain('is not a relation')
    expect(bad.errors.join('\n')).toContain('@immutable')
  })

  test('@sealed on the belongsTo side is refused, naming the direction', () => {
    const { errors } = parse(`${HEAD}
model Invoice {
  id    Int      @id
  state DocState
  n     String   @immutable
  lines InvoiceLine[]
  @@transitions(state, issue: draft -> issued @seals)
}

model InvoiceLine {
  id        Int     @id
  invoice   Invoice @relation(fields: [invoiceId], references: [id]) @sealed
  invoiceId Int
}`)
    expect(errors.join('\n')).toContain('goes on the side that OWNS the children')
  })
})
