/*
 * persisted.js — #1, a preference kept in localStorage: `persisted(key, fallback)`.
 *
 * A PREFERENCE, never a credential. A key that `/redact` reads as a credential
 * (`portal_token`, `apiKey`) is refused by name: a token kept here sits in a
 * namespace nothing clears on sign-out, and junction's `tokenStorage` is the
 * owner that does.
 *
 * ─── The stored key ──────────────────────────────────────────────────────
 *
 * `${prefix}:${key}`, and the prefix is the app's (`prefix.js`): sierra's
 * router boot calls `setPrefix` from config, so two apps on one dev origin do
 * not read each other's `rail`. It is resolved at every access rather than at
 * the call, because a store module that calls `persisted()` at import runs
 * before the boot that sets the prefix — ES imports are evaluated first.
 *
 * ─── One cell per stored key ─────────────────────────────────────────────
 *
 * The `storage` event fires in every tab BUT the one that wrote, so a write
 * here has to notify this tab's readers itself; two `persisted('rail')` in one
 * tab share a cell for that reason, and the cross-tab listener is the cell's,
 * started by its first reader and stopped with its last.
 *
 * ─── When storage refuses ────────────────────────────────────────────────
 *
 * A sandboxed frame throws on the `localStorage` getter itself, a full quota
 * throws on `setItem`. Neither may take the page down: a refused write is held
 * in memory for this tab, so the toggle still works and simply is not saved,
 * and each failure warns once per key.
 */
import { subscribe } from '../runtime.js'
import { isSecretKey } from '@frontierjs/toolbelt/redact'
import { live } from './host.js'
import { storageKey } from './prefix.js'

// ─── warnings ──────────────────────────────────────────────────────────

const _warned = new Set()
function warnOnce(key, kind, message) {
  const id = `${kind}\0${key}`
  if (_warned.has(id)) return
  _warned.add(id)
  console.warn(`[mesa/browser] persisted('${key}'): ${message}`)
}

// ─── the cell ──────────────────────────────────────────────────────────

const _cells = new Map()

function cellFor(full) {
  let cell = _cells.get(full)
  if (cell) return cell
  // `held` is what a refused write left behind for this tab: a string, or
  // null for a refused removal. `undefined` means storage is the answer.
  cell = { held: undefined, notify: null }
  cell.track = subscribe((update) => {
    cell.notify = update
    const onStorage = (e) => {
      // null is another tab's clear(); sessionStorage events arrive here too
      if (e.key !== full && e.key !== null) return
      if (e.storageArea !== localStore()) return
      cell.held = undefined
      update()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      cell.notify = null
      window.removeEventListener('storage', onStorage)
    }
  })
  _cells.set(full, cell)
  return cell
}

function localStore() {
  try { return window.localStorage } catch { return null }
}

function readRaw(cell, key, full) {
  if (cell.held !== undefined) return cell.held
  try {
    return window.localStorage.getItem(full)
  } catch (e) {
    warnOnce(key, 'read', `localStorage refused the read (${e.name}); reading the fallback`)
    return null
  }
}

function writeRaw(cell, key, full, raw) {
  try {
    if (raw === null) window.localStorage.removeItem(full)
    else window.localStorage.setItem(full, raw)
    cell.held = undefined
  } catch (e) {
    cell.held = raw
    warnOnce(key, 'write', `localStorage refused the write (${e.name}); the value holds for this tab and is not saved`)
  }
  cell.notify?.()
}

// ─── persisted ─────────────────────────────────────────────────────────

/**
 * A value read from and written to localStorage, tracked: an effect reading
 * `.value` re-runs on a write in this tab or another. `undefined` written is a
 * `reset()`. Under a server render `.value` is `fallback` and nothing is
 * subscribed; on a terminal or a phone the call throws.
 */
export function persisted(key, fallback, { parse = JSON.parse, format = JSON.stringify } = {}) {
  if (isSecretKey(key))
    throw new Error(
      `persisted('${key}'): '${key}' names a credential, and a credential kept in ` +
      `localStorage outlives the sign-out that should end it. Junction's tokenStorage ` +
      `owns tokens; persisted() is for preferences.`)
  live('persisted()')

  // A parsed value is kept for as long as the raw string it came from, so an
  // object preference reads back as the same object until something writes it.
  let lastRaw = null, lastValue
  const decode = (raw) => {
    if (raw === null) return fallback
    if (raw === lastRaw) return lastValue
    try {
      lastValue = parse(raw)
    } catch {
      warnOnce(key, 'parse', `the stored value does not parse; reading the fallback`)
      lastValue = fallback
    }
    lastRaw = raw
    return lastValue
  }

  const write = (raw) => {
    if (!live('persisted()')) return
    const full = storageKey(key)
    writeRaw(cellFor(full), key, full, raw)
  }

  return {
    get value() {
      if (!live('persisted()')) return fallback
      const full = storageKey(key)
      const cell = cellFor(full)
      cell.track()
      return decode(readRaw(cell, key, full))
    },
    set value(v) {
      write(v === undefined ? null : format(v))
    },
    /** Remove the stored value; `.value` reads `fallback` again. */
    reset() {
      write(null)
    },
  }
}
