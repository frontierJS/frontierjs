// web/src/lib/session.js -- who is signed in at the door.
//
// Sierra's own session asks `account.me` (the auth plugin's service), which
// Workbench does not mount (`FJS-D1786`): a member signs in with the machine's
// pass-phrase at POST /door/login and the client keeps the token under
// `junction.tokenKey`. This object is the one noun for "who", so a template has
// one import and a `$:` watch resolves the way `session.user` does elsewhere.
//
// Nothing here is a permission boundary. The server grades every request again
// on arrival; this only decides what the UI offers.

import { watchProxy } from '@frontierjs/mesa/runtime'
import { getClient, session as sierraSession } from '@frontierjs/sierra/resource'

export const session = { user: null, checked: false, error: null }

const _w = watchProxy(session)

// Sierra's tethered lists skip the read when its `session.level` cannot pass the
// model's gate, and that level is filled only by `account.me`, which this door
// replaces: left at 0 every gated list rendered empty with no request made.
// Unknown (null) is permissive there; the server still grades every call.
const _sierra = watchProxy(sierraSession)
function adopt(member) {
  _w.user = member
  _sierra.level = member ? null : 0
}

// Explicit Accept: application/json is load-bearing: the dev proxy routes on it,
// and a request without it is answered with the SPA shell, because a service
// path and a page path are the same URL (web/config/vite.config.js).
async function rawJson(path, init = {}) {
  const headers = { accept: 'application/json' }
  if (init.body) headers['content-type'] = 'application/json'
  const res = await getClient().fetch(path, { ...init, headers, body: init.body ? JSON.stringify(init.body) : undefined })
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** One in-flight promise the navigation guard awaits, so a direct load is judged with the session already known. */
export const ready = restore()

async function restore() {
  try {
    if (getClient()?.token) adopt(await rawJson('/door/me'))
  } catch (err) {
    // 401 is a token that expired or came from a database since reset: not an
    // error to show anybody. Anything else is the API not answering.
    if ((err?.code ?? err?.status) === 401) getClient().setToken(null)
    else _w.error = err?.message ?? String(err)
  }
  _w.checked = true
}

export async function signIn(key) {
  _w.error = null
  const answer = await rawJson('/door/login', { method: 'POST', body: { key } })
  getClient().setToken(answer.token)
  adopt(answer.member)
}

export async function signOut() {
  try { await rawJson('/door/logout', { method: 'POST', body: {} }) } finally {
    getClient().setToken(null)
    adopt(null)
  }
}

/** Re-read who the bearer is: linking the team chat changes `profileExternalId` after sign-in. */
export async function refreshSession() {
  adopt(await rawJson('/door/me'))
}
