# Calling as a user

`env.as(user).service(name)` calls a service with a principal bound into every call. The user goes through the same steps a request's does: the app's gate grades them, a row policy sees their id, and the scoped client queries as them.

```lite
model Lead {
  id      Int     @id
  name    String
  ownerId String?
  @@gate(2.4.4.5)
  @@allow(read, ownerId == auth().id || ownerId == null)
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

await env.system.lead.createMany({ data: [
  { id: 1, name: 'mine',   ownerId: 'u1' },
  { id: 2, name: 'theirs', ownerId: 'u2' },
] })

const ada = sessionContext({ id: 'u1', role: 'member' })
const { data } = await env.as(ada).service('leads').find()
if (data.map((l) => l.name).join() !== 'mine') throw new Error('the row policy did not see the principal')

await env.close()
```

A row policy that receives no principal filters to nothing and answers a 200, so a test with a row-owned model and no `id` on the user passes an empty list as correct. That is why the test above checks which row came back.

## What else it can do

- `sessionContext(fields)` fills the three required `SessionContext` fields and invents nothing else, since an absent standing field means "not modelled" and only `null` grades down
- `env.service(name)` calls with no principal, which is STRANGER(0), what a job or a stray fetch is
- `find(filters, opts)` takes filters bare: `find({ status: 'open' })`, and `find({ query: {...} })` is refused
- Paging goes in the options: `find({}, { directives: { limit: 10 } })`
- A custom method is `call(name, id, data)`, with `null` for an id the method does not take
- `env.as(user)` sets `ctx.user` as given and signs nothing in, so a claim a resolver reads off a request header is absent; put it on the user object
- A method on a real service caller that Junction's `CALL_OPTIONS_AT` table does not name is refused when the caller is built, because a call bound at the wrong argument runs anonymous
- `env.verifyGateLadder()` and the other executed checks work unchanged here; see [The checks a schema contains](../checks/derived-checks.md)

**In depth:** [testing README § Calling a service](../../../README.md#calling-a-service), [§ sessionContext()](../../../README.md#sessioncontext)
