// The caller's gate level, as reported by /login.
//
// It lives here rather than being derived in the browser because a gate level
// is the SERVER's judgement of who you are. The UI reads it only to decide what
// to offer — every request is graded again on arrival.
//
// Plain object, not a signal — the same contract as Sierra's own `status`.
// Readers declare `$: session.level`; the writer holds a watchProxy handle and
// mutates through that, because assigning `session.level` directly updates the
// object and notifies nobody (Mesa RULE 45).

import { watchProxy } from '@frontierjs/mesa/runtime'

export const session = {
  level: 0,
}

const _w = watchProxy(session)

export function setLevel(level) {
  _w.level = Number(level) || 0
}
