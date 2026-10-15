// src/home-row.js — the left hand's keys (`IDEAS/haven.md` 9.4): `a s d f` in
// NORMAL while the right walks on `h j k l`, each keeping what the key means
// in vim. An operator waits for the key after it, as vim's do:
//
//   d          a bolt the way the figure faces, once PENDING_MS passes
//   d h|j|k|l  a bolt that way;  dd  a volley, all four ways
//   f <letter> walk to the nearest member whose nick starts with it
//   s <char>   draw the figure as that character;  s Space  as itself again
//   a <char>   chalk the cell behind the figure
//
// Esc drops a waiting operator; any key an operator cannot take drops it too,
// and is swallowed, as vim's `d` swallows a key that is no motion. Pure: the
// scene's keydown hands each key in with the time, and acts on what returns.
//
// In the terminal's NORMAL the shell renames h j k l to the arrows before a
// scene sees them (`sierra/src/terminal/shell.js`), so after `f`, `s` or `a`
// an arrow is read back as its letter — an `f` then Left finds a nick in h.

import { glyphOf } from '../../api/src/shape.ts'

/** How long a lone `d` waits for a second key before it fires the way faced. */
export const PENDING_MS = 400

const OPERATORS = new Set(['a', 's', 'd', 'f'])
const WAYS = { h: 'w', j: 's', k: 'n', l: 'e' }
const ARROWS = { ArrowLeft: 'h', ArrowDown: 'j', ArrowUp: 'k', ArrowRight: 'l', left: 'h', down: 'j', up: 'k', right: 'l' }

const letterOf = (k) => ARROWS[k] ?? k

/**
 * A home row's state. `key(k, now)` answers an action to take, `true` for a
 * key it kept (an operator, or one it dropped), or null for a key that is not
 * its own — a walk, or anything else the scene does. A key that comes after a
 * lone `d` ran out is the bolt that `d` was, with what the key itself answers
 * as its `after`, so a step taken just late is still a step.
 */
export function createHomeRow() {
  let pending = null   // { op, at }

  const take = (op, k) => {
    const l = letterOf(k)
    if (op === 'd') {
      if (l === 'd') return { act: 'volley' }
      if (WAYS[l]) return { act: 'bolt', facing: WAYS[l] }
      return true
    }
    if (op === 'f') return /^[a-z0-9]$/i.test(l) ? { act: 'find', letter: l.toLowerCase() } : true
    if (op === 's' && k === ' ') return { act: 'shape', ch: null }
    const ch = glyphOf(l)
    if (!ch) return true
    return op === 's' ? { act: 'shape', ch } : { act: 'chalk', ch }
  }

  return {
    /** The operator waiting for its next key, or null. */
    get pending() { return pending?.op ?? null },

    key(k, now = Date.now()) {
      const fired = this.due(now)
      if (fired) return { ...fired, after: this.key(k, now) }
      if (pending) {
        const { op } = pending
        pending = null
        return k === 'Escape' ? true : take(op, k)
      }
      if (OPERATORS.has(k)) { pending = { op: k, at: now }; return true }
      return null
    },

    /** A lone `d` past PENDING_MS: the bolt it was, the way faced. A scene asks on its clock as well as on a key. */
    due(now = Date.now()) {
      if (pending?.op !== 'd' || now - pending.at < PENDING_MS) return null
      pending = null
      return { act: 'bolt', facing: null }
    },

    cancel() { pending = null },
  }
}
