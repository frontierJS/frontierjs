# Audit Logging

Litestone provides field-level and model-level audit logging via the `trail` database driver. Every write produces a structured log entry with before/after images, actor attribution, and optional custom metadata.

## Setup

Declare a trail database in your schema:

```lite
database audit {
  path      "./audit/"
  driver    trail
  retention 90d          // prune entries older than 90 days on startup
}
```

## Model-level logging — @@trail

Log every write (create, update, delete) on a model:

```lite
database audit { path "./audit/"  driver trail }

model User {
  id    Int @id
  email String
  name  String?
  @@trail(audit)
}
```

Every `create`, `update`, and `delete` on `User` produces an entry in the audit trail database. Reads do not, unless the model says `@@trail(audit, reads: true)`.

## Field-level logging — @trail

Log reads and writes of a specific sensitive field:

```lite
database audit { path "./audit/"  driver trail }

model User {
  id     Int     @id
  salary Float?  @trail(audit)                // reads and writes
  apiKey String? @secret                      // implies @trail(audit, reads: false) — writes only
  note   String? @trail(audit, writes: false) // reads only
}
```

A field-level `@trail(audit)` logs reads AND writes by default — the field was singled out, so a read of it is the point. A model-level `@@trail` and the one `@secret` implies log writes only.

## Log entry shape

```js
const sys = db.asSystem()
await sys.user.create({ data: { id: 1, salary: 50000 } })
await sys.user.update({ where: { id: 1 }, data: { salary: 75000 } })
await new Promise(r => setTimeout(r, 0))   // an entry lands one event-loop tick after its write

const [entry] = await sys.auditTrail.findMany({ where: { operation: 'update', field: 'salary' } })
// {
//   operation:  'update',             // create | update | delete | read
//   model:      'user',               // the accessor spelling (FJS-2380)
//   field:      'salary',             // only for @trail field-level entries; null on a model-level one
//   transition: null,                 // the named @@transitions move, where an update was one
//   records:    [1],                  // the affected IDs
//   before:     50000,                // a field entry carries the one value; a model entry the row image
//   after:      75000,
//   actorId:    'user_abc',  actorType: 'user',  subjectId: null,  episodeId: null,
//   correlationId, source, origin, ip, userAgent, tenant,   // where the write came from — see onLog
//   meta:       { requestId: 'req_xyz' },
//   createdAt:  '2026-01-15T10:30:00.000Z',
// }
if (entry?.model !== 'user' || !/\b1\b/.test(JSON.stringify(entry.records))) throw new Error(`unexpected entry ${JSON.stringify(entry)}`)
```

The entry's `records`, `before`, `after` and `meta` are declared `Json`, and a trail read through the jsonl reader hands them back as JSON STRINGS (`"[1]"`, `"{\"salary\":50000}"`) rather than decoding them; a model declared in a jsonl database decodes its own `Json` columns, so this is the trail reader's and not the format's.

`before`/`after` images are only included for single-row writes — `update()`, `delete()` and `remove()`. A bulk write records **which** rows it touched and **what** it did to them, never their contents:

```lite
database audit { path "./audit/"  driver trail }

model Widget {
  id    Int    @id
  state String
  @@trail(audit)
}
```

```js
const sys = db.asSystem()
await sys.widget.createMany({ data: [{ id: 1, state: 'draft' }, { id: 2, state: 'draft' }, { id: 3, state: 'draft' }] })
await sys.widget.updateMany({ where: { state: 'draft' }, data: { state: 'live' } })
await new Promise(r => setTimeout(r, 0))

const [entry] = await sys.auditTrail.findMany({ where: { model: 'widget', operation: 'update' } })
// { operation: 'update', model: 'widget', records: [1, 2, 3], before: null, after: null, ... }
if (entry.before !== null || entry.after !== null || !/1,2,3/.test(JSON.stringify(entry.records))) throw new Error('a bulk write logs ids and no images')
```

Every write path reaches the trail: `create`, `createMany`, `update`, `updateMany`, `upsert`, `upsertMany`, `remove`, `removeMany`, `delete`, `deleteMany` and `restore`. A bulk op on a logged model takes a `RETURNING` path so the entry can name the rows by id — an autoincrement id does not exist until SQLite assigns one — and `upsertMany` splits its batch into a `create` entry and an `update` entry, because it did both. `restore` logs as `update`: a restored row changed state, it was not created.

