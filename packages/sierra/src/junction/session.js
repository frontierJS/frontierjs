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
 * @property {string|null} oauthError  how a sign-in with a provider ended, read
 *                                off the URL at boot and then removed from it.
 *                                One of `denied` · `state` · `exchange` ·
 *                                `unavailable` · `link_required`. The code, for
 *                                branching — `link_required` is not a failure
 * @property {string|null} oauthMessage  the same thing in words, for rendering.
 *                                `OAUTH_ERRORS` is the table and it is one
 *                                owner, so five apps do not write five switches
 */
export const session = {
  user:         null,
  level:        0,
  checked:      false,
  error:        null,
  oauthError:   null,
  oauthMessage: null,
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
  takeOAuthError()

  // No credential means no question to ask — and asking anyway would answer 401
  // on every cold visit to a public page, filling the console for anonymous
  // traffic that is behaving correctly.
  //
  // NOT `client.token`, which is the Bearer answer to a question that has two
  // modes: in cookie mode the session is an httpOnly cookie no script can read,
  // so the token is empty for a signed-in caller too and this returned early on
  // every cold load, leaving `session.user` null while a valid session sat in
  // the jar — the app rendered signed out and the guard redirected an
  // authenticated caller to sign-in (FJS-474). Signing in worked, which is what
  // hid it: `_adopt` handles the no-token answer and `refresh()` runs on the way
  // through, so the app behaved correctly until the first reload.
  if (!client.hasCredential) {
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

/**
 * What each `oauth_error` code means, in words.
 *
 * The codes are coarse on purpose — the route that emits them refuses to say
 * whether a state existed or an exchange failed, because that is an oracle
 * handed to whoever can reach the URL. What that leaves is five tokens no
 * person can read, and without a table here every app writes the same switch:
 * this module exists because `example` and `basecamp` each carried their own
 * session.js, and five untranslated codes is exactly how the next divergence
 * starts.
 *
 * `link_required` IS NOT A FAILURE, and an app rendering all five in one red
 * alert gets it wrong. The flow worked; an account already holds that address
 * and has not proved it, so a confirmation link went out and the next step is
 * in the person's inbox. Branch on the code — `session.oauthError` is kept
 * beside the sentence for exactly this — rather than on the text.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const OAUTH_ERRORS = Object.freeze({
  denied:        'Sign-in was cancelled.',
  state:         'That sign-in link has expired or was already used. Please try again.',
  exchange:      'We could not complete the sign-in. Please try again.',
  unavailable:   'That sign-in method is not available right now.',
  link_required: 'An account already uses that email address. Check your inbox — ' +
                 'we have sent a link to confirm it is you.',
})

/**
 * The sentence for a code, or a generic one for a code this version has never
 * heard of.
 *
 * A fallback rather than null, because the server is deployed separately from
 * the app: a code added on one side reaches a browser running the other, and
 * *nothing at all on screen* is the failure this whole channel exists to fix.
 *
 * @param {string|null|undefined} code
 * @returns {string|null} null only for no code at all
 */
export function oauthErrorMessage(code) {
  if (!code) return null
  return OAUTH_ERRORS[code] ?? 'We could not complete the sign-in. Please try again.'
}

/**
 * Lift `?oauth_error=` off the URL, onto `session`, and out of the address bar.
 *
 * An OAuth refusal cannot arrive the way every other error here does. The
 * callback is a browser redirect, so there is no promise to reject and no
 * response to read — the only channel back is a query parameter on a page load,
 * and until something reads it the app boots as if nothing had happened. A
 * person who clicked *Deny* would see the sign-in page again with no
 * explanation and no reason to think anything went wrong.
 *
 * It is REMOVED once read, and that is not tidiness: left on the URL it
 * survives a refresh and every subsequent share of the link, so a message about
 * one sign-in attempt reappears for ever, including for whoever the link is
 * pasted to. `replaceState` rather than `pushState` — the failed attempt is not
 * a place in history to go back to.
 */
function takeOAuthError() {
  if (typeof location === 'undefined' || typeof history === 'undefined') return

  const url  = new URL(location.href)
  const code = url.searchParams.get('oauth_error')
  if (!code) return

  _w.oauthError   = code
  _w.oauthMessage = oauthErrorMessage(code)
  url.searchParams.delete('oauth_error')
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
}
