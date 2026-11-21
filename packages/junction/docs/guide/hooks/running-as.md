# Running as somebody

A call made inside a request already runs as that caller. Work that outlives the request, such as a queued job or a scheduled sweep, has no caller, and `app.runAs` states who it acts for.

```ts
import { requireRole } from '@frontierjs/junction/hooks'

const app = await createTestApp({
  users:  [{ id: 'u1', role: 'developer' }],
  system: { id: 'system', userType: 'service', role: 'system', authMethod: 'created' },
})

app.services.register(createService({
  name: 'reports',
  async find() { return [{ who: app.principal()?.id ?? null }] },
  hooks: { before: { find: [requireRole('developer', 'system')] } },
}))

const reports = app.service('reports') as any

const nobody = await reports.find({}).catch(() => 'refused')
if (nobody !== 'refused') throw new Error('a call with no principal was served')

const asPerson = await app.runAs('u1', () => reports.find({}))
if (asPerson.data[0].who !== 'u1') throw new Error('not running as u1')

const asApp = await app.runAs(null, () => reports.find({}))
if (asApp.data[0].who !== 'system') throw new Error('not running as the app')
```

## What else it can do

- `app.runAs(userId, fn)` looks the id up again through `IAuth.sessionFor`, so a user demoted or removed since the work was queued is graded on what they hold now
- `app.runAs(null, fn)` runs as the app's own `system` principal, declared with `createApp({ system })`
- An app that declares no `system` gets `null` for it, and `runAs(null, ...)` then runs with no principal
- An id that cannot be resolved throws by name; there is no fallback to nobody or to `system`
- `fn` receives the resolved principal as its argument
- `app.principal()` answers who is in scope from code that holds no `ctx`, or `null`
- `sessionFor` proves no credential and is never wired to anything a request can name
- Caravan records `app.principal()?.id` when a job is queued and runs the handler inside `runAs`

**In depth:** [README § Running as somebody](../../../README.md#running-as-somebody)
