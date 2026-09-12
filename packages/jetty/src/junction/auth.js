// Auth flow — login/logout token management.
//
// Spec invariant (from earlier patch):
//   1. Junction call → result
//   2. Store token in browser.storage.local
//   3. Upgrade Junction client with new token
//   4. Broadcast 'session' to all open ports
//
// (3) precedes (4) so any port reacting to `session` can issue authenticated
// channel subscriptions or service calls.

import { safeSetToken } from './adapter.js'

export function makeAuthFlow({ adapter, storage, pages, tokenKey = 'jetty_token' }) {
  let session = { user: null, authenticated: false, expiresAt: null }

  // Sign-in is `adapter.auth` where the adapter has one, and `call('auth', …)`
  // where it does not. A pseudo-service named `auth` was the only spelling for
  // as long as the placeholder was the only adapter, and it cannot be the real
  // one: Junction has no service by that name — `@frontierjs/auth` registers
  // `account`, `sessions` and `api-keys`, and establishing a session is a ROUTE
  // (`FJS-D20`) — so an app that DOES have a service called `auth` would find
  // its own methods shadowed by three the framework invented.
  const authApi = {
    login:  (credentials) => adapter.auth?.login  ? adapter.auth.login(credentials)
                                                  : adapter.call('auth', 'login',  credentials),
    completeLogin: (code)  => adapter.auth?.completeLogin ? adapter.auth.completeLogin(code)
                                                  : adapter.call('auth', 'completeLogin', { code }),
    logout: ()            => adapter.auth?.logout ? adapter.auth.logout()
                                                  : adapter.call('auth', 'logout', {}),
    verify: (token)       => adapter.auth?.verify ? adapter.auth.verify(token)
                                                  : adapter.call('auth', 'verify', { token }),
  }

  async function loadStoredToken() {
    if (!storage?.local) return null
    try {
      const got = await storage.local.get(tokenKey)
      return got?.[tokenKey] ?? null
    } catch { return null }
  }

  async function persistToken(token) {
    if (!storage?.local) return
    try {
      if (token == null) await storage.local.remove(tokenKey)
      else               await storage.local.set({ [tokenKey]: token })
    } catch (e) {
      console.warn('[jetty] auth token persist failed:', e.message)
    }
  }

  /**
   * A session answered, stored, upgraded and broadcast.
   *
   * One function because both steps of a login end here, and a second copy is
   * how the two would come to disagree about whether the token is persisted
   * before the connection is upgraded — which decides what a reload sees after a
   * crash between them.
   */
  async function adopt(result, what) {
    if (!result?.token) throw new Error(`${what} response missing token`)
    await persistToken(result.token)
    await safeSetToken(adapter, result.token)
    session = {
      user:          result.user ?? null,
      authenticated: true,
      expiresAt:     result.expiresAt ?? null,
    }
    pages.broadcast('session', session)
    return session
  }

  return {
    get session() { return session },

    async hydrate() {
      const token = await loadStoredToken()
      if (!token) return
      // Best-effort verify with server. If verify fails, treat as logged out.
      try {
        const result = await authApi.verify(token)
        if (result?.user) {
          session = {
            user:          result.user,
            authenticated: true,
            expiresAt:     result.expiresAt ?? null,
          }
          // Make sure the live junction connection knows about the token.
          await safeSetToken(adapter, token)
        }
      } catch (e) {
        // Stale or invalid token. Clear it.
        await persistToken(null)
        session = { user: null, authenticated: false, expiresAt: null }
      }
    },

    /**
     * Phase 2 login: credentials → Junction call → store → upgrade → broadcast.
     *
     * An account with a second factor answers `{ awaitingCode: true }` and none
     * of that happens: nothing is stored, the connection is not upgraded, and the
     * broadcast says the popup is waiting rather than signed in. `submitCode` is
     * the other half.
     */
    async login(credentials) {
      const result = await authApi.login(credentials)
      if (result?.awaitingCode) {
        session = { user: null, authenticated: false, expiresAt: null, awaitingCode: result.expiresAt ?? true }
        // Broadcast, because the popup that asked may already be gone — a
        // toolbar window closes on a click elsewhere, and the next one to open
        // has to find the attempt still standing.
        pages.broadcast('session', session)
        return session
      }
      return adopt(result, 'auth.login')
    },

    /**
     * Finish a login that owed a code. A TOTP code or a recovery code — the
     * person typing it is answering one question.
     *
     * The ticket is the wire client's and is never carried through a page or a
     * port: in cookie mode there is no ticket a page could hold, and a popup that
     * held one would be storing a password substitute for five minutes.
     */
    async submitCode(code) {
      try {
        return adopt(await authApi.completeLogin(code), 'auth.completeLogin')
      } catch (err) {
        // `retryable: false` is the server saying the attempt is spent. The port
        // hands a page the message and nothing else, so a waiting state left
        // standing here is a box in the popup that refuses every code it is ever
        // given — the broadcast is the only way the page learns to ask for the
        // password again. A retryable refusal leaves the attempt where it was.
        if (err?.data?.retryable === false || err?.retryable === false) {
          session = { user: null, authenticated: false, expiresAt: null }
          pages.broadcast('session', session)
        }
        throw err
      }
    },

    async logout() {
      try { await authApi.logout() } catch {/* still log out locally */}
      await persistToken(null)
      await safeSetToken(adapter, null)
      session = { user: null, authenticated: false, expiresAt: null }
      pages.broadcast('session', session)
      return session
    },
  }
}
