# Decisions

Dated rulings by the project owner. These are settled unless explicitly reopened —
do not "fix" behavior back toward what a decision replaced. When a decision is
reversed, amend it here (strike and date it), don't delete it.

Format: **decision — why — where it lives.**

---

## Naming & vocabulary

**2026-08-13 · `FJS-D29` — the process a fleet server runs is an OUTPOST, and
infrastructure gets place nouns while AI gets personified ones.** Basecamp's
resident process was called an *agent*. So is the thing `IDEAS/agent-surface.md`
proposes to expose over MCP. **The collision was already in the tree**, not a
risk to guard against: one word, two meanings, both written down, in a repo whose
`UserKind` enum already has an `ai` member and whose junction batteries already
include AI.

**Outpost** is the ruling. It is exact — a small permanent installation at a
distance from the main body, which holds a position and reports back — and the
cardinality matches, one per `Server`. It pairs with Basecamp in a sentence that
needs no gloss: *Basecamp installs an Outpost on every server.*

**The rule underneath it is the part that keeps working.** Every AI-flavoured
word is a **person**: agent, assistant, copilot, scout, ranger, worker. So:

> **Infrastructure takes place nouns. AI takes personified nouns.**

A place noun cannot drift into meaning a model, which is a stronger guarantee
than picking a different word and hoping. It also decides the next collision
without another argument, and it is why `scout`, `ranger` and `warden` were
rejected here despite fitting the frontier theme.

The technically-honest alternatives were all taken, which is worth recording so
nobody re-proposes them: `daemon` is `AppType.daemon`, `worker` is **both**
`ServerRole.worker` and `AppType.worker`, `node` is Node.js in a JavaScript
framework, `runner` belongs to CI, `minion` to Salt, and `depot`/`porter`/
`warden`/`marshal` are already claimed in `IDEAS/package-map.md`.

**Ruled now rather than later because three of the renamed names are wire
contracts and nothing speaks them yet.** The Conduit target `outpost:<server-id>`,
the target `kind`, and the snake_case heartbeat payload (`outpost_version`,
`outpost_url`) are the protocol between Basecamp and a process that has not been
written. Basecamp's own half *is* written — both engines dispatch through it —
so the caller exists and the callee does not, which is the last moment this is a
find-and-replace instead of a compatibility window.

**What did not change.** `userAgent` is an HTTP header and stays. `CHANGES.md`
entries and closed `ISSUES.md` rows keep the word, because they describe what was
true when they were written. `db/legacy-sql/002_server_agent.sql` keeps its
filename — it is history, and `db/README.md` explains that it never worked.
The architecture question is still open: whether a server runs a resident process
at all, or Basecamp pushes over SSH, is argued in `IDEAS/deploy-plane.md` and
ruled nowhere. **This decision reserves the name, not the design.**
*Lives in:* `packages/basecamp/db/schema.lite` (`outpostVersion`, `outpostUrl`),
`api/src/engine/fleet.engine.ts`, `api/src/engine/deployment.engine.ts`,
`api/src/services/servers/servers.service.ts`, `docs/VISION.md`,
`IDEAS/deploy-plane.md`.

---

**2026-08-08 · A resource file is named for its noun — PascalCase, singular —
one Resource per file.** `App.mesa`, not `apps.mesa`. Repo Invariant 19.

The three realms are already **Model → Service → Resource**, and two of them
had settled naming: `model App` is PascalCase singular (2026-08-01) and the
accessor derived from it is `db.app`. The UI realm was the one that had not —
`web/src/resources/` was named after the *service* (`apps.mesa`), so the same
noun was spelled three ways across three files and only one of them matched the
declaration it came from.

**The export does not change.** `App.mesa` exports `apps`, and call sites still
read `apps.find()`. That is the same split the Data realm makes: the
declaration is PascalCase singular, the accessor is lowercase — a Resource is
one noun, the binding is a handle on many.

What the rename bought beyond consistency: **the irregular cases became visible
in the file tree.** `AlertRule.mesa` exporting `alerts` states, at a glance,
that `modelNameFor()` cannot bridge those two and `model:` has to be given —
which was previously a paragraph inside the file that you had to open to find.
`AuditEvent.mesa` is the same shape. A resource over no model at all keeps its
service noun, singularised: `Portal.mesa`.

Applied repo-wide the same day. `packages/basecamp`: 13 files renamed, 36 call
sites. `example/`: `shop.mesa` — three resources in one file — split into
`Order.mesa` / `Product.mesa` / `Customer.mesa`, and `notifications.mesa` →
`Notification.mesa`. One Resource per file is half the rule; a grouped file has
no single noun to be named for.
*Lives in:* `CLAUDE.md` Invariant 19, `packages/basecamp/web/src/resources/`,
`example/web/src/resources/`.

**2026-08-09 · A pagination control is `.pagination-link`, not `.page`.**
The gap beside it is `.pagination-gap`. `@frontierjs/css` v0.14.6, breaking.

`Page` is already a tier in the vocabulary — *what changes when you navigate*:
Screen, Pane, View, Tabs. So `.page` put one word on two subjects one file
apart, and `.page[aria-current="page"]` spelled it twice in a single selector
meaning different things each time: the class named a destination, the
attribute named the current one.

The clinching case is `Previous` and `Next`. Both carry this class and
neither is a page, so the old name was not merely ambiguous — it was wrong on
the two controls in a pager that get clicked most.

Chose the long form over `.pagelink` (which mirrors `.navlink`) because
`term-part` is what every other Anatomy class already does — `surface-header`,
`pill-close`, `navlist-label` — and it retires an exception rather than
growing one: `NOT_A_TERM.anatomy` in `vocabulary.js` is the register of parts
that carry no hyphen and therefore need naming by hand, and it drops from five
entries to four. `.pagination-gap` follows so one term does not ship two
prefixes.

Cheap to do now and never cheaper: no application in the repo used the class.
The only consumer was `@frontierjs/ui`'s `Pagination.mesa`.
*Lives in:* `packages/css/src/patterns/nav.css`, `vocabulary.js` (`ANATOMY`),
`packages/ui/components/display/Pagination.mesa`.

**2026-08-06 · The email component kit is `@frontierjs/email-kit`.**
Closes `FJS-D15`; fixes `FJS-051`. Not `@frontierjs/mesa-email`. Every other
package's npm name matches its directory, and `email-kit` is the directory —
so the directory was right and the name was the odd one out. It also says what
the package IS rather than what it is built on: `@frontierjs/ui` is a Mesa
component kit too and is not called `mesa-ui`.

`package.json` already carried the new name; what survived was the old one in
prose, comments and one filename, which is the shape this kind of thing takes
once the code is correct. Swept: README, `index.js`, `render.js` (including the
user-facing peer-dependency error), `PROJECT_STATE.md`, mesa's own docs, and
`mesa-email.test.js` → `email-kit.test.js`. `drift-report.md` keeps the old
name: it is a dated audit and rewriting its findings would falsify the record.
*Lives in:* `packages/email-kit/`.

**2026-08-01 · Model names are PascalCase and singular, always.**
`model Lead` → accessor `db.lead`; `model PageView` → `db.pageView`. The accessor
rule derives the API from the model name, so mixed conventions produced three
spellings of one model across packages. Exception: `@@external` models mirror a
foreign physical table and keep its name verbatim.
*Lives in:* all examples/docs in `packages/litestone`; enforce in scaffolds and reviews.

**2026-08-01 · Named gate syntax is canonical; digits are the compact form.**
`@@gate(read: READER, write: USER, delete: OWNER)` in all docs and new schemas;
`@@gate("2.4.4.6")` remains valid shorthand. `write:` expands to
create+update+delete unless one is given explicitly; missing keys cascade
read→create→update→delete, read defaults to STRANGER.
*Lives in:* `packages/litestone/docs/access-control.md`, parser `parseGateArg()`.

**2026-08-06 · `Signal` and `Event` are two words for two things, both legal.**
**Signal** is Mesa's reactive cell — the thing `createSignal`/`watchProxy` make and
`$:` tracks. **Event** is Junction's announcement — the thing `publish()` fans out
and a channel carries. `ARCHITECT.md` §2 previously listed *signal* as a banned
synonym for Event, which was written to stop "signal" meaning *notification* and
accidentally outlawed the word Mesa's own runtime, docs and White Paper use for
its core primitive. The ban is narrowed rather than dropped: **do not call an
Event a signal.** Calling a reactive cell a Signal is correct and required.
They cannot be confused in practice because they live in different realms — a
Signal never crosses a Boundary, an Event only exists to.
*Lives in:* `ARCHITECT.md` §2; `packages/mesa/runtime.js`;
`packages/junction/src/transport/channels.ts`.

**2026-08-06 · `Policy` keeps exactly one meaning, and it is not "business rule".**
A **policy** is a row/field predicate (`@@allow`/`@@deny`) compiled into SQL WHERE.
A **Gate** is the ordinal per-operation level check. Both were already ruled. A
third proposed sense — "declarative business rule, as opposed to imperative
mechanism" — is **refused**: it is the word doing three jobs, and the two existing
senses cost an audit to separate. Where that distinction is wanted, the words are
already there: a **Declaration** is what the schema states, a **Hook** is what runs.
*Lives in:* `ARCHITECT.md` §2 clarifications.

**2026-08-06 · `Projection` is adopted for a read model only.**
A **Projection** is a *stored or served* shape derived from the seed for reading —
a materialised view, a serialised subset, a report. What the compiler derives at
build time stays **derived**; what a component computes stays **derived**. Adopted
because the existing vocabulary had no noun for "a second shape of the same truth,
kept in sync", and FJS-005's fix (`IDEAS/scoped-sql.md`) needs one. Not a synonym
for derived — if it has no independent existence, it is not a Projection.
*Lives in:* `ARCHITECT.md` §2 (to add); `IDEAS/scoped-sql.md`.

## Access control

**2026-08-10 · Basecamp's gate ladder: a level is a fact about a caller IN A
WORKSPACE, so it is resolved per request and carried on the principal.**

The gap `FJS-007` recorded for ten phases was never the resolver. It was that
the shape Junction ships — `sessionGateLevel()`, standing that travels with the
row in `user` — cannot say *admin of THIS workspace*. The same person is `owner`
in one workspace and `viewer` in the next, so grading them from their user row
answers USER(4) everywhere, in every workspace, including the ones they are not
a member of.

So the level is resolved from the `WorkspaceMember` row for the workspace the
request is for:

