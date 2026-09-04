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
import { writeFileSync, mkdirSync, symlinkSync } from 'fs'

import { resolveSchemaPath, generateSchemas } from '../src/build/schema-plugin.js'
import {
  registerSchemas, schemaFor, allSchemas, allDefs, hasSchemas, resolveRef,
} from '../src/junction/schema-registry.js'
import { tmpDir } from './tmp.js'

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

// Enums, relations and $ref-bearing fields — the parts of a real schema that
// used to be mishandled between the generator and make().
const RICH_SCHEMA = `
database main { path env("DATABASE_URL", "./app.db") }

enum Plan { starter pro enterprise }

model Lead {
  id     Int      @id
  name   String
  plan   Plan
  tier   Plan     @default(pro)
  tags   Tag[]
  due    DateTime?
}

model Tag {
  id    Int    @id
  name  String
  leads Lead[]
}
`

// Litestone deliberately is NOT linked into sierra/node_modules — cross-package
// resolution must be exercised, not bypassed (see frontier-resolution.test.js).
// So each fixture builds a root that legitimately has it, which also exercises
// the plugin's walk-up lookup.
const LITESTONE = resolve(__dirname, '../../litestone')

function fixture(contents = SCHEMA, filename = 'schema.lite') {
  const dir = tmpDir('sierra-schema-')
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

  test('honors an explicit relative path', () => {
    const { dir, path } = fixture()
    expect(resolveSchemaPath({ schema: 'db/schema.lite' }, dir)).toBe(path)
  })

  test('returns null when disabled', () => {
    const { dir } = fixture()
    expect(resolveSchemaPath({ schema: false }, dir)).toBeNull()
  })

  test('returns null when there is no schema', () => {
    const dir = tmpDir('sierra-noschema-')
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

describe('models vs definitions', () => {

  beforeEach(() => registerSchemas({}))

  test('generateSchemas reports models, not every $defs key', async () => {
    const { dir, path } = fixture(RICH_SCHEMA)
    const out = await generateSchemas(path, () => {}, dir)

    // $defs carries the enum too — the model list must not.
    expect(Object.keys(out.defs)).toContain('Plan')
    expect(out.models.sort()).toEqual(['Lead', 'Tag'])
  })

  test('an enum is not addressable as a resource', async () => {
    const { dir, path } = fixture(RICH_SCHEMA)
    const out = await generateSchemas(path, () => {}, dir)
    registerSchemas(out.defs, out.models)

    // 'Plan'/'plan'/'plans' used to resolve to the enum definition, and
    // createResource('plans') then threw inside make().
    expect(schemaFor('Plan')).toBeNull()
    expect(schemaFor('plan')).toBeNull()
    expect(schemaFor('plans')).toBeNull()
    expect(Object.keys(allSchemas()).sort()).toEqual(['Lead', 'Tag'])
  })

  test('the enum is still reachable as a $ref target', async () => {
    const { dir, path } = fixture(RICH_SCHEMA)
    const out = await generateSchemas(path, () => {}, dir)
    registerSchemas(out.defs, out.models)

    expect(allDefs().Plan).toBeTruthy()
    expect(resolveRef('#/$defs/Plan').enum).toEqual(['starter', 'pro', 'enterprise'])
    expect(resolveRef('#/definitions/Plan')?.enum).toBeTruthy()  // both spellings
    expect(resolveRef('#/$defs/Nope')).toBeNull()
    expect(resolveRef(undefined)).toBeNull()
  })

  test('without an explicit model list, definitions with fields still register', () => {
    registerSchemas({
      Lead: { type: 'object', properties: { name: { type: 'string' } } },
      Plan: { type: 'string', enum: ['a', 'b'] },
    })
    expect(schemaFor('leads')).toBeTruthy()
    expect(schemaFor('plans')).toBeNull()
  })
})

describe('end to end', () => {

  test('a generated schema resolves by the name a resource would use', async () => {
    const { dir, path } = fixture()
    const out = await generateSchemas(path, () => {}, dir)
    registerSchemas(out.defs, out.models)

    // createResource('leads') → tries model, service name, then singular.
    const def = schemaFor(undefined, 'leads', 'lead')
    expect(def).toBeTruthy()
    expect(Object.keys(def.properties)).toContain('email')
  })

  test('an implicit m2m relation is not a field of the model', async () => {
    const { dir, path } = fixture(RICH_SCHEMA)
    const out = await generateSchemas(path, () => {}, dir)
    const lead = out.defs.Lead

    // `tags Tag[]` is a relation. It used to be emitted as an array-of-string
    // property AND listed in required[], so the server demanded it on create.
    expect(lead.properties.tags).toBeUndefined()
    expect(lead.required ?? []).not.toContain('tags')
    expect(lead['x-relations'].some(r => r.field === 'tags')).toBe(true)
  })
})

// ─── a schema split across files ─────────────────────────────────────────────
//
// `import "./other.lite"` is resolved by litestone's parseFile and by nothing
// else. This read the root file and called parse(), so a split schema reached
// the browser as a $defs table with the imported models missing — and every
// step after that degrades rather than fails: modelNameFor misses, warns, and
// createResource falls back to a bare make(), so a generated <Form> renders no
// fields against an app that builds clean.
//
// `fli auth:install` writes exactly this layout — the app's models beside an
// imported file it does not own — so it is the shape apps will have.

const ROOT_IMPORTING = `
database main { path env("DATABASE_URL", "./app.db") }

import "./auth.lite"

model Lead {
  id    Int    @id
  name  String
}
`

const IMPORTED_MODELS = `
enum Plan { starter pro }

model Session {
  id      String  @id @default(uuid())
  userId  String
  plan    Plan    @default(starter)
  @@gate("8")
}
`

function splitFixture() {
  const f = fixture(ROOT_IMPORTING)
  writeFileSync(resolve(f.dir, 'db', 'auth.lite'), IMPORTED_MODELS)
  return f
}

describe('a schema that imports another file', () => {

  test('the imported models reach $defs', async () => {
    const { dir, path } = splitFixture()
    const out = await generateSchemas(path, () => {}, dir)

    // Lead proves the root file was read at all — without it a null result
    // would satisfy an assertion about absence.
    expect(out.models).toContain('Lead')
    expect(out.models).toContain('Session')
    expect(out.defs).toHaveProperty('Session')
  })

  test('an enum declared in the imported file resolves as a $ref target', async () => {
    const { dir, path } = splitFixture()
    const out = await generateSchemas(path, () => {}, dir)

    // $defs is the whole definition table, and a $ref into it has to land —
    // an enum reaching the client as a dangling ref is a control with no options.
    expect(out.defs).toHaveProperty('Plan')
    expect(out.models).not.toContain('Plan')
    registerSchemas(out.defs, out.models)
    expect(resolveRef('#/$defs/Plan')).toBeTruthy()
  })

  test('the imported models are absent from a schema that does not import', async () => {
    const { dir, path } = fixture()
    const out = await generateSchemas(path, () => {}, dir)
    expect(out.models).not.toContain('Session')
  })
})
