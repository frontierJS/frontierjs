# Transport parity

A service is reachable two ways, HTTP and WebSocket, and the two paths share almost nothing. `verifyTransportParity` puts the same call down both over a real socket and compares the answers, so a filter, a directive or a refusal that one transport handles differently shows up as a row.

```lite
model Lead {
  id   Int    @id
  name String
  @@gate(2.4.4.5)
}
```

```js
import { createTestEnv } from '@frontierjs/testing'
import { createApp, createService, channels } from '@frontierjs/junction'
import { GatePlugin } from '@frontierjs/litestone'

const gate = new GatePlugin({ getLevel: (user) => (user ? 4 : 0) })
const member = { id: 'u1', userType: 'user', authMethod: 'session', role: 'member' }
const auth = {
  async verifySession(token) { return token === 'tok-member' ? member : null },
  async login() { return { token: '', user: null } },
  async logout() {},
  async createUser() { return {} },
  async deleteUser() {},
  async createApiKey(id) { return { key: id, id } },
  async revokeApiKey() {},
  async verifyApiKey() { return null },
}

const env = await createTestEnv({
  schema:  './schema.lite',
  plugins: [gate],
  listen:  true,
  api: ({ db }) => {
    const app = createApp({ db, auth })
    app.services.register(createService({ name: 'leads', model: 'Lead' }))
    app.configure(channels())
    return app
  },
})

const found = await env.verifyTransportParity({
  as: [{ label: 'member', token: 'tok-member' }, { label: 'anonymous' }],
})
if (found.length) throw new Error(JSON.stringify(found))

await env.close()
```

An empty array means the two transports agreed on every call. A mismatch names both answers, such as `HTTP answered and WS refused with 400`, and says which one it believes nothing about: neither transport is treated as right.

## What else it can do

- Calls default to every CRUD method of every service registered with a `model:`, with fixtures derived from the schema, plus a `$limit`-bearing `find`
- `calls:` names a custom method or a narrower run, and `only:` names services
- `as:` is a list of principals, each a label and a bearer token, or none for anonymous
- Your app must `configure(channels())`; without it the client falls back to HTTP, and the runner reports an unconnected socket as a row rather than compare HTTP against itself
- It needs `listen: true`, which asks for port 0 so parallel suites cannot collide; `listen: 8110` binds a stated one
- A value that differs is measured across two HTTP calls first, so something moving with the clock is not reported as a mismatch

**In depth:** [testing README § Transport parity](../../../README.md#transport-parity)
