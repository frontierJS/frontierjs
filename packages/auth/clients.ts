// clients.ts
//
// The client registry for `/authorize` (`FJS-D1929`): a client is the URL of
// its own metadata document (CIMD), fetched through junction's bounded public
// fetch and kept no longer than the document's `max-age`. Nothing registers
// here; a client that publishes no document is not a client.
//
// The document asserts its own name, so nothing here trusts `client_name`: a
// screen shows `clientHost(clientId)`, which is the host the document was
// served from.

import { fetchPublicJson, PublicUrlError, type PublicFetchOptions } from '@frontierjs/junction/public-url'
import { ClientRefusedError } from './errors.ts'

export interface ClientDocument {
  client_id:                  string
  client_name?:               string
  client_uri?:                string
  redirect_uris:              string[]
  grant_types:                string[]
  response_types?:            string[]
  token_endpoint_auth_method: string
  [key: string]:              unknown
}

export interface ClientFetchOptions extends Omit<PublicFetchOptions, 'allowHttp'> {
  // The auth object's clock, `sys.$now()`; the cache's expiry reads it.
  now:    () => Date
  // Defaults to one registry per process.
  cache?: ClientCache
}

// ─── the cache ────────────────────────────────────────────────────────────

// An hour at most: a client that rotates its redirects is believed within the
// hour whatever `max-age` it sent.
const MAX_TTL_SEC = 3600
const MAX_ENTRIES = 256

export class ClientCache {
  readonly max: number
  // Insertion order is age order, so the first key is the oldest entry.
  private entries = new Map<string, { doc: ClientDocument, until: number }>()

  constructor(max = MAX_ENTRIES) { this.max = max }

  get(clientId: string, now: Date): ClientDocument | null {
    const hit = this.entries.get(clientId)
    if (!hit) return null
    if (hit.until <= now.getTime()) { this.entries.delete(clientId); return null }
    return hit.doc
  }

  set(clientId: string, doc: ClientDocument, maxAge: number | null, now: Date): void {
    if (maxAge === null || maxAge <= 0) return
    this.entries.delete(clientId)
    this.entries.set(clientId, { doc, until: now.getTime() + Math.min(maxAge, MAX_TTL_SEC) * 1000 })
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!)
  }

  get size(): number { return this.entries.size }
}

const shared = new ClientCache()

// ─── the fetch ────────────────────────────────────────────────────────────

/**
 * The client's metadata document, from the cache or fetched, or a
 * `ClientRefusedError` naming the client URL and the reason. A refusal is
 * never cached, so a client that fixes its document is believed on the next
 * try.
 */
export async function fetchClientDocument(clientId: string, opts: ClientFetchOptions): Promise<ClientDocument> {
  const { now, cache = shared, ...fetchOpts } = opts
  if (typeof clientId !== 'string' || !clientId) throw new ClientRefusedError(String(clientId), 'no client_id was given')

  const cached = cache.get(clientId, now())
  if (cached) return cached

  let url: URL
  try { url = new URL(clientId) } catch { throw new ClientRefusedError(clientId, 'its client_id is not a URL') }
  if (url.protocol !== 'https:') throw new ClientRefusedError(clientId, 'its client_id is not an https URL')

  let fetched
  try { fetched = await fetchPublicJson(url, { ...fetchOpts, allowHttp: false, maxHops: 0 }) }
  catch (err) {
    if (err instanceof PublicUrlError) throw new ClientRefusedError(clientId, err.message)
    throw err
  }

  const doc = gradeDocument(clientId, fetched.json)
  cache.set(clientId, doc, fetched.maxAge, now())
  return doc
}

function gradeDocument(clientId: string, json: unknown): ClientDocument {
  const refuse = (reason: string) => new ClientRefusedError(clientId, reason)
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw refuse('its metadata document is not a JSON object')
  const doc = json as Record<string, unknown>

  // A document served from one URL that names another is somebody else's
  // client wearing this URL.
  if (doc.client_id !== clientId) throw refuse('its metadata document names a different client_id')

  const redirects = doc.redirect_uris
  if (!Array.isArray(redirects) || !redirects.length || !redirects.every(r => typeof r === 'string'))
    throw refuse('its metadata document lists no redirect_uris')

  // The server metadata advertises `none` alone; a confidential client would be
  // trusted to prove a key the token endpoint never asks for.
  if (doc.token_endpoint_auth_method !== 'none')
    throw refuse(`it authenticates by ${String(doc.token_endpoint_auth_method ?? 'nothing stated')}, and only public clients (none) are accepted`)

  const grants = doc.grant_types
  if (!Array.isArray(grants) || !grants.includes('authorization_code'))
    throw refuse('its metadata document does not ask for the authorization_code grant')

  return doc as ClientDocument
}

// ─── redirects ────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function parse(raw: string): URL | null {
  try { return new URL(raw) } catch { return null }
}

function isLoopback(u: URL): boolean {
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)
}

// A redirect the consent page may post to. Anything but https or loopback http
// is an opaque origin, which `form-action` cannot name.
function isPostable(u: URL): boolean {
  return u.protocol === 'https:' || isLoopback(u)
}

/**
 * Whether `redirectUri` is one the document lists: byte-equal, or, for a
 * loopback redirect, equal in scheme, host and path with the port ignored,
 * because a native app binds whatever port is free (RFC 8252 § 7.3).
 */
export function checkRedirect(doc: ClientDocument, redirectUri: string): boolean {
  const asked = typeof redirectUri === 'string' ? parse(redirectUri) : null
  if (!asked || !isPostable(asked)) return false

  for (const listed of doc.redirect_uris) {
    const allowed = parse(listed)
    if (!allowed || !isPostable(allowed)) continue
    if (listed === redirectUri) return true
    if (isLoopback(asked) && isLoopback(allowed)
      && asked.hostname === allowed.hostname
      && asked.pathname === allowed.pathname
      && asked.search   === allowed.search
      && !asked.username && !asked.password && !asked.hash) return true
  }
  return false
}

/** Every redirect is loopback: the code goes to a program on this machine, which the page warns about. */
export function isLoopbackOnly(doc: ClientDocument): boolean {
  return doc.redirect_uris.every(r => { const u = parse(r); return !!u && isLoopback(u) })
}

/** The host a client's document is served from, which is what a screen shows instead of its self-chosen name. */
export function clientHost(clientId: string): string {
  return parse(clientId)?.host ?? clientId
}
