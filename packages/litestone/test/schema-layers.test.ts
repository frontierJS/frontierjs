// schema-layers.test.ts — the complexity score keeps its anchor.
//
// The score is a curve over hand-picked weights (FJS-D1871), and nothing else
// notices when a weight, the curve or the fixture moves: Studio would show a
// different number for the same schema and every number read before would
// mean something else. ERPNext is the top anchor and openmrp the middle.

import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import { parse, parseFile } from '../src/index.js'
import { schemaLayers } from '../src/tools/schema-layers.js'

const fixture = (...p: string[]) => join(import.meta.dir, 'fixtures', ...p)
const complexityOf = (file: string) => schemaLayers(parseFile(file).schema).complexity

describe('complexity', () => {
  test('the ERPNext corpus fixture scores 92', () => {
    expect(complexityOf(fixture('corpus', 'erpnext.lite')).score).toBe(92)
  })

  test('the openmrp scale fixture scores 77', () => {
    expect(complexityOf(fixture('scale', 'openmrp.lite')).score).toBe(77)
  })

  test('a declared rule weighs; plumbing does not', () => {
    const base = `model Note {\n  id Int @id\n  title Text @map("t") @default("")\n}`
    const ruled = `model Note {\n  id Int @id\n  title Text @map("t") @default("") @guarded\n  @@allow(read, true)\n}`
    const a = schemaLayers(parse(base).schema).complexity
    const b = schemaLayers(parse(ruled).schema).complexity
    expect(a.parts.rules).toBe(0)
    expect(b.parts.rules).toBe(2)
    expect(b.w).toBe(a.w + 1)
  })
})
