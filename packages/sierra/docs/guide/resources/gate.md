# The gate in the browser

`resource.gate` is the model's `@@gate` levels and `resource.can(op, level)` compares a level against them, so a screen can skip a button that would be refused. It is an affordance only: the server enforces the gate whatever the page shows.

```js
if (leads.gate.delete !== 5) throw new Error('expected delete at 5')
if (leads.can('delete', userLevel)) throw new Error('a level 4 caller may not delete')
if (!leads.can('create', userLevel)) throw new Error('a level 4 caller may create')
if (leads.can('patch', userLevel) !== leads.can('update', userLevel)) throw new Error('service names work too')
```

## What else it can do

- `can()` accepts an operation (`read`, `create`, `update`, `delete`) or a service method name (`find`, `patch`)
- An unknown answer is a yes: no gate, no level, or an operation the gate does not mention
- A `SYSTEM` or `LOCKED` need is a no at every level, since no browser caller reaches either
- `session.level` is the signed-in caller's level for the second argument
- The levels are the 0 to 9 ladder from `@frontierjs/toolbelt/gate`

**In depth:** [Sierra README § Gate](../../../README.md#gate)
