// src/dismissals.js — which notices the operator has said "got it" to.
//
// One store for the shell's NoticeBar and the home screen's ActionQueue. Each
// kept its own copy once: the queue's lived only in memory, so a reload
// brought every acknowledged notice back, and two copies writing one storage
// key would have overwritten each other's acknowledgements.
//
// Remembered per browser, keyed by notice id. An id is forgotten once its
// condition has cleared (`prune`), so a notice comes back when the condition
// does, but not on every refresh while it is still true.

import { watchProxy } from '@frontierjs/mesa/runtime'

const KEY = 'basecamp.notices.dismissed'

function recall() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

export const dismissals = { ids: recall() }
const _d = watchProxy(dismissals)

function save(ids) {
  // A new array, not a push: a watch re-derives from the assignment.
  _d.ids = ids
  try { localStorage.setItem(KEY, JSON.stringify(ids)) } catch {}
}

export function dismiss(ids) {
  save([...new Set([...dismissals.ids, ...ids])])
}

export function restore() { save([]) }

// Call only with a list that has finished loading: pruning against an empty
// or half-loaded one forgets every acknowledgement.
export function prune(notices) {
  const kept = dismissals.ids.filter(id => notices.some(n => n.id === id))
  if (kept.length !== dismissals.ids.length) save(kept)
}
