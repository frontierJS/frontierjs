# The browser client

`@frontierjs/junction/client` is a zero-dependency client for a browser app, Sierra or any other, that talks to a Junction API. It reads the same services the server declares, over HTTP and the socket.

```ts
import { createJunctionClient } from '@frontierjs/junction/client'

app.services.register(createService({
  name: 'posts',
  async find() { return [{ id: 1, title: 'Hello' }] },
}))

const client = createJunctionClient({ url: 'http://localhost:3000' })

const rows = await client.service('posts').findData()
if (rows[0].title !== 'Hello') throw new Error('the client did not read the service')
```

## What else it can do

- `client.service(name)` has the service's methods: `find`, `get`, `create`, `patch`, `remove` and any custom method
- `findData()` answers the rows, and `find()` answers the envelope with `total`, `limit` and `offset`
- `tokenStorage: localTokenStore('my_app_token')` keeps the token between page loads
- `client.setToken(token)` sets a token and opens, or cycles, the socket; `client.connect()` opens it as an anonymous caller
- `client.auth` signs up and in, reads `me()` and `sessions()`, and manages keys, password resets and magic links
- `client.setSocketQuery({ room: 'tavern' })` states what the upgrade asks for, kept across a reconnect
- `litestone types --audience client --augment junction` generates row types, and a service name then types itself with no call site restating it
- `@guarded` and `@secret` columns are stripped from the client's types, as they are from every response

**In depth:** [README § Browser client](../../../README.md#browser-client), [§ Typed from the schema](../../../README.md#typed-from-the-schema)
