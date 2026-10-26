// src/sign-in.browser.js — this browser walking in, the twin of `sign-in.js`.
// `#sign-in` resolves here under the `browser` condition.
//
// A browser holds no key (`FJS-D1477`): a login is a Frontier member's machine
// signing with its chain, and a tab is no machine. `fli haven --browser` signs
// in on the terminal and opens this page with the session as `#session=` in
// the address. A fragment is never sent to a server, and it is wiped from the
// address once read, so it stays out of what a reload or a shared link carries.
// The session is then the client's, kept in its `tokenStorage` under
// `junction.tokenKey`, so a reload is the same member until it expires and
// `fli haven --browser` hands a new one.
import { getClient } from '@frontierjs/sierra/resource'

/** The session this page walks in with: handed in the address, else the one the client kept. */
export function sessionToken() {
  const handed = new URLSearchParams(location.hash.slice(1)).get('session')
  if (handed) history.replaceState(history.state, '', location.pathname + location.search)
  const token = handed ?? getClient()?.token
  if (!token) throw new Error('Nobody walked in: a browser is handed its session by `fli haven --browser`.')
  return token
}