| | |
| --- | --- |
| no session, or `suspended` | STRANGER (0) |
| authenticated, no membership in the workspace named | VISITOR (1) — reads `Workspace`, nothing else |
| `viewer` · `billing` | READER (2) |
| `developer` | USER (4) |
| `admin` | ADMINISTRATOR (5) |
| `owner` | OWNER (6) |
| `User.isSystemAdmin` | SYSADMIN (7), above any membership |

Three things about it are the decision rather than the arithmetic.

**The standing goes on the PRINCIPAL, not on the client.** Junction scopes the
Litestone client in an around hook installed by `createApp({ db })`, before any
hook knows which workspace is being addressed — and `getTable()` re-derives its
own scoped copy from `ctx.auth.user` on first use. A standing put only on
`ctx.locals.db` is therefore dropped the moment a service touches a model.
`applyStanding()` builds a fresh principal carrying `memberRole`, assigns it to
`ctx.auth.user`, and re-scopes from that. Fresh, never a mutation: over
WebSocket the session is resolved once at upgrade and shared by every frame on
that socket — and the internal-call path freezes it — so mutating would either
throw or leak one call's role into the next.

**It re-resolves when the workspace changes mid-request.** The workspaces
service addresses `ctx.id`, not the header, and an admin of the workspace they
are looking at must not carry level 5 into a patch of a different one.

**The hooks stay.** A gate refuses with a level; `requireWorkspaceRole` refuses
with the sentence a person can act on (*requires admin or owner in this
workspace — you have developer*). Two ladders over one membership row, so they
cannot disagree about who the caller is, only about what they say when refusing.
The gate is the boundary and covers what a hook cannot: an engine calling a
service in-process, a custom action nobody wired a hook onto, a where-clause
built by hand.

**What a gate deliberately does not do is scope rows.** It is per model:
*may this caller touch Server at all*, never *may they touch THAT server*.
Tenancy stays the `workspaceId` filter in every service read plus
`scopeToWorkspace` refusing a non-member. Expressing it as `@@allow` is the next
step and is not claimed by this ruling.

**2026-08-10 · A tier above every tenant is a SEPARATE service, and the bit
that grants it is a column named for the standing it grants.**

Basecamp's four sysadmin screens read across every workspace. Nineteen of its
twenty services take `X-Workspace-Id` and refuse without it, so there were two
ways to answer them, and only one of them scales down to being wrong safely:

| | |
| --- | --- |
| Widen the existing services with `?scope=hub` | The tenancy decision moves into a **query string**, on nineteen services, each of which has to get it right. Nineteen chances to leak every tenant, and the one that forgets looks exactly like the eighteen that did not |
| One new service behind one hook | One place to be wrong. `requireSystemAdmin` is the whole guard, and `/hub` is greppable |

The second. What makes it hold is that the hub service takes **no workspace at
all** — there is nothing for a caller to widen. It reads through `asSystem()`,
not as a convenience but because `User` is the model auth's own fragment gates
at level 8, which even SYSADMIN(7) does not reach: no caller-scoped client can
read a user list, so writing those reads any other way would have meant
rewriting them when the gates landed. They landed the same day, and the hub
needed no change.

**The privileged bit is `User.isSystemAdmin Boolean`, and the name is
load-bearing.** Not auth's `role` — that column defaults to `"user"`, nothing in
the app reads it, and putting the grant there would give one column two owners.
Not an env allowlist, which cannot be granted or revoked by the people who need
to. The name is the one `sessionGateLevel()` already grades **SYSADMIN(7)** on
(`junction/src/core/litestone.ts`), so the column filling these screens today is
the column `@@gate` will read tomorrow. The cost, accepted: two fields beside
each other that both look like privilege, so the schema comment says which one
this app enforces on.

**Refusal is 404, not 403.** The hub is not a screen someone is being refused;
it is a surface they have no business knowing exists — the same reasoning the
workspaces service already uses for a workspace you are not a member of.

*Lives in:* `packages/basecamp/api/src/services/hub/hub.service.ts`,
`api/src/core/hooks.ts` (`requireSystemAdmin`); 4 data tests, 25 browser checks.

**2026-08-10 · A status column that nothing reads is not a state, and
suspension needs a door on each side.**

`User.status` had been a free `String` since the schema was written, and
@frontierjs/auth — which owns the model — never looks at it. So "suspended" was
a word the app could store and nothing anywhere would honour: a Suspend button
would have reported success and revoked nothing. The same would have been true
of a new `Workspace.status`.

Three things together make it real, and none of them is sufficient alone:

1. **The vocabulary is an enum** (`UserStatus`, `WorkspaceStatus`), so the
   column carries a CHECK and the service's copy of the list is held against it
   by a test in both directions. A free string beside a service that invents
   values is the shape that let `AlertRule.severity` default to a value its own
   API refused.
2. **The front door refuses.** A suspended user cannot sign in — checked AFTER
   the password, so the refusal does not tell an unauthenticated caller which
   addresses are suspended accounts.
3. **The already-open door refuses.** A token issued before the suspension stops
   resolving, at an app-level `before: all` hook. Deleting the `Session` rows is
   not enough on its own: an API key is a `Credential` and survives that.

For a workspace the one door is `scopeToWorkspace`, the hook every scoped
service already runs — so suspension bites in nineteen places by being written
in one. And it is **not** deletion: `@@softDelete(cascade)` stamps every child,
a status change stamps nothing, and conflating them would make a reversible-
sounding action unrecoverable.

*Lives in:* `packages/basecamp/api/src/core/session-auth.ts`,
`api/src/core/hooks.ts`; pinned by db tests and by `verify.mjs` § 13f.

**2026-08-10 · A machine account is created from an admin screen. A human is
not.**

The hub's Users screen creates `UserKind.bot` accounts and deliberately ships
without the mock's Invite button. The asymmetry is the whole point: creating a
bot hands nobody anything — it has no password credential, so there is no way
for it to sign in, and its only route in is an API key issued to it separately.
Creating a human from the same screen would be an administrator minting an
account with a password only they know, which is why the human path is
invite → accept and stays unbuilt (`FJS-032`).

Three rules fall out of it, each refused by name at the API:

- **A bot's address is at `bots.invalid`** — RFC 2606 reserves the TLD, so it
  resolves nowhere. `User.email` is required and unique and a bot has no inbox;
  a plausible-looking address would eventually be mailed.
- **A bot may not own a workspace.** An owner is the one member `removeMember`
  refuses to remove and the one role that can delete the tenant.
- **A bot may not hold the hub tier.** `isSystemAdmin` is a revocable human —
  the point of it is that somebody can be asked why they used it.

It also closes a gap `api-keys.service.ts` had recorded in its own comment since
Phase 6: a key was always minted for the caller, because nothing else existed to
own one, so CI's key was a person's key and revoking it when they left broke the
pipeline. A key may now name a bot — and only a bot, only in this workspace, and
only one that does not outrank you.

*Lives in:* `packages/basecamp/api/src/services/hub/hub.service.ts`
(`createBot`), `api/src/services/api-keys/api-keys.service.ts`
(`assertBotOwner`).

**2026-08-06 · Raw SQL is available through `asSystem()` only, on any schema
that declares access rules.** Fixes `FJS-005`.

`db.sql` goes straight to the read connection — no `@@gate`, no `@@allow`, no
`@guarded`, no `@scoped`, no `@@softDelete`, because all of those are enforced
above SQLite. For a deliberate escape hatch that is defensible. What was not is
that it was the **same function on every proxy**: `db.$setAuth(user).sql` closed
over the user and never read it, so a caller who had done everything right got
every row in the table, silently. Measured on one model with `@@allow` +
`@guarded` + `@@softDelete`:

```
$setAuth({id:1}).invoice.findMany()   → 1 row,  ssn absent
$setAuth({id:1}).sql`SELECT * …`      → 3 rows, ssn plaintext, another owner's
                                         row and a soft-deleted one included
```

**The unscoped client was the wider gap, not the narrower one.** An
unauthenticated `db.invoice.findMany()` returns **0** rows — the policy
evaluates with `auth() == null` and matches nothing — while `db.sql` returned
all 3. So the defect is not "the scoped proxy drops its scope"; it is that raw
SQL ignores the schema on every path and the ORM never does. That is why the
rule covers `db.sql` too, overturning `IDEAS/scoped-sql.md`'s "unchanged".

The rule:

| Surface | Schema declares access rules | It does not |
| --- | --- | --- |
| `db.sql` | **throws** | unchanged |
| `db.$setAuth(u).sql` | **throws** | unchanged |
| `db.asSystem().sql` | works — the documented bypass | works |

"Access rules" means `@@gate`, `@@allow`/`@@deny`, `@guarded`, `@encrypted`/
`@secret`, field-level `@allow`, `@scoped`. **Not** `@omit` or `@@softDelete`:
those shape what a read returns rather than who may read it, and refusing raw
SQL for a soft-delete column would fire on most schemas for a lifecycle rule.

**Coarse per schema, not per statement, on purpose.** Deciding per statement
means parsing the statement, and a hand-written SQL validator that is subtly
wrong grants a FALSE guarantee — worse than an honest raw hatch, because people
trust it. The escape routes are numerous and all real in SQLite (`main.` and
`temp.` qualification, `ATTACH` — which litestone exposes on the proxy —
`PRAGMA`, views created mid-statement, comment and string-literal tricks).
SQLite's own authorizer would be the right mechanism and **`bun:sqlite` does not
expose it** (verified: `Database` has no `setAuthorizer`).

The refusal names both ways forward: `asSystem().sql` to bypass deliberately, or
`where: { $raw: sql`…` }` to stay on the ORM — verified to keep every policy
(1 row, `@guarded` column still withheld).

**Scoped raw SQL as a capability — a per-identity view set — is NOT built.**
`IDEAS/scoped-sql.md` designs it; it is a feature where this is a defect, and
the consumer that made it urgent (`herald`, the AI agent surface) does not exist.
Revisit with `herald`.

*Lives in:* `packages/litestone/src/core/client.js`
(`schemaDeclaresAccessRules`, `rawSqlRefusal`, `_runRawSql`); 9 tests in
`test/litestone.test.ts` § "raw SQL and the access rules it cannot enforce",
5 of which fail if the refusal is removed.

**2026-08-01 · Gates enforce by default when declared; undeclared imposes nothing.**
Any model with `@@gate` is enforced from the first request via the shipped
`FrontierGateGetLevel` resolver (null user → STRANGER) even with no GatePlugin
installed. A user-supplied `GatePlugin({ getLevel })` replaces the resolver
entirely. Models without `@@gate` are completely open. `asSystem()` bypasses
(except LOCKED). Rationale: a declared gate that silently does nothing is a
fail-open security default — verified live before the fix.
*Lives in:* `packages/litestone/src/core/client.js` (default plugin injection);
tests in `test/elegance-fixes.test.ts`.

