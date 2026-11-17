// api/src/domain/capture/connect.ts
// Connecting Capture to its share app without pasting a key, and testing the
// connection. The share app's side is `fjs-prototypes/capture/api`:
//
//   1. connect() builds `{BASE}/connect/?device&redirect_uri&state&code_challenge`
//      and remembers ONE attempt in memory. The page opens that URL in a browser.
//   2. The browser comes back to `landed()` with `?code&state` (or `?error`), where
//      the state matching the pending attempt is the whole proof: the request
//      carries no Workbench cookie, and anything else that reaches the route is
//      refused without writing.
//   3. landed() trades the code and the PKCE verifier for the key at
//      `{BASE}/api/connect/exchange` and writes it through `setCaptureConfig`, so
//      the 0600 file and every refusal there still hold.
//
// The key is never put in a page, a log or a redirect. A pending attempt is not
// stored on disk: a restart of the API drops it, and the person presses Connect
// again.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { hostname } from 'node:os'
import type { TransportContext } from '@frontierjs/junction'

import { setCaptureConfig, shareCredentials, shareUrlRefusal, type Where } from './config.ts'

/** The loopback route the share app sends the browser back to. */
export const CONNECTED_PATH = '/capture-connected'

const PENDING_MS = 10 * 60_000
const ASK_MS     = 10_000

type Pending = { state: string, verifier: string, redirectUri: string, webUrl: string, expires: number }

let pending: Pending | null = null

const b64url = (bytes: Buffer) => bytes.toString('base64url')
const live   = (): Pending | null => (pending && pending.expires > Date.now() ? pending : (pending = null))

/** Whether a Connect is waiting for its browser to come back. */
export const connecting = (): boolean => live() !== null

/** Forget the attempt, whatever it was. */
export const resetConnect = () => { pending = null }

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// ─── the share app's address ─────────────────────────────────────────────────

// Rust's `endpoint()` (`capture-core/src/share.rs`): a bare host is https, a
// path stays as a prefix, a query or fragment is dropped.
function shareBase(raw: string): string {
  const base = raw.trim().includes('://') ? raw.trim() : `https://${raw.trim()}`
  return base.split(/[?#]/)[0].replace(/\/+$/, '')
}

const encode = (v: string) => encodeURIComponent(v)

// ─── step 1: the URL to open ─────────────────────────────────────────────────

/**
 * Start an attempt and answer the share app's connect page. `port` is the one
 * this API is bound to, which only the caller knows (it is not 5501 under a
 * drive). A second call replaces the first.
 */
export function startConnect(opts: { port: number | null }, where: Where = {}): { url: string } | { refused: string } {
  const { url: saved } = shareCredentials(where)
  if (!saved) return { refused: 'Save the share server address first; Connect goes there to ask for a key.' }
  const bad = shareUrlRefusal(saved)
  if (bad) return { refused: bad }
  if (!opts.port) return { refused: 'Workbench cannot tell which port it is listening on, so the share app has nowhere to send you back.' }

  const state       = b64url(randomBytes(16))
  const verifier    = b64url(randomBytes(32))
  const redirectUri = `http://localhost:${opts.port}${CONNECTED_PATH}`
  pending = { state, verifier, redirectUri, webUrl: saved, expires: Date.now() + PENDING_MS }

  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const query = [['device', hostname()], ['redirect_uri', redirectUri], ['state', state], ['code_challenge', challenge]]
    .map(([k, v]) => `${k}=${encode(v)}`).join('&')
  return { url: `${shareBase(saved)}/connect/?${query}` }
}

// ─── step 2 and 3: the browser comes back ────────────────────────────────────

export type Landing = { status: number, message: string }

const NOT_WAITING = 'Workbench is not waiting for a connection here, so nothing was changed. Press Connect on the Capture screen to start again.'

async function exchange(p: Pending, code: string): Promise<{ key: string, email: string | null } | { error: string }> {
  const url = `${shareBase(p.webUrl)}/api/connect/exchange`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, verifier: p.verifier, redirectUri: p.redirectUri }),
      signal: AbortSignal.timeout(ASK_MS),
    })
  } catch {
    return { error: `Could not reach ${shareBase(p.webUrl)} to finish connecting.` }
  }
  const body = await res.json().catch(() => null) as { key?: unknown, email?: unknown, error?: unknown } | null
  if (res.status === 200 && body && typeof body.key === 'string' && body.key.trim()) {
    return { key: body.key, email: typeof body.email === 'string' ? body.email : null }
  }
  if (typeof body?.error === 'string' && body.error) return { error: body.error }
  return { error: `The share server did not give a key (it answered ${res.status}).` }
}

