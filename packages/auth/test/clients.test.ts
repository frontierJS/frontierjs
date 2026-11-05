// test/clients.test.ts
//
// The client registry (`FJS-D1929`): the two documents Claude publishes,
// verbatim from the plan's step 0.1, served by a stub `fetch` handed through
// `fetchPublicJson`'s own option. `allowPrivate` skips the DNS lookup, which
// would otherwise reach the network for claude.ai; the address guard itself
// is junction's and graded in its public-fetch suite.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fetchClientDocument, checkRedirect, isLoopbackOnly, clientHost, ClientCache, type ClientDocument,
} from '../clients.ts'
import { ClientRefusedError } from '../errors.ts'
import { rejectsWith } from './harness.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures/cimd', name), 'utf8')
const CLAUDE_AI   = fixture('claude-ai.json')
const CLAUDE_CODE = fixture('claude-code.json')
const AI_ID       = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const CODE_ID     = 'https://claude.ai/oauth/claude-code-client-metadata'

/** A stub server: URL → body, every answer `max-age` seconds fresh. Counts fetches. */
function serve(docs: Record<string, string>, maxAge: number | null = 300) {
  const seen: string[] = []
  const fetch = (async (url: string) => {
    seen.push(String(url))
    const body = docs[String(url)]
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(body, { headers: {
      'content-type': 'application/json',
      ...(maxAge === null ? {} : { 'cache-control': `public, max-age=${maxAge}` }),
    } })
  }) as unknown as typeof globalThis.fetch
  return { fetch, seen }
}

function clock(start = new Date('2026-11-05T12:00:00Z')) {
  let t = start.getTime()
  return { now: () => new Date(t), advance: (sec: number) => { t += sec * 1000 } }
}

function opts(server: ReturnType<typeof serve>, c = clock(), cache = new ClientCache()) {
  return { fetch: server.fetch, allowPrivate: true, now: c.now, cache }
}