An unlogged model pays none of this — the `RETURNING` path is taken only when the model declares `@trail` / `@@trail`.

## Protected fields are redacted

The audit trail records **that** a protected field was written — by whom, to which rows, when — never what it holds. Any field carrying `@encrypted`, `@guarded`, `@hashed`, or `@secret` (which implies the first two) has its value replaced with `'[redacted]'` in every log entry, in both the field-level entry and the model-level `before`/`after` snapshot:

```lite
database audit { path "./audit/"  driver trail }

model Vault {
  id      Int     @id
  name    String
  apiKey  String? @secret
  @@trail(audit)
}
```

```js
const sys = db.asSystem()
await sys.vault.create({ data: { id: 7, name: 'prod', apiKey: 'sk-1' } })
await sys.vault.update({ where: { id: 7 }, data: { apiKey: 'sk-2' } })
await new Promise(r => setTimeout(r, 0))

const entries = await sys.auditTrail.findMany({ where: { model: 'vault', operation: 'update' } })
// { operation: 'update', model: 'vault', field: 'apiKey',
//   records: [7], before: '[redacted]', after: '[redacted]', actorId: 'user_abc', ... }

// model-level image — name is logged, apiKey is not
// { operation: 'update', model: 'vault', field: null, records: [7],
//   before: { id: 7, name: 'prod', apiKey: '[redacted]' },
//   after:  { id: 7, name: 'prod', apiKey: '[redacted]' }, ... }
const text = JSON.stringify(entries)
if (/sk-[12]/.test(text) || !/\[redacted\]/.test(text) || !/prod/.test(text)) throw new Error('the secret must be redacted and the name kept')
```

This is what makes `@secret`'s expansion safe. `@secret` is `@encrypted + @guarded + @trail(<first trail db>)`, so **declaring a trail database is on its own enough to start logging every `@secret` field in the schema** — without redaction that would write plaintext to a file sitting next to a correctly-encrypted database row, with none of the column's read protections.

Two details worth knowing:

- **`null` is preserved, not redacted.** It holds nothing to leak, and keeping it means a `null → value` transition stays visible: `before: null, after: '[redacted]'` tells you a secret was set without telling you what it is.
- **Unprotected fields on the same model are logged in full.** Redaction is per-field, not per-model, so the trail stays useful.

The value returned to the caller is never affected — redaction happens on the way to the log, on a copy.

## Personal data — @personal and @@person

A column about a person is `@personal`, optionally with a category. A reader the gate admits still sees it; the trail does not keep it, because the trail outlives the row and an erased person's email would otherwise stay in every before- and after-image. It logs as `'[personal]'`, so an entry still says which kind of value was dropped:

```lite
database audit { path "./audit/"  driver trail }

model Candidate {
  id          Int     @id
  email       String  @personal(contact)
  coverLetter String? @personal
  stage       String
  @@person
  @@trail(audit)
}
```

```js
const sys = db.asSystem()
await sys.candidate.create({ data: { id: 3, email: 'c@example.com', coverLetter: 'Dear…', stage: 'new' } })
await sys.candidate.update({ where: { id: 3 }, data: { stage: 'interview' } })
await new Promise(r => setTimeout(r, 0))

const [entry] = await sys.auditTrail.findMany({ where: { model: 'candidate', operation: 'update' } })
// { operation: 'update', model: 'candidate', field: null, records: [3],
//   after: { id: 3, email: '[personal]', coverLetter: '[personal]', stage: 'interview' }, ... }
const after = JSON.stringify(entry.after)
if (/c@example/.test(after) || !/\[personal\]/.test(after) || !/interview/.test(after)) throw new Error('personal data is dropped, the rest kept')
```

