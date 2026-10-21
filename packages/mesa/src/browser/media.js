/*
 * media.js — #3, a media query as a signal: `media(q)`, `reducedMotion`,
 * `colorScheme`.
 *
 * The hand-written version is a `matchMedia` call, a `change` listener and a
 * cleanup per component, and the same few queries retyped with their own
 * widths. Here a query is one `MediaQueryList` and one listener however many
 * components read it: started by the first reader, removed a microtask after
 * the last (`subscribe`).
 *
 * `.matches` reads the list itself, so a read outside an effect is still the
 * live answer — tracking only decides who re-runs on a change. A query this
 * browser does not parse, or a feature it does not know, matches false, which
 * is what the browser answers; it is not refused, because a feature one
 * engine lacks is a query another parses.
 *
 * Each is a call, held in a component's own `const`. A template read of an
 * imported name compiles to a static value, so an exported signal object
 * would render once and never again — the reason sierra exports none
 * (`FJS-060`). `{media(q).matches}` written inline is static for the same
 * reason, and `externalReactivityHints: 'strict'` says so.
 *
 * `colorScheme()` is the operating system's preference, not the app's theme: the
 * theme is a class on `<html>` and sierra owns the switch, which reads this.
 *
 * Under a server render `.matches` is false and `colorScheme().value` is
 * `'light'`, with nothing subscribed. On a terminal or a phone each throws at
 * the call (`host.js`).
 */
import { subscribe } from '../runtime.js'
import { live } from './host.js'

const _lists = new Map()

function listFor(query) {
  let list = _lists.get(query)
  if (list) return list
  const mql = window.matchMedia(query)
  list = {
    mql,
    track: subscribe((update) => {
      mql.addEventListener('change', update)
      return () => mql.removeEventListener('change', update)
    }),
  }
  _lists.set(query, list)
  return list
}

function signal(query, name) {
  return {
    get matches() {
      if (!live(name)) return false
      const { mql, track } = listFor(query)
      track()
      return mql.matches
    },
  }
}

/** Whether `query` matches now, tracked. Server render: false. */
export function media(query) {
  if (typeof query !== 'string' || !query.trim())
    throw new Error(`media(${JSON.stringify(query)}): a media query is a non-empty string`)
  live('media()')
  return signal(query, 'media()')
}

/** The reader has asked for less motion. Server render: false. */
export function reducedMotion() {
  live('reducedMotion()')
  return signal('(prefers-reduced-motion: reduce)', 'reducedMotion()')
}

/** The operating system's scheme, `'dark'` or `'light'`. Server render: `'light'`. */
export function colorScheme() {
  live('colorScheme()')
  const dark = signal('(prefers-color-scheme: dark)', 'colorScheme()')
  return { get value() { return dark.matches ? 'dark' : 'light' } }
}
