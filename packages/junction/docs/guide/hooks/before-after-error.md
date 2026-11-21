# Before, after and error

`before` runs ahead of the method and may refuse or reshape the call, `after` runs on what the method returned, and `error` runs when any stage threw.

```ts
import { requireRole, protect } from '@frontierjs/junction/hooks'

const app = await createTestApp({ users: [{ id: 'u1', role: 'developer' }, { id: 'u2', role: 'user' }] })
const failures: string[] = []

app.services.register(createService({
  name: 'accounts',
  async create(ctx) { return { id: 1, email: (ctx.data as any).email, passwordHash: 'x' } },
  hooks: {
    before: { create: [requireRole('developer')] },
    after:  { all: [protect('passwordHash')] },
    error:  { all: [(ctx) => { failures.push(String(ctx.error?.message)) }] },
  },
}))

const accounts = app.service('accounts')
const made = await app.runAs('u1', () => accounts.create({ email: 'a@b.test' })) as any
if ('passwordHash' in made) throw new Error('after hook did not strip the field')

await app.runAs('u2', () => accounts.create({ email: 'c@d.test' })).catch(() => {})
if (failures.length !== 1) throw new Error('error hook did not run once')
```

## What else it can do

- `protect('meta.internal')` strips a nested field with a dot path
- `requireRole` and `authenticate` refuse a call that has no principal or the wrong role
- Throw a named error such as `Forbidden` and the transport answers its status
- `rateLimitHook({ max, window })` counts per user, or per address for an anonymous caller
- `after` means after the method, not after the call succeeded: a later `after` hook that throws still fails a call whose earlier hook already acted
- `transactional: true` on the service wraps the pipeline in one transaction, so a throw rolls the write back
- A side effect that cannot be undone belongs in `ctx.afterCommit(fn)`, not in an `after` hook
- `announce(...)` as an `after` hook pushes the result to a channel

**In depth:** [README § 2. The hook pipeline — `core/hooks.ts`](../../../README.md#2-the-hook-pipeline--corehooksts)