- **The category is a closed list**, refused by name: `contact`, `device`, `location`, `government`, `financial`, `employment`, `communication`, `demographic`, `health`, `genetic`, `biometric`, `characteristic`, `criminal`. It changes no enforcement; it is what a data map groups by, and which categories GDPR Art. 9/10 or the CPRA treat as special is one framework table (`PERSONAL_CATEGORIES`), not something an app restates.
- **`@@person` says every row is a person.** An `@@auth` model is one without saying so. `@@person(child)` says every row is a child in the legal sense — a status, never an age.
- **On a person model, a column named like personal data** (`email`, `phone`, `firstName`, `dob`, …) with no `@personal` is a parse warning naming the category to add. Nothing warns on another model, so `Company.email` stays quiet.
- **A column that is both protected and personal logs as `'[redacted]'`.**
- **`@personal` does not imply `@omit`.** Who may read the column is the gate's question (`FJS-D205`); a recruiter has to see a candidate's email.

## onLog — enrich log entries

`actorId` and `actorType` are filled from the principal already (`ctx.auth.id`,
`ctx.auth.type`, else `user`/`system`/`bearer`). The `onLog` callback on
`createClient` overrides them and adds `meta`; it may return only those three keys.

```js
import { AsyncLocalStorage } from 'node:async_hooks'
const requestStore = new AsyncLocalStorage()   // the app's per-request store

const db = await createClient({
  path:       './schema.lite',
  db:         ':memory:',
  logContext: () => requestStore.getStore() ?? null,
  onLog:      (entry, ctx) => ({ meta: { plan: ctx.auth?.plan } }),
})

const me = db.$setAuth({ id: 'user_abc', plan: 'pro' })
await me.candidate.create({ data: { id: 1, email: 'c@example.com', stage: 'new' } })
await new Promise(r => setTimeout(r, 0))
const [entry] = await db.asSystem().auditTrail.findMany()
if (entry.actorId !== 'user_abc' || !/pro/.test(JSON.stringify(entry.meta))) throw new Error(`expected the actor and the meta, got ${JSON.stringify(entry)}`)
```

**`ctx` is the client's, not the request's** (`FJS-D03`): `ctx.auth` is the
principal that scoped it, and there is no `ctx.requestId` or `ctx.ip`. Where the
write came from — `correlationId`, `ip`, `userAgent`, `origin`, `source`,
`tenant` — is `logContext`'s to supply, and lands in the entry's own columns.
Junction installs one itself; elsewhere, return what your request store holds.

`onLog` runs synchronously inside the write and a throw in it is swallowed; the
entry is then appended one event-loop tick later, never blocking the caller.

## Querying logs

Log entries are queryable through the standard ORM API, at SYSTEM only: the
synthesized model is `@@gate("8")`, as the auth models are, because a row holds
the before- and after-image of a write in any tenant. A service that shows a
caller their own history reads through `asSystem()` and narrows the `where`
itself. A trail model the schema declares (`driver trail model AuditRow`)
carries whatever `@@gate` it declares; an `@@allow` or `@@deny` there is refused
at parse, because the jsonl reader compiles no row policy — a trail that must be
filtered per row goes in a SQLite database with a `model` key.

```js
const trail = db.asSystem().auditTrail
await db.$setAuth({ id: 'user_abc' }).candidate.create({ data: { id: 1, email: 'c@example.com', stage: 'new' } })
await new Promise(r => setTimeout(r, 0))

// All writes to the candidate table — `model` holds the accessor spelling (FJS-2380)
const writes = await trail.findMany({
  where:   { model: 'candidate' },
  orderBy: { createdAt: 'desc' },
  limit:   50,
})

// Writes by a specific actor
const actorWrites = await trail.findMany({
  where: { actorId: 'user_abc', operation: { in: ['create', 'update', 'delete'] } }
})
if (writes.length !== 1 || actorWrites.length !== 1) throw new Error('expected the one create')
```

A `$raw` predicate over `records` — *all changes to a specific record* — is ignored by the jsonl reader rather than applied or refused (`FJS-2298`), so until that is fixed the narrowing is done in JS:

```js failing
// FJS-2298 — the trail reader drops a `$raw` it does not understand
const trail = db.asSystem().auditTrail
await db.asSystem().candidate.create({ data: { id: 1, email: 'c@example.com', stage: 'new' } })
await new Promise(r => setTimeout(r, 0))

const history = await trail.findMany({
  where: {
    model:   'candidate',
    records: { $raw: sql`json_extract(records, '$[0]') = ${999}` }
  }
})
if (history.length !== 0) throw new Error('no entry names record 999')
```

The auto-generated model name for a trail database is `<dbName>Trail` — `audit` → `auditTrail`.

