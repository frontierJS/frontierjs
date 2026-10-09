# Audit Logging

Litestone provides field-level and model-level audit logging via the `logger` database driver. Every write produces a structured log entry with before/after images, actor attribution, and optional custom metadata.

## Setup

Declare a trail database in your schema:

```prisma
database audit {
  path      "./audit/"
  driver    trail
  retention 90d          // prune entries older than 90 days on startup
}
```

## Model-level logging — @@trail

Log every write (create, update, delete) on a model:

```prisma
model User {
  id    Int @id
  email String
  name  String?
  @@trail(audit)
}
```

Every `create`, `update`, and `delete` on `users` produces an entry in the audit trail database.

## Field-level logging — @trail

Log reads and writes of a specific sensitive field:

```prisma
model User {
  salary Float?   @trail(audit)
  apiKey String?   @secret    // @secret implies @trail(audit) automatically
}
```

## Log entry shape

```js
{
  operation:  'update',             // create | update | delete | read
  model:      'users',
  field:      'salary',             // only for @trail field-level entries
  records:    [1],                  // array of affected IDs
  before:     { salary: 50000 },    // single-row writes only
  after:      { salary: 75000 },
  actorId:    'user_abc',
  actorType:  'user',
  meta:       { requestId: 'req_xyz' },
  createdAt:  '2024-01-15T10:30:00.000Z',
}
```

`before`/`after` images are only included for single-row writes — `update()`, `delete()` and `remove()`. A bulk write records **which** rows it touched and **what** it did to them, never their contents:

```js
// db.widget.updateMany({ where: { state: 'draft' }, data: { state: 'live' } })
{ operation: 'update', model: 'widget', records: [1, 2, 3], before: null, after: null, ... }
```

Every write path reaches the trail: `create`, `createMany`, `update`, `updateMany`, `upsert`, `upsertMany`, `remove`, `removeMany`, `delete`, `deleteMany` and `restore`. A bulk op on a logged model takes a `RETURNING` path so the entry can name the rows by id — an autoincrement id does not exist until SQLite assigns one — and `upsertMany` splits its batch into a `create` entry and an `update` entry, because it did both. `restore` logs as `update`: a restored row changed state, it was not created.

An unlogged model pays none of this — the `RETURNING` path is taken only when the model declares `@trail` / `@@trail`.

## Protected fields are redacted

The audit trail records **that** a protected field was written — by whom, to which rows, when — never what it holds. Any field carrying `@encrypted`, `@guarded`, `@hashed`, or `@secret` (which implies the first two) has its value replaced with `'[redacted]'` in every log entry, in both the field-level entry and the model-level `before`/`after` snapshot:

```prisma
model Vault {
  id      Int     @id
  name    String
  apiKey  String? @secret
  @@trail(audit)
}
```

```js
{ operation: 'update', model: 'vault', field: 'apiKey',
  records: [7], before: '[redacted]', after: '[redacted]', actorId: 'user_abc', ... }

// model-level image — name is logged, apiKey is not
{ operation: 'update', model: 'vault', field: null, records: [7],
  before: { id: 7, name: 'prod', apiKey: '[redacted]' },
  after:  { id: 7, name: 'prod', apiKey: '[redacted]' }, ... }
```

This is what makes `@secret`'s expansion safe. `@secret` is `@encrypted + @guarded + @trail(<first trail db>)`, so **declaring a trail database is on its own enough to start logging every `@secret` field in the schema** — without redaction that would write plaintext to a file sitting next to a correctly-encrypted database row, with none of the column's read protections.

Two details worth knowing:

- **`null` is preserved, not redacted.** It holds nothing to leak, and keeping it means a `null → value` transition stays visible: `before: null, after: '[redacted]'` tells you a secret was set without telling you what it is.
- **Unprotected fields on the same model are logged in full.** Redaction is per-field, not per-model, so the trail stays useful.

The value returned to the caller is never affected — redaction happens on the way to the log, on a copy.

## Personal data — @personal and @@person

A column about a person is `@personal`, optionally with a category. A reader the gate admits still sees it; the trail does not keep it, because the trail outlives the row and an erased person's email would otherwise stay in every before- and after-image. It logs as `'[personal]'`, so an entry still says which kind of value was dropped:

```prisma
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
{ operation: 'update', model: 'candidate', field: null, records: [3],
  after: { id: 3, email: '[personal]', coverLetter: '[personal]', stage: 'interview' }, ... }
```