## Query & write semantics (Litestone)

**2026-08-01 · Unknown `where` fields: WARN on reads, ERROR on writes.**
Reads log once per model+field (did-you-mean hint) and still execute; writes
(update/delete/restore/upsert families) reject — a typo'd filter on a write is a
mis-scoped destructive operation. `AND/OR/NOT` are descended into; relation
sub-filters are not (their keys belong to the related model).

**2026-08-01 · Unknown `data` keys are silently stripped.**
Mass-assignment protection: pass a request body straight in without
whitelisting. This deliberately REPLACED an earlier reject-with-did-you-mean
behavior — do not restore the rejection. Safety net: a typo on a *required*
field still fails loudly via the required-field pre-flight.

**2026-08-01 · `take`/`skip` are rejected with a pointer to `limit`/`offset`.**
Prisma muscle-memory must fail loudly and helpfully, never be silently ignored.

**2026-08-01 · Missing required fields on create are a ValidationError.**
`name is required`, same shape as every other field rule — never a raw SQLite
`NOT NULL constraint failed`. Exempt: optional fields, arrays (implicit `[]`
DDL default), `@default`/`@updatedAt`/`@sequence`/generated/computed/`@from`,
`Int @id` (autoincrement). Applies to create/createMany/upsert-insert only —
updates stay partial.

**2026-08-01 · `@@strict` model flag: PARKED.**
(Would escalate read-warnings to errors per-model.) Revisit after the warnings
have been observed in practice; the warn infrastructure makes it nearly free.
*All four above live in:* `packages/litestone/src/core/client.js`
(`withArgValidation`, `checkWhereKeys`, `writeData`); tests in
`test/elegance-fixes.test.ts` and the rewritten block in `test/litestone.test.ts`
("write payload — unknown fields are silently stripped").

**2026-08-13 · Clock-relative derived fields: `@derived(expr)`, evaluated at query time.**
Supersedes the ruling written earlier the same day, which said no such tier
should exist. That ruling's reason does not hold: SQLite refuses a
non-deterministic function in a `GENERATED ALWAYS` column, because the column is
part of the table — it has no objection to the same expression in a `SELECT`, a
`WHERE` or an `ORDER BY`. Verified: `(dueAt < ? AND completedAt IS NULL)` works
in all three positions against one bound instant. The restriction was about a
storage strategy and was mistaken for a restriction on derivation.

```prisma
overdue Boolean @derived(dueAt < now() && completedAt == null)
```

Compiles three ways from one declaration — a SELECT expression for the value, a
substitution into `WHERE` to filter by it, a substitution into `ORDER BY` to
sort by it. This is not new machinery: `@from` already substitutes its subquery
into all three, and `where: { subCount: { gt: 1 } }` already works. A `@derived`
field is the same seam carrying a scalar expression instead of a subquery, with
the request's single instant (see `FJS-227`) as the bound parameter.

**Not `@generated`, and not a raw SQL string.** `@generated` creates a real
column — stored, migrated, indexable — and an attribute that sometimes creates a
column and sometimes does not is a migration trap. And the body must be the
**declarative expression language** `@@allow` already uses, not SQL text,
because a SQL string cannot travel: the browser cannot evaluate it. Being data
is the whole point.

**The client half is the reason this tier earns its place.** The JSON Schema
carries the expression and its dependency on `now()`, so a Mesa component knows
both that the value decays and how to recompute it — against the **viewer's**
clock and timezone, on a timer, without a refetch. Server and client can
therefore disagree by a few seconds; the viewer's clock wins for display, which
is correct. Litestone already compiles this language two ways (`compileSql`,
`evalJs`) and `verifyRowPolicies` already grades one against the other, so the
client evaluator is a function that exists and is tested. Unlike the four
`x-litestone-*` keys with no reader anywhere, this extension ships with its
consumer.

**The expression language gains a ternary**, right-associative and nestable:
`dueAt < now() ? 1 : 0`. It compiles to `CASE WHEN … THEN … ELSE … END` in SQL
and to a ternary in JS — **both halves or neither**, since a form added to one
compiler and not the other is the `FJS-195` defect exactly. This is also the
point at which the language stops being predicate-only and starts producing
*values*, so a `@derived` field's declared type is checked against its branches
at parse time.

**What survives of "store the boundary, not the state":** it was right about
what to *store* and wrong as a claim about what can be *derived*. `dueAt` is
still the column; `overdue` is a projection of it, not a second copy of the
truth. Nothing about a row's state is duplicated, so nothing can drift.

**Scopes shrink back to query shape.** A derived boolean gives
`where: { overdue: true }` for free, which was most of what a schema-level
`@@scope` was for. The existing `createClient({ scopes })` registry — named
fragments, chaining, all read methods, documented merge rules — keeps the cases
that are about the *shape* of a query rather than a fact about a row: bundled
`orderBy`, `limit`, `include`, and composition.

**2026-08-13 · Amended the same day: three tiers, not two. `@@scope` is
reinstated.** The paragraph above collapsed two different things into the
function registry, and the cell it emptied is one nothing else fills.

| | Declared in | Materialises a property? | A browser can name it? |
| --- | --- | --- | --- |
| `@derived(expr)` | schema | **yes** — row, generated type, JSON Schema, generated form | yes — `where: { overdue: true }` |
| `@@scope(name, expr)` | schema | **no** — a name and a predicate | yes — `where: { $scope: 'overdue' }` |
| `createClient({ scopes })` | JS config | no | **no** — server-side only, `db.task.overdue()` |

**The registry cannot be named by a browser, and that is the whole argument.**
Sierra's `createResource` sends a `where` **object** over HTTP; it cannot invoke
`db.task.overdue()`. Ruling that scopes live in the registry therefore moved
every query-shape scope to server-only without saying so. `$scope` is the one
spelling that travels.

The second cost is shape. `@derived` buys its filter by adding a property to the
model — carried in every SELECT, present in the generated type, in the JSON
Schema, and in any form built from it. Where the predicate is only ever a way to
*ask*, that surface is waste and it misdescribes the model.

`@@scope` is also about half the work: predicate-only, so `compileSql` alone —
no `evalJs` value branch, no dependency on the ternary (`FJS-234`), no branch
type-checking, no client evaluator, no JSON Schema property. What it adds is a
published name list, so `$checkWhere` accepts `$scope` and the client knows which
names are legal.

**The rule that keeps them apart: if the UI ever renders it, it is `@derived`; if
it only ever appears in a `WHERE`, it is `@@scope`.** A `@@scope` may reference a
`@derived` field.

`{ $scope: 'overdue', status: 'open' }` conjoins, and `$scope: ['overdue',
'mine']` is legal and also conjoins. Invariant 8 holds without an exception: a
`$scope` value is a **name looked up in a declared table**, never text
interpolated into a pattern — state that at the site, because it is exactly the
shape the invariant warns about.

## Migrations (Litestone)

**2026-08-01 · The executor owns the transaction.**
`apply()`/`autoMigrate()` strip in-file `BEGIN/COMMIT` + FK pragmas and provide
the real thing: one transaction per migration, ROLLBACK on failure,
`recordMigration` committed atomically inside it, FK pragma restored in a
finally. Generated files keep the in-file pair for hand-running in a sqlite
shell only.

**2026-08-01 · Rebuilds copy only the old∩new column intersection.**
Added columns are never named in the copy-SELECT (SQLite's double-quoted-string
fallback turns unknown identifiers into literals — this silently corrupted or
destroyed data). A rebuild that adds a NOT NULL column with no default is
generated BLOCKED (commented out, with fix options); `autoMigrate` reports
`state: 'blocked'` and does not write its hash, so it resurfaces every startup.
*Both live in:* `packages/litestone/src/core/migrate.js` + `migrations.js`;
tests in `test/migrations-fixes.test.ts`.

## API design (Junction)

**2026-08-13 · A service is a definition and a compiled runtime, and `methods:`
declares.** (`FJS-D01`, closing `FJS-016`.)

A Junction service was *options + methods + internals in one object*, ending in
`[method: string]: unknown` so actions hung off the same namespace as
configuration. Two things followed, and both had already shipped bugs.

Nothing could ask what a key meant. "Option or action" was answered by
exclusion — two hand-maintained sets — and six consumers re-applied that rule.
The sets had drifted across five copies once; the option-forwarding list, a
third statement of the same fact, stopped at `hooks` and made
`createService({model, softDelete})` **hard-delete rows** where
`createBaseService` soft-deleted them.

Nothing said when a service was finished being built. `hooks()` mutated the live
service and had to remember to null a cache that four writers touched, the
registry monkey-patched `hooks()` on the instance to recompile, and `callService`
read a ladder in which the cache **beat the app hooks the transport had just
handed it** — so a stale entry was a wrong answer, not a slow one.

**Ruled: go on the split, and only the split.** Export tiering (`FJS-046`) and
the middleware/hook renaming (`FJS-017`) were part of the original proposal and
are refused here; they stay open on their own merits.

The shape is Feathers 5's, adapted rather than copied:

| Feathers 5 | Junction |
| --- | --- |
| options are a separate `app.use()` argument | options stay on the definition; the built `Service` loses its index signature |
| options behind a `SERVICE` symbol | `describe()` — one answer for /manifest, OpenAPI and /metrics |
| custom methods **declared** in `methods:` | `methods:` declares; the scan is the compat fallback |
| a per-method hook manager owns the chain | `pipelines(appHooks)`, memoised on both inputs |
| `wrapService` guards re-wrapping | `Symbol.for('junction.service')`, and the loader tests it |

**`methods:` inverts.** It used to be validated *against* the scan; it is now the
source of truth, which is what makes an action nameable after an option key —
`cache`, `schema` and `channel` were eaten by the deny-list with no error at any
point. Absent, the scan runs exactly as before, so **inline actions stay
supported permanently and no app was migrated**. The one caveat is honest: an
option that is *typed* on `ServiceDefinition` needs a cast to be an action, since
`cache` cannot also be declared a function.

**What is not adopted:** Feathers' `Object.create(service)` prototype wrapper.
Feathers wraps user-authored instances it did not construct; Junction's factory
already returns a fresh object, and a prototype member is invisible to `{...svc}`
— which the autoloader and a dozen tests depend on.

**The measured result:** the typecheck baseline 211 → 199, one deleted line
accounting for most of it. Not the justification, though — the register claimed
the baseline was mostly this defect and it was not: 137 of the 211 were in tests
and examples. The justification is four bugs of one class, fixed four times.

