# A test environment

`createTestEnv` builds a migrated database from your schema, mounts your Junction app over it, and hands back the tools to arrange rows, call as a user and see what was announced. `@frontierjs/testing` sits above Junction, so it can do what Litestone's own `createTestEnv` cannot: run the app.

```lite
model Lead {
  id    Int    @id
  name  String
  @@gate(2.4.4.5)
}
```

```js
import { createTestEnv, sessionContext } from '@frontierjs/testing'
import { createApp, createService } from '@frontierjs/junction'
import { GatePlugin } from '@frontierjs/litestone'

const gate = new GatePlugin({ getLevel: (user) => (user ? 4 : 0) })

const env = await createTestEnv({
  schema:  './schema.lite',
  plugins: [gate],
  api: ({ db }) => {
    const app = createApp({ db })
    app.services.register(createService({ name: 'leads', model: 'Lead' }))
    return app
  },
})

const user = sessionContext({ id: 'u1', role: 'member' })
const t = env.phases({ as: user })

await t.act(() => env.as(user).service('leads').create({ name: 'Ada' }))
await t.assert(async (read) => {
  if (await read.lead.count() !== 1) throw new Error('expected one lead')
})
if (env.announced('leads:created').length !== 1) throw new Error('expected one announcement')

await env.close()
```

The app is built over the env's own client, never a second one on the same file, so what a factory writes and what a service reads are the same rows. `env.as(user).service('leads')` puts the user through the whole request path except the socket.

## What else it can do

- `api:` takes an app or a function of `{ db, system, factories, schema, path, dir }`; without it you get Litestone's env unchanged
- `migrations:` builds the database from your committed migration files instead of the schema
- `env.phases({ as })` gives `arrange`, `act` and `assert`; `arrange` writes below the boundary, so it announces nothing
- `env.announced(event?)` answers what the current act announced, and `env.clearAnnounced()` is for a test not using `phases()`
- `env.http` is Junction's `request(app)`, and auth is the app's to issue
- `listen: true` binds a real port, asked for as 0, and sets `env.url` and `env.port`
- `env.close()` is async, because it stops the app's plugins first
- An app built with `createApp({ root })` reads its `junction.config.js` under test as `start()` does
- An `app.ts` that opens the database at import cannot be mounted this way; export `buildApp({ db })` as the scaffold does

**In depth:** [testing README](../../../README.md), [Testing § createTestEnv](../../../../litestone/docs/testing.md#createtestenv)
