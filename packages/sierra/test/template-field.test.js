/**
 * test/template-field.test.js — the resource names the @@hasTemplates column.
 *
 * FJS-2748. `x-templates` crossed the wire but was read only inside
 * `_templateReach`, so a screen telling templates from instances had to
 * hard-code the column (`row.isTemplate`) and break on `field: "isPreset"`.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SIERRA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: () => ({}),
    callHeaders: () => ({}),
    resource: () => ({
      service: {},
      tether: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      stale: { get: () => 0, subscribe: (fn) => { fn(0); return () => {} }, reset: () => {} },
      load: () => Promise.resolve([]),
    }),
  }),
}))

const { generateSchemas } = await import('../src/build/schema-plugin.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')
const { createResource }  = await import('../src/resource/resource.js')

const SOURCE = `
model Doc    { id Int @id   name String  @@gate(0.0.0.0)  @@hasTemplates }
model Preset { id Int @id   name String  @@gate(0.0.0.0)  @@hasTemplates(field: "isPreset") }
model Plain  { id Int @id   name String  @@gate(0.0.0.0) }
`

beforeEach(async () => {
  const dir  = mkdtempSync(join(tmpdir(), 'sierra-templates-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, SOURCE)
  const g = await generateSchemas(path, () => {}, SIERRA_ROOT)
  registerSchemas(g.defs, g.models, g.updatePatch)
})

describe('resource.templateField', () => {
  test('is the default marker column', () => {
    expect(createResource('docs', { model: 'Doc' }).templateField).toBe('isTemplate')
  })
  test('is the column the schema renamed it to', () => {
    expect(createResource('presets', { model: 'Preset' }).templateField).toBe('isPreset')
  })
  test('is null where the model has no templates', () => {
    expect(createResource('plains', { model: 'Plain' }).templateField).toBeNull()
  })
})
