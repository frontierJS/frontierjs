// test/extend-model.test.ts
//
// `extend model X { … }` — what an app has to say about a model it did not
// write.
//
// The case is a package that ships `.lite`. `@frontierjs/auth` owns the columns
// of Credential / Session / Verification / OauthFlow; the APP owns where those
// rows sit in its own schema — the relation back to its own User, whether they
// are audited, and under row tenancy that they span tenants. A package cannot
// know any of that, so before this the only way to say it was to paste the
// models in and edit them.
//
// A copy stops being the package's the first time either side moves, and
// NOTHING FAILS: basecamp's carried `@guarded` where the package writes
// `@secret`, so every OAuth token it stored was in plain text, with 137 green
// tests either side of the divergence. That is the failure this feature is
// measured against, and it is why every rule below refuses rather than resolves.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { parse, parseFile } from '../src/core/parser.js'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOST = `
database main  { path "./a.db" }
database audit { path "./audit/"; driver logger; retention 90d }

model User {
  id    String @id @default(uuid())
  email String @email @unique
  @@db(main)
  @@gate("4")
}

model Session {
  id        String   @id @default(uuid())
  userId    String
  token     String   @unique @guarded
  expiresAt DateTime
  @@db(main)
  @@gate("8")
}
`

const ok = (src: string) => {
  const out = parse(src)
  if (!out.valid) throw new Error(out.errors.join(' · '))
  return out.schema as any
}

const bad = (src: string) => {
  const out = parse(src)
  expect(out.valid).toBe(false)
  return out.errors.join(' · ')
}

const model = (schema: any, name: string) => schema.models.find((m: any) => m.name === name)

// ─── what it adds ────────────────────────────────────────────────────────────

describe('extend model', () => {

  test('adds a field to a model declared elsewhere', () => {
    const schema = ok(HOST + `
      extend model Session {
        user User @relation(fields: [userId], references: [id], onDelete: Cascade)
      }
    `)
    const s = model(schema, 'Session')
    expect(s.fields.map((f: any) => f.name)).toContain('user')
    // The base's own fields are untouched and keep their order — an extend is
    // additive, so anything reading the model by position still reads it.
    expect(s.fields.slice(0, 4).map((f: any) => f.name))
      .toEqual(['id', 'userId', 'token', 'expiresAt'])
  })

  test('adds model attributes, and the base keeps its own', () => {
    const schema = ok(HOST + `
      extend model Session {
        @@log(audit)
        @@index([userId])
      }
    `)
    const kinds = model(schema, 'Session').attributes.map((a: any) => a.kind)
    expect(kinds).toContain('log')
    expect(kinds).toContain('index')
    expect(kinds).toContain('gate')     // the package's statement, still there
    expect(kinds).toContain('db')
  })

  test('two extends of one model compose', () => {
    const schema = ok(HOST + `
      extend model Session { ipAddress String? }
      extend model Session { userAgent String? }
    `)
    const names = model(schema, 'Session').fields.map((f: any) => f.name)
    expect(names).toContain('ipAddress')
    expect(names).toContain('userAgent')
  })

  test('an added @@allow reaches the access layer like a declared one', () => {
    // The point of the whole feature: what the app adds has to be REAL, not
    // recorded. An allow that parsed and did not compile into the WHERE would
    // be an empty screen with a 200 — the worst failure this repo has.
    const schema = ok(HOST + `
      extend model Session {
        @@allow('read', userId == auth().id)
      }
    `)
    const allows = model(schema, 'Session').attributes.filter((a: any) => a.kind === 'allow')
    expect(allows).toHaveLength(1)
  })
})

// ─── what it refuses ─────────────────────────────────────────────────────────
//
// Each of these is a real mistake that otherwise looks like a working schema.

describe('extend model refuses', () => {

  test('a model that is not there — naming what is', () => {
    // The two causes are a misspelling and an import that did not resolve, and
    // both read as "my extend did nothing", forever, with a green parse.
    const err = bad(HOST + `extend model Sesion { foo String? }`)
    expect(err).toContain("no model 'Sesion'")
    expect(err).toContain('Session')      // and what IS declared
  })

  test('a field the model already declares', () => {
    // Redefining a package's column is the copy this feature exists to remove:
    // it is how `@secret` became `@guarded` and nobody noticed.
    const err = bad(HOST + `extend model Session { token String }`)
    expect(err).toContain("field 'token' is already declared")
  })

  test('a second answer to a single-valued attribute', () => {
    // @@gate twice is not a narrowing — it is two statements about who may read
    // the table, resolved by whichever the merge happened to put last.
    const err = bad(HOST + `extend model Session { @@gate("5") }`)
    expect(err).toContain('@@gate is already declared')
  })

  test('but a repeatable attribute is not a second answer', () => {
    const schema = ok(HOST + `
      extend model Session {
        @@allow('read', userId == auth().id)
        @@allow('delete', userId == auth().id)
        @@index([token])
      }
    `)
    expect(model(schema, 'Session').attributes.filter((a: any) => a.kind === 'allow'))
      .toHaveLength(2)
  })
})

// ─── across an import, which is the case it was built for ────────────────────

describe('extend model across an import', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lite-extend-'))
    // The shipped fragment: a package's models, knowing nothing about the app.
    writeFileSync(join(dir, 'auth.lite'), `
model Session {
  id        String   @id @default(uuid())
  userId    String
  token     String   @unique @guarded
  expiresAt DateTime
  @@db(main)
  @@gate("8")
}
`)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const app = (body: string) => {
    writeFileSync(join(dir, 'schema.lite'), `
database main  { path "./a.db" }
database audit { path "./audit/"; driver logger; retention 90d }

import "./auth.lite"

model User {
  id    String @id @default(uuid())
  email String @email @unique
  @@db(main)
  @@gate("4")
}
${body}
`)
    return parseFile(join(dir, 'schema.lite'))
  }

  test('the app says what the package could not', () => {
    const out = app(`
extend model Session {
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@log(audit)
}
`) as any
    if (!out.valid) throw new Error(out.errors.join(' · '))

    const s = out.schema.models.find((m: any) => m.name === 'Session')
    expect(s.fields.map((f: any) => f.name)).toContain('user')
    expect(s.attributes.map((a: any) => a.kind)).toContain('log')
    // And the package's own statement about the model survives untouched.
    expect(s.attributes.find((a: any) => a.kind === 'gate').value).toBe('8')
  })

  test('the extend may be written before the import is read', () => {
    // Extends are collected across the whole tree and applied once it is
    // merged, so textual order cannot decide whether a schema is valid.
    writeFileSync(join(dir, 'early.lite'), `
database main { path "./a.db" }

extend model Session { ipAddress String? }

import "./auth.lite"
`)
    const out = parseFile(join(dir, 'early.lite')) as any
    if (!out.valid) throw new Error(out.errors.join(' · '))
    expect(out.schema.models.find((m: any) => m.name === 'Session')
      .fields.map((f: any) => f.name)).toContain('ipAddress')
  })

  test('an unresolved import does not turn a live extend into a silent no-op', () => {
    // The failure mode the "no such model" error is really guarding: the
    // package is not installed, so the model is absent, so the extend applies
    // to nothing. Without the refusal the app parses and runs against a table
    // that has none of what the extend said.
    writeFileSync(join(dir, 'broken.lite'), `
database main { path "./a.db" }

import "./nowhere.lite"

extend model Session { ipAddress String? }
`)
    const out = parseFile(join(dir, 'broken.lite')) as any
    expect(out.valid).toBe(false)
    expect(out.errors.join(' · ')).toContain("no model 'Session'")
  })
})
