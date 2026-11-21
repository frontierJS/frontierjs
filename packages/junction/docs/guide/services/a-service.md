# A service

A service is a named set of methods the API answers. Over a model, `createService` generates `find`, `get`, `create`, `patch` and `remove` from the schema, so a service file can be one line.

```ts
import { createClient } from '@frontierjs/litestone'

const db  = await createClient({ db: ':memory:', schema: 'model Post { id Int @id  title String @length(1, 200) }' })
const app = createApp({ db })
app.services.register(createService({ name: 'posts' }))

const post = await app.service('posts').create({ title: 'Hello' })
const page = await app.service('posts').find({})
if (page.data.length !== 1 || page.data[0].id !== post.id) throw new Error('unexpected rows')
```

## What else it can do

- `model: 'Post'` names the model when the service name does not resolve to it (`posts` finds `db.post`)
- `schema:` takes a JSON Schema and validates `create` and `patch` from it
- `softDelete: 'deletedAt'` turns `remove` into a timestamp
- `paginate: { default, max }` sets the page size of `find`
- `allowBulk` and `bulkMax` permit and bound a filtered `patch` or `remove`
- `hooks: { before, after, error }` run around each method
- `GET`, `POST`, `PUT`, `PATCH` and `DELETE` on `/posts` are mounted with no route written
- `HEAD` runs the `GET` route, `OPTIONS` answers `204`, and a verb a path has no route for is `405`, each with `Allow`

**In depth:** [README § Litestone ORM](../../../README.md#litestone-orm), [§ Methods the transport answers for you](../../../README.md#methods-the-transport-answers-for-you)