/** The browser's return. Wrong state, or no attempt, writes nothing and leaves a real attempt waiting. */
export async function landed(params: URLSearchParams, where: Where = {}): Promise<Landing> {
  const p = live()
  const state = params.get('state') ?? ''
  if (!p || !state || !same(state, p.state)) return { status: 400, message: NOT_WAITING }
  pending = null

  if (params.get('error')) {
    return { status: 200, message: params.get('error') === 'access_denied' ? 'Connecting was cancelled, so no key was saved.' : 'The share server did not approve the connection, so no key was saved.' }
  }
  const code = params.get('code') ?? ''
  if (!code) return { status: 400, message: 'The share server sent no code, so no key was saved.' }
  if (shareCredentials(where).url !== p.webUrl) return { status: 400, message: 'The share server address was changed while waiting, so no key was saved. Press Connect again.' }

  const got = await exchange(p, code)
  if ('error' in got) return { status: 400, message: got.error }
  const out = setCaptureConfig({ webKey: got.key }, where)
  if ('refused' in out) return { status: 400, message: out.refused }
  return { status: 200, message: `Connected${got.email ? ` as ${got.email}` : ''}. You can close this tab and go back to Workbench.` }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** GET CONNECTED_PATH: no session, no key in anything it answers. */
export const connectedRoute = (where: Where = {}) => async (ctx: TransportContext): Promise<Response> => {
  // `ctx.query` is parsed, and a code of digits would arrive as a number.
  const out = await landed(new URL(ctx.$raw.url).searchParams, where)
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Capture</title><body style="font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">Capture</h1><p>${esc(out.message)}</p>`
  const res = ctx.html(page, out.status)
  res.headers.set('cache-control', 'no-store')
  res.headers.set('referrer-policy', 'no-referrer')
  return res
}

// ─── test ────────────────────────────────────────────────────────────────────

export type TestResult = { ok: boolean, part: 'url' | 'key' | 'network' | null, message: string, email?: string | null }

/** Ask the share app whose key this is. Read-only, with a short timeout. */
export async function testShare(where: Where = {}): Promise<TestResult> {
  const { url, key } = shareCredentials(where)
  if (!url) return { ok: false, part: 'url', message: 'No share server address is saved; enter it and press Save.' }
  const bad = shareUrlRefusal(url)
  if (bad) return { ok: false, part: 'url', message: `The saved share server address is not usable: ${bad}.` }
  if (!key) return { ok: false, part: 'key', message: 'No key is saved; press Connect to get one.' }

  const site = shareBase(url)
  let res: Response
  try {
    res = await fetch(`${site}/api/ping`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(ASK_MS) })
  } catch {
    return { ok: false, part: 'network', message: `Could not reach ${site}; check the address and that the server is running.` }
  }
  if (res.status === 401) return { ok: false, part: 'key', message: 'The share server refused the key; press Connect to get a new one.' }

  const body = await res.json().catch(() => null) as { app?: unknown, user?: { email?: unknown } } | null
  if (res.status !== 200 || body?.app !== 'capture' || typeof body.user !== 'object' || body.user === null) {
    return { ok: false, part: 'url', message: `${site} answered, but not as the share app; check the address.` }
  }
  const email = typeof body.user.email === 'string' ? body.user.email : null
  return { ok: true, part: null, message: email ? `Connected as ${email}.` : 'Connected.', email }
}
