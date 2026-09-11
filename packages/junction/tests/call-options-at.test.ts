/**
 * tests/call-options-at.test.ts — the table that says where a principal goes
 *
 * `CALL_OPTIONS_AT` names the argument index of `CallOptions` for every
 * `ServiceCaller` method. Anything outside this package that has a principal and
 * a method NAME rather than a call site — `@frontierjs/testing`'s
 * `as(user).service(x)`, an agent surface dispatching a tool — binds through it.
 *
 * The failure it guards is silent in both directions and that is the whole
 * reason the file exists. A method the table does not name gets its principal
 * bound at a guessed index, where the options object is read as `data` or as a
 * query and the call runs as STRANGER: the gate refuses, the row policy filters
 * to nothing, and an empty list is what a caller sees (`FJS-097`). A name the
 * table holds and the caller no longer offers is the same mistake aged — it
 * points at an argument list that has moved.
 *
 * So the grading is against a REAL caller off a REAL app, in BOTH directions.
 * A one-way check passes while half the table is wrong: junction adding a method
 * is invisible to a test that only walks the table, and junction renaming one is
 * invisible to a test that only walks the caller.
 *
 * This lived in the consumer until `FJS-D258`, where it could only fire after
 * the interface had already shipped.
 */

import { describe, test, expect } from 'bun:test'
import { createApp, CALL_OPTIONS_AT } from '../index.ts'
import { createService } from '../src/core/service.ts'

const app = createApp()
app.services.register(createService({ name: 'things' }) as never)
const caller = app.service('things') as unknown as Record<string, unknown>

const callerMethods = Object.keys(caller).filter(k => typeof caller[k] === 'function')

describe('CALL_OPTIONS_AT — the table and the caller, both directions', () => {

  test('every method a real caller offers is in the table', () => {
    const missing = callerMethods.filter(m => CALL_OPTIONS_AT[m] === undefined)
    expect(missing).toEqual([])
  })

  test('every name in the table is a method a real caller offers', () => {
    const stale = Object.keys(CALL_OPTIONS_AT).filter(m => !callerMethods.includes(m))
    expect(stale).toEqual([])
  })

  // The control. Both assertions above pass vacuously against a caller that
  // offers nothing — an app whose service failed to register, a `service()` that
  // started answering a proxy. Without this, a table of 13 and a caller of 0 is
  // a green run.
  test('the caller was really built', () => {
    expect(callerMethods.length).toBeGreaterThan(10)
    expect(callerMethods).toContain('find')
    expect(callerMethods).toContain('call')
  })

  test('an index is a non-negative integer', () => {
    for (const [m, at] of Object.entries(CALL_OPTIONS_AT)) {
      expect(Number.isInteger(at), `${m}`).toBe(true)
      expect(at, `${m}`).toBeGreaterThanOrEqual(0)
    }
  })

  // `call(name, id, data, opts)` carries the method name as its first argument,
  // so it is the one row whose index is not shared with its CRUD sibling. A
  // table that copied `patch`'s 2 onto it binds the principal onto `data`.
  test('call() sits one past the write methods, because the name shifts it', () => {
    expect(CALL_OPTIONS_AT.call).toBe(3)
    expect(CALL_OPTIONS_AT.patch).toBe(2)
    expect(CALL_OPTIONS_AT.find).toBe(1)
  })
})
