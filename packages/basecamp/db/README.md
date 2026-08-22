# Basecamp — Data realm

`schema.lite` is the seed. The SQL in `migrations/` is generated from
it and must never be hand-edited.

```bash
bun db/generate.js           # regenerate migrations/main/20260801000000_initial_schema.sql
bun db/generate.js --check   # exit 1 if the SQL is stale (wire this into CI)
bun db/generate.js --print   # dump DDL to stdout
```


## Where the database file comes from

`db/schema.lite` declares it:

```
database main { path env("DATABASE_URL", "./db/basecamp.db") }
database audit { path "./db/audit/" driver logger retention 90d }
```

Both paths resolve against the **process CWD**, not the schema file — start the
API from the package root.

**A declaration wins over `createClient({ db })`, silently.** The option is not
an error and produces no warning; it is simply ignored. `api/src/core/db.ts`
therefore does not pass one, and anything that needs a different file — a
scratch script, a test — sets `DATABASE_URL` instead. This is not theoretical:
when `db/test/schema.test.ts` passed `db: <tmpdir>`, every test opened the
DEVELOPMENT database, read its rows into assertions and wrote to it. Four tests
failed the moment `database main` was declared, which is how it surfaced.

Litestone's own `makeTestClient` (from `@frontierjs/litestone/testing`) is the
safer path for new tests: it always builds a throwaway tmpdir and **overrides**
a declared `database` path, so a test pointed at this schema cannot reach the
app's real database at all. `schema.test.ts` predates that and steers
`DATABASE_URL` instead; both work, only one is hard to get wrong.

## Conventions that bite

These are Litestone's, not Basecamp's, and the previous schema got three of them
wrong:

| | |
|---|---|
| **Model names** | PascalCase singular — `WorkspaceMember`, never `workspace_member` |
| **Table names** | snake_case of the model name, derived automatically — `workspace_member` |
| **Accessors** | camelCase of the model name — `db.workspaceMember` |
| **Columns** | emitted **verbatim**. `workspaceId` is the column. Litestone does *not* snake_case field names |
| **DateTime** | ISO-8601 `TEXT` (`2026-08-03T22:57:22.263Z`), not epoch milliseconds |
| **Tables** | `STRICT` by default |
| **Scalars** | `String` / `Int` / `Float` / `Bytes` / `Boolean` / `DateTime` / `Json` / `File`. `Text`, `Integer`, `Real` and `Blob` are rejected outright — a hard cut, no aliases |

## Identity is owned by `@frontierjs/auth`

`User`, `Credential`, `Session` and `Verification` come from
`authSchemaFragments()` in `packages/auth/schema.ts`. `auth.ts` reaches for the
accessors `db.user`, `db.credential`, `db.session`, `db.verification` through
`asSystem()`, so **those four model names are load-bearing** — renaming one
breaks the auth package, not just Basecamp.

Two deliberate deviations from the shipped fragment, each noted in the schema:

1. **`accountId` is `String`, not `Int`.** `Account.id` is a uuid; `Int` cannot
   hold it. Safe for `auth.ts`, which only ever does `String(user.accountId)`.
2. **`@secret` → `@guarded(all)`** on the `Credential` and `Session` token
   columns. Not for a logging reason — log entries redact protected fields as of
   2026-08-03, so `@secret` is safe here now. What still defers it is
   encryption: `@secret` implies `@encrypted`, and `Session.token` is looked up
   *by value*, which needs `@encrypted(searchable: true)`. `Credential.value`
   already holds a hash, so encrypting it buys little. Revisit in the API pass.

`@@log(audit)` is kept, as auth ships it.

**Everything Basecamp adds to `User` is nullable or defaulted on purpose.**
`auth.createUser()` writes only `{ email, name, role }` — a required Basecamp
column would make user creation throw.

## Two renames

| Was | Now | Why |
|---|---|---|
| `model service` | `App` | `Service` is the API realm's primary noun. `docs/VISION.md` §Vocabulary forbids the overload by name; the rest of the codebase already said App (`apps.service.ts`, `AppType`, `AppStatus`). Also renames `service_server` → `AppServer`, `service_network` → `AppNetwork` |
| `model credential` | `Secret` | `@frontierjs/auth` owns `Credential` and the `db.credential` accessor. The distinction is real: a **Credential** is how a *person* proves identity to Basecamp; a **Secret** is how *Basecamp* proves identity to a machine or provider (SSH keys, provider API keys, registry auth, TLS certs) |

## Access control