**2026-08-10 · A method may answer what it likes; an ANNOUNCEMENT is about a
row, so it carries one.** (`FJS-D08`, closing `FJS-020`.)

A custom method's return value is also its broadcast payload, and those two jobs
want different things. A caller asked for `setVariable` and can be answered with
whatever suits it. A subscriber was told *this row changed* and has nowhere to
put anything that is not the row: the browser store upserts BY ID and replaces
wholesale, so an id-less payload is appended as a phantom row and a partial one
replaces the record and loses every field it omitted — in every open tab, with
nothing said.

Basecamp shipped four of them: `setVariable` answering `{ id, variables }`, the
deployment engine's five-field projection, `servers.heartbeat` answering
`{ ok, server_id, status }` with no id at all, and `jobs.trigger` answering
`{ id, queued: true }`. **All four were found by looking at a screenshot** — a
page doing the obvious thing rendered `undefined` as its heading while every
other assertion passed. *A partial row is indistinguishable from a full one
until it breaks.*

Three options, and the difference is who pays:

| | |
| --- | --- |
| Document the rule | What already happened. Four times, in one app, by the people who wrote the rule |
| Warn and send it anyway | Names the mistake, still corrupts every subscriber's store |
| **Send the row** | The announcement is correct whatever the method answered, and the service is told once so the *caller's* half gets fixed too |

The third. `announcementPayload()` in `core/litestone.ts` — one owner, called
from the one announcement point in `callService`:

- the payload when it already is a row (extra keys are fine — `{ ...job, queued: true }`
  is a row and a flag, and only an OMISSION makes it a projection)
- otherwise the row re-read by `payload[idField] ?? ctx.id`, which is why a
  collection-level action and an id-bearing one behave differently
- otherwise the payload, as the **signal** it is

**Dropping that last case was the first design, and it was wrong.** An action
that changes MANY rows has no single row to carry — `volumes.report` answers
`{ serverId, reported, added, updated, forgotten }` — and its subscribers use
the event as a trigger to re-read, not as a record. Suppressing would have
stopped a live screen updating with nothing but a server-side line to say why:
the same silent failure this ruling exists to remove, introduced by the fix for
it. Caught by asking what basecamp actually returns before running its drive.
The phantom-row half is closed on the client instead, where `Store.upsert`
refuses a record with no id — which is the better place for it anyway, since a
payload from a hand-rolled `channel.send()` never reaches the server-side check.

**The warning is once per `service.method`**, names the missing columns and both
ways out. Per-call would be a log nobody reads, which is the same silence in a
louder font.

**Two things are deliberately left alone.** `ctx.dispatch` — a stated payload is
a declaration of what to send, and second-guessing it would make one switch mean
two things. And a service with **no model**: there is no row for its answer to be
a partial version of, so nothing is inferred. *I cannot tell* is not *this is
wrong* — the same rule `$checkWhere` follows for an unknown accessor.

The response half is NOT fixed by this and cannot be: a method that answers a
projection still answers a projection, and a caller assigning it over a record
still loses fields. That is what the warning is for.

**2026-08-10 · An app's own User columns reach the session through one hook, at
the point the row is already in hand.** `createLitestoneAuth(db, {
sessionFields })`.

@frontierjs/auth OWNS `model User`; every app that uses it EXTENDS that model,
and until this existed there was no way to get an app's own column onto the
`SessionContext`. Basecamp needed three (`isSystemAdmin`, `status`, `kind`) and
the only route was to wrap `verifySession` and re-read the user — a **third
query on the hottest path in the app, forever**, for a row auth had just
fetched.

`sessionFields(user)` is called from `toContext()`, which is the single place
every issued session is built, so one hook covers login, `verifySession`, an API
key and `createUser` alike. Two kinds of thing belong in it: the **standing**
`sessionGateLevel()` grades on (`isAdmin` / `isOwner` / `isSystemAdmin` /
`activatedAt` / `verifiedAt`) — which is how an app whose privileged bit is its
own column reaches `@@gate` at all — and the app's own keys, which travel on the
session untouched and which only the app's hooks read.

It is spread **last**, so an app that states a field wins. The other order would
mean adding any key to `toContext` silently overrides what an app asked for,
which is a breaking change nobody would see.

*Lives in:* `packages/auth/auth.ts` (`toContext`), `packages/auth/types.ts`;
consumed at `packages/basecamp/api/src/core/session-auth.ts`. 83 auth tests
green, `example/` 37/37 unchanged (the option is additive).

**2026-08-10 · A saved view names a declared kind. It never stores a query.**
Ruled while building basecamp's `Dashboard` + `DashboardWidget`; the question
had been open since the screen inventory was written.

A dashboard widget has to say what it shows. The two candidates were a
free-form query stored on the row — `{ accessor, where, orderBy }`, one renderer
for everything — and a declared vocabulary, where a widget names one of a fixed
set of kinds and carries only a subject and a few knobs.

**A stored query is a read that no policy graded.** The row travels: it is
seeded, exported, copied between workspaces, and read by everyone who opens the
board. The policy does not travel with it — `@@gate` and `@@allow` grade a
CALLER against a MODEL, and neither can say anything about a string. So the
server would end up running a query one person wrote on behalf of another, at
the second person's privilege, with nothing in the schema able to see it. The
generous version of the same idea — validate the stored query at read time — is
`IDEAS/scoped-sql.md`, deliberately unbuilt for the reason recorded there: a
wrong validator grants a *false* guarantee.

**A declared kind reads through the service that owns the data.** Each kind
names a read this app already answers, and the browser makes that call with the
reader's own session — so a dashboard shows exactly what its reader could have
opened for themselves, and a card they may not read refuses in words rather
than quietly appearing for everybody. Nothing new is readable because a widget
exists.

**The vocabulary is an enum in the schema, which is what makes the picker
honest.** It reaches the browser as a `$def` on the model's JSON Schema — the
path every other enum already takes — so the Add-widget list is built from the
same declaration the column's CHECK constraint is, and cannot offer a kind the
write would refuse. What the schema cannot express (which kinds need a server,
which need an app, which config keys each reads) is one table in the service,
fetched by the screen through a `kinds` action rather than copied into the
bundle. A data test holds enum and table together in both directions.

The cost is real and accepted: **adding a widget kind is a migration.** That is
the honest price of a kind that cannot be added without something being able to
draw it — a widget nothing renders is a blank rectangle on somebody's morning
screen.

The same reasoning applies to anything else that saves *what to look at*:
a report, a filter preset, a scheduled digest. Name the shape; do not store the
query.

**2026-08-10 · Where a declared vocabulary cannot bound the act, the RECORD
bounds it — and the two live on separate screens with separate roles.** Ruled
while building basecamp's `/recipes/` and `/cleanup/`, the day after the saved-view
ruling above, because the obvious move was to apply that ruling again and it
does not apply.

A recipe is a saved shell script run on a machine. It looks like the same
question — something stored on a row that later decides what happens — but the
argument above turns on a fact that is not true here. **A stored query is
dangerous because it is executed at the Data boundary, where `@@gate` and
`@@allow` grade a caller against a model and a string cannot be graded.** A
script is not executed at that boundary at all: it is handed to an Outpost and run
on a machine, where there is no model, no caller and no grade. It runs at
whatever the Outpost has, for everyone, every time. A vocabulary of allowed
scripts would buy nothing — the danger is not *which read it stands for*, it is
that it is code.

So the safeguards are different in kind:

| | `/cleanup/` — declared | `/recipes/` — arbitrary |
| --- | --- | --- |
| What is stored | target names from a fixed list | a script |
| Refusal | an unknown target, by name | none possible |
| Authoring | developer | **admin or owner** |
| Running | developer | developer |
| Record | what the Outpost said it freed | the script AS RUN, per server |

**Authoring and running split, and that split is the point.** Writing the script
is the privileged act; running a vetted one is the ordinary act somebody on the
pager does at 3am. Collapsing them would make recipes admin-only in practice,
which is how people end up pasting the script into a terminal instead — the
thing this screen exists to stop.

**A run keeps the script it ran.** `RecipeRun.script` is a copy, not a foreign
key: a recipe is editable, so output read against a script that has since
changed is not evidence of anything. Same reason the run row is per SERVER —
a fleet run is N executions with N exit codes, and one row would have to pick a
single status for *three succeeded and two failed*.

**The declared half is declared as far as the tooling allows, and no further.**
`enum ReclaimTarget` is not in the schema, because `targets ReclaimTarget[]`
does not parse — *array [] is only supported for Text, Integer, File, or a model
name for many-to-many* (`FJS-141`). A declared enum beside a `String[]` column
would be two homes with no CHECK joining them, which is exactly the shape that
let `AlertRule.severity` default to a value its own API refused. So the list has
one home in the service, the API refuses anything outside it by name, the screen
fetches it rather than copying it, and a data test asserts the schema declares no
competing enum.

**The premise expired 2026-08-11.** `FJS-141` is closed: `targets
ReclaimTarget[]` parses, and the members are checked at the Data boundary. What
does NOT follow is that the enum belongs there automatically — the CHECK this
paragraph asked for still cannot exist (SQLite forbids the subquery `json_each`
would take), so the schema declaration buys the type, the JSON Schema `$def` and
one home, not a database-enforced one. Moving basecamp's list into the schema is
a live option and a migration; the decision above stands until someone takes it.
*Lives in:* `packages/basecamp/api/src/services/cleanup/targets.ts`,
`api/src/services/recipes/recipes.service.ts`, `api/src/engine/fleet.engine.ts`,
`db/schema.lite` § FLEET ACTIONS; tests in `db/test/schema.test.ts` § Recipe and
CleanupRun.

**2026-08-08 · A field that is accepted on the wire but is not a column is
captured in a BEFORE hook, never read from the method body.** Ruled while
building `channels`; the open half is `FJS-D23`.

Some payloads carry a value the model does not — and should not — declare. A
notification channel is created with the plaintext credential in `secret`, which
is deliberately not a column: the service lifts it into a `Secret` row
(`@encrypted`) and keeps only `secretId`. The same shape shows up wherever the
API takes something *about* a write rather than *part of* one — a confirmation
token, a "notify the owner" flag, a raw value that is stored somewhere else.

**Junction's derived `autoValidate(model, method)` deletes every key the model
does not declare, and user hooks run BEFORE the derived ones.** That ordering is
not incidental — it is what lets a hook shape `ctx.data` before validation sees
it, which is how `stampWorkspace` supplies a required column the client was
never meant to send. The consequence for a wire-only field is the mirror image:
**a before-hook is the only place it still exists.**

