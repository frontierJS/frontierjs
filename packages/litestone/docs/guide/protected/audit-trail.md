# The audit trail

A `driver trail` database records who changed what. `@@trail` on a model files one entry per row written, with the before and after image and the actor, and protected fields are redacted on the way in.

```lite
database audit {
  path      "./audit/"
  driver    trail
  retention 90d
}

model Vault {
  id     Int     @id
  name   String
  apiKey String? @secret

  @@trail(audit)
  @@gate(0)
}
```

```js
const sys = db.asSystem()
await sys.vault.create({ data: { id: 7, name: 'prod', apiKey: 'sk-1' } })
await sys.vault.update({ where: { id: 7 }, data: { apiKey: 'sk-2' } })
await new Promise(r => setTimeout(r, 0))   // an entry lands one tick after its write

const entries = await sys.auditTrail.findMany({ where: { model: 'Vault', operation: 'update' } })
const text = JSON.stringify(entries)
if (/sk-[12]/.test(text) || !/\[redacted\]/.test(text) || !/prod/.test(text)) throw new Error('the secret must be redacted and the name kept')
```

The trail records that a protected field was written, by whom and when, never what it holds. A trail database synthesizes its own model, `AuditTrail`, read as `db.auditTrail` and open to `asSystem()` only.

## What else it can do

- `@@trail(audit)` logs writes, and `@@trail(audit, reads: true)` logs reads as well
- `@trail(audit)` on a field logs that field's reads and writes, with `reads: false` or `writes: false` to narrow it
- `@encrypted`, `@guarded`, `@hashed` and `@secret` log as `[redacted]`, `@personal` as `[personal]` and `@opaque` as `[opaque:<digest>]`
- `null` is kept as it is, so a secret going from `null` to set stays visible
- A single-row write carries `before` and `after` images, and a bulk write files one entry per row with the ids alone
- Every write path is logged, including `upsertMany`, `remove` and `restore`
- An entry carries `operation`, `model`, `recordId`, `field`, `transition`, `actorId`, `actorType` and `meta`
- A refused access files a `denied` entry, so a policy that filtered to nothing can be told from a real miss
- `onLog(entry, ctx)` overrides the actor and adds `meta`, and `logContext` supplies `ip`, `userAgent` and `correlationId`
- The history of one record is a plain `where: { model, recordId }`, and a `$raw` predicate is refused
- A reader that is not the system is declared on the host's own `AuditTrail` model with its own gate and policy
- `retention 90d` prunes on startup, and `db.asSystem().$retain()` runs the same pass on demand
- `@@anonymous` refuses a trail, or a writer stamp, on rows nobody may attribute
- `db.$audit()` records an event that is not a write

**In depth:** [Trail](../../trail.md), [§ Protected fields are redacted](../../trail.md#protected-fields-are-redacted), [§ Personal data](../../trail.md#personal-data--personal-and-person), [§ onLog](../../trail.md#onlog--enrich-log-entries), [§ Retention](../../trail.md#retention), [Guide: Audit Trail](../../guides/audit-trail.md)
