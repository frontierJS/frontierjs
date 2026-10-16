// core/app-schema.js — the gate level appSchemaModels reads off a model.
//
// A gate is written as digits (FJS-D239). The named form is deleted, and
// Litestone's parser refuses it, so a second reader that accepted it graded as
// declared a gate the app could never load (FJS-2991).

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir }                                        from 'node:os'
import { join }                                          from 'node:path'
import { appSchemaModels }                               from '../core/app-schema.js'

const roots = []
const gateOf = (decl) => {
  const dir = mkdtempSync(join(tmpdir(), 'fli-gate-'))
  roots.push(dir)
  mkdirSync(join(dir, 'db'))
  writeFileSync(join(dir, 'db', 'schema.lite'), `model Lead {\n  id Int @id\n  ${decl}\n}\n`, 'utf8')
  return appSchemaModels(dir).find(m => m.name === 'Lead').gate
}
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

test('a digit gate reads its first position', () => {
  expect(gateOf('@@gate(4.4.4.5)')).toBe(4)
  expect(gateOf('@@gate(8)')).toBe(8)
})

test('the named forms FJS-D239 deleted declare nothing', () => {
  expect(gateOf('@@gate(read: USER)')).toBeNull()
  expect(gateOf('@@gate(SYSTEM)')).toBeNull()
})
