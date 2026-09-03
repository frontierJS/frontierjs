// ─── @seals in the files a reviewer reads ─────────────────────────────────────
//
// Phase 5. A guard nobody can see in a diff is a guard that moves without being
// noticed — which is exactly what `FJS-613` was about one attribute along.
//
// Three artefacts and three different questions: the access snapshot says WHO
// may do what, the release surface says whether N-1 survives the deploy, and the
// JSON Schema says what a form should offer. `@seals` answers all three
// differently, and the third one is the awkward case — the freeze has a moment,
// so no schema can state it and the consumer is told what to read instead.

import { test, expect, describe } from 'bun:test'

/** The finding for one subject — `detail` is the sentence, `severity` the grade. */
const about = (r: any, needle: string) =>
  r.findings.find((f: any) => `${f.subject} ${f.detail}`.includes(needle))
import { parse } from '../src/core/parser.js'
import { deriveAccess, renderAccessSnapshot } from '../src/access.js'
import { deriveReleaseSurface as releaseSurface, classifyPivot, classifyAccess, renderReleaseSnapshot } from '../src/release.js'
import { generateJsonSchema } from '../src/jsonschema.js'

const doc = (moveAttrs = '@seals', relAttrs = '@sealed') => parse(`
enum DocState { draft issued paid void }

model Invoice {
  id     Int      @id
  state  DocState @default(draft)
  number String   @immutable
  lines  InvoiceLine[] ${relAttrs}
  @@gate("1.8.8.8")
  @@transitions(state,
    issue:  draft  -> issued ${moveAttrs} @gate(5),
    settle: issued -> paid @system,
    void:   issued -> void)
}

model InvoiceLine {
  id        Int     @id
  invoice   Invoice @relation(fields: [invoiceId], references: [id])
  invoiceId Int
  amount    Int
  @@gate("1.8.8.8")
}
`).schema

describe('access.snapshot.md', () => {
  const md = renderAccessSnapshot(deriveAccess(doc()))

  test('the move carries a Seals column beside Made by, and they are separate facts', () => {
    expect(md).toContain('| Model | Field | Move | From → To | Made by | Level | Seals |')
    expect(md).toContain('| `issue` | draft → issued | caller | 5 ADMINISTRATOR | **yes** |')
    // `settle` is @system and does NOT seal. Folding the two would render an
    // ungated application move identically to a sealing one.
    expect(md).toContain('| `settle` | issued → paid | **application** | — | — |')
  })

  test('the sealed relations are named, because @seals alone does not say which', () => {
    expect(md).toContain('- `Invoice` seals `lines` (`InvoiceLine`)')
  })

  test('the counts line carries it, so a seal appearing at all is a diff', () => {
    expect(md).toContain('· 1 @seals')
  })

  test('a machine with no seal renders neither', () => {
    const plain = renderAccessSnapshot(deriveAccess(doc('', '')))
    expect(plain).toContain('· 0 @seals')
    expect(plain).not.toContain('seals `lines`')
  })
})

describe('release.snapshot.md and the pivot', () => {
  test('the surface carries the move and the relation', () => {
    const s = releaseSurface(doc())
    const inv = s.models.find((m: any) => m.name === 'Invoice')
    expect(inv.transitions.find((t: any) => t.name === 'issue').seals).toBe(true)
    expect(inv.sealed).toEqual(['lines'])
  })

  test('the rendered file says both out loud', () => {
    const md = renderReleaseSnapshot(releaseSurface(doc()))
    expect(md).toContain('@seals')
    expect(md).toContain('relation lines @sealed')
  })

  test('adding @seals is a CONTRACT — N-1 still writes to an issued invoice', () => {
    const r = classifyPivot(releaseSurface(doc('', '@sealed')), releaseSurface(doc()))
    expect(about(r, 'becomes @seals')?.severity).toBe('contract')
  })

  test('removing it is an expand', () => {
    const r = classifyPivot(releaseSurface(doc()), releaseSurface(doc('', '@sealed')))
    expect(about(r, 'no longer @seals')?.severity).toBe('expand')
  })

  test('a relation gaining @sealed is a contract on its own', () => {
    const r = classifyPivot(releaseSurface(doc('@seals', '')), releaseSurface(doc()))
    expect(about(r, 'becomes @sealed')?.severity).toBe('contract')
  })

  test('and on the access axis it narrows — it takes writes from everybody at once', () => {
    const r = classifyAccess(releaseSurface(doc('', '@sealed')), releaseSurface(doc()))
    const f = about(r, 'becomes @seals')
    expect(f?.access).toBe('narrows')
    expect(f?.detail).toContain('asSystem()')
  })
})

describe('the JSON Schema — the half no schema can state', () => {
  const update = generateJsonSchema(doc(), { mode: 'update' })

  test('a frozen column on a sealing model is NOT readOnly, because a draft is editable', () => {
    const n = update.$defs.Invoice.properties.number
    expect(n.readOnly).toBeUndefined()
    expect(n['x-litestone-kind']).toBe('immutable-until-seal')
  })

  test('and it says what to read instead — the column, and the values that mean sealed', () => {
    // The difference lives in the ROW, so a consumer resolves readOnly off the
    // record. Emitting the closure rather than the seal's target is what makes
    // `void` and `paid` read as frozen too.
    expect(update.$defs.Invoice.properties.number['x-litestone-seal'])
      .toEqual({ field: 'state', states: ['issued', 'paid', 'void'] })
  })

  test('the same column on a model with no seal keeps readOnly, unchanged', () => {
    const plain = generateJsonSchema(doc('', ''), { mode: 'update' })
    const n = plain.$defs.Invoice.properties.number
    expect(n.readOnly).toBe(true)
    expect(n['x-litestone-kind']).toBe('immutable')
  })

  test('create mode still offers the box either way', () => {
    const c = generateJsonSchema(doc(), { mode: 'create' })
    expect(c.$defs.Invoice.properties.number.readOnly).toBeUndefined()
    expect(c.$defs.Invoice.properties.number['x-litestone-kind']).toBeUndefined()
  })
})
