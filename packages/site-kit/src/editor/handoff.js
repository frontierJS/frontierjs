// src/editor/handoff.js — how a draft's preview signs in to basecamp
// (`FJS-D1357`, `FJS-D2128`): RFC 9700's code with PKCE across one redirect.
//
// Edit sends the person to basecamp with this page's address and a challenge;
// basecamp checks their grant and comes back with a one-time code on this
// page's fragment. The code is redeemed here, from this origin, with the
// verifier only this tab holds, for a key that reaches only `drafts` and lapses
// in hours. Basecamp's cookie is third-party on a workers.dev page and Safari
// and Firefox never send it, which is why there is a key at all.
//
// The trip runs in a popup, so the preview never leaves: the popup lands back
// on this origin, hands the code to the tab that opened it and closes. A
// blocked popup falls back to the whole tab going, the same steps.
//
// The key is in localStorage, so every tab of the preview shares one sign-in
// until it lapses; Sign out forgets it for all of them.

import { createJunctionClient } from '@frontierjs/junction/client'

const HELD     = 'fjs-editor'
const VERIFIER = 'fjs-editor-verifier'
const CODE     = /^#fjs-edit=([^&]+)$/
const POPUP    = 'width=480,height=640'

const local = {
  get(k)    { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} },
  drop(k)   { try { localStorage.removeItem(k) } catch {} },
}

const tab = {
  get(k)    { try { return sessionStorage.getItem(k) } catch { return null } },
  set(k, v) { try { sessionStorage.setItem(k, v) } catch {} },
  drop(k)   { try { sessionStorage.removeItem(k) } catch {} },
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** RFC 7636 S256. */
export async function challengeFor(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

/**
 * What the script tag names: basecamp's page for this site's draft,
 * `<basecamp>/sites/<appId>/?draft=<slug>`.
 * @param {string} at
 */
export function siteOf(at) {
  const url = new URL(at)
  return { origin: url.origin, appId: url.pathname.split('/').filter(Boolean)[1], draft: url.searchParams.get('draft'), page: url.href }
}

export const clientFor = (site, key) => createJunctionClient({ url: site.origin, ...(key ? { token: key } : {}) })

/**
 * Sign in through basecamp. The popup must open before the first await: a
 * browser allows one only inside the click that asked for it.
 * @returns {Promise<{ held: object } | { error: string } | null>} null when the
 *   popup was closed before it came back; never settles when the tab itself left
 */
export async function begin(site) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  tab.set(VERIFIER, verifier)
  const popup = open('', 'fjs-edit', `popup,${POPUP},left=${screenX + (outerWidth - 480) / 2},top=${screenY + 80}`)
  const to = new URL(`/sites/${site.appId}/edit/`, site.origin)
  to.searchParams.set('return', location.href.split('#')[0])
  to.searchParams.set('challenge', await challengeFor(verifier))
  if (!popup) return new Promise(() => location.assign(to.href))
  popup.location.href = to.href
  const code = await codeFrom(popup)
  return code ? spend(site, code) : null
}

/** The code the popup posts back, or null once it closes without one. */
function codeFrom(popup) {
  return new Promise((resolve) => {
    const done = (code) => { removeEventListener('message', heard); clearInterval(watch); resolve(code) }
    const heard = (e) => {
      if (e.source === popup && e.origin === location.origin && typeof e.data?.fjsEdit === 'string') done(e.data.fjsEdit)
    }
    addEventListener('message', heard)
    // Closing the popup sends nothing, and the button would wait forever.
    const watch = setInterval(() => { if (popup.closed) done(null) }, 400)
  })
}

/**
 * In the popup, back from basecamp: hand the code to the tab that opened it
 * and close. The opener is this preview only when its origin reads as ours;
 * reading another origin's throws.
 * @returns {boolean} true when this window is that popup and is closing
 */
export function handBack() {
  const m = location.hash.match(CODE)
  if (!m || !opener) return false
  try { if (opener.location.origin !== location.origin) return false } catch { return false }
  opener.postMessage({ fjsEdit: decodeURIComponent(m[1]) }, location.origin)
  close()
  return true
}

/** The key this preview holds, while it lasts. */
export function held() {
  try {
    const h = JSON.parse(local.get(HELD) ?? 'null')
    return h && Date.parse(h.expiresAt) > Date.now() ? h : null
  } catch { return null }
}

export function forget() { local.drop(HELD) }

/** Calls `fn` when another tab of this preview signs in or out. */
export function onHeldChange(fn) {
  const heard = (e) => { if (e.key === HELD || e.key === null) fn(held()) }
  addEventListener('storage', heard)
  return () => removeEventListener('storage', heard)
}

/**
 * Back from basecamp in this tab, when the popup was blocked: spend the code
 * on the fragment, if there is one. The code leaves the address bar first, so
 * a reload or a copied link never carries it.
 * @returns {Promise<{ held: object } | { error: string } | null>}
 */
export async function arrive(site) {
  const m = location.hash.match(CODE)
  if (!m) return null
  const strip = () => { if (CODE.test(location.hash)) history.replaceState(history.state, '', location.pathname + location.search) }
  strip()
  const answer = await spend(site, decodeURIComponent(m[1]))
  // Sierra's router writes back the address it booted with once its route
  // loads, which restores the code; the redeem's round trip outlasts that.
  strip()
  return answer
}

async function spend(site, code) {
  const verifier = tab.get(VERIFIER)
  tab.drop(VERIFIER)
  if (!verifier) return { error: 'This tab did not start that sign-in — press Edit again' }
  try {
    const answer = await clientFor(site).service('drafts').invoke('redeem', null, { appId: site.appId, code, verifier })
    local.set(HELD, JSON.stringify(answer))
    return { held: answer }
  } catch (err) {
    return { error: err.message }
  }
}
