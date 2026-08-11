// web/src/session.js — who the browser thinks you are.
//
// The level is the SERVER's judgement (GET /session, backed by api/gate.ts), not
// something derived here from a role string — that mapping has one owner and
// this is not it. The UI reads the level only to decide what to offer; every
// request is graded again on arrival.
//
// Plain object, not a signal — the same contract as Sierra's own `status`.
// Readers declare `$: session.level`; the writer holds a watchProxy handle and
// mutates through that, because assigning session.level directly updates the
// object and notifies nobody (Mesa RULE 45).

import { watchProxy } from '@frontierjs/mesa/runtime'
import { login, logout } from '@frontierjs/sierra/junction'

export const session = {
  level: 0,
  email: null,
  role:  null,
  error: null,
}

const _w = watchProxy(session)

/** Ask the server who we are. Safe to call with no token — answers level 0. */
export async function refresh() {
  try {
    const res = await fetch('/session', { headers: authHeader() })
    // Check the response BEFORE parsing. With the API down, Vite answers the
    // proxied path with an empty-bodied 502 and res.json() throws inside a
    // promise nobody awaited — the only trace being a PromiseRejectionEvent
    // logged against virtual:sierra, which is the listener, not the cause.
    if (!res.ok) {
      _w.error = res.status === 502
        ? 'API not reachable on :8110 — run `bun run api` in another terminal'
        : `session check failed: HTTP ${res.status}`
      return
    }
    const me = await res.json()
    _w.error = null
    _w.level = Number(me.level) || 0
    _w.email = me.email
    _w.role  = me.role
  } catch (e) {
    _w.error = `session check failed: ${e.message}`
  }
}

function authHeader() {
  const token = localStorage.getItem('shop_token')
  return token ? { authorization: `Bearer ${token}` } : {}
}

export async function signIn(email, password) {
  _w.error = null
  const res = await fetch('/auth/login', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    _w.error = res.status === 401
      ? 'Wrong email or password'
      : res.status === 502
        ? 'API not reachable on :8110 — run `bun run api` in another terminal'
        : `sign-in failed: HTTP ${res.status}`
    return false
  }
  const { token } = await res.json()
  login(token)                 // hands the token to the Junction client
  await refresh()
  return true
}

export function signOut() {
  logout()
  _w.level = 0
  _w.email = null
  _w.role  = null
}

// Ask once at boot — a token in localStorage from a previous visit is still
// good, and the level has to come back from the server either way.
refresh()
