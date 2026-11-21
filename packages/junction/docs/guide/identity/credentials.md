# Credentials that are not a bearer token

`createApp({ credentials })` is an ordered list of verifiers the transport asks before the bearer path. Each one reads the request and answers a session, `null` for not mine, or `REFUSE` for mine and wrong.

```ts
import { createApp, REFUSE, type CredentialVerifier } from '@frontierjs/junction'

const keys = new Map([['deploy-key-1', { id: 'ci-bot', userType: 'service', authMethod: 'apiKey' as const }]])

const deployKey: CredentialVerifier = (req) => {
  const key = req.headers['x-deploy-key']
  if (!key) return null
  return keys.get(String(key)) ?? REFUSE
}

const app = createApp({ credentials: [deployKey] })
app.get('/whoami', (ctx) => ctx.json({ id: ctx.user?.id ?? null }))
await app._startForTest()

const ask = async (headers: Record<string, string>) =>
  app.http.fetch(new Request('http://api.test/whoami', { headers }))

const good = await ask({ 'x-deploy-key': 'deploy-key-1' })
if ((await good.json()).id !== 'ci-bot') throw new Error('the verifier did not sign the caller in')

const bad = await ask({ 'x-deploy-key': 'guessed' })
if (bad.status !== 401) throw new Error(`a refused credential answered ${bad.status}`)

const none = await ask({})
if ((await none.json()).id !== null) throw new Error('no credential should stay anonymous')
await app.stop()
```

## What else it can do

- A refusal is a 401 at once and never falls through to anonymous
- The 401 names the scheme the caller tried in `WWW-Authenticate`, so a refused `Authorization: Basic` is answered `Basic realm="<host>"`
- `signedRequest({ keyFor })` is the shipped verifier for a request signed with `@frontierjs/toolbelt/signature`
- A bearer token is the last entry of the list: `verifySession`, then `verifyApiKey` when that answers null
- A raw route holds `ctx.user` and no client; read through `ctx.app.db.$setAuth(ctx.user)` and grade a write with `$checkWrite`
- The schema still decides who may read and write, whatever verified the caller

**In depth:** [README § Credentials that are not a bearer token](../../../README.md#credentials-that-are-not-a-bearer-token)
