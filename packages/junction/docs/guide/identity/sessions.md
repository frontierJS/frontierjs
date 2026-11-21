# Sessions from a cookie

By default the transport reads a session token from a header only. Turning on cookie mode makes it read the token from a named cookie as well, on HTTP requests and on the WebSocket upgrade, which is how a browser that holds a session cookie is signed in.

```ts
const app = await createTestApp({ users: [{ id: 'u1' }, { id: 'u2' }] })
app.http.setAuthCookie('session')
app.get('/whoami', (ctx) => ctx.json({ id: ctx.user?.id ?? null }))
await app._startForTest()

const whoami = async (headers: Record<string, string>) =>
  (await app.http.fetch(new Request('http://api.test/whoami', { headers }))).json() as Promise<{ id: string | null }>

const fromCookie = await whoami({ cookie: `session=${app.tokenFor('u1')}` })
if (fromCookie.id !== 'u1') throw new Error('the cookie did not sign the caller in')

const explicit = await whoami({ cookie: `session=${app.tokenFor('u1')}`, authorization: `Bearer ${app.tokenFor('u2')}` })
if (explicit.id !== 'u2') throw new Error('the bearer token should win over the cookie')

const loggedOut = await whoami({ cookie: 'session=' })
if (loggedOut.id !== null) throw new Error('an empty cookie is not a token')
```

## What else it can do

- `config: { auth: { cookie: 'session' } }` turns it on without a call
- `auth(auth, { cookieAuth: true })` from `@frontierjs/auth` declares the cookie from its own `register()`
- `Authorization: Bearer` and `X-API-Key` win over the cookie, so acting as someone else still works from a signed-in browser
- `setAuthCookie('session', { secure: true })` reads and writes `__Host-session`, `Secure` with `Path=/`
- `@frontierjs/auth` passes `secure` in production
- Turning it on installs `csrf()` at start, since a browser attaches a cookie to a cross-site request by itself
- A changed cookie reaches an open socket by a reconnect

**In depth:** [README § Sessions from a cookie](../../../README.md#sessions-from-a-cookie)
