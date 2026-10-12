// FJS-1452: the unscoped-models report names the fix an app CAN make. A model a
// package ships is not the app's to edit, so `mark each @@tenant(none)` sends
// the app to a file it does not own; `extend model X { @@tenant(none) }` is
// the spelling that works.
import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFile } from '../src/core/parser.js'

describe('the row-tenancy report for a model a package ships', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ls-tenancy-shipped-'))
  mkdirSync(join(dir, 'node_modules/@acme/kit'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/@acme/kit/package.json'), JSON.stringify({ name: '@acme/kit', version: '1.0.0' }))
  writeFileSync(join(dir, 'node_modules/@acme/kit/kit.lite'), `model KitSession { id Int @id }`)
  writeFileSync(join(dir, 'more.lite'), `model Mine { id Int @id }`)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const report = (body: string) => {
    const root = join(dir, 'schema.lite')
    writeFileSync(root, `tenancy { strategy row  column accountId }\nimport "@acme/kit/kit.lite"\nimport "./more.lite"\n${body}`)
    const out = parseFile(root)
    expect(out.valid).toBe(true)
    return out.warnings.filter((w: string) => w.includes('NOT scoped to a tenant'))
  }

  test('names the extend that silences it, for the imported model only', () => {
    const [w] = report(`model Lead { id Int @id  accountId Int }`)
    expect(w).toContain('extend model KitSession { @@tenant(none) }')
    expect(w).not.toContain('extend model Mine')
    expect(w).toContain('Mine')
  })

  test('an app\'s own model keeps the plain advice', () => {
    const [w] = report(`model Lead { id Int @id  accountId Int }`)
    expect(w).toContain('mark each @@tenant(none)')
  })

  test('the extend line silences the report', () => {
    const w = report(`model Lead { id Int @id  accountId Int }\nextend model KitSession { @@tenant(none) }`)
    expect(w.join(' ')).not.toContain('KitSession')
  })
})
