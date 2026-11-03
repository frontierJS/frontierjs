/**
 * peer-dialer.test.ts -- Workbench dials Basecamp's `apps.preview` as a signed
 * peer (`FJS-D1188`, `FJS-D1604`). The stub runs the same `verifyRequest` that
 * junction's `signedRequest` runs at Basecamp's door, against the minted public
 * key, so a request it accepts is one the door accepts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'
import { verifyRequest } from '@frontierjs/toolbelt/signature'
import { wrapResult } from '@frontierjs/junction/envelope'

import { peerKeys, type PeerKeys } from '../src/peer.ts'
import { createBasecamp } from '../src/domain/peer/basecamp.ts'
import { PeerRefusal } from '../src/domain/peer/peer-call.ts'

const scratch = mkdtempSync(join(tmpdir(), 'wb-peer-'))
const KEY_ID  = 'key_peer_1'

const settings = { projectId: 'p1', app: '.', domain: 'preview.test', apiUrl: 'https://api.preview.test', serverId: null }
const open     = { action: 'open' as const, settings, branch: { slug: 'one', branch: 'wb/one', port: 5173 } }

let keys: PeerKeys
let server: ReturnType<typeof Bun.serve>
const seen: Array<{ headers: Record<string, string>, nonce: string }> = []
let refuseNext: { status: number, message: string } | null = null

beforeAll(async () => {
  keys = await peerKeys(join(scratch, 'peer.json'))
  const nonces = new Set<string>()
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch (req) {
      const url     = new URL(req.url)
      const body    = await req.text()
      const headers = Object.fromEntries(req.headers.entries())
      const verdict = await verifyRequest({
        publicKey: keys.publicKey, method: req.method, path: url.pathname, query: url.search.slice(1),
        body, headers, toleranceSeconds: 300, now: Math.floor(Date.now() / 1000),
        seenNonce: (n: string) => { if (nonces.has(n)) return true; nonces.add(n); return false },
      })
      if (!verdict.ok) return Response.json({ name: 'NotAuthenticated', message: `signature refused: ${verdict.reason}` }, { status: 401 })
      seen.push({ headers, nonce: headers['x-fjs-nonce'] })
      if (refuseNext) {
        const r = refuseNext; refuseNext = null
        return Response.json({ name: 'BadRequest', message: r.message, code: r.status }, { status: r.status })
      }
      const sent = JSON.parse(body)
      return Response.json(wrapResult({ action: sent.action, route: { ok: false, why: 'no machine named' } }, 'apps', 'preview'))
    },
  })
})

afterAll(() => { server?.stop(true); rmSync(scratch, { recursive: true, force: true }) })

const dialer = (over: { keyId?: string | null, url?: string, fetcher?: typeof fetch } = {}) => createBasecamp({
  url: over.url ?? `http://127.0.0.1:${server.port}`, keyId: over.keyId === undefined ? KEY_ID : over.keyId,
  keys: async () => keys, fetcher: over.fetcher,
})

describe('the key pair', () => {
  test('is minted once, 0600, and read back the same', async () => {
    const file = join(scratch, 'peer.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await peerKeys(file)).toEqual(keys)
  })

  test('a file that is not a pair is refused, never minted over', async () => {
    const file = join(scratch, 'bad.json')
    writeFileSync(file, '{"publicKey": 1}')
    await expect(peerKeys(file)).rejects.toThrow(/is not a key pair/)
  })
})

describe('the dialer', () => {
  test('signs the way the door verifies, naming its key and the service method', async () => {
    seen.length = 0
    const answer = await dialer().preview(open)
    expect(answer).toEqual({ action: 'open', route: { ok: false, why: 'no machine named' } })
    expect(seen).toHaveLength(1)
    expect(seen[0].headers['x-fjs-key']).toBe(KEY_ID)
    expect(seen[0].headers['x-service-method']).toBe('preview')
    expect(seen[0].headers['x-fjs-signature']).toMatch(/^v1-ed25519=/)
  })

  test('a nonce is fresh per call', async () => {
    seen.length = 0
    await dialer().preview(open)
    await dialer().preview(open)
    expect(seen).toHaveLength(2)
    expect(seen[0].nonce).not.toBe(seen[1].nonce)
  })

  test('a refusal becomes a thrown error carrying its sentence', async () => {
    refuseNext = { status: 400, message: "settings.projectId 'p1' is not a project in this workspace" }
    const err = await dialer().preview(open).catch(e => e)
    expect(err).toBeInstanceOf(PeerRefusal)
    expect(err.message).toBe("settings.projectId 'p1' is not a project in this workspace")
    expect([err.status, err.peerStatus]).toEqual([409, 400])
  })

  test('a signature the peer refuses is not answered to the page as a 401', async () => {
    const other = await peerKeys(join(scratch, 'other.json'))
    const err = await createBasecamp({ url: `http://127.0.0.1:${server.port}`, keyId: KEY_ID, keys: async () => other })
      .preview(open).catch(e => e)
    expect([err.status, err.peerStatus]).toEqual([502, 401])
    expect(err.message).toMatch(/signature refused/)
  })

  test('without BASECAMP_KEY_ID it refuses before dialing', async () => {
    let dialed = 0
    const fetcher = (async () => { dialed++; return new Response('{}') }) as unknown as typeof fetch
    const err = await dialer({ keyId: null, fetcher }).preview(open).catch(e => e)
    expect(err).toBeInstanceOf(PeerRefusal)
    expect(err.message).toMatch(/GET \/door\/peer.*"Add a peer"/)
    expect(dialed).toBe(0)
  })

  test('freeze to a Basecamp on another machine refuses before dialing', async () => {
    let dialed = 0
    const fetcher = (async () => { dialed++; return new Response('{}') }) as unknown as typeof fetch
    const remote = dialer({ url: 'https://basecamp.example.com', fetcher })
    expect(remote.local).toBe(false)
    const err = await remote.preview({ action: 'freeze', settings, branch: { path: '/x', branch: 'wb/one', appId: 'a1' } }).catch(e => e)
    expect(err.message).toMatch(/not this machine/)
    expect(dialed).toBe(0)
    expect(remote.refusal('thaw')).toBeNull()
  })
})
