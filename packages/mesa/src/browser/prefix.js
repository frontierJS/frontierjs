/*
 * prefix.js — the app's namespace for every key the kit stores
 * (`FJS-D1097` Q2). Its own module because sierra's router sets it in every
 * app, and an app that never calls `persisted()` should not ship the
 * credential table that `persisted.js` imports to refuse a key.
 */
let _prefix = ''

/** The app's namespace for every stored key. Sierra calls it once at boot. */
export function setPrefix(prefix) {
  _prefix = prefix ? String(prefix) : ''
}

/** `prefix:key`, or the key bare with no prefix set. Read at every access. */
export const storageKey = (key) => (_prefix ? `${_prefix}:${key}` : key)