## @secret — encrypted + guarded + logged

`@secret` is a composite that bundles all three security attributes:

```lite
database audit { path "./audit/"  driver trail }

model User {
  id     Int     @id
  apiKey String? @secret                 // @encrypted + @guarded + @trail(audit, reads: false)
  token  String? @secret(rotate: false)  // same, but excluded from $rotateKey
}
```

Every write of a `@secret` field is logged automatically, redacted. A read — `asSystem()` is the only caller that gets one — is not, unless the field also says `@trail(audit, reads: true)`.

## @@anonymous — rows nobody may attribute

An anonymous survey answer must have no writer, and an ordinary log can give it
one back from ANOTHER model. The survey writes the answer and flips the
respondent's row on a roster in one transaction. Log the roster, and every flip
is an audit entry naming the person with a millisecond clock, in order. That
order lines up with the answer table's rowid order, which SQLite keeps whether
the schema mentions it or not. So a comment on the answer model protects
nothing. `@@anonymous` is a declaration the parser and client refuse from:

```lite
model SurveyResponse {
  id         String @id @default(uuid())
  rating     Int
  answeredOn String @date     // a day, which everyone answering shares
  @@anonymous
}
```

- **At parse**, the model may not carry `@@trail` or `@trail` (including the one
  `@secret` implies), a column stamped from the writer (`@createdBy`,
  `@updatedBy`, `@@createdBy`, `@default(auth().…)`), or a clock
  (`@updatedAt`, `@default(now())`).
- **At runtime**, a transaction that writes an `@@anonymous` row and a row of a
  model that logs writes is refused, whichever comes first, and both roll back.

**What it does not do.** It closes the join by refusing the logged end. It does
not hide insertion order: raw SQL against the file still reads the rowids, and
a log on the roster written in a *separate* transaction still lines up in time.
It also cannot be tightened later. Rows written while the model was
attributable stay attributable, so declare it before the first row (`FJS-D349`).

## Retention

The `retention` value on a trail database prunes old entries on startup:

```lite
database audit {
  path      "./audit/"
  driver    trail
  retention 90d    // prune entries older than 90 days
}
```

Also applies to JSONL databases. Accepts: `30d`, `24h`, `2w`, `1y`.

**On startup means only on startup**, and a long-lived process is the normal case: the
pass runs inside `createClient` and nothing reschedules it, so a server that boots on
Monday prunes on Monday and not afterwards. **`db.asSystem().$retain()` is the same
pass on demand**, and scheduling it is the app's — the clock belongs to the queue
(`FJS-D36`) and litestone cannot import it, so a Junction app wraps it in a `defineJob`
with a `cron`:

```js
const swept = await db.asSystem().$retain()   // what a job on the app's queue runs, say nightly on a cron
```

`asSystem()` because a sweep is a DELETE against the base table and applies no gate, no
row policy and no `@@softDelete`; every other flavor of client refuses it by name. It
answers one row per model in a retained SQLite database — `{ model, table, removed }`, plus
`error` where a table would not sweep and `skipped` where the model has no `createdAt DateTime`
(a model dated `fetchedAt` keeps every row). Both are worth logging: a declared policy quietly
not applying is the failure the whole declaration exists to prevent.

**A SQLite sweep is batches of a thousand rows, yielding to the event loop between
them**, so requests keep being served while it runs. The startup pass takes ONE batch a
table and drains any backlog after `createClient` resolves — the first boot after a
window is declared over an existing table would otherwise not listen until it finished
(`FJS-2288`); `$retain()` waits for that drain, then sweeps. Rows are read back only
where something hears the delete — a plugin answering `onAfterDelete`, or a cascade
child with one. **Index `createdAt`**: the sweep is `createdAt < cutoff`, and without
`@@index([createdAt])` every pass scans the table whether or not anything is due;
`litestone advise` reports it as `retention-without-an-index`. The freed pages stay in
the file — nothing vacuums.

The cutoff is a **rolling instant** rather than a day boundary — `Date.now()` minus the
duration, with `d` a flat 24 hours and `y` a flat 365 days — so *ninety days* is measured
from the moment the pass runs, in no particular zone. That half is stated rather than
fixed: a calendar-aligned window needs a zone the schema has no way to say yet
(`FJS-D143`).
