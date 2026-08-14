// db/test/types.test.ts
// db/schema.d.ts is generated from db/schema.lite, and this is what stops it
// rotting.
//
// The file is committed because every service imports the client type through
// it, and it is generated because a hand-maintained copy of 37 models is a
// second schema. That pair only works if a schema change that is not
// regenerated FAILS — otherwise the types keep describing yesterday's columns,
// which is worse than no types: `job.timeoutSeconds` was a type error against a
// hand-written `timeout_seconds` that no row has ever had.
//
// audience=system, matching package.json's `db:types`: this file types the API,
// which reads `Secret.data` (@encrypted) through asSystem(). The client
// audience strips protected columns and would call that read an error.

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseFile } from '../../../litestone/src/index.js'
import { generateTypeScript } from '../../../litestone/src/tools/typegen.js'

const SCHEMA = join(import.meta.dir, '..', 'schema.lite')
const DTS    = join(import.meta.dir, '..', 'schema.d.ts')

describe('db/schema.d.ts', () => {

  test('is what the schema generates right now — run `bun run db:types`', () => {
    const { schema } = parseFile(SCHEMA)
    const fresh      = generateTypeScript(schema, { audience: 'system' })
    expect(readFileSync(DTS, 'utf8')).toBe(fresh)
  })

  test('carries the columns the API reads through asSystem()', () => {
    // Two properties the audience decides, asserted rather than assumed: an
    // @encrypted column is present (system) and its comment says why.
    const dts = readFileSync(DTS, 'utf8')
    const secret = dts.slice(dts.indexOf('export interface Secret {'), dts.indexOf('export interface SecretCreate {'))
    expect(secret).toContain('data: string')
    expect(secret).toContain('@encrypted')
  })

  test('a nullable column accepts an explicit null on write', () => {
    // Invariant 9: an explicit null CLEARS, and absent leaves the column alone.
    // Typing a nullable column `T` made the only way to clear one a type error.
    const dts = readFileSync(DTS, 'utf8')
    const create = dts.slice(dts.indexOf('export interface AuditEventCreate {'), dts.indexOf('export interface AuditEventUpdate {'))
    expect(create).toContain('workspaceId?: string | null')
    // …while a required column stays required.
    expect(create).toContain('action: string')
  })
})