**Every model declares `@@gate`.** `api/src/core/gate.ts` is the resolver and
`api/src/core/hooks.ts`'s `applyStanding()` is what feeds it; the full ruling is
`DECISIONS.md` § Access control (2026-08-10).

**The level is a fact about a caller IN A WORKSPACE, not about their user row.**
That is the whole reason this app could not use `example/`'s four-line
`getLevel`: `sessionGateLevel()` grades standing that travels with the user, and
the same person here is `owner` in one workspace and `viewer` in the next.

| | |
| --- | --- |
| no session, or `suspended` | STRANGER (0) |
| authenticated, no membership in the workspace named | VISITOR (1) — reads `Workspace`, nothing else |
| `viewer` · `billing` | READER (2) |
| `developer` | USER (4) |
| `admin` | ADMINISTRATOR (5) |
| `owner` | OWNER (6) |
| `User.isSystemAdmin` | SYSADMIN (7) |
| `asSystem()` | SYSTEM (8) — jobs, outposts, the seed, migrations |

CREATOR(3) is unused: the narrowest role reads and the next one up writes.

The trap that remains real, and is not about this app: a schema carrying **any**
`@@gate` auto-installs `GatePlugin({ getLevel: FrontierGateGetLevel })` when the
app supplies none. Supplying your own replaces it; supplying none does *not*
disable it. `core/db.ts` supplies one — and the tests in `db/test/schema.test.ts`
install the same one, so they assert against the levels the API actually runs
rather than a stand-in's.

**What a gate does not do is scope rows.** It answers *may this caller touch
Server at all*, never *may they touch THAT server*. That is `@@allow`, and
**15 models declare one** — every model carrying a `workspaceId` except two:

| | |
| --- | --- |
| `Server` `Project` `Environment` `App` | the hierarchy every screen walks |
| `Deployment` `Job` `Domain` | what a person does to an app |
| `Network` `Recipe` `FeatureFlag` `NotificationChannel` `AlertRule` `Dashboard` | the workspace's own settings |
| `Secret` `ApiKey` | credential material |

The two that carry `workspaceId` and are deliberately left out: `WorkspaceMember`,
because it is what standing is *read from* — `applyStanding()` reads it through
`asSystem()` before there is a workspace on the principal to compare against, so
a policy would be reading the field it is in the middle of deciding — and
`AuditEvent`, whose `workspaceId` is nullable because a hub action belongs to no
workspace, and a null compared to a caller's workspace hides exactly the rows the
trail exists for. The line each of the 15 carries:

```
@@allow('all', workspaceId == auth().workspaceId)
```

`workspaceId` reaches `auth()` the same way `memberRole` does — `applyStanding()`
resolves the workspace being addressed once per request and puts both on the
principal. So the declaration is the same fact the service where-clauses already
filter on, moved to where it cannot be omitted: compiled into the SQL of every
read, update and delete from a scoped client, and checked in JS before a create.
`db/test/schema.test.ts` runs all three sets with no service and no hook in the
picture, which is the only way to tell the policy from the where-clause the
service was already writing — and each set drives its models through one table
of shapes, so the next model is a row rather than a copy.

**The audit is the work; the line is not.** Before declaring, every scoped read
of that model has to be workspace-filtered already and every path that
legitimately crosses has to be `asSystem()`. For all 14 it came out clean:
the services read through `dbOf(ctx)` with `workspaceId: wsOf(ctx)` throughout,
the jobs and the hub take `asSystem()`. Proven a second way, over HTTP
with two workspaces owned by one person: each lists only its own rows, a
cross-workspace `GET` is a 404, and a create naming the other workspace in the
BODY lands in the caller's own — the service stamps the header's workspace and
the policy would refuse the rest.

`Deployment`, `Job` and `Domain` added one shape the hierarchy did not have: a
read filtered on **`appId` alone**, with no workspace clause — an app's recent
releases, a hostname's siblings to demote. Those are safe today only because the
app was fetched scoped first, an argument that lives in the reader's head. The
declaration is what makes them safe without it, and `an appId-only read cannot
reach another workspace app` is the test that says so by handing the other
tenant's `appId` in directly.

`Secret` and `ApiKey` were held to last because both have real system readers
that look a row up **by id with no workspace in the query**: the conduit
resolver reading `secret:<id>` (`core/credentials.ts`), the channels service
writing a channel's credential, and the API-key guard asking whether a key may
act at all (`services/api-keys/scopes.ts`). All three are `asSystem()`, which is
what makes the declaration safe — and a test says so, because a policy applied to
any of them would fail every send and refuse every key with nothing to
distinguish it from a bad token.

