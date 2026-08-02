/**
 * tests/schema-generation.test.js
 *
 * The browser needs a model's field shape for make() defaults. That used to be
 * hand-written in each resource file, duplicating db/schema.lite — and once
 * Junction started deriving server validation from the Litestone client's own
 * $schema, the hand-written copy became the only place the two halves of an app
 * could drift.
 *
 * build/schema-plugin.js reads the same .lite file and hands $defs to
 * virtual:sierra, which calls registerSchemas() before any route is evaluated.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { writeFileSync, mkdtempSync, mkdirSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'

import { resolveSchemaPath, generateSchemas } from '../src/build/schema-plugin.js'
import {
  registerSchemas, schemaFor, allSchemas, hasSchemas,
} from '../src/junction/schema-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SCHEMA = `
database main { path env("DATABASE_URL", "./app.db") }

model Lead {
  id      Int    @id
  ownerId String @default(auth().id)
  name    String @length(1, 200)
  email   String @email
  status  String @default("new")
  value   Float  @default(0) @gte(0)
  @@gate("4")
}

model Category {
  id   Int    @id
  name String
}
`

// Litestone deliberately is NOT linked into sierra/node_modules — cross-package
// resolution must be exercised, not bypassed (see frontier-resolution.test.js).
// So each fixture builds a root that legitimately has it, which also exercises
// the plugin's walk-up lookup.
const LITESTONE = resolve(__dirname, '../../litestone')

function fixture(contents = SCHEMA, filename = 'schema.lite') {
  const dir = mkdtempSync(resolve(tmpdir(), 'sierra-schema-'))
  mkdirSync(resolve(dir, 'db'), { recursive: true })
  const p = resolve(dir, 'db', filename)
  writeFileSync(p, contents)

  mkdirSync(resolve(dir, 'node_modules', '@frontierjs'), { recursive: true })
  try { symlinkSync(LITESTONE, resolve(dir, 'node_modules', '@frontierjs', 'litestone'), 'dir') } catch {}

  return { dir, path: p }
}

describe('resolveSchemaPath', () => {

  test('finds db/schema.lite by convention', () => {
    const { dir, path } = fixture()
    expect(resolveSchemaPath({}, dir)).toBe(path)
  })

  test('honours an explicit relative path', () => {
    const { dir, path } = fixture()
    expect(resolveSchemaPath({ schema: 'db/schema.lite' }, dir)).toBe(path)
  })

  test('returns null when disabled', () => {
    const { dir } = fixture()
    expect(resolveSchemaPath({ schema: false }, dir)).toBeNull()
  })

  test('returns null when there is no schema', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sierra-noschema-'))
    expect(resolveSchemaPath({}, dir)).toBeNull()
  })
})

describe('generateSchemas', () => {

  test('produces $defs for every model', async () => {
    const { dir, path } = fixture()
    const out = await generateSchemas(path, () => {}, dir)
    expect(out).not.toBeNull()
    expect(out.models.sort()).toEqual(['Category', 'Lead'])
  })

  test('carries field defaults through', async () => {
    const { dir, path } = fixture()
    const out = await generateSchemas(path, () => {}, dir)
    const lead = out.defs.Lead
    expect(lead.properties.status.default).toBe('new')
    expect(lead.properties.value.default).toBe(0)
  })

  test('warns and returns null on an unparseable schema', async () => {
    const { dir, path } = fixture('model Broken { id Text @id }')   // Text is a removed type
    const warnings = []
    const out = await generateSchemas(path, (m) => warnings.push(m), dir)
    expect(out).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('the registry', () => {

  beforeEach(() => registerSchemas({}))

  test('reports whether the build supplied anything', () => {
    expect(hasSchemas()).toBe(false)
    registerSchemas({ Lead: { properties: {} } })
    expect(hasSchemas()).toBe(true)
  })

  test('resolves by model name, accessor and service name', () => {
    const def = { properties: { name: { type: 'string' } } }
    registerSchemas({ Lead: def })

    expect(schemaFor('Lead')).toBe(def)     // model name
    expect(schemaFor('lead')).toBe(def)     // litestone accessor
    expect(schemaFor('leads')).toBe(def)    // conventional service name
  })

  test('handles -y plurals', () => {
    const def = { properties: {} }
    registerSchemas({ Category: def })
    expect(schemaFor('categories')).toBe(def)
  })

  test('first match wins across candidates', () => {
    const lead = { properties: { a: {} } }
    const user = { properties: { b: {} } }
    registerSchemas({ Lead: lead, User: user })
    expect(schemaFor('nope', 'user')).toBe(user)
  })

  test('returns null for an unknown model', () => {
    registerSchemas({ Lead: { properties: {} } })
    expect(schemaFor('widget', 'widgets')).toBeNull()
  })

  test('re-registering replaces rather than merges', () => {
    registerSchemas({ Lead: { properties: {} } })
    registerSchemas({ User: { properties: {} } })
    expect(schemaFor('lead')).toBeNull()
    expect(Object.keys(allSchemas())).toEqual(['User'])
  })
})

describe('end to end', () => {

  test('a generated schema resolves by the name a resource would use', async () => {
    const { dir, path } = fixture()
    const out = await generateSchemas(path, () => {}, dir)
    registerSchemas(out.defs)

    // createResource('leads') → tries model, service name, then singular.
    const def = schemaFor(undefined, 'leads', 'lead')
    expect(def).toBeTruthy()
    expect(Object.keys(def.properties)).toContain('email')
  })
})
