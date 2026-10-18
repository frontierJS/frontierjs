// test/audit-envelope-copies.test.ts — one owner for the result envelope (Invariant 4).
//
// Fable audit run 2.1. `isServiceResult()` in `src/core/envelope.ts` is the one
// test for "is this value an envelope" — `kind` in {single,list} AND `data` AND
// `object` AND an `errors` array — and `unwrapResult()` is the one way out of it.
// Three places re-state the rule with fewer clauses, and each of them takes a
// ROW for an envelope when the row happens to have a column named `kind` and one
// named `data`:
//
//   • the browser client's push `unwrap` (`src/client/index.ts`, resource wiring)
//     — `kind === 'single'` with no `object`/`errors`, so a pushed row with those
//     two columns reaches the tether as its `data` column instead of itself
//   • `rowsOf` in `@frontierjs/mcp`'s `src/client/run.ts` — `kind === 'list'`
//     with an array `data`
//   • `rowsOf` in `example/file-upload.ts` — `'kind' in r && 'data' in r`
//
// Each `test.failing` asserts the FIXED behavior — the copy agrees with the owner
// — and so fails today; drop `.failing` when the fix lands. The last two copies
// are not importable (one is unexported, the other starts a server on import),
// so those two are graded off the source text: the fix is that the file asks the
// owner.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isServiceResult, unwrapResult } from '../src/core/envelope.ts'
import { createJunctionClient } from '../src/client/index.ts'

const here = new URL('.', import.meta.url).pathname

// A row of a model with columns `kind` and `data` — a `Message { kind, data }`
// is an ordinary schema — whose `kind` value is the one the envelope uses.
const ROW_LIKE_AN_ENVELOPE = { id: 2, kind: 'single', data: 'payload', status: 'paid' }

describe('the owner leaves a row with kind/data columns alone', () => {

  test('control: isServiceResult refuses it and unwrapResult hands it back whole', () => {
    expect(isServiceResult(ROW_LIKE_AN_ENVELOPE)).toBe(false)
    expect(unwrapResult(ROW_LIKE_AN_ENVELOPE)).toEqual(ROW_LIKE_AN_ENVELOPE)
  })
})

describe('the browser client asks the owner when a push arrives', () => {

  // A page client with no socket of its own: `relay` answers every call, and
  // `receive()` is the function the socket handler would call with a frame.
  function pageClient(rows: unknown[]) {
    const page: any = createJunctionClient({
      relay: async () => ({ kind: 'list', object: 'messages', data: rows, errors: [], total: rows.length, limit: 20, offset: 0 }),
    })
    page.receive({ type: 'connected' })
    return page
  }

  test('control: a pushed row with ordinary columns lands in the tether as itself', async () => {
    const page = pageClient([{ id: 1, kind: 'note', data: 'hello', status: 'paid' }])
    const { tether, load } = page.resource('messages')
    await load()
    const pushed = { id: 2, kind: 'note', data: 'again', status: 'paid' }
    page.receive({ type: 'event', event: 'messages created', data: pushed })
    expect(tether.get().find((r: any) => r.id === 2)).toEqual(pushed)
  })

  test('a pushed row whose kind column reads "single" lands in the tether as itself', async () => {
    const page = pageClient([{ id: 1, kind: 'note', data: 'hello', status: 'paid' }])
    const { tether, load } = page.resource('messages')
    await load()
    page.receive({ type: 'event', event: 'messages created', data: ROW_LIKE_AN_ENVELOPE })
    expect(tether.get().find((r: any) => r.id === 2)).toEqual(ROW_LIKE_AN_ENVELOPE)
  })
})

describe('the two unimportable copies ask the owner', () => {

  test('mcp run.ts reads the list envelope through envelope.ts, not its own kind test', () => {
    const src = readFileSync(`${here}../../mcp/src/client/run.ts`, 'utf8')
    expect(src).toMatch(/\b(isListResult|isServiceResult|unwrapResult|resultData)\b/)
    expect(src).not.toMatch(/kind === 'list' && Array\.isArray/)
  })

  test('example/file-upload.ts unwraps through envelope.ts, not "kind in r"', () => {
    const src = readFileSync(`${here}../example/file-upload.ts`, 'utf8')
    expect(src).toMatch(/\b(isServiceResult|unwrapResult|resultData)\b/)
    expect(src).not.toMatch(/'kind' in r && 'data' in r/)
  })
})
