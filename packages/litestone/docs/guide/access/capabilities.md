# Capabilities

A gate is a ladder, and a business app often needs a grid: which actions on which nouns. `@@capabilities` turns a model's own surface into capabilities that a caller either holds or does not.

```lite
enum InvoiceStatus { draft  issued  voided }

model Invoice {
  id     Int           @id @default(autoincrement())
  number String
  status InvoiceStatus @default(draft)

  @@gate(0)
  @@capabilities
  @@transitions(status, issue: draft -> issued, void: issued -> voided)
}
```

```js
const clerk = db.$setAuth({ id: 1, role: 'user', capabilities: ['Invoice.create', 'Invoice.issue'] })

const inv = await clerk.invoice.create({ data: { number: 'A-1' } })
await clerk.invoice.transition(inv.id, 'issue')

try { await clerk.invoice.transition(inv.id, 'void'); throw new Error('the clerk voided an invoice') } catch (e) { if (e.name !== 'AccessDeniedError') throw e }
```

A capability is never a name in a list: it refers to something the schema already declares, so a typo refers to nothing and is caught.

## What else it can do

- Bare `@@capabilities` covers create, update, delete and every named move, and `@@capabilities(all)` adds read
- `@capability` on a column makes writing that column its own capability
- A finer grant replaces the coarse one: writing a `@capability` column asks for that grant, not for `Invoice.update`
- Capabilities are ANDed with the gate, so a model that opts in usually lowers its gate to the read floor
- A move the engine makes, one marked `@system` or gated at 8 or 9, is not a capability
- `Capability[]` is a synthesized type for a role row's grant list, validated member by member
- You may only grant what you hold: a write to a grant column is refused unless every value is in the writer's own set
- A capability named by hand in a policy, as in `'Invoice.number' in auth().capabilities`, is checked against the derived set
- `db.$capabilitiesFor(principal)` answers what a caller holds

**In depth:** [Access control § Capabilities](../../access-control.md#capabilities--the-grid-a-ladder-cannot-express), [§ The identity models](../../access-control.md#the-identity-models--the-one-recipe-worth-copying)