```ts
// The rule.
function captureCredential(ctx: ServiceContext): void {
  const data = ctx.data as Record<string, unknown>
  if (!data) return
  if (typeof data.secret === 'string' && data.secret) ctx.locals.credential = data.secret
  delete data.secret          // explicit, so the intent is not "autoValidate got it"
}

hooks: { before: { create: [requireWorkspaceRole(…), captureCredential, stampChannel] } }
```

`ctx.locals` and not `ctx.data`: locals is per-call scratch that nothing
serialises, which is exactly what a value on its way somewhere else should be.
The `delete` is written out even though `autoValidate` would strip the key
anyway — a reader should see the field leave the payload on purpose, and the
hook must behave the same if it is ever reused on a service with no model.

**Why the obvious alternatives are refused:**

- **Reading it in the method body.** This is what was written first, and it is
  silent: the service answered *Slack needs a credential — send it as `secret`*
  about a request that carried exactly that. The failure names the caller for
  the framework's behaviour, which is the worst kind.
- **Declaring the field on the model so it survives validation.** That puts a
  plaintext credential in the schema, in the DDL, in `x-`whatever reaches the
  browser, and in the audit trail. The whole point is that it is not stored.
- **`{ validate: false }` on the resource, or dropping `model:` from the
  service.** Both disable schema-derived validation for the *entire* service to
  admit one key — the coercion, the labels, the field rules and the required
  list go with it.
- **A second endpoint that takes only the credential.** Two writes where the
  user made one, and a channel that exists for a moment with no credential.

**The cost, stated:** nothing enforces this. A wire-only field is a convention
held by a hook and a comment; the framework cannot tell one from a typo, and the
symptom of getting it wrong is a message about the field being missing. `FJS-095`
is the same seam from the other side — *nothing can say "this column is written
by the system, not by a user"* — and the two want one answer, not two.
*Lives in:* `packages/basecamp/api/src/services/channels/channels.service.ts`
(`captureCredential`), `packages/basecamp/CLAUDE.md` § What bites here,
`CLAUDE.md` § Live hazards.


**2026-08-06 · A custom action announces like any other write, under its own
name.** Closes `FJS-D21`; fixes `FJS-033`. `callService`'s one announcement
point derives `orders pay` for an action exactly as it derives `orders patched`
for a patch — no past tense is invented, matching what the `publish()` hook form
had always put on the wire and what the browser client's `*` handler had always
upserted. Only `find` and `get` are excluded, by name.

The alternative considered was opt-in: an action announces only if it set
`ctx.dispatch`. Rejected because it makes the safe case the one you have to
remember — a transition is the ordinary reason to have an action at all, and a
framework whose live updates work for `patch` but not for `pay` until you add a
line is one that looks broken in the exact place it is being shown off.

Rulings inside the ruling:

- **An action that only READS opts out with `ctx.dispatch = false`.** At this
  layer a `search` action is indistinguishable from a `pay` one, so the leak
  direction is real and accepted; `dispatch` is the existing one switch,
  suppressing browsers and the in-process bus together. No new vocabulary.
- **Nothing announces without `channel:`.** Unchanged. Broadcasting is still
  opt-in per service, because row policies are evaluated on read and a broadcast
  does not re-evaluate them per subscriber.
- **The gap was structural, not a slip.** Both halves existed and neither side
  could see the other: the client listened for action events, the server sent
  none, and every app masked it by re-issuing `find()` after each action — which
  made the *acting* tab correct and every other tab stale. Nothing in the repo
  watched a client that had not acted until `example/web/test/verify-live.mjs`.

**2026-08-06 · A service narrows its method set with one key: `methods`.**
Closes `FJS-D07`; fixes `FJS-004`. Two forms on the same key —
`methods: ['find', 'get']` is the general allow-list, `methods: 'readOnly'` is
shorthand for exactly that list. Absent means every method, so nothing that
exists changes.

The allow-list is the general form because a narrower method set is not only
ever "read only": `['find','get','create','approve']` says *no patch, no remove,
one action*, which a boolean cannot express and which otherwise goes back to a
hand-written hook. `'readOnly'` is sugar **on the same key** rather than a
second option, so there is still one place to look.

Rulings inside the ruling:

- **CRUD and actions share one list.** Being defined on the service is not being
  offered; an action the list omits is refused like any verb.
- **405, not 404 or 403.** The route is real and the service exists; the verb is
  not offered, to anybody. A 404 sends someone hunting a mounting problem and a
  403 implies a different identity would succeed.
- **Enforced in `callService`, ahead of the hook pipeline.** That is the one path
  every caller takes, so an in-process `app.service('audit').create()` is refused
  exactly as the wire is — the alternative leaves jobs, engines and hooks free to
  do what a request cannot. Ahead of hooks because the policy is structural
  rather than authorization: nothing an identity could change, already public in
  `/manifest`, and running `before` hooks for an impossible call means running
  their side effects. Consequence, accepted: an anonymous caller gets 405 where
  it used to get 401.
- **An unknown name throws at construction.** `['find','gett']` would otherwise
  silently block `get` and only read as broken after a 405 in production.
- **The three advertisers filter by the same predicate** — `/manifest`,
  `/metrics` and the OpenAPI spec — so what a service answers and what it claims
  to answer cannot drift. `isMethodAllowed()` / `allowedMethodNames()` are the
  one owner, beside `isCustomMethod()` / `customMethodNames()`.

*Lives in:* `packages/junction/src/core/service.ts`; consumed by
`plugins/manifest`, `plugins/openapi`, `transport/health.ts`. 21 tests in
`tests/method-policy.test.ts`; 7 of them fail if the enforcement is removed.
First consumer: `packages/basecamp`'s `/audit`, which drops four hand-written
`MethodNotAllowed` stubs for one line.

**2026-08-01 · Custom service actions stay on `X-Service-Method` header dispatch.**
Proposal to move to sub-path dispatch (`POST /api/notes/:id/summary`) was
considered and declined. Case is preserved for action names (`getStats` works);
CRUD names remain blocked from header override; `restore`/`upsert` match
case-insensitively.
*Lives in:* `packages/junction/src/transport/bridge.ts`.

**2026-08-01 · `createService({ model })` carries the derived hook layer.**
The model path must always include schema-derived gates/validation
(`base.hooks` = user hooks + derived); hook-less custom actions run the `'*'`
(all-hooks) pipeline, never an empty one. Litestone error names map across the
package boundary: `AccessDeniedError` → 403, `ValidationError` → 400.
*Lives in:* `packages/junction/src/core/service.ts`, `core/hooks.ts`,
`core/errors.ts`.

