// test/agent-refusals.test.ts
//
// What an agent over `/mcp` may do to the person whose session it holds
// (`FJS-1795`). A real app: this package's services over a real Litestone
// client, `@frontierjs/mcp` mounted beside them, and every call made over the
// wire the way an agent makes it.
//
// Two things were wrong. Every method here was declared as a bare name, so the
// projection graded all of them `ungraded` and the boot warning named them in
// every app that mounted `/mcp`. And `api-keys_create` answered 200 to an
// agent with a fresh bearer, a credential that outlives the session the agent
// was handed.
//
// Every refusal is PAIRED with the same call over HTTP succeeding, and with the
// credential re-read afterwards: a refusal that answered 403 having already
// minted the key is the failure this exists to catch.
//
// `../../mcp/src/plugin.ts` by relative path: `workspace:*` installs a COPY, so
// the package specifier would test a stale plugin.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createApp } from '@frontierjs/junction'
import { mcpPlugin } from '../../mcp/src/plugin.ts'
import { createAuthPlugin } from '../plugin.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'

const PW = 'pw-agent-1'

let h:     Harness
let app:   any
let base:  string
let seq    = 0
const warnings: string[] = []

beforeAll(async () => {
  h   = await makeAuth({ encryptionKey: TEST_KEY })
  app = createApp({
    db:       h.db,
    auth:     h.auth as any,
    config:   { port: 0, services: { dir: '/nonexistent' } },
    logLevel: 'silent',
  } as never)
  app.configure(createAuthPlugin(h.auth, {
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
  }))
  app.configure(mcpPlugin({ name: 'agent-refusals' }))
  // The boot warning goes to `console.warn` on an app with no `log`.
  const warn = console.warn
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')) }
  try { await app.start() } finally { console.warn = warn }
  base = `http://localhost:${app.http.port}`
})
afterAll(async () => { await app?.stop?.(); h?.cleanup() })

async function person() {
  const email = `agent-${Date.now()}-${seq++}@example.com`
  const { userId } = await h.auth.createUser({ email, password: PW })
  const { token }  = await h.auth.login(email, PW) as { token: string }
  return { email, userId, token }
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method:  'POST',
    headers: {
      'content-type': 'application/json',
      accept:         'application/json, text/event-stream',
      authorization:  `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return await res.json() as { result?: any; error?: any }
}

const call = async (token: string, name: string, args: Record<string, unknown>) =>
  (await rpc(token, 'tools/call', { name, arguments: args })).result as
    { isError?: boolean; content: Array<{ text: string }> }

const http = (token: string, path: string, init: { method: string; headers?: Record<string, string>; body?: unknown }) =>
  fetch(`${base}${path}`, {
    method:  init.method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })

const keyCount = async (userId: string) => (await h.auth.listApiKeys!(userId)).length

describe('the projection grades every method this package ships', () => {

  test('the boot names none of them as graded by nothing', () => {
    const open = warnings.find(w => w.includes('graded by nothing'))
    for (const name of ['account_', 'sessions_', 'api-keys_', 'connections_', 'account-recovery_'])
      expect(open ?? '').not.toContain(name)
  })

  test('a signed-in person is offered the reads', async () => {
    const p     = await person()
    const names = ((await rpc(p.token, 'tools/list')).result?.tools ?? []).map((t: { name: string }) => t.name)
    expect(names).toContain('sessions_find')
    expect(names).toContain('api-keys_find')
  })

  test('a stranger is offered none of them', async () => {
    const res = await fetch(`${base}/mcp`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const names = (((await res.json()) as any).result?.tools ?? []).map((t: { name: string }) => t.name)
    expect(names.filter((n: string) => /^(account|sessions|api-keys|connections|account-recovery)_/.test(n))).toEqual([])
  })
})

describe('an agent cannot change the credentials of the person it acts for', () => {

  test('api-keys_create is refused, and no key exists afterwards', async () => {
    const p   = await person()
    const res = await call(p.token, 'api-keys_create', { name: 'from-agent' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("agent's tool call")
    expect(await keyCount(p.userId)).toBe(0)
  })

  test('the same person mints the same key over HTTP', async () => {
    const p   = await person()
    const res = await http(p.token, '/api-keys', { method: 'POST', body: { name: 'from-browser' } })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { key?: string }).key).toMatch(/^fjs_/)
    expect(await keyCount(p.userId)).toBe(1)
  })

  test('sessions_revokeOthers is refused, and the other session still verifies', async () => {
    const p     = await person()
    const other = (await h.auth.login(p.email, PW) as { token: string }).token
    const res   = await call(p.token, 'sessions_revokeOthers', {})
    expect(res.isError).toBe(true)
    expect(await h.auth.verifySession(other)).not.toBeNull()
  })

  test('account_changePassword is refused before the password is read', async () => {
    const p   = await person()
    const res = await call(p.token, 'account_changePassword', { data: { currentPassword: PW, newPassword: 'pw-agent-2' } })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain("agent's tool call")
    expect(await h.auth.login(p.email, PW)).toHaveProperty('token')
  })

  test('api-keys_remove is refused, and the key still authenticates', async () => {
    const p       = await person()
    const { id, key } = await h.auth.createApiKey(p.userId, { name: 'kept' })
    const res     = await call(p.token, 'api-keys_remove', { id })
    expect(res.isError).toBe(true)
    expect(await h.auth.verifySession(key)).not.toBeNull()
  })

  test('a read still answers: sessions_find lists the caller\'s own', async () => {
    const p   = await person()
    const res = await call(p.token, 'sessions_find', {})
    expect(res.isError).toBeFalsy()
    const { data } = JSON.parse(res.content[0].text) as { data: Array<{ current: boolean }> }
    expect(data.some(r => r.current)).toBe(true)
  })
})
