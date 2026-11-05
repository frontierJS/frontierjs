// test/fixture/panva.ts — panva's `oidc-provider` in-process, then the drive.
//
// `bun test/fixture/panva.ts` starts a certified provider on an ephemeral port
// with one client (`drive:drive-secret`, client_secret_basic, PKCE required),
// walks its dev login and consent pages WITHOUT a browser — three form posts
// with a cookie jar — to come away with an authorization code, and runs the
// drive with FIXTURE_URL, FIXTURE_CLIENT, FIXTURE_CODE and FIXTURE_VERIFIER
// pointing at it. The discovery, JWKS, code exchange, id_token, refresh and
// userinfo rows then run against an implementation this connector did not
// write. A code is single use, so the fixture rows run once per start.
//
// `oidc-provider` warns that Bun is an unsupported runtime; it has served
// these rows regardless. Bun.serve takes no Koa callback, so the provider
// listens through node:http, which Bun implements.

import { createServer } from 'node:http'
import Provider from 'oidc-provider'
import { pkce } from '../../src/index.ts'

const CLIENT_ID = 'drive', CLIENT_SECRET = 'drive-secret', REDIRECT = 'http://app.test/callback'

const server = createServer()
await new Promise<void>(resolve => server.listen(Number(process.env.FIXTURE_PORT ?? 0), '127.0.0.1', resolve))
const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const provider = new Provider(issuer, {
  clients: [{
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'client_secret_basic',
  }],
  pkce:     { required: () => true },
  scopes:   ['openid', 'offline_access'],
  features: { devInteractions: { enabled: true } },
})
// Local http, no TLS: the provider refuses a plain-http issuer otherwise.
provider.proxy = true
server.on('request', provider.callback())

// ─── the login, by hand ────────────────────────────────────────────────────
const jar: Record<string, string> = {}
const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
const step = async (url: string | URL, init: RequestInit = {}) => {
  const res = await fetch(new URL(url, issuer), { redirect: 'manual', ...init, headers: { cookie: cookie(), ...(init.headers ?? {}) } })
  for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); jar[k] = v }
  return res
}
const post = (url: string, body: string) => step(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
const next = (res: Response) => res.headers.get('location') ?? ''

const p    = await pkce()
const auth = new URL(`${issuer}/auth`)
for (const [k, v] of Object.entries({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: 'openid offline_access', state: 'st', nonce: 'fixture-nonce', code_challenge: p.challenge, code_challenge_method: 'S256', prompt: 'consent' }))
  auth.searchParams.set(k, v)

let res = await step(auth)                                         // → /interaction/:uid (login)
let uid = next(res).split('/').pop()!
await step(`/interaction/${uid}`)
res = await step(next(await post(`/interaction/${uid}`, 'prompt=login&login=alice&password=x')))   // resume → consent
uid = next(res).split('/').pop()!
await step(`/interaction/${uid}`)
res = await step(next(await post(`/interaction/${uid}`, 'prompt=consent')))                        // resume → redirect_uri
const callback = new URL(next(res))
const code = callback.searchParams.get('code')
if (!code) { console.error(`[panva] no code on the callback: ${callback}`); process.exit(2) }
console.log(`[panva] ${issuer}  client ${CLIENT_ID}:${CLIENT_SECRET}  code obtained`)

const drive = Bun.spawn(['bun', 'test/oidc.drive.ts'], {
  cwd: new URL('../..', import.meta.url).pathname,
  env: { ...process.env, FIXTURE_URL: issuer, FIXTURE_CLIENT: `${CLIENT_ID}:${CLIENT_SECRET}`, FIXTURE_CODE: code, FIXTURE_VERIFIER: p.verifier, FIXTURE_REDIRECT: REDIRECT, FIXTURE_NONCE: 'fixture-nonce' },
  stdout: 'inherit', stderr: 'inherit',
})
const exit = await drive.exited
server.close()
process.exit(exit)