- **The category is a closed list**, refused by name: `contact`, `device`, `location`, `government`, `financial`, `employment`, `communication`, `demographic`, `health`, `genetic`, `biometric`, `characteristic`, `criminal`. It changes no enforcement; it is what a data map groups by, and which categories GDPR Art. 9/10 or the CPRA treat as special is one framework table (`PERSONAL_CATEGORIES`), not something an app restates.
- **`@@person` says every row is a person.** An `@@auth` model is one without saying so. `@@person(child)` says every row is a child in the legal sense — a status, never an age.
- **On a person model, a column named like personal data** (`email`, `phone`, `firstName`, `dob`, …) with no `@personal` is a parse warning naming the category to add. Nothing warns on another model, so `Company.email` stays quiet.
- **A column that is both protected and personal logs as `'[redacted]'`.**
- **`@personal` does not imply `@omit`.** Who may read the column is the gate's question (`FJS-D205`); a recruiter has to see a candidate's email.

## onLog — enrich log entries

The `onLog` callback on `createClient` adds actor attribution and custom metadata:

```js
const db = await createClient({
  path:  './schema.lite',
  onLog: (entry, ctx) => ({
    actorId:   ctx.auth?.id,
    actorType: ctx.auth?.type ?? 'system',
    meta: {
      requestId: ctx.requestId,
      ip:        ctx.ip,
    },
  }),
})
```

The return value is merged into the log entry. Fires asynchronously via `setImmediate` — never blocks the calling operation.

## Querying logs

Log entries are queryable through the standard ORM API, at SYSTEM only: the
synthesized model is `@@gate("8")`, as the auth models are, because a row holds
the before- and after-image of a write in any tenant. A service that shows a
caller their own history reads through `asSystem()` and narrows the `where`
itself. A trail model the schema declares (`driver trail model AuditRow`)
carries whatever `@@gate` it declares.

```js
const trail = db.asSystem().auditTrail

// All writes to users table
const writes = await trail.findMany({
  where:   { model: 'users' },
  orderBy: { createdAt: 'desc' },
  limit:   50,
})

// Writes by a specific actor
const actorWrites = await trail.findMany({
  where: { actorId: 'user_abc', operation: { in: ['create', 'update', 'delete'] } }
})

// All changes to a specific record
const history = await trail.findMany({
  where: {
    model:   'users',
    records: { $raw: sql`json_extract(records, '$[0]') = ${userId}` }
  }
})
```

The auto-generated model name for a trail database is `<dbName>Trail` — `audit` → `auditTrail`.

## @secret — encrypted + guarded + logged

`@secret` is a composite that bundles all three security attributes:

```prisma
model User {
  apiKey String? @secret                 // @encrypted + @guarded + @trail(audit)
  token  String? @secret(rotate: false)  // same, but excluded from $rotateKey
}
```

Every access to `@secret` fields (reads via `asSystem()` and all writes) is automatically logged.

## @@anonymous — rows nobody may attribute

An anonymous survey answer must have no writer, and an ordinary log can give it
one back from ANOTHER model. The survey writes the answer and flips the
respondent's row on a roster in one transaction. Log the roster, and every flip
is an audit entry naming the person with a millisecond clock, in order. That
order lines up with the answer table's rowid order, which SQLite keeps whether
the schema mentions it or not. So a comment on the answer model protects
nothing. `@@anonymous` is a declaration the parser and client refuse from:

```prisma
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

```prisma
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
(`FJS-D36`) and litestone cannot import it:

```js
export default defineJob('retention', () => db.asSystem().$retain(), { cron: '0 4 * * *' })
```

`asSystem()` because a sweep is a DELETE against the base table and applies no gate, no
row policy and no `@@softDelete`; every other flavor of client refuses it by name. It
answers one row per table it touched — `{ model, table, removed }`, plus `error` where a
table would not sweep, which is worth logging: a declared policy quietly not applying is
the failure the whole declaration exists to prevent.

The cutoff is a **rolling instant** rather than a day boundary — `Date.now()` minus the
duration, with `d` a flat 24 hours and `y` a flat 365 days — so *ninety days* is measured
from the moment the pass runs, in no particular zone. That half is stated rather than
fixed: a calendar-aligned window needs a zone the schema has no way to say yet
(`FJS-D143`).
