// web/src/lib/session.js — who the caller is, and which workspace they are in.
//
// WHO is no longer this file's: `@frontierjs/sierra/resource` owns the session
// — the reactive object, the boot restore, sign in and sign out — and this
// file's job is now the half no framework can answer, which is the tenant
// everything downstream is scoped to.
//
// The app's fields are added to the FRAMEWORK's object rather than to one
// beside it, so a component still has one noun and one import for "the
// session". That works because a watchProxy is cached per object: sierra's
// writes and this file's go through the same proxy and notify the same path
// watches. The rule it costs — write only your own fields. Sierra owns
// `user` / `level` / `checked` / `error`; everything below is this app's.
//
// Nothing here is a permission boundary. The server grades every request again
// on arrival; this only decides what the UI offers.

import { watchProxy } from '@frontierjs/mesa/runtime'
import {
  session, ready as sessionReady, refresh, getClient,
  signIn as authSignIn, signOut as authSignOut, completeSignIn as authCompleteSignIn,
  verifyEmail as authVerifyEmail,
} from '@frontierjs/sierra/resource'

export { session }

// The chosen workspace outlives the tab. Without this, every reload silently
// snaps back to the first membership from /auth/workspace, so a switch appears
// to work and then undoes itself — the kind of bug that reads as "the API
// ignored me".
const WORKSPACE_KEY = 'basecamp_workspace'

// This app's own fields, declared on the shared object so a `$:` watch on any
// of them resolves the same way `session.user` does.
Object.assign(session, {
  workspaceId: null,   // the workspace every scoped request is stamped with
  workspaces:  [],     // the caller's memberships — what the switcher offers
  needsSetup:  false,  // no account exists yet — the wizard owns the app
  canMail:     true,   // false only when the API said it has no mail provider
})

const _w = watchProxy(session)

