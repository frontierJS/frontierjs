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
     */
    async login(credentials) {
      const result = await authApi.login(credentials)
      // Expected shape (default adapter convention; real Junction may differ):
      //   { token, user, expiresAt }
      if (!result?.token) {
        throw new Error('auth.login response missing token')
      }
      await persistToken(result.token)
      await safeSetToken(adapter, result.token)
      session = {
        user:          result.user ?? null,
        authenticated: true,
        expiresAt:     result.expiresAt ?? null,
      }
      // Broadcast new session to all connected ports.
      pages.broadcast('session', session)
      return session
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
