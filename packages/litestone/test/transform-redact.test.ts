// redact() nulls what the schema DECLARES (FJS-D657, FJS-2059). A list of
// likely column names caught `email` and passed `applicantEmail` and a @secret
// named `stripeKey` into the copy untouched, and nulled a company's public
// `email` that is nobody's personal data.
//
// An optional column redacts to NULL; a required one to a per-row placeholder
// (FJS-2063).

import { describe, test, expect, beforeAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join, resolve } from 'path'
import { writeFileSync } from 'fs'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { splitStatements } from '../src/core/migrate.js'
import { execute } from '../src/transform/framework.js'
import { run } from '../src/transform/runner.js'
import { tempDir } from '../src/tmp-dirs.js'

const TMP       = tempDir('litestone-transform-redact-')
const FRAMEWORK = resolve(import.meta.dir, '../src/transform/framework.js')

const SCHEMA = `
  model Candidate {
    id             Int     @id
    stage          String
    applicantEmail String? @personal
    phone          String? @personal(contact) @map("phone_number")
    stripeKey      String? @guarded
    @@person
  }
  model Company {
    id    Int     @id
    email String?
  }
`

const schemaPath = join(TMP, 'schema.lite')
const dbPath     = join(TMP, 'source.db')

beforeAll(() => {
  writeFileSync(schemaPath, SCHEMA)
  const r = parse(SCHEMA)
  if (!r.valid) throw new Error(r.errors.join('\n'))
  const db = new Database(dbPath)
  for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) db.run(s)
  db.run(`INSERT INTO candidate (id, stage, applicantEmail, phone_number, stripeKey) VALUES (1, 'interview', 'a@person.test', '555-0100', 'sk_live_x')`)
  db.run(`INSERT INTO company (id, email) VALUES (1, 'hello@company.test')`)
  db.close()
})

function configWith(name: string, pipeline: string, extra = '') {
  const path = join(TMP, `${name}.js`)
  writeFileSync(path,
    `import { $ } from '${FRAMEWORK}'\n` +
    `export const db = '${dbPath}'\n` +
    `export const pipeline = [${pipeline}]\n` + extra)
  return path
}

async function transformed(name: string, pipeline: string, opts: Record<string, unknown> = {}, extra = '') {
  const out = join(TMP, `${name}.db`)
  await execute(configWith(name, pipeline, extra), { verbose: false, outputPath: out, schemaPath, ...opts }, run)
  const db = new Database(out, { readonly: true })
  const rows = { candidate: db.query('SELECT * FROM candidate').get() as any, company: db.query('SELECT * FROM company').get() as any }
  db.close()
  return rows
}

describe('redact() reads the schema', () => {
  test('bare redact nulls every protected and every @personal column, under its mapped name', async () => {
    const { candidate, company } = await transformed('both', `$.all.redact()`)
    expect(candidate.applicantEmail).toBe(null)
    expect(candidate.phone_number).toBe(null)
    expect(candidate.stripeKey).toBe(null)
    expect(candidate.stage).toBe('interview')
    expect(company.email).toBe('hello@company.test')
  })

  test("'PERSONAL' leaves a protected column and 'SECRETS' leaves a personal one", async () => {
    const personal = await transformed('personal', `$.all.redact('PERSONAL')`)
    expect(personal.candidate.applicantEmail).toBe(null)
    expect(personal.candidate.stripeKey).toBe('sk_live_x')

    const secrets = await transformed('secrets', `$.all.redact('SECRETS')`)
    expect(secrets.candidate.stripeKey).toBe(null)
    expect(secrets.candidate.applicantEmail).toBe('a@person.test')
  })

  test('a config list adds a column the schema does not declare', async () => {
    const { company } = await transformed('extra', `$.all.redact()`, {}, `export const redact = { PERSONAL: ['email'] }\n`)
    expect(company.email).toBe(null)
  })

  test('a redact with no schema is refused before anything runs', async () => {
    await expect(execute(configWith('none', `$.all.redact()`), { verbose: false, outputPath: join(TMP, 'none.db') }, run))
      .rejects.toThrow(/no schema was found/)
  })

  test("the retired 'PII' key is refused by name", async () => {
    await expect(execute(configWith('pii', `$.all.redact()`, `export const redact = { PII: ['email'] }\n`),
      { verbose: false, outputPath: join(TMP, 'pii.db'), schemaPath }, run))
      .rejects.toThrow(/"PII" is not a mode/)
  })
})

// FJS-2063: under FJS-D657 the commonest target is a REQUIRED @unique column.
describe('redact() over a required column', () => {
  const REQUIRED = `
    model Member {
      id    Int    @id
      email String @personal @unique
      age   Int    @personal
      name  String
    }
  `
  const reqSchemaPath = join(TMP, 'required.lite')
  const reqDbPath     = join(TMP, 'required-source.db')

  beforeAll(() => {
    writeFileSync(reqSchemaPath, REQUIRED)
    const r = parse(REQUIRED)
    if (!r.valid) throw new Error(r.errors.join('\n'))
    const db = new Database(reqDbPath)
    for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) db.run(s)
    db.run(`INSERT INTO member (id, email, age, name) VALUES (1, 'a@person.test', 31, 'Ann'), (2, 'b@person.test', 44, 'Bo')`)
    db.close()
  })

  test('a NOT NULL column gets a placeholder that survives @unique, and the real value is gone', async () => {
    const out = join(TMP, 'required.db')
    const cfg = join(TMP, 'required.js')
    writeFileSync(cfg,
      `import { $ } from '${FRAMEWORK}'\n` +
      `export const db = '${reqDbPath}'\n` +
      `export const pipeline = [$.all.redact()]\n`)
    await execute(cfg, { verbose: false, outputPath: out, schemaPath: reqSchemaPath }, run)
    const db = new Database(out, { readonly: true })
    const rows = db.query('SELECT * FROM member ORDER BY id').all() as any[]
    db.close()
    expect(rows.length).toBe(2)
    expect(rows[0].email).not.toBe(null)
    expect(rows[0].email).not.toBe(rows[1].email)
    expect(JSON.stringify(rows)).not.toContain('person.test')
    expect(rows.map(r => r.age)).not.toContain(31)
    expect(rows.map(r => r.age)).not.toContain(44)
    expect(rows.every(r => r.age != null)).toBe(true)
    expect(rows.map(r => r.name)).toEqual(['Ann', 'Bo'])
  })
})
