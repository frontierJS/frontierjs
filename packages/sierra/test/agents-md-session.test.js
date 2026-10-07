/**
 * test/agents-md-session.test.js
 *
 * AGENTS.md names `session.user`'s fields, and every one it names is a field
 * of the SessionContext the server builds (FJS-1827).
 *
 * A page written from the guide alone reaches for the user's id to compare a
 * row's owner column against. With the shape unstated it wrote
 * `session.user.id` — undefined on every session, so the owner was offered
 * none of their own moves. The field list is read out of junction's
 * `SessionContext` rather than written here, so a renamed field fails the
 * guide rather than this file.
 */

import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const guide = read('../AGENTS.md')
const types = read('../../junction/src/auth/types.ts')

// The first column of *Wrong guesses* quotes the habit, so a wrong spelling
// there is the guide working.
const told   = guide.replace(/(## Wrong guesses[\s\S]*?)(?=\n## )/, s => s.replace(/^\|[^|\n]*\|/gm, '|'))
const body   = types.match(/export interface SessionContext \{([\s\S]*?)\n\}/)[1]
const fields = new Set([...body.matchAll(/^  (\w+)\??:/gm)].map(m => m[1]))
const named  = [...new Set([...told.matchAll(/session\.user\.(\w+)/g)].map(m => m[1]))]

describe('AGENTS.md — session.user', () => {
  test('the SessionContext read is the real one', () => {
    expect(fields.has('userId')).toBe(true)
    expect(fields.has('id')).toBe(false)
  })

  test('the guide names the id the way the session spells it', () => {
    expect(named).toContain('userId')
  })

  test('every field the guide names is on the SessionContext', () => {
    expect(named.filter(f => !fields.has(f))).toEqual([])
  })
})
