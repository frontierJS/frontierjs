/**
 * sierra/junction/session — who the browser thinks you are.
 *
 * The UI-realm half of the auth surface. The wire half is `client.auth`
 * (junction owns it, next to the token and the socket); this adds the three
 * things a page needs and a wire client cannot have: a reactive object to
 * render from, a boot restore that runs before the first route is judged, and
 * a promise the navigation guard can await.
 *
 * It exists because every app was writing it. `example` and `basecamp` each
 * carried their own `session.js` — 87 and 201 lines — and between them they
 * had four different answers to "is the token stored", "what does a 401 mean"
 * and "who asks the server". Neither ever called POST /auth/logout, so signing
 * out dropped the token locally and left the session row alive until it
 * expired.
 *
 *   import { session, signIn, signOut, ready } from '@frontierjs/sierra/junction'
 *
 *   $: session.user
 *   {#if session.user}<span>{session.user.email}</span>{/if}
 *
 * Plain object, not a signal — the same contract as `status` beside it.
 * Readers declare `$: session.user`; this module is the writer and mutates
 * through its own watchProxy handle, because assigning `session.user`
 * directly updates the object and notifies nobody (Mesa RULE 45).
 *
 * NOTHING HERE IS A BOUNDARY. The server grades every request again on
 * arrival; this only decides what the UI offers.
 */

import { watchProxy } from '@frontierjs/mesa/runtime'

/**
 * @property {object|null} user   the SessionContext the server built, or null
 * @property {number|null} level  the caller's gate level. 0 with no session —
 *                                STRANGER is what the ladder calls a caller
 *                                with no principal, and that is true whatever
 *                                an app's own resolver says. Signed in it is
 *                                the SERVER's grading and is null unless the
 *                                app configured `services: { level }` on the
 *                                auth plugin, because the role→level mapping
 *                                has one owner and the browser is not it
 * @property {boolean} checked    the boot restore has finished; guards await
 *                                `ready` rather than polling this
 * @property {string|null} error  the last thing that went wrong asking
 */
export const session = {
  user:    null,
  level:   0,
  checked: false,
  error:   null,
}

const _w = watchProxy(session)

/** @type {object|null} */
let _client = null

let _resolveReady
/**
 * Resolves when the boot restore has finished — signed in or not.
 *
 * Await it before judging a route. Without it a direct load of a guarded URL
 * is decided while the answer is still in flight, which is the redirect flash
 * both dogfood apps had to solve by hand.
 *
 * @type {Promise<void>}
 */
export let ready = new Promise(resolve => { _resolveReady = resolve })

/**
 * Called by initJunction once the client exists. Restores from the stored
 * token, if there is one.
 * @param {object} client
 */
export function initSession(client) {
  _client = client

  // No token means no question to ask — and asking anyway would answer 401 on
  // every cold visit to a public page, filling the console for anonymous
  // traffic that is behaving correctly.
  if (!client.token) {
    _w.checked = true
    _resolveReady()
    return
  }

  refresh().finally(() => {
    _w.checked = true
    _resolveReady()
  })
}

/** Ask the server who this token is. Safe to call at any time. */
export async function refresh() {
  if (!_client) return null
  try {
    const me = await _client.auth.me()
    _w.error = null
    _w.user  = me
    // Present only when the app told the auth plugin how to grade — see
    // AuthServicesOptions.level. null, not 0, when it publishes none: an
    // unknown level is PERMISSIVE
    // to `canAtLevel` (Invariant 6 — a client-side gate is an affordance), and
    // answering 0 would hide every gated control in an app that never asked to
    // be graded here.
    _w.level = typeof me?.level === 'number' ? me.level : null
    return me
  } catch (err) {
    // 401 is the ordinary answer to a token that expired or was issued by a
    // database that has since been reset — not an error to show anybody.
    if (err?.code === 401 || err?.status === 401) {
      clear()
      return null
    }
    _w.error = err?.message ?? String(err)
    return null
  }
}

/**
 * Sign in. Stores the token, opens the socket, and loads the session — so a
 * caller that awaits this can read `session.user` on the next line.
 */
export async function signIn(email, password) {
  return _attempt(() => _client.auth.signIn(email, password))
}

/** Register and sign in — the plugin's /auth/register does both. */
export async function signUp(data) {
  return _attempt(() => _client.auth.signUp(data))
}

/**
 * A refusal is put on `session.error` AND rethrown.
 *
 * Both, because there are two shapes of caller and neither should have to
 * write the other's: a form awaits and catches, a shell renders
 * `{#if session.error}` and never touches the promise. Recording it only, or
 * throwing it only, is what made every app's sign-in page carry its own
 * status-code mapping.
 */
async function _attempt(run) {
  _w.error = null
  try {
    const result = await run()
    await refresh()
    return result
  } catch (err) {
    // The message is the server's — junction's client keeps the body of a 401
    // now, so this is "Invalid credentials" rather than "Unauthorized".
    _w.error = err?.message ?? String(err)
    throw err
  }
}

/**
 * Sign out — at the server first, then here.
 *
 * Redirect handling is the caller's: call goto() after. The local half runs
 * even when the server call fails, so a person is never left signed in
 * because the network was down.
 */
export async function signOut() {
  const result = await _client.auth.signOut()
  clear()
  return result
}

/** Drop what we know locally. The client's own token is cleared by signOut. */
function clear() {
  _w.user  = null
  // A caller with no session is STRANGER(0). Not invented and not the app's to
  // disagree with: every gate above 0 refuses a request carrying no principal
  // whatever an app's own resolver says, so this is the one level a browser can
  // state for itself. Leaving it null would make it UNKNOWN, which is
  // permissive, and a signed-out page would offer every gated control it has.
  _w.level = 0
  _w.error = null
}

/** Internal — initJunction wires this to the client's 'unauthorized' event. */
export function _onUnauthorized() {
  clear()
}
