/**
 * test/local-db-open.test.js — an open the page abandoned is not a failure.
 *
 * Litestone's browser client rejects every call in flight on `pagehide`, the
 * open included. Reported as "the local database did not open", that is a
 * console warning for a navigation, and a drive counting warnings (example's
 * verify) failed one run in two on it (`FJS-1598`).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

let _rejectOpen

vi.mock('@frontierjs/litestone/browser', () => ({
  createBrowserClient: () => new Promise((_, reject) => { _rejectOpen = reject }),
}))
vi.mock('../src/resource/local-db-open.js', () => ({ openWorker: () => ({}) }))

const { configureLocalDb, localDb, _resetLocalDb } = await import('../src/resource/local-db.js')

const GONE = new Error('[Litestone] this browser client is closed — the page it belonged to went away.')

let _handlers
beforeEach(() => {
  _handlers = {}
  _resetLocalDb()
  globalThis.addEventListener = (type, fn) => { (_handlers[type] ??= []).push(fn) }
  globalThis.fetch = async () => ({ json: async () => ({ models: {} }) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); delete globalThis.addEventListener; delete globalThis.fetch })

const fire = (type, event = {}) => { for (const fn of _handlers[type] ?? []) fn(event) }
const opened = async () => { while (!_rejectOpen) await new Promise(r => setTimeout(r, 0)) }

describe('an open cut short by the page leaving', () => {
  test('answers null and says nothing', async () => {
    _rejectOpen = null
    configureLocalDb({ schemaUrl: '/s.json', wasmUrl: '/w.js' })
    await opened()
    fire('pagehide')
    _rejectOpen(GONE)
    expect(await localDb()).toBe(null)
    expect(console.warn).not.toHaveBeenCalled()
  })

  test('a failure while the page stays is still reported', async () => {
    _rejectOpen = null
    configureLocalDb({ schemaUrl: '/s.json', wasmUrl: '/w.js' })
    await opened()
    _rejectOpen(new Error('quota'))
    expect(await localDb()).toBe(null)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  test('a page restored from the back/forward cache reports again', async () => {
    _rejectOpen = null
    configureLocalDb({ schemaUrl: '/s.json', wasmUrl: '/w.js' })
    await opened()
    fire('pagehide')
    fire('pageshow', { persisted: true })
    _rejectOpen(new Error('quota'))
    await localDb()
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
