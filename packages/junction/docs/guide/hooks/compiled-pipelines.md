# Compiled pipelines

A hook can come from the service or from the app's own `app.hooks(...)`. Junction merges them once into one list per service and method, so a request pays an array lookup and nothing is merged while it runs.

```ts
import { requireRole } from '@frontierjs/junction/hooks'

const app = await createTestApp({ users: [{ id: 'u1', role: 'developer' }, { id: 'u2', role: 'user' }] })
const trail: string[] = []

app.hooks({ before: { all: [() => { trail.push('app') }] } })
app.services.register(createService({
  name: 'builds',
  async create() { return { id: 1 } },
  hooks: { before: { create: [() => { trail.push('service') }, requireRole('developer')] } },
}))
await app._startForTest()

const builds = app.service('builds')
await app.runAs('u1', () => builds.create({}))
if (trail.join(',') !== 'app,service') throw new Error(`merged order was ${trail.join(',')}`)

const refused = await app.runAs('u2', () => builds.create({})).catch(() => 'refused')
if (refused !== 'refused') throw new Error('the compiled pipeline lost the role hook')
```

## What else it can do

- Compilation happens during `app.start()`, after every plugin has registered
- `app.hooks(...)` is merged with the service's own hooks, so neither is written beside the method
- The merged list for a method is `all` followed by that method's own hooks, per stage
- The gate wraps the compiled list, so a hook an app wrote cannot run before it

**In depth:** [README § 6. Compiled hook pipelines](../../../README.md#6-compiled-hook-pipelines)
