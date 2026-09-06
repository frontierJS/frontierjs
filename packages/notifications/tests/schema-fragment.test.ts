// The model this package requires, and the file it ships it in.
//
// It exists because the model used to live in the README: every app typed it
// out, and a column this package started writing that an app's copy did not
// have was detectable by nothing (FJS-910). Shipping it makes `fli check`'s
// `package-model-drift` able to compare — but only while the file is exported
// AND packed, which is what these ask.

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join }                    from 'node:path'
import { parse }                   from '../../litestone/src/core/parser.js'

const root     = join(import.meta.dir, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const FRAGMENT = './db/notification.lite'

describe('the schema fragment', () => {
  test('is exported under the name an app imports it by', () => {
    // `shippedSchemas` in the cli reads the exports map and nothing else, so an
    // unexported file is a file no rule can see.
    expect(manifest.exports['./schema.lite']).toBe(FRAGMENT)
  })

  test('and is packed — a declared entry point files: leaves out is a broken install', () => {
    expect(manifest.files).toContain('db')
    expect(existsSync(join(root, FRAGMENT))).toBe(true)
  })

  test('parses standalone against a host that declares database main', () => {
    // The claim the file's own header makes. A fragment that only parses inside
    // the app that happens to import it is one nobody can check.
    const text = 'database main { path "./x.db" }\n' + readFileSync(join(root, FRAGMENT), 'utf8')
    const out  = parse(text)
    expect(out.errors).toEqual([])
    expect(out.valid).toBe(true)
  })

  test('declares the columns the drivers write, by the names they write them by', () => {
    // Read off the file rather than restated: these five are what
    // `drivers/inapp.ts` puts in its create call, so a rename here that the
    // driver does not follow is the failure this test is for.
    const out    = parse('database main { path "./x.db" }\n' + readFileSync(join(root, FRAGMENT), 'utf8'))
    const model  = out.schema.models.find(m => m.name === 'Notification')
    const fields = new Set(model.fields.map(f => f.name))

    for (const column of ['userId', 'type', 'data', 'contextType', 'contextId'])
      expect(fields.has(column)).toBe(true)

    // The recipient's own column, and the reason update is USER in the gate.
    expect(fields.has('readAt')).toBe(true)
  })

  test('create is SYSTEM and not LOCKED — 9 would stop notify() writing a row', () => {
    const text = readFileSync(join(root, FRAGMENT), 'utf8')
    const gate = text.match(/@@gate\("([\d.]+)"\)/)?.[1]
    expect(gate).toBe('0.8.4.8')
    expect(gate.split('.')[1]).not.toBe('9')
  })
})