describe('fetchClientDocument', () => {
  test('accepts both of Claude\'s documents', async () => {
    const s = serve({ [AI_ID]: CLAUDE_AI, [CODE_ID]: CLAUDE_CODE })
    const ai   = await fetchClientDocument(AI_ID, opts(s))
    const code = await fetchClientDocument(CODE_ID, opts(s))
    expect(ai).toEqual(JSON.parse(CLAUDE_AI))
    expect(code).toEqual(JSON.parse(CLAUDE_CODE))
  })

  test('refuses a document whose own client_id is not the URL fetched', async () => {
    const id = 'https://claude.ai/oauth/other'
    const s  = serve({ [id]: CLAUDE_AI })
    const err = await rejectsWith(() => fetchClientDocument(id, opts(s)), ClientRefusedError)
    expect(err.status).toBe(400)
    expect(err.message).toContain(id)
    expect(err.message).toContain('different client_id')
  })

  test('refuses an http client_id without fetching it', async () => {
    const id  = 'http://claude.ai/oauth/mcp-oauth-client-metadata'
    const s   = serve({ [id]: CLAUDE_AI.replace(AI_ID, id) })
    const err = await rejectsWith(() => fetchClientDocument(id, opts(s)), ClientRefusedError)
    expect(err.message).toContain('https')
    expect(s.seen).toEqual([])
  })

  test('refuses the confidential twin', async () => {
    const id   = `${AI_ID}/confidential_client`
    const twin = { ...JSON.parse(CLAUDE_AI), client_id: id, token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'https://claude.ai/v1/mcp/jwks' }
    const s    = serve({ [id]: JSON.stringify(twin) })
    const err  = await rejectsWith(() => fetchClientDocument(id, opts(s)), ClientRefusedError)
    expect(err.message).toContain('private_key_jwt')
  })

  test('refuses a document without redirect_uris or the authorization_code grant', async () => {
    const noRedirects = serve({ [AI_ID]: JSON.stringify({ ...JSON.parse(CLAUDE_AI), redirect_uris: [] }) })
    expect((await rejectsWith(() => fetchClientDocument(AI_ID, opts(noRedirects)), ClientRefusedError)).message).toContain('redirect_uris')
    const noGrant = serve({ [AI_ID]: JSON.stringify({ ...JSON.parse(CLAUDE_AI), grant_types: ['refresh_token'] }) })
    expect((await rejectsWith(() => fetchClientDocument(AI_ID, opts(noGrant)), ClientRefusedError)).message).toContain('authorization_code')
  })

  test('a fetch the helper refuses is the same refusal, naming the client', async () => {
    const s   = serve({})
    const err = await rejectsWith(() => fetchClientDocument(AI_ID, opts(s)), ClientRefusedError)
    expect(err.message).toContain(AI_ID)
    expect(err.message).toContain('404')
  })

  test('refuses a document behind a redirect, without following it', async () => {
    const moved = 'https://claude.ai/oauth/moved'
    const seen: string[] = []
    const fetch = (async (url: string) => {
      seen.push(String(url))
      return String(url) === AI_ID
        ? new Response(null, { status: 302, headers: { location: moved } })
        : new Response(CLAUDE_AI, { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof globalThis.fetch
    const err = await rejectsWith(() => fetchClientDocument(AI_ID, { fetch, allowPrivate: true, now: clock().now, cache: new ClientCache() }), ClientRefusedError)
    expect(err.message).toContain('redirected')
    expect(seen).toEqual([AI_ID])
  })
})

describe('the cache', () => {
  test('serves a second call without a fetch, and refetches after max-age', async () => {
    const s = serve({ [AI_ID]: CLAUDE_AI }, 300)
    const c = clock()
    const o = opts(s, c)
    await fetchClientDocument(AI_ID, o)
    await fetchClientDocument(AI_ID, o)
    expect(s.seen.length).toBe(1)
    c.advance(299)
    await fetchClientDocument(AI_ID, o)
    expect(s.seen.length).toBe(1)
    c.advance(2)
    await fetchClientDocument(AI_ID, o)
    expect(s.seen.length).toBe(2)
  })

  test('caps a long max-age at one hour', async () => {
    const s = serve({ [AI_ID]: CLAUDE_AI }, 86_400)
    const c = clock()
    const o = opts(s, c)
    await fetchClientDocument(AI_ID, o)
    c.advance(3601)
    await fetchClientDocument(AI_ID, o)
    expect(s.seen.length).toBe(2)
  })

  test('keeps nothing when the document sent no max-age', async () => {
    const s = serve({ [AI_ID]: CLAUDE_AI }, null)
    const o = opts(s)
    await fetchClientDocument(AI_ID, o)
    await fetchClientDocument(AI_ID, o)
    expect(s.seen.length).toBe(2)
  })

  test('never keeps a refusal', async () => {
    const docs: Record<string, string> = { [AI_ID]: CLAUDE_AI.replace('"none"', '"client_secret_basic"') }
    const s = serve(docs)
    const o = opts(s)
    await rejectsWith(() => fetchClientDocument(AI_ID, o), ClientRefusedError)
    docs[AI_ID] = CLAUDE_AI
    expect((await fetchClientDocument(AI_ID, o)).client_id).toBe(AI_ID)
    expect(s.seen.length).toBe(2)
  })

  test('holds at most its maximum, evicting the oldest', () => {
    const cache = new ClientCache(2)
    const now   = new Date()
    const doc   = JSON.parse(CLAUDE_AI) as ClientDocument
    cache.set('a', doc, 60, now)
    cache.set('b', doc, 60, now)
    cache.set('c', doc, 60, now)
    expect(cache.size).toBe(2)
    expect(cache.get('a', now)).toBeNull()
    expect(cache.get('c', now)).toBe(doc)
  })
})

describe('checkRedirect', () => {
  const ai   = JSON.parse(CLAUDE_AI) as ClientDocument
  const code = JSON.parse(CLAUDE_CODE) as ClientDocument

  test('a loopback redirect matches on any port, on both hosts', () => {
    expect(checkRedirect(code, 'http://localhost:51234/callback')).toBe(true)
    expect(checkRedirect(code, 'http://127.0.0.1:9/callback')).toBe(true)
    expect(checkRedirect(code, 'http://localhost/callback')).toBe(true)
  })

  test('a loopback redirect on another path is refused', () => {
    expect(checkRedirect(code, 'http://localhost/other')).toBe(false)
    expect(checkRedirect(code, 'https://localhost/callback')).toBe(false)
  })

  test('an https redirect matches exactly and not over http', () => {
    expect(checkRedirect(ai, 'https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(checkRedirect(ai, 'http://claude.ai/api/mcp/auth_callback')).toBe(false)
    expect(checkRedirect(ai, 'https://claude.ai/api/mcp/auth_callback/')).toBe(false)
    expect(checkRedirect(ai, 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(false)
  })

  test('a listed redirect that is neither https nor loopback http is refused', () => {
    const doc = { ...ai, redirect_uris: ['ftp://claude.ai/cb', 'http://claude.ai/cb', 'myapp://cb'] }
    expect(checkRedirect(doc, 'ftp://claude.ai/cb')).toBe(false)
    expect(checkRedirect(doc, 'http://claude.ai/cb')).toBe(false)
    expect(checkRedirect(doc, 'myapp://cb')).toBe(false)
  })

  test('isLoopbackOnly is the Claude Code document and not claude.ai', () => {
    expect(isLoopbackOnly(code)).toBe(true)
    expect(isLoopbackOnly(ai)).toBe(false)
  })
})

describe('clientHost', () => {
  test('is the host the document came from, whatever it calls itself', async () => {
    const id  = 'https://evil.example/claude'
    const s   = serve({ [id]: JSON.stringify({ ...JSON.parse(CLAUDE_AI), client_id: id, client_name: 'Claude' }) })
    const doc = await fetchClientDocument(id, opts(s))
    expect(doc.client_name).toBe('Claude')
    expect(clientHost(doc.client_id)).toBe('evil.example')
    expect(clientHost(AI_ID)).toBe('claude.ai')
  })
})
