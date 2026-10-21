// src/editor/handoff.js — how a draft's preview signs in to basecamp
// (`FJS-D1357`): RFC 9700's code with PKCE across one redirect.
//
// Edit sends the person to basecamp with this page's address and a challenge;
// basecamp checks their grant and comes back with a one-time code on this
// page's fragment. The code is redeemed here, from this origin, with the
// verifier only this tab holds, for a key that reaches only `drafts` and lapses
// in hours. Basecamp's cookie is third-party on a workers.dev page and Safari
// and Firefox never send it, which is why there is a key at all.
//
// The key is in sessionStorage: it dies with the tab, and a preview is a link
// handed to reviewers, so nothing here outlives the person who signed in.

import { createJunctionClient } from '@frontierjs/junction/client'

const HELD     = 'fjs-editor'
const VERIFIER = 'fjs-editor-verifier'
const CODE     = /^#fjs-edit=([^&]+)$/

const store = {
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

/** Leave for basecamp's sign-in, holding a fresh verifier. */
export async function begin(site) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  store.set(VERIFIER, verifier)
  const to = new URL(`/sites/${site.appId}/edit/`, site.origin)
  to.searchParams.set('return', location.href.split('#')[0])
  to.searchParams.set('challenge', await challengeFor(verifier))
  location.assign(to.href)
}

/** The key this tab holds, while it lasts. */
export function held() {
  try {
    const h = JSON.parse(store.get(HELD) ?? 'null')
    return h && Date.parse(h.expiresAt) > Date.now() ? h : null
  } catch { return null }
}

export function forget() { store.drop(HELD) }

/**
 * Back from basecamp: spend the code on the fragment, if there is one. The
 * code leaves the address bar first, so a reload or a copied link never
 * carries it.
 * @returns {Promise<{ held: object } | { error: string } | null>}
 */
export async function arrive(site) {
  const m = location.hash.match(CODE)
  if (!m) return null
  history.replaceState(history.state, '', location.pathname + location.search)
  const verifier = store.get(VERIFIER)
  store.drop(VERIFIER)
  if (!verifier) return { error: 'This tab did not start that sign-in — press Edit again' }
  try {
    const answer = await clientFor(site).service('drafts').invoke('redeem', null,
      { appId: site.appId, code: decodeURIComponent(m[1]), verifier })
    store.set(HELD, JSON.stringify(answer))
    return { held: answer }
  } catch (err) {
    return { error: err.message }
  }
}
