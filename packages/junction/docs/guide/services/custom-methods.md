# Custom methods

A service is not limited to CRUD. Any function written on it is a method of its own, called by name and sent through the same hooks as `create` or `find`.

```ts
import { requireRole } from '@frontierjs/junction/hooks'

const app = await createTestApp({ users: [{ id: 'u1', role: 'developer' }, { id: 'u2', role: 'user' }] })

app.services.register(createService({
  name: 'servers',
  async reboot(ctx) { return { id: ctx.id, status: 'rebooting' } },
  hooks: { before: { reboot: [requireRole('developer')] } },
}))

const servers = app.service('servers') as any
const out = await app.runAs('u1', () => servers.call('reboot', 7))
if (out.status !== 'rebooting' || out.id !== 7) throw new Error('unexpected answer')

let refused = false
await app.runAs('u2', () => servers.call('reboot', 7)).catch(() => { refused = true })
if (!refused) throw new Error('the role hook did not run')
```

## What else it can do

- Over HTTP a method rides `POST /servers` with an `x-service-method: reboot` header; there is no `/servers/1/reboot` route
- Over a socket it is a `service_call` frame naming the method
- Hooks key on the method name: `before`, `after`, `error` and `around` all take `reboot`
- On a model-backed service it sits beside the generated CRUD and reads rows through `$.db`
- It starts from the model's read gate and states any higher `gate:` itself
- `read: true` marks a method that only reads, so a keyed retry runs it again
- A key named like a protected column is dropped from the answer, so a minted secret goes under another name
- The case it is written in is the case that dispatches

**In depth:** [README § The secret sauce 3, custom methods as first-class citizens](../../../README.md#3-custom-methods-as-first-class-citizens)
