// web/src/session.js — who the caller is, and which workspace they are in.
//
// WHO is no longer this file's: `@frontierjs/sierra/junction` owns the session
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
  signIn as authSignIn, signOut as authSignOut,
} from '@frontierjs/sierra/junction'

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
})

const _w = watchProxy(session)

// ─── One JSON helper ──────────────────────────────────────────────────────────
// Explicit Accept: application/json is load-bearing, not decoration. The dev
// proxy routes on it — a request without it is treated as a page navigation and
// answered with the SPA shell, because a service path and a page path are the
// same URL (see web/config/vite.config.js).
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  // The token is the client's — this file no longer keeps one. Two copies of
  // "am I signed in" is what the framework session exists to end.
  const token = auth ? getClient()?.token : null
  if (token) headers['authorization'] = `Bearer ${token}`

  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined })

  // Read the body once, then decide. With the API down, Vite answers 502 with
  // an empty body and res.json() throws "Unexpected end of JSON input" from
  // inside a promise — the real cause is "the API isn't running", so say that.
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* not JSON */ }

  if (!res.ok) {
    const message = res.status === 502
      ? 'API not reachable on :8120 — run `bun run api`'
      : data?.message ?? `HTTP ${res.status}`
    throw Object.assign(new Error(message), { status: res.status, data })
  }
  return data
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

// A single in-flight promise, resolved once. The navigation guard awaits it, so
// a direct load of any URL is judged with the session already known rather than
// flashing a redirect after the fact.
//
// It waits on Sierra's own restore first — that is what puts `session.user`
// there and clears a token the server no longer honours — and then adds the
// two questions that are this app's: is there an account at all, and which
// workspace are we in.
export const ready = restore()

async function restore() {
  try {
    const probe = await api('/setup/probe', { auth: false })
    _w.needsSetup = Boolean(probe?.needs_setup)
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
      if (err.status === 401) await signOut()
    }
  }
}

async function loadWorkspace() {
  // Read the remembered choice FIRST. adoptWorkspace() writes it, so adopting
  // the server default before reading overwrote the very value being restored
  // — the switch persisted, then undid itself on the next load, silently.
  const remembered = typeof localStorage !== 'undefined' ? localStorage.getItem(WORKSPACE_KEY) : null

  // The fallback: the caller's oldest membership.
  const { workspace_id: fallback } = await api('/auth/workspace')

  // Adopt something BEFORE listing: /workspaces is itself scoped, and a request
  // carrying no X-Workspace-Id is refused with 400.
  adoptWorkspace(remembered ?? fallback ?? null)

  const list = await api('/workspaces')
  _w.workspaces = list?.data ?? []

  // The list is the authority on membership, which can be revoked between
  // sessions. A remembered workspace the caller no longer belongs to drops back
  // to the default rather than leaving every request scoped to nothing.
  if (!_w.workspaces.some(w => w.id === session.workspaceId)) adoptWorkspace(fallback ?? null)
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

/** Switch the workspace everything downstream is scoped to. */
export function switchWorkspace(id) {
  if (!id || id === session.workspaceId) return
  adoptWorkspace(id)
}

export function currentWorkspace() {
  return session.workspaces.find(w => w.id === session.workspaceId) ?? null
}

/**
 * Resource before/create hook: put the active workspace on the record.
 *
 * Every workspace-scoped model declares `workspaceId String` — not optional —
 * so the schema-derived client validation refuses a create without it:
 * `workspace is required`, before the request is even sent. But the column is
 * SERVER-stamped: the services take it from the X-Workspace-Id header, because
 * a client that names its own workspace is a client choosing its own tenant.
 *
 * So the record has to carry it to satisfy the schema, and the value has to be
 * ignored by the server. Both are true: the service's own stampWorkspace hook
 * overwrites whatever arrives, so this is bookkeeping, not authority — and a
 * lying client gains nothing by it.
 *
 * It lives here, once, rather than in each form, because a form that forgot it
 * would fail with a validation error naming a field the person cannot see.
 * Resource before-hooks run BEFORE validation for exactly this case
 * (sierra src/junction/resource.js ~429).
 */
export function stampWorkspace(ctx) {
  if (ctx.data && !ctx.data.workspaceId) ctx.data.workspaceId = session.workspaceId
}

// ─── Transitions ──────────────────────────────────────────────────────────────

/** First-run bootstrap: account + user + workspace + membership, one call. */
export async function completeSetup({ workspace_name, name, email, password }) {
  // The only unauthenticated write in the app, and it self-closes: /setup
  // answers 409 once an active user exists.
  const result = await api('/setup', {
    method: 'POST',
    auth:   false,
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

export async function signIn(email, password) {
  const result = await authSignIn(email, password)
  await loadWorkspace()
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