// ─── The three raw routes ─────────────────────────────────────────────────────
// `client.fetch` owns the bearer, origin, call headers and the error a failed
// call throws (`code` is the status). Explicit Accept: application/json is
// load-bearing: the dev proxy routes on it — a request without it is treated as
// a page navigation and answered with the SPA shell, because a service path and
// a page path are the same URL (see web/config/vite.config.js).
async function rawJson(path, { body, ...init } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  const res = await getClient().fetch(path, { ...init, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

// A single in-flight promise, resolved once. The navigation guard awaits it, so
// a direct load of any URL is judged with the session already known rather than
// flashing a redirect after the fact.
//
// It waits on Sierra's own restore first — that is what puts `session.user`
// there and clears a token the server no longer honors — and then adds the
// two questions that are this app's: is there an account at all, and which
// workspace are we in.
export const ready = restore()

async function restore() {
  try {
    const probe = await rawJson('/setup/probe')
    _w.needsSetup = Boolean(probe?.needs_setup)
    _w.canMail    = probe?.mail !== false
  } catch {
    // The probe is also the API's liveness check from the browser's side. If it
    // fails there is nothing to route on — leave needsSetup false and let the
    // login screen surface the error, which is where a human can act on it.
  }

  await sessionReady

  if (session.user) {
    try {
      await loadWorkspace()
    } catch (err) {
      if (err.code === 401) await signOut()
    }
  }
}

async function loadWorkspace() {
  // Read the remembered choice FIRST. adoptWorkspace() writes it, so adopting
  // the server default before reading overwrote the very value being restored
  // — the switch persisted, then undid itself on the next load, silently.
  const remembered = typeof localStorage !== 'undefined' ? localStorage.getItem(WORKSPACE_KEY) : null

  // The list BEFORE anything is adopted. `Workspace` is `@@tenant(none)` — the
  // tenant itself cannot be scoped by the tenant claim — so /workspaces answers
  // with no X-Workspace-Id, and adopting first only bought a window in which
  // every request named a workspace nobody had checked the caller belongs to.
  // The shell reloads on `session.workspaceId`, so that window is three
  // Forbidden refusals in the API log on the first sign-in after a db reset,
  // when the remembered id belongs to a workspace that no longer exists.
  _w.workspaces = await getClient().service('workspaces').findData()

  // Membership can also be revoked between sessions, which is the same test.
  if (remembered && _w.workspaces.some(w => w.id === remembered)) {
    adoptWorkspace(remembered)
    return
  }

  // The fallback: the caller's oldest membership, named by the server off the
  // membership row itself, so it needs no second check here.
  const { workspace_id: fallback } = await rawJson('/auth/workspace')
  adoptWorkspace(fallback ?? null)
}

// The client stamps X-Workspace-Id on every request from here on. Without it
// every scoped service answers 400 — the workspace is not optional context.
function adoptWorkspace(id) {
  _w.workspaceId = id
  getClient()?.setWorkspace(id)
  if (typeof localStorage === 'undefined') return
  if (id) localStorage.setItem(WORKSPACE_KEY, id)
  else localStorage.removeItem(WORKSPACE_KEY)
}

/**
 * Re-read the caller's memberships after one was made or ended here, and move
 * off the current workspace if it is no longer among them — every scoped
 * request would otherwise name a workspace that answers nothing.
 */
export async function reloadWorkspaces() {
  _w.workspaces = await getClient().service('workspaces').findData()
  if (!_w.workspaces.some(w => w.id === session.workspaceId))
    adoptWorkspace(_w.workspaces[0]?.id ?? null)
}

/** Switch the workspace everything downstream is scoped to. */
export function switchWorkspace(id) {
  if (!id || id === session.workspaceId) return
  adoptWorkspace(id)
}

export function currentWorkspace() {
  return session.workspaces.find(w => w.id === session.workspaceId) ?? null
}

// ─── Transitions ──────────────────────────────────────────────────────────────

/** First-run bootstrap: account + user + workspace + membership, one call. */
export async function completeSetup({ workspace_name, name, email, password }) {
  // The only unauthenticated write in the app, and it self-closes: /setup
  // answers 409 once an active user exists.
  const result = await rawJson('/setup', {
    method: 'POST',
    body:   { workspace_name, name, email, password },
  })

  // /setup answers a token like /auth/login does, but it is this app's own
  // route — so the client is handed the token directly and then asked who it
  // is, which is exactly what signIn does one call earlier.
  getClient().setToken(result.token)
  await refresh()
  await loadWorkspace()
  _w.needsSetup = false
  return result
}

// ─── Restoring a hub ──────────────────────────────────────────────────────────
// The other way through first run (`IDEAS/backups.md` 4.4): the API stages an
// archive and the next boot swaps it in, so the page's last word is "restart"
// and `/setup/probe`'s `restore` is how it learns the restart happened.

export function setupProbe() {
  return rawJson('/setup/probe')
}

export function listHubArchives(bucket) {
  return rawJson('/setup/restore/archives', { method: 'POST', body: bucket })
}

/** `{ ...bucket, archive }` from the bucket, or a File the operator chose. */
export async function stageHubRestore(from) {
  if (from instanceof Blob) {
    const res = await getClient().fetch('/setup/restore', {
      method: 'POST', body: from, headers: { accept: 'application/json', 'content-type': 'application/gzip' },
    })
    return res.json()
  }
  return rawJson('/setup/restore', { method: 'POST', body: from })
}

// ─── Invitations ──────────────────────────────────────────────────────────────
//
// Both of these run with no session — that is the whole point of an invitation
// (`FJS-032`). They go through the Junction client rather than this file's
// `rawJson()` helper because they ARE service calls, and the client is what knows
// the prefix and the transport.

/** What is this link? Answered to whoever holds the token and nobody else. */
export async function previewInvitation(token) {
  return getClient().service('invitations').invoke('preview', null, { token })
}

/**
 * Take it, and land the person inside the workspace.
 *
 * Two shapes come back and the difference is whether an account had to be made:
 * a new account arrives with a session token, an existing one was already
 * signed in and keeps the session it had. Everything after that is the same —
 * the memberships are re-read and the workspace they just joined is adopted,
 * because the alternative is landing on the overview scoped to some other
 * workspace, or to none, with every request answering 400.
 */
export async function acceptInvitation({ token, name, password }) {
  const result = await getClient().service('invitations').invoke('accept', null, { token, name, password })

  if (result?.sessionToken) {
    getClient().setToken(result.sessionToken)
    await refresh()
  }

  await loadWorkspace()
  // After the list, not before: loadWorkspace() adopts the remembered or the
  // default workspace, so adopting first would be overwritten by the very call
  // meant to confirm the new membership.
  if (result?.workspace_id) adoptWorkspace(result.workspace_id)
  return result
}

// An account with a second factor answers a challenge, and then there is no
// token yet — `/workspaces` asked now is a 401 that reads as a wrong password.
// The workspace is loaded by `completeSignIn` once the code has been accepted.
export async function signIn(email, password) {
  const result = await authSignIn(email, password)
  if (session.awaitingCode) return result
  await loadWorkspace()
  return result
}

export async function completeSignIn(code) {
  const result = await authCompleteSignIn(code)
  await loadWorkspace()
  return result
}

// A registration's link signs in (`FJS-D1310`), and a session with no
// workspace answers 400 on every scoped request.
export async function verifyEmail(token) {
  const result = await authVerifyEmail(token)
  if (result?.user) await loadWorkspace()
  return result
}

export async function signOut() {
  // The framework half ends the session AT THE SERVER and then locally — this
  // app used to drop the token and leave the session row alive until it
  // expired, which is what `FJS-D20` found in both dogfood apps.
  await authSignOut()
  _w.workspaces = []
  // Forget the workspace too. Leaving it behind means the next person to sign
  // in on this machine starts scoped to a workspace they may not belong to,
  // and every request 400s until they notice the switcher.
  adoptWorkspace(null)
}