Declaring `Secret` also found a defect in Litestone's own checks:
`verifyFieldProtection` seeds a row carrying the policy's targeted value and did
not create the parent that value points at, so a model with **both** a protected
field and a row policy could not be graded at all (fixed the same day; its
sibling `verifyRowPolicies` already did this). 15 models can carry the policy and
exactly one has a `@guarded` column, which is why nothing before it had put the
two attributes on one model.

**A policy filters where a gate refuses**, and that is the whole risk in the
remaining 22. A read that legitimately crosses a workspace and is not
`asSystem()` matches nothing — no error, an empty screen. The paths that do
cross are the jobs, the hub and the outpost's heartbeat, and every one of
them already takes `asSystem()`. What is left carries no `workspaceId` column of
its own — a `DeploymentStep`, a `JobRun`, a `Volume` — so the next move is
`check(parent)`, delegating to the parent's policy rather than restating it.

One thing had to be fixed in Litestone before the declaration was worth
anything: **an `include:` applied no access rule of the model it reached** — not
the policy, not the gate, not `@guarded` (litestone `FJS-150`). A model that
filters correctly on its own is one join away from a parent that does not.

### What is still enforced at the Data boundary

`@guarded` and `@encrypted` are **field policy keyed on `asSystem()`, not
GatePlugin**, so no level reaches them — an ADMINISTRATOR(5) clears
`Secret.read` and still gets no `data` key:

- `Secret.data` is still AES-256-GCM encrypted at rest — the plaintext key is
  absent from the database file.
- It is still missing entirely from any non-system read: an admin listing
  secrets gets `id`, `name`, `kind` and **no `data` key at all**.
- Audit snapshots still redact it.

All three are pinned by tests in `db/test/schema.test.ts`, including one that
re-arms a gate in an inline schema to keep the auto-install trap documented.

### The declared gates

**`schema.lite` is the list — this section is only what the numbers cannot
say.** A table here would be a second copy of 37 declarations and would go stale
on the first one anyone edits.

The shape of them: an ordinary workspace model is `"2.4.4.5"` (a viewer reads, a
developer writes, an admin deletes), a model in the admin tier is `"2.5"` or
`"5"`, a model only a machine writes has an 8 in its write positions, and the
identity models auth owns are `"8"` throughout.

Where the levels came from: the `requireWorkspaceRole` calls the services were
already making. Two places the shipped levels differ from what this document
recorded before they landed, both because a path reads what it needs:

- **`Recipe` reads at 4, not 5.** Authoring is an admin's act and running is a
  developer's — but running one means reading its script, so a read gate above
  `developer` refuses the person the service is written to allow.
- **The machine-written models read at 2 and take 8 only on the writes the
  JOB makes.** `ServerEvent`, `DeploymentStep`, `RecipeRun` and `CleanupRun`
  are created as a side effect of a person's action, through that person's own
  client; it is the later advance-the-run updates that no caller may make.

Two properties worth knowing, both verified by running:

- **`User` reads at USER (4), and what makes that safe is not the level.** It was
  SYSTEM (8) until auth moved its own fragment (`FJS-170`) — a level no request
  reaches, which is why every service listing members was written through
  `asSystem()`, and they all still are. A gate is per MODEL, so 4 on update says
  *any signed-in caller may rewrite any other person's row*, the hub tier
  column included. Two declarations narrow it, neither of them a level:
  `@@allow('update', id == auth().id)` for whose row, and
  `@allow('write', auth().isSystemAdmin)` on `isSystemAdmin`, `status` and
  `kind` for which columns — the three `basecampGateLevel()` grades on, which is
  the reason they may not be written by the caller being graded. `asSystem()`
  passes both, so the hub grants the tier and `/setup` makes the first
  administrator exactly as before.
- **`AuditEvent` update/delete at LOCKED (9) is not passable by `asSystem()`.**
  The audit trail cannot be rewritten from inside the application — the one gate
  here aimed at the app rather than at its callers. `db/seed.js --force` cannot
  clear the table and lets the workspace FK cascade do it.

`Secret.data` is `@encrypted`, which implies `@guarded(all)`: an ADMIN listing
secrets gets `id`, `name`, `kind` and **no `data` key at all**, `asSystem()`
gets the plaintext, and the SQLite file holds only `v1.Kz9wXnW5…`. That is
constraint 7 ("secrets are held, never shown") enforced at the Data boundary
instead of by a hook someone can forget.

**This makes an encryption key mandatory.** `createClient()` throws at startup
without one — `Encryption key must be 32 bytes (got 16). Use a 32-byte (64 hex
char) key.` It fails closed, which is what we want, but the API pass has to add
`ENCRYPTION_KEY` to `env.ts` and pass it through.