**2026-08-02 · The result envelope has one owner, and `kind` is the discriminant.**
`{ kind, object, data, errors, total?, limit?, offset? }`. `kind` is `'single' |
'list'` and is THE field to branch on; `object` is the SERVICE name for both
kinds (`'posts'`, never `'list'` and never `'Post'`), so it is a stable identity
a client can key a cache or a type off. The shape was built in one place and
taken apart in twelve others, each with its own rules, and they had drifted:
the same `find()` returned a full envelope over HTTP, a bare array to internal
callers, and a bare array to the browser — `total` was reachable from curl and
nowhere else. Detection was `'object' in value`, which classifies any row with
a column named `object` as an envelope.
**The rule, everywhere: a list keeps its envelope, a single unwraps to the
record.** A list carries metadata that has nowhere else to live; a single does
not. `$wrap` is tri-state on the wire — absent = the rule, `true` = envelope the
single too, `false` = unwrap the list to a bare array (Feathers' `paginate:false`).
*Lives in:* `packages/junction/src/core/envelope.ts` — `wrapResult`,
`unwrapResult`, `resultData`, `isServiceResult`, `isListResult`, `single`, `list`.
Import them; do not reach into `.data`.

**2026-08-02 · `$` is transport syntax, not an internal data model.**
`ctx.query` is FILTERS ONLY (which records); `ctx.directives` is DIRECTIVES
(how to shape the result) — `limit`, `offset`, `orderBy`, `select`, `populate`,
`search`, `withDeleted`, `onlyDeleted`, structured and unprefixed. The bridge is
the only place that understands `$`. Conflating them is not theoretical: the
bridge stripped `$limit/$offset/$orderBy/$select` from `ctx.query` as "reserved"
while `parseQuery` looked for exactly those four keys there — the transport
deleted precisely what the query builder read, so pagination, ordering and field
selection were ALL inert over HTTP, and the unprefixed `?limit=1` became a WHERE
clause on a nonexistent column and returned zero rows. Internal callers pass
`{ directives: { limit: 10 } }` via `CallOptions`.
*Lives in:* `packages/junction/src/transport/bridge.ts` (`parseDirectives`),
`src/core/context.ts` (`QueryDirectives`, `RESERVED_PARAMS`),
`src/core/litestone.ts` (`parseQuery`).

**2026-08-02 · `errors[]` is load-bearing: bulk writes return partial success.**
Kept, not dropped — and now written to. A bulk create saves what it can and
returns the failures as `{ data, error }` pairs: the input that failed, paired
with why, so a caller can tell WHICH of fifty rows was rejected rather than
"some subset broke". This is Feathers issue #562's 2017 envelope proposal,
which never shipped there because the migration cost across its ecosystem
killed it; Junction had carried the field with nothing writing to it. Bulk stays
opt-in (`allowBulk: true`). Deliberate trade-off: rows are created individually,
so there is no all-or-nothing rollback — atomicity and partial success are
mutually exclusive; wrap the call in a transaction if you want the former.
*Lives in:* `packages/junction/src/core/envelope.ts` (`BulkFailure`,
`toBulkFailure`, `partitionBulk`, `BULK_FAILURES`), `src/core/litestone.ts`.

**2026-08-02 · One event origin, and broadcasting is declared on the service.**
A mutation is announced ONCE, in `callService`, and fans out to two consumers:
the in-process bus (`posts:created`) and the channel manager (`posts created`).
They were independent origins, which cost three separate things: two places
derived the event name and disagreed; `ctx.dispatch = false` suppressed the
socket but not the bus, so a hook that deliberately withheld a broadcast still
handed the record to every server-side subscriber including webhook fan-out;
and an app that forgot to wire the publish hook had half a real-time layer with
no signal. `ctx.dispatch` is now the single switch for both — `false` announces
nothing, any other value replaces the payload.
A service declares its target with **`channel:`** — `'posts'`, a
`(rows, ctx) => Channel` function, or `false` for a declared opt-out. Named
`channel` and NOT `publish` because "publish" is an ordinary action name
(publishing a draft — the openapi suite has exactly that service) and reserving
it as an option key would stop a service from having one. A noun cannot collide
with a verb-shaped action.
**Bulk writes announce once per record**, as Feathers does: the browser's
created/patched/removed handlers each take one record, so a single event
carrying an array lands as one malformed upsert.
*Lives in:* `packages/junction/src/core/service.ts` — `callService`,
`publishToChannels`, `PublishDeclaration`.

**2026-08-02 · Broadcasting is opt-in in the framework, opt-out in the scaffold.**
`createService({ name, model })` broadcasts nothing. `@@allow` row policies are
enforced when a row is READ, and a broadcast does not re-evaluate them per
subscriber — so a default of "announce everything" hands every connection in a
channel rows it could never have fetched. This is exactly Feathers' split: its
core publishes nothing without a publisher, and its *generator* scaffolds
`app.publish(() => app.channel('authenticated'))` — the line its own docs then
tell you to replace. `fli make:model` / `make:scaffold` emit `channel: '<name>'`
with the scoping warning attached, so a generated app is live out of the box and
the line is in front of the developer who has to narrow it.
*Lives in:* `packages/cli/commands/make/model.md`, `make/scaffold.md`;
rationale in `publishToChannels()`.

## UI substrate (Mesa)

**2026-08-05 · A component's composition API is snippet props, and a snippet's
arguments are getters.**
`{#snippet row(r)}` written inside a component tag is passed as the same-name
prop (VISION §9.5, implemented 2026-08-04), and `{@render row(order)}` hands
`() => order` rather than the value.

Why: a named slot cannot take a parameter, so a snippet prop is the only
parameterised composition the language has — a table that draws rows, a
component with a trailing icon per item, a list with a per-row action. And a
snippet's DOM is built once, so an argument read as a value is frozen at that
moment: the first version of this shipped a kit `Table` that drew its first
page of rows and then ignored the store. Reading through a getter keeps the
fine-grained model — the read happens inside each binding's own effect.

Consequence: a snippet held in a variable and invoked from ordinary JavaScript
takes `(anchor, ...getters)`.

**2026-08-05 · `$attributes` is the REST of the props, and a portal is a
delegation root.**
`$attributes` excludes everything the component declared, plus `class` (which
arrives as `$class` and is *merged* by `bindClassPassthrough`, never replaced).
`<mesa:portal>` registers its target as a delegation root for as long as it is
open, reference-counted.

Why both: a component kit cannot enumerate every attribute a caller might need
— `id`, `aria-label`, `title`, `data-*` — so forwarding has to be possible;
before this, `$attributes` was every prop unfiltered and spreading it wrote
`tone="danger" variant="ghost"` onto the DOM node. And delegated handlers are
found by walking from the event target up to a registered root: portalled
content is appended to `document.body`, outside the app's container, so every
menu item, command-palette row and toast dismiss button in `@frontierjs/ui` was
inert — correct markup, correct ARIA, no error, and a click that did nothing.
Reference counting is what stops the first of two open portals from taking
`document.body`'s listener away from the second.

**2026-08-05 · A compiler error fails the build.**
`analysis.errors` is not advisory: Sierra's `mesa-plugin` throws rather than
serving the module.

Why: a settings screen with five `bind:` errors in it — each one correctly
diagnosed as "must be a writable top-level `let`" — rendered, looked right, and
silently collected nothing, because the plugin forwarded `warnings` and never
looked at `errors`. A diagnosis nobody sees is the same as no diagnosis, and
this repo's recurring failure mode is exactly that: the compiler knew.


**2026-08-04 · `x = x` forces a notify — the same idiom for local state and for
watched imports.**
Self-assignment on a reactive binding compiles to a write that skips the
equality guard, so `user.score += 10; user = user` re-renders. It reads as a
no-op and deliberately is not one: it is how you say *"I mutated this in place,
notify anyway"*.

Why: the idiom already existed and already meant exactly this — for an
**imported** proxy root, `themeNew = themeNew` compiles to `$$fire_themeNew()`
(ES module bindings are read-only, so the assignment could never have been
literal). For a **local** `let` it compiled to an ordinary `$$set_user(user)`,
and signals write through `Object.is`, so the identical reference was skipped and
nothing happened. One idiom, two behaviours, no diagnostic — and the natural
guess for anyone arriving from Svelte, where `x = x` is the standard nudge.

**The force is per-write, never per-signal.** `track()` has carried an unused
`_alwaysNotify` flag that would have made a binding always notify; that is the
wrong shape, because it discards the equality optimisation for every ordinary
write to that binding. `createSignal`'s `write(next, force)` and
`set(tracked, value, force)` take the flag per call instead, and only the
self-assignment call site passes it. RULE 43 is unchanged: a bare mutation with
no assignment is still inert.
*Lives in:* `packages/mesa/src/compiler.js` (`rewriteAssignments`, beside the
imported-proxy case it mirrors), `packages/mesa/src/runtime.js`
(`createSignal`, `set`), VISION **RULE 43**; pinned by three tests in
`test/compiler.test.js`, one of which asserts an ordinary equal write is still
skipped.


**2026-08-03 · Scoped CSS binds to the selector's SUBJECT, not to an ancestor.**
A component's `<style>` rules are emitted by appending the component hash to the
**rightmost compound selector** (`button` → `button.mHASH`), and every element in
a styled component carries that hash. Two things follow, and both reverse the
previous behaviour: a component **can** style its own root element, and it
**cannot** reach the markup of a child component. Cross a component boundary with
`:global(...)`.

Why: the previous form emitted `.mHASH button` — an ancestor selector — while
putting the hash *on* the element, and those cannot both be true. `.mHASH button`
matches a button *inside* a `.mHASH` element, never the `<button class="mHASH">`
carrying it, so any rule targeting the component's own root silently did nothing
in every environment. It went unnoticed because a second bug cancelled it: the
prerenderer de-scoped CSS before shipping it, which made component styles apply —
globally, to the whole page. `addStyles` was well covered as a *mechanism* (19
assertions) and nothing had ever asserted that the selector matches the markup.

This is a **breaking change** for any component that styled a child's internals.
*Lives in:* `packages/mesa/src/compiler.js` (`_appendScope`, `_scopeSelector`, the
element writer), VISION **RULE 55**, `packages/mesa/CHANGES.md`;
computed-style proof in `packages/sierra/tests/fixtures/island-site/verify.mjs`.

**2026-08-03 · CSS scope ids are content-addressed, never generated.**
The component hash is `cssHash(styleContent)` — a pure function of the `<style>`
content, so the same component yields the same id in any process, any build, and
any compiler. It replaced `genId()` (clock + counter), whose one caller this was.

Why: three separate things needed it. Reproducible builds — output could not be
diffed or content-hashed, and checking a compiler change for byte-identity
reported 13 false differences that were all scope ids. Cross-compiler identity —
a prerendered island is compiled by Mesa's renderer *and* by Vite for its chunk,
and two ids meant the same rules shipped twice under two hashes with the markup
swapping class on mount. And debuggability — a class that changes every build
cannot be searched for.

**Hash the style content and nothing else.** Including the filename would break
cross-compiler identity the moment the two disagree about a path (absolute vs
relative, a Vite id with a query, a symlinked workspace) and would do it
silently. Two components with byte-identical CSS therefore share an id; that is
harmless, because their rules are the same rules.
*Lives in:* `packages/mesa/src/compiler.js` (`cssHash`, `processCSS`);
`genId()` remains exported and non-deterministic with no caller.

**2026-08-03 · A page assembles its own styles; the renderer offers both shapes.**
`renderComponent` returns `.styles` — `[{ id, css }]` per component in tree order
— alongside the concatenated `.css`, and `styleTag: false` suppresses the blob it
otherwise prepends to `.html`. A caller emitting `<style id="mHASH">` per
component gets dedupe for free: the id is the scope hash, so the runtime's
`addStyles` treats the block as already present. Sierra's prerenderer does this,
taking an island's CSS on a static page from three copies to one.
*Lives in:* `packages/mesa/src/render-component.js`,
`packages/sierra/src/build/prerender.js` (`wrapDocument`).

**2026-08-03 · The NEAREST delegation root owns an event; ancestors stay out.**
`_makeDelegatedHandler` now scans the composed path first and returns if any
registered root sits between the target and its own root. Before, each root
walked the path independently, so a handler ran **once per ancestor root above
it** — one click, two increments.

Roots nest whenever two mounted trees sit at different depths, and `mount()`
registers the anchor's parent element, so this is the ordinary shape for Sierra
islands: one island directly in `<main>` and another inside a `<div>` in that
`<main>` is enough. It went unseen because the fixture happened to put every
island in the same parent.
*Lives in:* `packages/mesa/src/runtime.js` (`_makeDelegatedHandler`), pinned in
`runtime.test.js` ("a handler fires ONCE when delegation roots nest").

**2026-08-03 · An ancestor island's mount is authoritative; `client:static`
under a live parent cannot be honoured.**
Mesa's `island()` short-circuits on the client, so a mounted island renders its
nested `client:*` children **directly** — live, in its own delegation root,
before their directives fire. Sierra's loader therefore defers to the ancestor
rather than racing it: a subsumed island resolves nothing and downloads nothing,
mounting clears the range as it stands *now* (not the scan-time list) and
disposes any descendant that mounted first. `client:static` inside a live island
is the one case with no correct answer — the parent renders its children — so it
warns instead of being silently reinterpreted. A `client:static` **parent** never
mounts, so it does not subsume anything inside it.
*Lives in:* `packages/sierra/src/islands/loader.js`, pinned in
`packages/sierra/tests/islands.test.js` and end-to-end in
`tests/fixtures/island-site/` (`Outer.mesa` / `Inner.mesa`).

**2026-08-03 · A prerendered page's CSS keeps its scoping; only the inlining
targets flatten it.** `renderComponent`'s `email` and `fragment` targets push
declarations into `style=""` attributes, so their selectors are consumed and
flattening them is harmless. The `html` target ships a `<style>` block, where the
hash is the only thing keeping one component's rules off another's markup.
*Lives in:* `packages/mesa/src/render-component.js` (`compileTree`, `opts.descope`).

---

## Design system (`@frontierjs/css`)

**2026-08-08 · There is no Menu term. A dropdown menu is Popover + Items.menu
+ a keyboard contract, and the third one is not CSS.**

Asked while building the wizard: does the vocabulary need Menu or Dropdown?

It does not, and the reason is the same one that made Bar and Toolbar two
terms rather than one with a variant. **A role is a promise the app owes.**
`role="menu"` tells a screen reader the list is one tab stop and the arrow
keys move within it; a stylesheet cannot implement any of that. A term named
Menu would advertise a contract the package has no way to keep, and the
person who trusted it would ship a menu harder to use than a plain list of
links.

The composition already exists and is what everything real uses:
`.popover` is the surface, `.items.menu` is the list, and the behaviour comes
from whatever opens it. `@frontierjs/ui`'s `DropdownMenu` is exactly that —
`.popover`, `.items.menu`, `role="menu"`, focus management — which is the
evidence rather than the argument.

**What was missing was a route, not a term.** Nothing could get you from "I
want a dropdown menu" to Popover unless you already knew the answer, so the
wizard's `anchored` question now names it, the Popover outcome states the
three parts, and the Popovers page has a Dropdown menu section with a live one.

**Three defects fell out of asking:**

- The wizard's own Popover markup taught the anti-pattern `lists.css` warns
  about in its header — `<li class="item">Rename</li>`, a row styled to look
  clickable with no control in it.
- `popovers.css` told you to position it with `class="popover absolute
  top-12 left-0"`, Uno utilities the package does not ship and, since the
  UnoCSS ruling, may not require. Replaced with anchor positioning, which is
  the platform's answer and needs no JavaScript. `[popover]` is in the top
  layer, so a `position: relative` parent means nothing and the menu opens in
  the corner of the viewport — worth stating, because it looks like a bug.
- **`.item` on a `<button>` or `<a>` needed a control reset nobody shipped.**
  The documented-correct way to build a menu row is to put a real control in
  it, and then the control arrives with a UA background, border, font and
  width the row cannot override — so everyone who followed the advice wrote
  the same eight lines. `lists.css` owns it now, scoped through `.items`
  because `.items.menu .item` is (0,3,0) and a bare rule loses the cursor on
  a disabled row. The copy in the kit is gone (`FJS-126`, closed 2026-08-08) — deleting it also removed a `gap: 0.625rem` literal that disagreed with `.item`'s own rung and could not move with density.

---

**2026-08-08 · The guide gets a decision wizard, and its tree names terms
only.** `guide/decisions.js`, first page of the guide, new `Learn` nav group.

The guide was 48 reference pages and no entry point. Every one of them answers
"how does Badge work" for somebody who has already decided they want a Badge —
and nothing answered the question that comes first, which of the 54 terms the
thing in front of you actually is. That question is where the mental model
lives: Pill or Badge, Bar or Toolbar, Alert or Toast or Dialog, Item or Row.

**A wizard rather than a lesson**, chosen deliberately over a linear
first-principles walkthrough. A lesson is read once; a decision tree is
returned to, and the near-miss pairs are the thing people get wrong repeatedly
rather than the thing they fail to learn initially.

**Questions are about behaviour, placement and promise — never about looks.**
That ordering IS the system. Pick the term first and the look is three further
decisions that all compose; pick the look first and you get
`class="card-small-blue-bordered"`.

**The tree holds no facts about a term.** An outcome names one, and the
element, class, tier and meaning are read out of `vocabulary.js` at render
time. What lives in `decisions.js` is only what the reference cannot hold: the
question that reaches a term, and the near misses. A distinction like
Pill-versus-Badge belongs to neither page alone, which is why neither page
could ever state it.

**Both directions are tested**, the same insight that made `vocabulary.spec.js`
worth having. Forward — every outcome names a real term — would eventually be
noticed by somebody copying dead markup. Reverse — **every shipped term is
reachable by some path** — never would: a component ships, the teacher does not
mention it, and the one page whose job is completeness is quietly incomplete.
`Chip` and `Surface` are the only exclusions, and they take a reason: they are
the two lineages, so you never choose them.

Writing it found **eight errors in the first draft that reading it could not**:
`.pill.outlined` and `.badge.outlined` do not exist, `menu`/`hover`/`divided`
belong on the list container rather than the entry, and `pills`/`stretch` and
the tone belong on `.tablist` rather than `.tabs`. Each would have rendered a
control that did nothing, which teaches that treatments are decorative. The
test that catches them asks whether the generated markup matches a rule it did
not match without the class — not whether the class exists, which it does.

---

**2026-08-08 · Syntax highlighting is `glow()` in `@frontierjs/utils`, and its
theme is element selectors in `@frontierjs/css`. Neither side knows a class.**

The guide had 137 code samples and no highlighting. The obvious shape — a
highlighter that emits `<span class="token keyword">` and a stylesheet that
styles those classes — was rejected on both halves of the split.

**The output is elements, not classes.** glow marks a token with the HTML
element that already means it: `<em>` a value, `<sup>` a comment, `<b>` an
identifier, `<strong>` a keyword, `<label>` an at-rule, `<i>` punctuation. The
whole theme is therefore `code[language] em { … }`, which means the package
ships **no new class** — nothing to add to `vocabulary.js`, nothing for a
consumer to import, and any other highlighter emitting the same shape is themed
for free. The wrapper carries the language as an attribute so a theme can key
on it without the caller adding anything.

**The function lives in `@frontierjs/utils`, not in `css`.** `glow(source,
opts)` is a string in and a string out with no clock, no I/O and no framework
import — the exact rule that package was created around, and its first export.
`@frontierjs/css` stays what it claims to be: CSS, no build step, `main` is a
stylesheet. `css` takes `utils` as a **devDependency** for the guide and the
test suite; nothing it ships imports it.

**The guide imports the sibling package's real file** — `../../utils/src/glow/
glow.js` — rather than vendoring a copy. A browser clamps `..` at the origin,
so `demo/serve.js` now serves the workspace root; over `file://` the path just
resolves. That is also why `guide.js` became an ES module. `vocabulary.js`
stays a classic script, because `test/run.js` inlines its source.

**The tone palette is clamped, not blended.** A tone is tuned as a *fill behind
white text*; as text on a surface it mostly fails. Measured across the eight
shipped themes the raw tones came in as low as 1.65:1, and only one theme had
all six roles above AA. Blending each tone toward `--ink` fixes it at 55% but
flattens every well-tuned theme equally. Instead each tone passes through a
lightness window in oklch — hue and chroma untouched — which is a **no-op
wherever the tone already reads**, so a theme that was fine stays looking like
itself.

The window is two tokens (`--code-l-min`, `--code-l-max`) rather than a
derivation because CSS cannot derive it: relative colour syntax exposes the
channels of one origin colour, and the origin is the tone, not the surface it
will land on. So a dark theme has to declare the inverted window, the way it
already declares `color-scheme: dark`. `code: every token clears AA in
theme-*` pins all eight.

Comments and punctuation are deliberately **not** derived — they are the
theme's own `--ink-mute` and `--ink-soft` verbatim, so retuning a theme's ink
ramp moves them, and a theme whose muted ink does not read is visible as a
theme defect rather than absorbed here (`FJS-125`).

---

**2026-08-08 · The tint ramp is three named tokens, and `tones.css` is the only place the percentages live.**
`--tint-surface` (10% into `--surface`), `--tint-rule` (30% into `--rule`),
`--tint-ink` (55% into `--ink`). The names say which token each one tints, so
there is nothing to look up.

Those three numbers already existed — inside `surface.css`, private to the
block lineage. An app that wanted a strip tinted like a toned Card had to
re-derive them by hand and then promise to keep them equal forever.
`surface.css` now *reads* the ramp instead of restating it, so there is one
definition and a test that fails if that stops being true.

**Not `lighten-N` / `darken-N`, and the difference is the reason.** A lighten
scale mixes toward **white**; these mix toward `--surface` and `--ink`, which a
theme redefines — so one set of percentages is correct in light and dark alike.
A fixed "lighten 90%" is a light-theme assumption wearing a neutral name. (The
v0.5 `lighten-N`/`darken-N` Uno shortcuts wrote `--bg`/`--color`, which no rule
ever read; they never worked and were removed in v0.6. These are not their
replacement.)

**Declared on the universal selector, deliberately.** Listing the seven tone
classes again would make adding an eighth tone *two* edits in `tones.css`, and
that file's whole promise is that it is one line. There is no selector for "any
element where `--bg-mix` is set", so the derivation is declared everywhere and
the cascade decides: `--bg-mix` is registered `inherits: false` with no
initial-value, so on an untoned element it is guaranteed-invalid, each
`color-mix()` becomes invalid at computed-value time, and the token stays unset
— which is what makes `var(--tint-rule, var(--rule))` degrade on its own. The
same mechanism means every element computes from its **own** tone, so nothing
leaks into an untoned child.

Every rendered colour in the package is byte-identical after the change —
verified in a browser against a captured baseline (toned/untoned Card, nested,
dark theme, both lineages), not assumed. Five tests in `tones.spec.js` pin it,
including one that overrides `--tint-surface` and asserts a Card follows.
*Lives in:* `packages/css/src/foundation/tones.css`; read by `surface.css`;
`guide/guide.js` → *Tones & contrast* → "The tint ramp".

**2026-08-08 · `Bar` and `Toolbar` are two terms. The difference is a promise, not a pixel.**
They render identically. `Bar` is a horizontal strip and nothing else — no
role, no keyboard contract, contents are whatever you put there. `Toolbar` is a
strip whose contents are *controls*, presented to assistive tech as one widget
with **one tab stop**.

Splitting them rather than renaming Bar, because both things are real and the
package already had both: this file's own comments used the word "toolbar"
three times to describe what `Bar` was doing. The word was load-bearing and had
nowhere to live, which is the definition of a missing term.

**`role="toolbar"` is the reason this needed a decision.** It is a composite
widget: Tab enters and leaves once, arrow keys move between the controls
inside. CSS cannot supply that, and this package ships no JS — so the same
split as `tabs.css` applies (Principle 6): *visual treatment is a class,
keyboard behaviour is a component*. The app owes a roving `tabindex`,
Left/Right, and Home/End.

The rule that follows, and the reason `Bar` is not deprecated: **a toolbar that
announces itself and then ignores an arrow key is worse than a plain Bar**,
because it has told the user a lie about how to operate it. If you are not
providing the keys, use `.bar` — same strip, promises nothing.

Layout is shared through `:where(.bar, .toolbar)` at zero specificity; defaults
differ because they follow the meaning (a Bar splits, a Toolbar packs to the
start). Bar's five rendered variants are unchanged — verified in a browser
against the previous computed values, not assumed.
*Lives in:* `packages/css/src/patterns/bars.css`; `vocabulary.js`;
`guide/guide.js` → *Bar* → "Bar or Toolbar?".

**2026-08-08 · The vocabulary covers everything the stylesheet ships, and a test says so.**
Six tiers / 35 terms → **eight tiers / 53 terms**. Nothing was designed: the CSS
already shipped every addition and the vocabulary simply did not name it.

The guide had claimed *"all 35 vocabulary terms ship CSS"* since v0.6. True, and
half the question — **the reverse was never asked, and it was false eighteen
times.** `table` had its own guide page and no term. `tabs`, `disclosure`,
`switch`, `progress`, `spinner`, `skeleton`, `empty`, `breadcrumb`, `pagination`
and the nav list all shipped unnamed. `stack`/`cluster`/`center`/`split`/
`container` were documented on their own page and absent from the list. And
**`chip` and `surface` — the two lineages every other term extends — were not
in the vocabulary at all**, while the Composition page taught nothing else.

Two new tiers, because neither fits the containment ladder: **Base** (Chip,
Surface) and **Layout** (Stack, Cluster, Center, Split, Container — Every
Layout's names, kept deliberately: it is the vocabulary people already have).

**The vocabulary moved out of the guide** into `vocabulary.js`, because a
vocabulary only the documentation knows about is one nothing can check. One
file, two readers: the guide loads it with `<script src>`, the runner inlines
the same source into its page. It is a classic script and cannot become a
module — the guide needs it to run *before* `guide.js`, and module scripts are
deferred past every classic one.

`test/specs/vocabulary.spec.js` asks both directions **against the real CSSOM,
not the source files** — the two disagree, because `.chip` and `.surface` never
appear as their own rule and exist only inside a `:where()` group, so a grep
concludes they are not shipped. A class containing `-` is Anatomy by the
package's own convention and is skipped; everything else must be a term or be
listed in `NOT_A_TERM` under tone / treatment / modifier / container / anatomy /
heading, with a reason. Shipping something unnamed now fails the suite, and the
fix is a decision rather than an edit that makes red go away.
*Lives in:* `packages/css/vocabulary.js`; `test/specs/vocabulary.spec.js`;
`guide/index.html` loads it.

**2026-08-08 · `Pill` is the count and `Badge` is the status. Kept, against the industry.**
The distinction is right and every large system draws it. Nobody agrees on
which word goes where, and **`badge` is the word they disagree about** — it
names the *count* in more systems than it names the *status*:

| System | The count | The status |
|---|---|---|
| **FrontierJS** | **Pill** | **Badge** |
| Atlassian | Badge | Lozenge |
| Material 3 | Badge | Chip |
| Primer | Counter label | Label |
| Polaris | — | Badge (Tag = a removable keyword) |
| Bootstrap | Badge for both; `rounded-pill` is a *shape* |  |

So FrontierJS agrees with Polaris and contradicts Atlassian, Material and
Bootstrap on the one word an arriving reader is most likely to have opinions
about. And `pill` is a shape word nearly everywhere else — Bootstrap's
`rounded-pill`, Uno's `rounded-full` — so it reads as a modifier rather than a
noun.

**Kept regardless.** The pair is internally consistent, both words are short,
and the shape carries the meaning rather than only the name: a rounded end
reads as a value, a square uppercase box reads as a label. Renaming buys
agreement with an industry that does not agree with itself, at the cost of
every app in the repo.

**What the decision obliges instead.** The failure mode is silent — a count in
a `badge` renders fine, nothing complains, and the vocabulary stops meaning
anything. So the collision is documented where a reader meets it, not only
here: the guide's *Badges & Pills* page carries the comparison table, and both
stylesheet headers state it. If a third place starts explaining this, that is
the signal the name lost.
*Lives in:* `packages/css/src/components/pills.css`, `badges.css`;
`guide/guide.js` → *Badges & Pills* → "What these words mean elsewhere".

**2026-08-08 · UnoCSS is supported alongside `@frontierjs/css`, not banned.**
Amends Invariant 13, which previously read "No UnoCSS, no utility classes,
anywhere." The semantic half of the invariant stands unchanged and is the part
that matters: style with a **tone** and a **treatment**, never a colour. What
is withdrawn is the ban on an app *also* running Uno.

The ban never described the package anyway. `packages/css/README.md` has
carried a measured §Using it with UnoCSS since v0.10.1 — layer position for
`uno.css`, the unlayered-reset trap that silently zeroes `.btn` padding and
`h1` size, and the three colliding class names — all verified against UnoCSS
66.7.5 with `presetWind3`. A repo-level invariant said "never" while the
package shipped the instructions, so the two documents contradicted each
other and the README was the one that had been run.

**The boundary that replaces it:** a package in *this* repo ships no utility
classes. `@frontierjs/ui`, `example/` and `basecamp` must render correctly with
Uno absent, because a component that needs Uno to look right cannot be used by
an app that does not run it. Uno is a consuming app's choice, one layer, opt in.

The `text-*` collision is now a third option rather than a fork: the scale is
`--text-*` tokens, so an app that prefers Uno's 4px grid retunes the tokens and
gets *one* scale under both sets of class names, instead of blocklisting.
*Lives in:* root `CLAUDE.md` Invariant 13; `packages/css/README.md`
§Using it with UnoCSS; `packages/css/src/foundation/tokens.css`.

**2026-08-08 · The type scale is tokens. No literal `font-size` in a component.**
`--text-2xs … --text-4xl` (11 → 36px) plus six unitless `--leading-*`, declared
once in `tokens.css`. The `.text-*` utilities and `h1`–`h6` read the **same**
rungs, which is why `.text-xl` and `<h4>` are one number rather than two that
agreed by hand.

Before this, 53 sizes were literal across 20 files, and 4 of them were written
in two spellings at once: `13px` **and** `0.8125rem`, `14px` **and**
`0.875rem`, `11px` **and** `0.6875rem`, `22px` **and** `1.375rem`. The px half
does not scale when a reader raises their browser's base font — so the same
nominal size was accessible in a table cell and not in a popover, in one
package, by accident. Every substitution was pixel-identical except
`.empty-title` (17 → 18px), which was off the ladder entirely.

Values are **literal** in `:root`, never `--text-sm: var(--text-md)` — the
2026-08-02 alias ruling above applies to this ladder exactly as it does to
`--ring`.
*Lives in:* `packages/css/src/foundation/tokens.css`; every file under
`src/components/` and `src/patterns/`.

**2026-08-02 · An alias token declared in `:root` is always wrong.**
If token A should follow token B, write the fallback at the *use site* —
`var(--ring, var(--color-primary))` — and do not declare A at all. The
`:root` form (`--ring: var(--color-primary)`) looks equivalent and silently
is not: the `var()` resolves once against `:root`'s own value and the result
inherits straight past every `.theme-*` override. This has now bitten twice:
`--badge-radius` (Elite's square buttons kept round badges) and `--ring`
(**every** focus ring in **every** theme was the default blue). There is no
case where the `:root` form does what it looks like it does.
*Lives in:* `packages/css/tokens.css`; tested in `test/specs/focus.spec.js`.

**2026-08-02 · One focus ring, in the last cascade layer.**
`focus.css` writes the whole recipe once, at `:where()` specificity, in the
`a11y` layer. Variation goes through `--ring-color` / `--ring-width` /
`--ring-offset`, never a second recipe. It is in the last layer so a component
cannot switch the ring off by accident — which is exactly what had happened:
`.btn.outlined { box-shadow: none }` and the ring's `box-shadow` were the same
specificity in the same layer, so outlined and link buttons had **no focus
indicator at all**. A consumer's unlayered CSS still overrides deliberately.
*Lives in:* `packages/css/focus.css`; `test/specs/focus.spec.js`.

**2026-08-02 · A Treatment class works on every element that reads it, or it is a bug.**
This was already the rule for the seven tones; it applies equally to
`.raised` / `.outlined` / `.ghost`. Only `.outlined` was implemented on `.btn`,
so a toolbar of `.btn.ghost` rendered as solid primary blue. The test for a new
Treatment consumer is not "does it look right" but "does every value of that
Treatment do something".
*Lives in:* `packages/css/buttons.css`; `test/specs/components.spec.js`.

**2026-08-02 · Competing background inputs compose through a variable, not specificity.**
Stripe, hover and tone all want a say in a table row and only one can own
`background`. They set `--row-base` and the tone mixes into it, so a tone
survives a stripe instead of being out-specified by it. Any future "several
things tint the same surface" follows the same shape.
*Lives in:* `packages/css/tables.css`; `test/specs/tables.spec.js`.

**2026-08-02 · `.icon` means "this element IS an icon". The icon-only button is `.btn.square`.**
**Breaking rename**, v0.10. One class cannot mean both, or `<button class="btn
icon">` sizes the button itself to 1.15em. Icon sizing is one rule in
`icon.css` — it was previously hand-copied into three files with three
different sizes and a missing selector branch — covering the components the
package owns, plus `.icon` for anywhere else, varied by `--icon-size`.
Note the old markup fails *quietly*: with `border-box` a width under
padding+border clamps, so a stale `.btn.icon` floors at 30x30 and looks
roughly right while having lost its `aspect-ratio` and padding.
*Lives in:* `packages/css/icon.css`, `buttons.css`; `test/specs/core-gaps.spec.js`.

**2026-08-02 · Interactive state is styled from ARIA, never from a class.**
`[aria-selected]`, `[aria-current]`, `:user-invalid`, `[hidden]`, `[open]`.
A class lets the visual state and the announced state drift the moment someone
updates one and forgets the other; keying off the attribute makes that
divergence unrepresentable. Every affected component has a test asserting that
adding `.active` / `.current` / `.selected` fails to fake it. The one documented
exception is a completed Step — there is no ARIA token for "done", so the markup
owes assistive tech a `.visually-hidden` word.
*Lives in:* `tabs.css`, `nav.css`, `steps.css`, `form-core.css`.

*(A 2026-08-04 ruling that Basecamp declare no `@@gate` was withdrawn the same
day. It rested on the premise that no `getLevel` could grade a `@frontierjs/auth`
session past `VISITOR(1)`; `example/` disproved that by running it —
`sessionGateLevel()` plus a one-line role wrapper grades a verified user 4 and a
verified admin 5. Invariant 6 has no exceptions. Basecamp's gates are outstanding
work, not a decision.)*

## Open (discussed, not yet ruled)

**Moved to `ISSUES.md` § Needs a decision (2026-08-05)** — every unruled question
in the repo is listed there with an id, so that "what is waiting on me?" is one
table rather than six. A ruling comes back **here** and closes the row there.

What was listed here, by its new id: `FJS-D01` junction structural refactor ·
`FJS-D11` bulk PATCH/REMOVE partial success · `FJS-D04` litestone `onEvent`
post-construction subscribe · `FJS-D06` coherence-review vocabulary ·
`FJS-D09` migrations second tier · `FJS-D10` the deferred API cluster.
