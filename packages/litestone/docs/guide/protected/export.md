# Bulk export

`@@export` declares that a model may leave in bulk, as ndjson or csv. It adds no way in: an export is a paginated read as a named principal, so the gate, row policies and tenancy already shape the file.

```lite
model User { id Int @id  isStaff Boolean @default(false)  @@auth  @@gate(0) }

model Order {
  id        Int      @id @default(autoincrement())
  ownerId   Int
  total     Int
  cardToken String?  @secret
  updatedAt DateTime @updatedAt

  @@gate(0)
  @@allow(read, auth().isStaff || ownerId == auth().id)
  @@export(ndjson, since: updatedAt)
}
```

```js
import { runExport } from '@frontierjs/litestone/export'

const sys = db.asSystem()
await sys.user.createMany({ data: [{ id: 1 }, { id: 2 }] })
await sys.order.createMany({ data: [{ ownerId: 1, total: 10, cardToken: 'c1' }, { ownerId: 2, total: 20 }] })

const lines = []
const manifest = await runExport(db, 'Order', { as: { id: 1 }, write: line => lines.push(line) })

if (lines.length !== 1 || JSON.parse(lines[0]).total !== 10) throw new Error('the extract is the rows this account can read')
if (lines[0].includes('cardToken') || !manifest.omitted.some(o => o.name === 'cardToken')) throw new Error('a protected column is omitted and named in the manifest')
```

From a shell the same run is `litestone export Order --as alice@example.com`, or `fli db:export Order --as alice@example.com`.

## What else it can do

- `@@export(csv)` or `ndjson`, and `since: <column>` names the cursor a later run resumes from
- `@@export` needs a `@@gate` beside it, and `@@gate(0)` says public on purpose
- A row policy narrows the file, a field policy or `@guarded` removes the column, and tenancy makes it one tenant's
- `@encrypted`, `@secret` and `@guarded` columns are omitted even for a caller who may read them, unless `--include-protected`
- A `createdAt` cursor sees new rows only, and `@updatedAt` also sees edits
- `--as` names an account in the `@@auth` model, and `--system` is the explicit escape that reads everything
- `--gate` grades with the app's own `getLevel`, and `--tenant` picks a tenant under database tenancy
- `--out`, `--stdout`, `--format` and `--with-deleted` shape the output
- A csv cell that starts like a formula is written with a leading `'`
- Every run writes `<dataset>.manifest.json`, naming the policies applied and the columns omitted
- Every run also files an `export` entry in the audit trail
- Junction's `exporter()` serves the same run over HTTP as the calling session

**In depth:** [Bulk export](../../export.md), [§ A @@gate is required beside it](../../export.md#a-gate-is-required-beside-it), [§ The manifest](../../export.md#the-manifest), [§ Over HTTP](../../export.md#over-http)