## Audit logging

```prisma
database audit { path "./audit/" driver logger retention 90d }
```

Every write to a `@@log(audit)` model lands in `./audit/auditLogs.jsonl` with
before/after snapshots and actor attribution, and is queryable through the
`auditLogs` accessor (`sys.auditLogs.findMany()`). **All 16 non-event models
carry it**, including `Secret`, `Credential`, `Session` and `Verification` —
an access trail over a credential is the whole point of having one.

The high-volume event tables are deliberately excluded (`ServerEvent`,
`DeploymentStep`, `JobRun`, `AlertEvent`, `AuditEvent`, `AppServer`,
`AppNetwork`): they are already append-only records of things that happened, so
logging them would just double the writes.

Two things about it are worth knowing, both verified by running:

**1. Protected fields are redacted — and this is load-bearing.** Any
`@encrypted`, `@guarded` or `@secret` field is written to the log as
`'[redacted]'`; the trail records *that* the field was written, by whom, to
which rows, when — never what it holds. Verified end to end on this schema: an
SSH key written and then rotated through `Secret` produces a full create+update
trail with **0 occurrences of the key material in the log or in the SQLite
file**.

This behaviour did not exist until 2026-08-03 — before that, `@@log(audit)` on a
model with an `@encrypted` column wrote the plaintext into the JSONL while the
database row was correctly ciphertext, which is why these models could not be
logged at all. **Basecamp now requires a Litestone with that fix**; on an older
one, the four identity models and `Secret` would leak.

**2. Reads lag writes within a session.** Entries flush on a ~1s timer and on
process exit. Immediately after a write, `auditLogs.findMany()` returns 0 rows
and the JSONL file may not exist yet; the next process sees everything. Measured:
1 write → 0 rows visible, +2s → 1 row, +50 more writes → still 1 row, next
process → 51 rows. **Nothing is lost** — this is visibility lag, not data loss,
and it is the whole explanation for the "audit logger writes 0 rows" note that
sat unexplained in the root `CLAUDE.md`.

**3. The path is CWD-relative, not schema-relative.** `path "./audit/"` resolves
against the process working directory, so where the audit trail lands depends on
where you launch the API from. That matches `DATABASE_URL`'s existing
`./basecamp.db` default, but it is a foot-gun for a tool whose whole job is
accountability.

The `AuditEvent` model is a different thing and both are wanted: `@@log(audit)`
is automatic row-level change capture, `AuditEvent` is the application-level
operational trail docs/VISION.md §Operate asks for ("every operational action
attributable to a person") — deploys, provisions, rotations. One answers *what
changed in the database*, the other *what an operator did*.

### A Litestone bug to route around

**`@encrypted` on a `Json` field silently destroys the value.** It round-trips
as the string `"[object Object]"` — the object is stringified with `String(obj)`
rather than `JSON.stringify` before encryption. Encryption at rest and read
withholding both work correctly; the payload is simply gone. `Secret.data` is
therefore `String @encrypted` and the service layer does its own
`JSON.parse`/`stringify`, which is what the old raw-SQL code did anyway.

## Soft delete cascades

`Account`, `Workspace`, `Project`, `Environment` and `App` use
`@@softDelete(cascade)`. Without the cascade, archiving a workspace leaves its
projects, servers, secrets and jobs live — Litestone warns about exactly this,
and the warning is worth keeping at zero.

## `db/legacy-sql/` — the superseded hand-written SQL

Kept for reference only; nothing reads it. It is **not** compatible with the
generated schema: it used snake_case columns (`workspace_id`, `created_at`) and
`INTEGER` epoch-ms timestamps, and its tables were not `STRICT`.

Note that `002_server_agent.sql` never worked — `ALTER TABLE … ADD COLUMN IF NOT
EXISTS` is not valid SQLite (confirmed: `near "EXISTS": syntax error`), and both
columns it adds already exist in `001`. The migration chain would have thrown on
first boot.

## Downstream — done (2026-08-04)

When this schema was regenerated it broke every service at once: they queried
snake_case columns and epoch-ms timestamps that no longer existed, and
`basecamp-auth.ts` read `password_hash` off `user`, a column that had moved to
auth's `Credential`. That was the intended consequence of the schema being the
seed — the alternative is two shapes drifting apart quietly.

All of it has since been converted: **9 services and both runners run on
Litestone accessors** with `createService({ model })`, `basecamp-auth.ts` is
deleted, and there is zero raw SQL in `api/src`.
