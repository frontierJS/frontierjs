# Declaring the surface

A model service answers every CRUD verb whether or not its file mentions one. `methods:` is the one key that states what it offers, so a read-only service is read-only on every transport.

```ts
import { createClient } from '@frontierjs/litestone'

const db  = await createClient({ db: ':memory:', schema: 'model AuditEvent { id Int @id  note String }' })
const app = createApp({ db })

app.services.register(createService({ name: 'audit', model: 'AuditEvent', methods: 'readOnly' }))

const audit = app.service('audit')
const page  = await audit.find({})
if (page.data.length !== 0) throw new Error('expected an empty trail')

let status = 0
await audit.create({ note: 'forged' }).catch(e => { status = e.status ?? e.code })
if (status !== 405) throw new Error(`expected 405, got ${status}`)
```

## What else it can do

- `methods: ['find', 'get']` is what `'readOnly'` spells; omitted means everything
- The list holds custom methods too: `['find', 'create', 'approve']`
- A listed custom method is declared, so it may be named `cache` or `schema` where an option already owns the word
- `{ method: 'pushed', transports: ['internal'] }` offers a method to in-process callers and refuses HTTP, the socket and MCP
- `{ method: 'draft', stream: true }` marks an `async *draft(ctx)` that answers in frames
- An unlisted method is `405` for a request, a job and `app.service(...)` alike, before any hook runs
- A name the service does not have throws when the service is built
- `/manifest`, `/metrics` and the OpenAPI spec list only what the service offers

**In depth:** [README § `methods:` — the surface, declared](../../../README.md#methods--the-surface-declared)
