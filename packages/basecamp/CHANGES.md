# Changes — Basecamp

## 2026-09-05 — the container a release starts is named for the app

`deployment-run.job.ts` called `/deploy` without `app_id`, and outpost names the
container `fjs-${body.app_id ?? body.deployment_id}` — so every release started
`fjs-<deployment>` while `/stop`, `/health-check` and `/logs`, which all send
`app_id`, addressed `fjs-<app>` ([`FJS-920`](../../ISSUES.md#fjs-920)).

Three consequences and none of them said anything: the health step failed on
every release that reached it, the next release stopped nothing, and containers
accumulated one per release under names no route could reach. The fallback in
the route is what hid it — it made a missing field look like a naming choice.

One line at the caller, where the protocol is written down. Found by
`fli tutor:fleet`'s release half, the first thing to drive this pipeline against
a real Outpost and a real daemon.

## 2026-09-05 — Act as: the hub can stand in for a person, and the trail says who really did it

210 tests, 0 fail. `verify:screens` 66/66.

`FJS-142` is closed. `canStartSupport` is wired to the hub tier — `isSystemAdmin`,
the same fact `requireSystemAdmin()` reads — and **a system administrator may not
be a SUBJECT**: the ceiling is the subject's standing, so standing in for one
grants the thing the feature replaces.

**`AuditEvent` gains `onBehalfOfId` and a fourth `ActorKind`.** The framework's own
trail files an episode under the operator; this app writes a second,
application-level trail from `hooks.ts`, and without the same treatment the screen
an operator actually reads would name the customer while the framework's file named
the operator. `AuditEvent.subjectId` is the ROW acted on, so the person acted as
takes another word.

**The banner is in the shell, not on the hub screens.** An episode is global — the
operator navigates the whole app as the subject — so a banner that only rendered
where it was started is missing from every screen where forgetting it matters. It
renders from `session.user.support` and from nothing else; a banner derived from
local state is one that survives the episode ending.

The workspaces screen's *Impersonate* alert points at the users screen. A workspace
is not somebody you can act as, and picking one would still leave the question of
which of its members.

## 2026-09-05 — the settings standing pill follows a workspace switch (`FJS-894`)

`$: session.user` was the whole watch and the pill reads the membership row out of
`session.workspaces`, picked with `session.workspaceId`, so it kept showing the previous
workspace's role. The compiler had been naming the exact watch to add for as long as the screen
existed, into a channel nobody read (`FJS-845`, mesa).

## 2026-09-05 — four hooks that did nothing, and a form key that never landed

Found the moment junction started refusing a payload key that names no column
(`FJS-889`) rather than dropping it.

`deriveSlug` stamps `data.slug` from `data.name`. It was wired into the create
pipeline of four services whose models have no `slug` column at all — `Job`,
`AlertRule`, `Deployment` and `Domain` — so every one of them added a key the
write discarded. Three OTHER services (`secrets`, `channels`, `flags`) carry a
hand-written comment explaining they omit `deriveSlug` for exactly this reason,
which is the tell: the rule was known and enforced by whoever happened to
remember it. Two of the four (`Deployment`, `Domain`) have no `name` either, so
the hook could not even fire.

`/alerts/`'s create spread the whole form draft, including the `threshold`
control it had already folded into `condition: { operator, threshold }`. The
raw key went to the server on every rule created and was dropped there.

Nothing behaved differently for any of this, which is the point — it was
invisible for as long as the drop was silent.

## 2026-09-03 — every live screen in the app, off

`FJS-749`, `FJS-D191`. The whole live layer had been dead: eighteen services
declare `workspaceChannel(app)`, every model behind them is scoped on
`workspaceId`, and a graded broadcast was refused for all of them.

The claim those models are scoped on is resolved per REQUEST by
`membershipClaim`, off the workspace header. A connection has no request — the
channel wiring says exactly this, in a comment three lines above the membership
query it does instead — so the principal a broadcast is graded against carried
no `workspaceId`, and the tenancy `@@deny` fires on UNKNOWN.

`channels(setup, { claims })` answers it off the channel name, which is sound
here rather than a shortcut: the join reads `WorkspaceMember` through
`asSystem()` and puts a connection in `workspace:<id>` only where a membership
row exists, so being in the channel IS the verified claim.
`workspaceIdFromChannel` lives beside `workspaceChannelName` for the reason that
one exists — a name written in one place and read in another is a name one
caller can get wrong while every other caller keeps working.

Found from the outpost heartbeat, which was the visible symptom and not the
defect: the signed POST answers 200 and writes every column, and the screen
showed `pending` because nothing ever reached it.

## 2026-09-01 — the config is found from any directory

`createApp({ configPath })` is stated, anchored to `api/src/app.ts` itself, and
`api/config/junction.config.js` anchors its own `jobsDir` the same way.

**The default is `./api/config` resolved against the process CWD**, so this app
read its own config only when the command was typed at the package root. From
anywhere else it looked for `api/api/config`, found nothing, and booted on
junction's defaults — taking the declared CORS origins with it and replacing
them with `*`. That is `FJS-430` from the other direction: the file exists now,
and it was still possible to not read it. Nothing about a boot from the package
root changes; the three committed snapshots regenerate byte-identical.

**The database is deliberately NOT anchored.** `api/src/core/db.ts` explains why
and now explains it accurately: `database audit` does have an env var
(`AUDIT_PATH`) and nothing sets it, so the CWD is still what isolates the trail
— which `db/test/seed.test.ts` depends on and `web/test/verify-screens.mjs`
does not do, so that drive's audit rows land in the developer's own `db/audit/`.
Filed as `FJS-633`, and it is what keeps this app's three API snapshots at the
package root while `example`'s four moved into `api/`.

## 2026-08-30 — the last six screens, and the two adapters that had no boundary

`FJS-153` closed. 211 db tests, `verify:screens` 26 → 66 checks, typecheck at
baseline.

**The six the mock still had are built** — `/infra-graph/`, `/onboarding/`,
`/dns/`, `/cloud-spend/`, `/git-activity/`, `/observability/`. Two of them are
reads this app can already answer and four are a statement about a third party,
and the split is the whole of what was decided. `docs/SCREENS.md` § Phase 14
carries the argument.

**`infra` is a service over no model** — `graph` and `onboarding`, two
projections assembled from several tables where storing either would be a second
answer that goes stale. A browser cannot substitute for it: `apps.find` answers
the environment and the domains, and WHERE an app runs is only on `apps.get`,
one request per app. Three of the six onboarding counts go through `asSystem()`
because `Secret` and `Invitation` are `@@gate("5")` and `WorkspaceMember` reads
only the caller's own rows — so a developer asking *does this workspace have an
SSH key* got a refusal rather than a zero, on the screen whose whole audience is
somebody who just arrived.

**Two providers that did not exist now do.** `IEdge` (zones, records, edge
analytics) and `ICloudSpend` (month to date, line items, per-server) are
declared with stubs behind them, and `IGit` grew what `/git-activity/` needs —
`ci`, `openPullRequests`, `openIssues` per repository plus `listPullRequests`,
where it answered a name and a clone URL before. Money crosses that boundary as
MINOR UNITS plus a currency, never a float: the divisor is the currency's, and
`/ 100` is wrong for the yen.

**The portal now reports ten in two kinds.** `hosted` on the entry separates an
appliance an operator installs and points a URL at from somebody else's service
reached with a token, because *unconfigured* means different work for each.
`/admin/adapters/` renders the two groups off that flag, and it is what let the
four adapter screens stop hardcoding their own status: each asks the portal for
its one adapter, so the words on the page change the day one is wired rather
than the day somebody remembers to edit them.

**A resource with no model can say so** — `createResource(name, { model: null })`,
shipped in sierra. Three here (`portal`, `hub`, `infra`) warned on every boot
about a model name that was never going to resolve, which is how a real warning
gets skimmed past.

## 2026-08-26 — capabilities adopted, and the never-escalate guard grew its second axis

`IDEAS/permission-sets.md` step 7 · `FJS-529` closed. Typecheck at baseline.

`Server` and `Environment` declare `@@capabilities`, `Environment.variables`
carries `@capability`, and `WorkspaceMember.capabilities` is the grant column —
10 capabilities, grouped by model, which is a picker. The two models are the
design's own worked examples: *restart a machine* is authority every developer
grades USER(4) for and only some of them are on call for, and `setVariable` is
one write to `Environment` that the gate had no way to separate from renaming it.

`api/src/core/capabilities.ts` is the one owner of role → set. Every membership
write stamps through it — setup, the hub, an invitation accepted, `addMember`,
`setMemberRole`, the seed and the test fixtures — so a grant a fixture invents
cannot differ from one production writes. A role is a DEFAULT set and not a
synonym for one: the column is the truth afterwards, which is what lets an
operator take one grant off one person without inventing a role to hold the
difference. `setMemberRole` re-stamps rather than merging, since leaving the old
grants behind would make a demotion change a word on screen and nothing else.

**`refuseRoleAboveOwn` is `refuseGrantAboveOwn` and grades two axes.** `FJS-529`
proposed the subset rule as a replacement for the ordinal one; that is wrong here
and the suite said so. `admin` and `owner` hold the same grid — what separates
them is the workspace itself, which is the gate's business — so a subset test
cannot tell an admin minting an owner from an admin appointing an admin, which is
`FJS-410` arriving again. The ladder catches a step UP, `grantsWithin()` catches
a step SIDEWAYS, and neither subsumes the other. Both spellings a payload can use
are graded by one rule.

It stays a hook rather than becoming the column's own guard, and the reason is
measured: all three membership writers go through `asSystem()` — membership
decides access and cannot be read through the caller it decides about — and
`asSystem()` has no principal, so *what you hold* is undefined there rather than
merely skipped. Litestone's `Capability[]` guard covers every other door.

**Two `capability-ladder` warnings are deliberate.** `fli check` says a model
graded by capability usually wants its gate flat at the read floor, and `Server`
and `Environment` keep `@@gate("2.4.4.5")`. The grant table is bounded by the
gate — a developer is never handed `Server.drain`, which is `@gate(5)` — so the
ladder never refuses a legitimate holder, and it is what still catches a grant
mis-stamped by a bug, a migration or a hub screen. The warning names something
the rule cannot judge from the schema alone; this is the answer.

## 2026-08-26 — every service reaches the REQUEST's client, not the app's

`FJS-519` part 2. Fourteen sites across eleven services moved from
`app.db.asSystem()` to `$.db.asSystem()`. The app-level client carries no
principal and therefore no tenant claim, so under `strategy row` it read and
wrote **every** workspace with a 200 — and part 1 made `asSystem()` keep the
tenancy scope of the client it is reached from, which only helps a client that
has one.

**A rename rather than a per-site judgement**, which is what the measurement
bought: `$.db` resolves on every READ, so the lazy `const sys = () => $.db.asSystem()`
that eleven of these files already had resolves against the call it is invoked
inside. Eight of the models involved are genuinely tenant-scoped — `AppServer`,
`Channel`, `DeploymentStep`, `Invitation`, `JobRun`, `Recipe`, `Volume`,
`Server` — so those eight gained real scoping. Three touch `@@tenant(none)`
models (`User`, `WorkspaceMember`, `Workspace`) and are unchanged in behavior;
they moved anyway, because leaving them means carrying an allowance forever.

**Three sites stay, and each has a reason rather than a deferral.** `/hub/` is
the cross-workspace tier and reaching every tenant is what it is for.
`api-keys/scopes.ts` reads the key record that DECIDES the caller's access —
the class `core/hooks.ts:142` is excluded for, and through a client already
scoped by that answer it could refuse every API key as unrecorded.
`jobs/job-schedule.ts` runs at BOOT, where there is no call scope at all and
`$` throws by name; it restores every tenant's schedules deliberately
(`FJS-327`).

The eleven deferred allowances in `scripts/ci-allowances.json` are gone. The
three that remain say why they are correct instead of when they will be fixed.

210 tests pass, typecheck clean.


## 2026-08-26 — a rollout percentage that applies

`FJS-124`. `rollout` was stored, returned by `resolve`, and applied by nothing, so a
flag at 10% behaved as on-or-off for its whole life.

What was owed was less a branch than an **agreement**: the decision has to be made where
the user is, per request, in whatever language the SDK is written in — so the server and
every SDK must land on the same answer for the same user, or the percentage names a
different tenth in each of them.

**MurmurHash3 x86 32-bit over `<flagKey>:<unitId>`, mod 100**, published beside
`resolveIn()` and executed by it. Each part is load-bearing:

- **murmur3** — synchronous, dependency-free, ~30 lines, stock implementation in every
  language an SDK might be written in. A crypto hash is reproducible too, but WebCrypto
  is async and a flag check sits in a render path.
- **the flag key inside the hash** — so two flags at 10% do not select the same tenth.
  Hashing the unit alone gives every flag one cohort, and a staged rollout then tests the
  same unlucky group over and over.
- **mod 100** — matching `rollout Int @gte(0) @lte(100)`. A finer bucket is a number the
  column cannot express.

`variantFor` is the same rule salted apart (`:variant`), because sharing one bucket puts
everyone at the front of a rollout into the first arm of the experiment they are there to
test. A pinned variant on an override still wins — that is a decision somebody made.

`resolve` takes an optional `unitId` and decides for it, reporting `bucket`, `inRollout`
and `on` beside the configured `isEnabled`; a screen explaining *why* needs the pair, and
"this user is at 47, the rollout is 10" is the sentence that makes a percentage
trustworthy. Absent, the answer is exactly what it was. This service never invents one.

**`rollout` now defaults to 100**, on the flag, on the override and in `setOverride`'s
coercion. That is not a detail: `isEnabled` is the switch and the rollout NARROWS it, so
the pair a new flag starts with has to read "off, and when you turn it on, everyone".
At `@default(0)` enabling a flag did nothing for anybody the moment an SDK started
bucketing — with the screen showing it on — which is a percentage feature whose default
percentage is nobody. Rolling out to nobody is `isEnabled: false`, the state that already
says it. A stated 0 is still a real 0; the fallback fires only on an absent column.

**The canonical vectors are asserted first**, because they are what makes *use a stock
murmur3* a sufficient instruction. Then the three properties a rollout is used for, none
of which follows from the hash being correct: even spread, independence between flags,
and that raising 10 to 20 never takes the feature off anyone. 22 tests, no fixture.

## 2026-08-26 — three detail screens watch their row instead of holding a copy

`service.get(id)` answers a plain object and nothing reaches a plain object, so
`environments/[id]`, `projects/[id]` and `servers/[id]` were stale from the
moment somebody else wrote the row — and looked correct throughout, because each
re-reads after its own actions and never after anyone else's (`FJS-533`).

`servers/[id]` is the interesting one: the ROW is a subscription now, and the
`on('*')` handler it already had is kept for the TRAIL, which is a custom method
no announcement carries. Its `act()` no longer assigns the answer over `server`
— the move's own announcement carries it — because assigning would race that
push and win with the older object.

The other detail screens were left deliberately. `apps`, `dashboards`,
`blueprints`, `deployments` and `jobs` compose children in `get()` that the list
read does not carry, and a store node holds one shape: watching them drops the
children at the first push. Measured rather than reasoned — converting
`apps/[id]` took `bun run verify` from 302/302 to two failures on hostnames.

## 2026-08-26 — `Server`'s engine moves say they are the engine's

Five of `Server`'s eight declared moves are decided by a machine, and the schema
had no way to say so. `checkIn` carried `@gate(8)`, which admits no caller at
all, and the four `report*` moves carried nothing.

They carry `@system` now (`FJS-D150`), and the four reports carry `@gate(5)`
beside it, because a person presses *Sync from provider* and the provider's
answer decides the move: the engine makes it, an administrator asks for it.
`sync` names the column on the write — `transition(id, move, { system: true })`
— so the caller keeps their gate, their row policies and their audit actor,
which `asSystem()` would have cost.

**What it recovered**: `checkIn` was declared `@gate(8)` and the machine had
never run. The heartbeat writes `status` as one column of one update — splitting
it out would write and announce the row twice for a single check-in — so it
carried its own `CHECK_IN_FROM` set under a comment admitting the two had to
agree by hand. The set is gone; the from-state is asked of the schema through
`transitions(row)`, off the row already in hand.

## 2026-08-26 — the audit trail is a window that grows

`/admin/audit/` read `service.find(…, { limit: 50 })` — a hard cap with nothing
saying rows were missing, which reads exactly like a trail that has fifty rows.
And a trail is the shape a numbered page is worst for: it only grows, and it
grows at the end a reader starts from, so between asking for page 1 and page 2
every offset has moved by however many things happened in between — a row served
twice and another skipped, on the one screen in this app whose job is to be
complete.

It is a window now (`FJS-D145`). `load()` takes the first one, `more()` grows it
from the far edge by the sort keys of the last row rather than by a count of
rows before it, and the rows live in the resource's store — this screen holds no
array of its own, so a row cannot be in the window and not on the table.

**The service half is `findWindow`**, junction's own, rather than a second copy
of the two paths. The audit find is hand-written on purpose (it forces
`workspaceId` and declares the three filters it exposes), and `getPagination`
grew `after` beside `limit` and `offset` — a hand-written find that reads two of
the three answers page one to every press of *load more*.

**The drive found a framework defect doing it** (`FJS-535`): five fixture rows
sharing one `createdAt` across the 50-row edge, two of them gone, because the
page was ordered by `createdAt` alone while the cursor was minted in the total
order. `web/test/audit-fixture.mjs` is the fixture that makes it visible — the
seeder writes about fourteen trail rows per workspace, which is a fine example
and a useless window, since a window with nothing past its edge cannot be told
from a hard cap.

Nine checks in `verify:screens`, and two of them are the argument: three rows
written ABOVE the window between reading it and growing it, which under an
offset would repeat three rows from page one; and the tie block, which under a
cursor built from the sort column alone loses two.

`/activity/` still reads a flat 100 and is deliberately unchanged: it merges the
trail with `servers.feed`, sorted by time, and growing one source alone makes
the tail of a merged feed silently one-sided. A window there is a cursor on the
fleet's own events first.

## 2026-08-26 — one name for the Data boundary

`app.data` is gone. It was a second claimed name for the object already on
`app.db` — `app.data === app.db` was true — and it existed because junction
typed `App.db` as `unknown` and Invariant 5 forbids narrowing a field by
redeclaring it. So this app claimed a name it could type, and then the alias won:
29 reads against `app.db`'s three, with the declaration itself saying *nothing
here reads it, and nothing should*.

Junction now exports `interface AppDb {}` (`FJS-532`), so the type comes from an
augmentation:

```ts
declare module '@frontierjs/junction' {
  interface AppDb extends BasecampDb {}
}
```

`app.claim('data', db)` is deleted and all 25 reads are `app.db`.

**One test failed and it is the one worth recording.**
`restore-schedules.test.ts` builds its app by hand — `{ data: env.db, jobs,
logger }` — so the rename moved the source and left the stub, and four cases read
`undefined.asSystem`. A hand-built collaborator is exactly what the house rule
about fake clients is about, and a rename is where it shows.

182 pass, typecheck baseline unmoved. This does NOT move anything onto `$.db`,
which is `FJS-519` part 2 and is a per-site judgement — the hub reads across
tenants on purpose, three caravan handlers have no service call to resolve
against, and `core/hooks.ts` resolves the claim itself.

## 2026-08-26 — a spent nonce outlives the process, and two derived columns say who writes them

**`OutpostNonce`** (`FJS-376`). Replay protection was a module-level `Map`, which
is per PROCESS: a request captured at one replica replayed at the other passed,
and a restart forgot everything still inside the five-minute window. It is a
table now, in the app's own database, where the outbox and the job queue already
put what must survive a process.

The primary key is the nonce, and that is the mechanism rather than a detail:
**the claim is the INSERT.** Asking whether the row exists and then writing it is
a race between exactly the two replicas this exists for — both would find it
absent. A duplicate key is refused by SQLite atomically, and that refusal is the
replay. Anything other than a `UniqueConflictError` propagates: reporting a
broken database as *replayed* refuses the request, which is the safe direction,
and hides the breakage behind a 401 that reads as the caller's problem.

Three tests, and two of them fail against the old Map — a nonce written straight
into the table is refused by a process that never verified the request carrying
it, which is the second replica expressed testably.

**`ApiKey.tokenHint` and `credentialId` are `@system`** (`FJS-095`). Both are
derived from a token that does not exist when the request is made, and
`tokenHint` was NOT NULL and therefore in create-mode `required` — so a browser
validating against the schema refused every create by naming a field the form
has no box for. The app fills them by naming the columns on the write, which
keeps the gate, the row policies and the audit actor where `asSystem()` would
drop all three to set two values.

`ApiKey.mesa` still says `validate: false`, now for one column and a stated
reason: `userId` is genuinely caller-supplied, since a key may be issued to a
bot. The way out is an owner control on the create form, not another annotation.

## 2026-08-26 — the audit trail is scoped by the schema, and a null means nobody

`AuditEvent` said `@@tenant(none)` and declared no policy, so the only thing
keeping one workspace's trail out of another's was `audit.service.ts` putting
`workspaceId: ws()` in its own `where`. One door, where a gate is every door —
a job, a hub screen or a `fli tinker` session at ADMINISTRATOR(5) inherited
nothing from that hook (`FJS-432`).

The model's header argued the other way: a null column never equals a claim, so
scoping it would hide the rows with no workspace rather than sharing them. True,
and it is the intended reading rather than the cost of it — the framework had
already ruled that a row holding no tenant belongs to nobody and stays invisible
(`FJS-D05`, restated as `FJS-D141`). So the fix is a DELETED line: `@@tenant(none)`
goes, the declared `tenancy { }` applies, and the scoping shows up in
`db/access.snapshot.md` where a hook never could.

**The database is what settled it.** 19 null-workspace rows: 6 hub actions, and
**12 `jobs.startRun`/`finishRun` that lost their stamp** — those methods are
`internalOnly()` and therefore exempt from `sessionScope`, so
`ctx.locals.workspaceId` was absent and a workspace's own `Job` runs filed under
nobody, invisible to the one feed that wants them. Under *null means global*
that is a feature; under the ruling it is the defect it is.

Fixed first, and separately: the audit hook already re-reads the subject row to
build its diff, so the subject's own `workspaceId` answers second and a
`Workspace` is its own workspace. Sealing the meaning in over a mis-stamped
column would have hidden those rows permanently behind a policy that looks
correct.

Three tests, each red without its half — the boundary read across two
workspaces, the null row reachable by `asSystem()` alone, and a `startRun` that
files under the job's workspace.

## 2026-08-25 — the tenant crossing is asserted, not assumed

`db/test/schema.test.ts` runs a fifth executed check beside the four it already
had: `verifyTenantIsolation()`.

It answers the half the row-policy test **reports** rather than grades. That test
compares a compiled WHERE against litestone's own JS evaluator and declines a rule
holding a `check()` by name — which on this schema is the fourteen models scoped
through a parent, and its own comment says skipped rows are the normal state.
`FJS-382` is what that costs: two implementations of `check()` disagreed about a
null foreign key, four dashboard widgets went empty with a 200, and the checker
called the policy correct throughout.

The new one executes the crossing instead — seed a row for tenant A, then have
tenant B and a caller holding no claim try to reach it, on read, create, update,
delete and post-update. No second implementation is involved, so a delegation is
graded by being run.

**31 graded (17 by column, 14 by delegation), 14 exempt, 18 uncheckable behind a
gate above 7, no leak.** The fourteen had never been graded by anything.

Coverage is asserted as a SET rather than a count — every model the schema
declares that is not `@@external` and not on a jsonl/logger driver must appear as
graded or exempt — so the suite survives the schema growing and still fails a
model that quietly drops out of the check. Proved to fire by appending a model
with no tenant column and no scoped parent to a copy of this schema: it reports
`unscoped` by name.

## 2026-08-25 — Server.status is a declared machine

`@@transitions(status, …)` on `model Server` (`FJS-507`). Eight moves in three
tiers, and the tier is the gate: no gate is a person at the model's own update
level, `@gate(5)` is a person one level up, `@gate(8)` is the machine's own
report and nothing below `asSystem()` reaches it.

**The bug it closes is the read-then-write.** `getScoped()` read the row and
`db().server.update()` wrote it in a second statement, so two concurrent drains
both read `online`, both passed the from-check and both wrote — a lost update
with no error, and a server recorded online while it was draining. The
declaration narrows the UPDATE's own WHERE to the from-state, so exactly one row
matches and the loser gets a retryable `TransitionConflictError`. Two drains in
flight is the assertion, because a sequential test cannot see it.

**Three role hooks are gone rather than joined.** `drain`/`undrain` are
`@gate(5)` and `reboot` takes the model's update level, which is what
`requireWorkspaceRole` was saying in a service file where `db/access.snapshot.md`
could not see it. 11 gated transitions in this schema became 19.

The cost is that litestone refuses in litestone's vocabulary — *requires level 5,
user has level 4* — and an operator has never seen a level. One app-level
`registerErrorMapper` turns it back into a role, reading the ladder
`basecampGateLevel` already grades with; `Deployment.rollback` gets it free.

**`sync` asks the machine instead of writing a mapped value.** `transitions(row)`
answers what is legal from where the row IS, so a provider reporting `running`
for a machine basecamp is DRAINING is simply not in the list — where the old
status map wrote it and silently undid the drain. A report that cannot be acted
on is recorded as an event rather than swallowed.

`heartbeat` keeps its single write: the status is one column of one update, and
splitting it out would write the row twice and announce it twice for one
check-in. Its from-set is declared as `checkIn @gate(8)` — `FJS-506`'s marker for
a move the engine makes — and a system client bypasses enforcement, so the two
have to agree by hand and the comment says so.

**The browser's copy went too**, and that is where `FJS-512` came from: the
screen asks `resource.transitions(row)` now, and the obvious shape for consuming
it — one Set, `{#if moves.has('drain')}` — does not update. The Set re-derives
and the blocks testing it keep the branch they had. One `$:` per button, each
reading `server` directly, is what works; the mesa fixture that rules out every
suspected cause passes 7/7.

## 2026-08-25 — five screens, and a drive of their own

`/blueprints/`, `/registry/`, `/hub/backups/`, `/hub/settings/` and `/settings/`
— the last of the mock's model-blocked views (`FJS-153`). 35 of 41 now exist.

**`bun run verify:screens`** is the new drive: 26 checks in a real browser,
seeding a database of its own in a temp directory and starting and stopping both
servers, so it touches nothing local and never asks anybody to reset a dev fleet.
Separate from `verify`, which asserts the first-run wizard owns an EMPTY app —
three of these screens are about rendering a populated catalogue, and an empty
grid looks exactly like a broken query.

**It found three things the build did not.**

*`Switch` hands `onchange` a boolean; `Input` hands `oninput` an event.* Both new
forms had been written with `e.target.checked` on a Switch, which reads a
property of `undefined`, throws inside the handler, and leaves the control
looking dead. The build was green and the screens rendered.

*A row that stays `pending` on screen while the job has already finished it.* The
backup job completes in ~80ms and writes a real archive. Every other list here
learns about a change from the socket and this one cannot: `announceDataWrites`
broadcasts through the app's channels, the only channel this app has is the
WORKSPACE's, and `Backup` is `@@tenant(none)`. The screen polls while an archive
is in flight and says why.

*And a drive that passed for the wrong reason.* The first version of that check
polled the history table's TEXT for `success` and a size — which the SEEDED
archive already matched, so it passed before the new row existed and would have
passed with the button disconnected. Rewritten to poll the row count first and
the new row second; the same class as an overlay assertion that only asks
`querySelector`.

**What the screens refuse to pretend.** Deploying from a blueprint is not wired
and the page says so — it needs a `blueprintId` on `App` and a path from params
to an app's environment, and inventing either would make a button that loses the
record of what something was built from. The registry offers neither sync nor
delete, with the reason on the page rather than a disabled control. Restore is
absent from backups, because restoring is replacing the database this process is
reading from while it serves. The hub settings screen has none of the mock's four
credentials. And three of its switches say out loud that they are stored and read
by nothing yet.

| | |
| --- | --- |
| Screens | 5 new · 35 of the mock's 41 views |
| `verify:screens` | 26/26 in a real browser |
| Tests | 168 pass, 0 fail |
| `fli check` | 21 rules, nothing to report |
| Typecheck | 14, at baseline |
| Snapshots | routes regenerated |


## 2026-08-25 — the seed learned the six new models

`db/seed.js` wrote nothing for anything added this session, so every new screen
would have been built against an empty list — which is the state that looks
exactly like a broken query.

**The catalogue is `db/blueprints.js`**, eight applications read out of the
mock's own `BLUEPRINTS` constant rather than invented, converted column for
column: the nested `app` block flattened (those columns are `App`'s where they
overlap) and `params` written as `BlueprintParam` rows, because that list is an
ordered form rather than a document. 31 params across the eight, and all three
`ParamGenerator` values are exercised.

**`brandColor` is set on one of the eight.** Four took their color from the
mock's own theme object (`T.blue`, `T.red`) — a design-system token, not a
vendor's brand. Copying those would put this app's palette in a data column and
call it somebody's identity, so they are null and the card falls back to its own
surface.

**Ghost is seeded withdrawn**, because *deprecated* is a state the list has to
hide and the detail page has to still resolve, and a catalogue where every row is
live cannot show either. Measured: 7 offered of 8, and the CMS category correctly
absent from the filter list.

**The registry mirror seeds a SHARED DIGEST on purpose.** `latest` and the newest
version tag are one image, and a registry stores those layers once. On
`acme/dashboard` that is 922MB summed per tag against 738MB per digest — a 25%
overstatement of the number somebody uses to decide what to delete, which is the
case `registry.repositories` was written for and now has data behind it.

**Two notification preferences, not fourteen.** A preference row exists only
where somebody has chosen, and `find` merges stored over default — seeding
everybody would erase the *chosen* against *default* distinction the screen
renders, which is the half that would go unnoticed.

`--force` had to learn them too: none of the four installation models carries a
workspaceId, so nothing in the existing clear list takes them with it. A re-seed
would have failed on the first blueprint's `@unique` slug and on `HubConfig`'s
constant primary key, both reading as a broken seeder rather than an incomplete
clear. Verified by running `--force` twice.

**And `db/test/seed.test.ts` was carrying the same defect it exists to catch.**
Its header describes a `--force` list that had drifted eleven models behind the
schema — and the tables it CHECKED were a hand-written list of sixteen, which
knew about none of the six added this session. The question is asked the other
way round now: every table in the database must have rows unless it is named in
`NOT_SEEDED` with a reason, so adding a model is a choice between seeding it and
saying why not, and neither one is silence. The exemptions are asserted EMPTY
too, so a table that starts being seeded cannot keep an exemption whose reason
has quietly become false. Proved by removing one entry and watching it go red.

| | |
| --- | --- |
| Seeded | 8 blueprints · 31 params · 15 registry images · 1 backup · 1 hubConfig · 2 preferences |
| Tests | 168 pass, 0 fail |
| `fli check` | 21 rules, nothing to report |
| Typecheck | 14, at baseline |


## 2026-08-25 — services over the six new models

Five services and one job, over the models the previous entry added. `blueprints`,
`registry`, `backups`, `hub-config`, `notification-preferences` — 27 services now,
and 5 job files.

**Four of the five take no workspace, and the SCHEMA is what makes that work.**
`tenantClaimGuard` runs app-wide, ahead of anything a service writes, and refuses
a signed-in caller with no tenant claim; it exempts a service whose model is
`@@tenant(none)`. So declaring the tenancy in the seed is what makes these
reachable, and a hook could not have done it. The exemption lives in junction,
keyed off this app's schema, and neither file names the other — the test that
would catch it moving is a sysadmin with no workspace on the session reading the
catalogue.

**What it found.**

*A closed create schema strips a relation in silence.* `blueprints.create` was
written to take its params inline, the way the mock's export format holds them.
It cannot: the derived create schema is `additionalProperties: false` and
`params` is a relation, so `autoValidate` removes the key before the method runs
— a blueprint with no form and no error. `@transient` is the declared answer and
is unavailable because the relation already owns the name, so the payload is
refused by name in a hook running AHEAD of the validator, which is the only place
the key is still visible.

*`@version` binds a state change, not just a form.* Withdrawing a blueprint
stamps `deprecatedAt`, and litestone refused it — `revision` is `@version`, so
every update carries the revision it read. `asSystem()` would have dropped the
gate, the audit actor and the announcement to withdraw one row.

*A shared digest was charged twice.* Two tags of one digest is the ordinary case
(`v2.14.1` and `latest`) and a registry stores those layers once, so a per-tag
sum reported double what the disk holds — the number an operator uses to decide
what to delete.

**Two deliberate absences.** `registry` offers no sync and no delete: the
`IRegistry` interface answers `listTags(repo): string[]`, so a sync would invent
`digest`, `sizeBytes` and `pushedAt`, and deleting a mirror row deletes nothing.
`backups` writes `local` only and refuses `s3` at create rather than queueing a
row that will fail for a reason already known. The job itself is real —
`VACUUM INTO`, SQLite's own consistent online backup, because a file copy of a
live WAL database silently omits whatever is still in the `-wal`.

**And the FJS-375 change earned itself the same day.** Five new services mounted,
and the proxy-path test went red because `surface.snapshot.md` was stale.
Regenerating the snapshot updated the dev proxy and the deploy's Caddy config
with no edit to either — which is the whole of what that change was for.

| | |
| --- | --- |
| Services | 27 (+5) · 5 job files (+1) |
| Tests | 162 pass, 0 fail (65 API-tier + 97 schema) |
| `fli check` | 21 rules, nothing to report |
| Typecheck | 14, at baseline |
| Snapshots | surface · jobs regenerated; the proxy list followed |


## 2026-08-25 — the models the last screens needed

`docs/SCREENS.md` said ten of the mock's 41 views were unbuilt and that most of
them were blocked on the Data realm. Recounting it off the mock made that eleven,
and this pass took the model-blocked group: **six models, four enums, and one
case decided the other way** (`FJS-153`).

| Model | Tenancy | Gate | The decision in it |
| --- | --- | --- | --- |
| `Blueprint` | `@@tenant(none)` | `1.7` | A curated catalogue, not a per-workspace one |
| `BlueprintParam` | `@@tenant(none)` | `1.7` | A child model, not a Json array |
| `RegistryImage` | `workspaceId` | `2.8.8.5` | Mirror a registry, do not query it live |
| `Backup` | `@@tenant(none)` | `7.7.8.7` | The outcome is the machine's, like every *Run |
| `HubConfig` | `@@tenant(none)` | `7` | One typed row, and no credentials in it |
| `NotificationPreference` | `@@tenant(none)` | `1`, own row | Per person, not per membership |

**A marketplace is not a tenant's.** Every entry in the mock is third-party
software, so a workspace-scoped `Blueprint` gives each tenant a private copy of
the same nine rows — and the other option, a nullable `workspaceId` meaning
*shared*, is the shape `FJS-432` is still an open question about: a null never
equals a claim, so row tenancy hides exactly the rows meant to be global.

**`HubConfig` holds no credentials, and the mock's screen showed four.** The auth
secret, agent secret, Resend key and Infisical token are read at BOOT, before any
database — a row would never reach the running process — rotating one is a deploy
rather than a form, and `Secret` already models credential material with
`@encrypted` data. What is left is configuration a person can genuinely change
while the app runs.

**Onboarding got no model.** All six steps the mock shows are questions the
database already answers; a stored `done` is a second answer that goes stale the
moment somebody deletes what it recorded. The mock stores them because a mock has
no database.

**What it found.** `baseUrl` was written `@trim @url @length(1, 300)`, and
`verifyConstraints` refused it by name: every string long enough to exercise the
length is refused by `@url` first, so the boundary was never checked and a pass
would have been a pass on the wrong refusal (`FJS-351`). The `@length` came off.
Separately, four documents disagreed about how many models this app has — 37, 38
and 39, plus 38 in the root map — and the `@@tenant(none)` count said *seven* and
had been nine for some time. Both corrected everywhere.

**Nothing sits on top of these yet** — no services, no resources, no screens, and
the seed writes none of the rows. Deliberate: a service written against a model
nobody has opened a screen onto is two guesses stacked.

| | |
| --- | --- |
| Schema | 45 models, 26 enums · 45 gated · 34 policied · 14 `@@tenant(none)` |
| Tests | 151 pass, 0 fail (48 API-tier + 103 schema) |
| `fli check` | 21 rules, nothing to report |
| Typecheck | 14, at baseline |
| Release | every new model classified **expand**; the six contract findings are pre-existing |
| Snapshots | ddl · access · jsonschema · release · `schema.d.ts` all regenerated |


## 2026-08-25 — the proxy list is read off the app, not remembered

`web/config/api-paths.js` told the dev proxy and the deploy's Caddy config which
paths belong to the API, because this app mounts services at `/{service}` with no
prefix — `GET /projects` is the service AND the page, and only `Accept` tells them
apart. It was a hand-kept copy of the service registry and it went stale six
times (`FJS-375`).

**Three of the six were never this app's to remember.** `/connections` is
junction's channels plugin, `/account` and `/sessions` are auth's,
`/conduit-targets` is conduit's — services that answer on this origin and are
named nowhere in this app's source. `/connections` was still missing when this
was written.

The file now parses `surface.snapshot.md`, which `junction surface` writes off
the built app and which CI's `snapshots` phase already reruns with `--check`. A
service added to the API reaches both proxies by regenerating a file CI forces
you to regenerate anyway.

**The parse is graded against the running app rather than the file it read.** A
change to junction's output shape would otherwise leave it finding fewer paths
and saying nothing, which is the same silence one layer along — so the test walks
`app.services.list()` and `buildRoutes(app)` and asserts every mounted service
and every raw route is proxied, that `/` is not (the shell, mounted by
`staticRoutes`), and that `/ws` is stated rather than derived, the channels
plugin having upgraded in the transport and mounted no route.

It broke the image on the way past, which is the part worth keeping: the
Dockerfile copies `api db web tsconfig*` and not the snapshot, while
`bun run build:web` runs INSIDE the image and loads `vite.config.js`. The SPA
build stopped before a line of it ran. One `COPY surface.snapshot.md ./`.

The durable fix `FJS-375` named — give the API an `apiPrefix` — is untouched and
now free: with a prefix the derivation answers that one path and retires itself,
which is asserted so adopting it stays a config change.

| | |
| --- | --- |
| Tests | 151 pass, 0 fail |
| `fli check` | 21 rules, nothing to report |
| Typecheck | 14, at baseline |
| Image | `docker build` exit 0, SPA built inside it |
| Proxy | 7 probes through a real dev server: JSON reaches the API, a document gets the shell, an unmounted path falls to Vite |


## 2026-08-25 — a job runs as whoever asked for it, and the dispatch says so

Five handlers opened `app.data.asSystem()` behind a comment saying a job has no
caller to scope to. It has had one since 2026-08-23: caravan records the actor
and the tenant at dispatch, junction re-binds both through `app.runAs`, and the
membership is READ AGAIN when the job runs — so an actor who lost access between
asking and running is refused rather than replayed (`FJS-384`).

**What adopting it means is not what the register assumed.** Measured against
this app's own schema: every row these handlers write is gated at SYSTEM for
update — `RecipeRun`, `DeploymentStep` and `CleanupRun` at `@@gate("2.4.8.8")`,
`JobRun` at `2.8` — and the highest standing a workspace grants is `owner`, 6.
That is the schema saying a run's outcome belongs to the machine and not to
whoever asked for it, and a gate refuses regardless of standing. `asSystem()`
there is the declared design; the comment above it was what was wrong.

**What was missing is confinement.** Nothing stopped a handler writing another
workspace's rows: an id off a payload was written wherever it pointed. Each
handler now goes through an `internalOnly()` method on the service that owns the
row, which reads the PARENT through the caller's own client first — a release,
run or job in another workspace answers nothing — and only then does the gated
write as system. The audit actor and the announcement come back with it.

**The rule is: the dispatch declares, the handler asserts** —
`api/src/jobs/context.ts`.

| | |
| --- | --- |
| `runsAsCaller` | refuses unless the queue recorded an actor AND a tenant |
| `runsAsApp` | refuses when it recorded one — running somebody's request as the app is the escalation pointed the other way |
| `runsEitherWay` | `job:run`, the one job dispatched by a person AND fired by a cron |

The cron fire in `job-schedule.ts` states `actor: null` explicitly. Caravan would
have defaulted to nobody there anyway — which is what makes stating it worth
doing: the default is right by accident, and the handler's refusal only means
something if the other side said what it meant.

`job:run` keeps ONE write path for both modes. Its service methods are exempt
from `sessionScope` (a cron fire has no session and names no workspace, the same
shape `invitations.preview` has) and `jobInScope` reads through the caller's
client where there is one and the system client where there is not — a cron fire
is the app acting on its own behalf and legitimately spans workspaces.

Nine methods across four services, every one `internalOnly` and every one in
`surface.snapshot.md`: junction answers 405 to a name `methods:` leaves out,
in-process included, so an engine method has to be declared surface and the hook
is what keeps it off the wire. `ctx.transport` is `'internal'` for an in-process
call — measured, not assumed.

Two things fell out on the way. `deployment:run` pushed the row to open screens
by hand after every step and `job:run` pushed nothing at all, so a job that ran
left every screen showing the previous history until it was reloaded; both are
the service's job now and cannot be forgotten. And `failDeploy`'s four writes —
the release, the steps it left behind, the app's status and the event — are one
call, where they used to be able to half-happen.

5 tests, including the one that matters: an `owner` of one workspace cannot open
a run in another, the owner of that workspace can, and the same principal moved
to a wire transport is refused by the hook rather than by the session.

## 2026-08-24 — an admin could still promote themselves, through the one door a person uses

`FJS-410` had two halves declared in the schema — `@@deny('update', userId ==
auth().id)`, then four `@@allow`s once the read turned out to be undecided — and
the register recorded what was left as *the sentence a person needs*. It was not
a sentence. Driven through `@frontierjs/testing` against the real app, an admin
naming their own `userId` with `role: 'owner'` got no throw, a 200, and OWNER(6).

**No policy can reach that path.** `members()` is `app.data.asSystem()`, because
membership is what decides access and cannot be read through the caller it is
deciding about — and `asSystem()` is the context every policy is bypassed in. The
boundary was holding a job, a hub screen and a `fli tinker` session, and the one
door with a person behind it was open.

Three refusals in the service tier, because the escalation has three shapes and
*not your own row* is only the first:

- a **self-check** in `setMemberRole` — your own role, in either direction;
- **`refuseRoleAboveOwn()`** on `workspaces.addMember`, `workspaces.setMemberRole`
  and `invitations.create`, because an admin who cannot promote themselves can
  invite an address they own AS owner and sign in as it. Registered per method
  and not on `all`: `role` is a word two other models use, and a hook grading
  every payload carrying the key would refuse a fleet write for holding the
  wrong kind of role;
- an **outrank check**, because `Cannot demote the last owner` only catches an
  admin demoting an owner where there happens to be exactly one.

Equal is allowed. An admin appointing an admin is what the role is for; it is
the step UP nobody may take on their own authority.

The members screen narrows both pickers to the roles the caller may hand out —
a slice of `WorkspaceRole`, which is declared in ascending authority, rather than
a fourth copy of the ladder `core/gate.ts` grades on — and disables the row that
is your own. An affordance; the refusal is the service's.

6 tests in `api/test/services.test.ts`, mutation-checked in three directions:
neuter the hook and two go red, the self-check one, the outrank check one. 143
tests, typecheck at baseline, `fli check` clean, `surface.snapshot.md`
regenerated (two hooks where there was one).

## 2026-08-24 — the four auth models are imported, not copied

`db/schema.lite` declared `Credential`, `Session`, `Verification` and
`OauthFlow` by hand. It had to: each needs a relation back to *this* app's
`User`, `@@log(audit)` and `@@tenant(none)` — identity spans workspaces, and row
tenancy otherwise reports a model with no tenant column — and none of that can
be in a file `@frontierjs/auth` ships.

Litestone's new `extend model` is where those three now live, so the schema
imports `@frontierjs/auth/schema.lite` and owns none of the columns. 39 models
still.

**What the copies had already cost:** `@guarded(all)` on
`Credential.accessToken` and `refreshToken` where the package writes `@secret`.
The comment above them argued the deviation on grounds that were true of
`Session.token` — looked up by value, so a random IV cannot answer — and are not
true of these two, which are read back and used. Turning OAuth on here would
have stored every provider access and refresh token unencrypted. 137 tests were
green either side of the divergence, because nothing anywhere compares a copy to
its original. Importing fixed it without anyone deciding to.

`model User` stays declared here, and that is the split auth already draws:
`user.lite` is appended into an app's schema to be extended and edited,
`auth.lite` is imported.


## 2026-08-23 — a required secret nothing read

`AUTH_SECRET` is gone from `core/env.ts`, `deploy/build.mjs`, the README and this
package's own notes (`FJS-360`). It was `required: true` with a public
placeholder default, and `NODE_ENV=production` refused to boot over a value no
code path here would have used — the README said as much, as though it were a
safety property. Nothing read it: a session is a row found by a random token.
`ENCRYPTION_KEY` is the credential this app actually has, and losing it still
loses every `@encrypted` column in the volume.

## 2026-08-23 — the entry moved out of `src/`, and four file-relative paths moved with it

`FJS-D128`: `api/index.ts` is the entry and starts the app, `api/src/app.ts`
builds one and never starts it. Basecamp had `api/src/index.ts` +
`api/src/core/app.ts` — recorded in `PROJECT_STATE.md` as a deliberate departure
from the layout the root README calls canonical, which is what a departure
nobody re-argues looks like after a while.

**What the move actually cost was four `new URL(…, import.meta.url)` paths**,
every one of them computed from `src/core/` and every one of them silent when
wrong. `../config` fell back to `defaultConfig` through a `.catch()` — the same
shape as `FJS-430`, where this app read a config directory that did not exist for
its whole life and ran with CORS `*` for everyone; the surface snapshot is what
caught it, because `corsPlugin` simply stopped appearing in the plugin list.
`../services` cost 23 tests with `Service 'projects' not found`, which is
`FJS-458` arriving from the other direction. The migrations directory and the
SPA's `index.html` were the two nobody would have noticed until a deploy: a
missing migrations path and a 404 on `/`.

They resolve off the file rather than the CWD for a good reason — a deploy starts
the app from the image root and a drive starts it from the package — and that is
exactly what makes them survive a move by pointing somewhere plausible and wrong.

Also moved with it: `bun run stop`'s pkill pattern and the two browser drives,
each of which spawned `api/src/index.ts` by literal path.

## 2026-08-23 — nothing in the browser names the workspace any more

Sixteen resources hooked `stampWorkspace` before create — a client putting the
active workspace on a record the server was going to overwrite — each with a
comment saying the browser would otherwise refuse the create because the column
is required. It has not been required for a while: the tenancy declaration
desugars a `@default(auth().workspaceId)` and litestone leaves an `auth()`
default out of create-mode `required`.

**Deleting the hook is what found the defect it was covering.** The column was
still WRITABLE, so `make()` seeded it, sierra's blank-strip turned the seed into
an explicit `null`, and a stated null is a value — the default never applied and
`/projects/create/` answered 400. Fixed in litestone: a tenancy-stamped column
is `readOnly`, which is `@system`'s treatment for `@system`'s reason
(`FJS-387`).

**And one service really was relying on the browser for its tenant.**
`invitations.create` writes through `sys()`, and a system client carries no
principal for the Data boundary to read a default from — so the only thing
putting `workspaceId` on that row was the hook. It stamps `ws()` in its own
before/create now, which is what `channels.createSecret` beside it already did.
Everything else here writes through the scoped client and is stamped at the
boundary.


## 2026-08-23 — the eight appliances are providers, and three names got an owner

`infra/` is gone. Its eight adapters — Infisical, Unleash, Typesense, Zot,
Forgejo, Grafana, NetBird, Nango — now live in `providers/` beside `executor.ts`
and `outpost.ts`, because that is what `FJS-D06` rules the word to mean: a party
outside the app that a capability speaks to. Infisical is one in exactly the
sense Hetzner is, so two folders were naming one concept. `BasecampInfra` →
`BasecampProviders`, `buildInfra` → `buildProviders`, `app.infra` →
`app.providers`, and the portal's `config_key` strings read `providers.*`. That
last rename is free: nothing had ever set `infra.*` in a config file — the keys
exist to tell an operator where a value would go, and the portal UI is the only
thing that reads them.

**Three names on the app object were being assigned rather than claimed**, under
a comment saying `app.claim()` is the guarded namespace claim. Only `data` went
through it. The other three each turned out to be a different problem.
`providers` was simply a missing claim and is one now. `logger` was junction
building a throwaway (`opts.logger ?? createLogger(…)`) and this app discarding
it a few lines later — `createApp({ logger })` is an option that already existed,
so it is passed in and the overwrite is gone.

`db` was the one worth arguing about. This app must pass the Litestone client to
`createApp` — that is what installs `withLitestoneDb` — so junction puts it at
`app.db`, and the next statement replaced it with the raw handle. One name, two
meanings, twelve lines apart. Now nothing is replaced: `app.db` stays what
createApp was given, `app.data` is the name this app uses for it, and the raw
`bun:sqlite` handle is claimed as **`app.sqlite`**. The single reader was
`hub.overview`, which reached it as
`(app.db as { db: { query: … } }).db` — and removing that cast turned the next
line red, because it had been declaring `get()` returns `any`. `sqliteVersion`
now reads through `raw.query<{ v: string }, []>(…)`. The cast was buying silence,
not safety.

**`AuditEvent.mesa` was not resolving its model.** It said
`createResource('audit')`, and `audit` is already singular — so the registry
looked for `Audit`, found nothing, warned, and degraded to a bare `make()` with
no field rules, no coercion and no validation behind it. Every other irregular
here states its model; this one had been missed. Proven rather than reasoned:
loading `db/schema.lite` through the parser, `generateJsonSchema` and sierra's
registry, `modelNameFor('audit')` answers `null` and
`modelNameFor('AuditEvent', 'audit')` answers `AuditEvent`. `jobs` and `recipes`
were checked the same way and correctly need nothing.

135 tests, 0 fail. `fli check` clean, typecheck at baseline, all seven snapshots
current.


## 2026-08-22 — the console is on by default here

`DEVTOOLS=1` is in `.env`, so `bun run api` brings the console up on 8503 with
no flag. The banner says which it did, either way.

Putting it there found two things in junction (`FJS-419`): describing this app
bound a real port, because the console's server started in `register()`; and the
toggle reached `surface.snapshot.md`, because bun auto-loads `.env` from the cwd
and every snapshot generator runs from the app root. CI has no `.env` — it is
gitignored — so the committed file would have failed for a plugin CI could not
see. Both fixed there; the snapshot is now identical with the toggle on or off.

The one real diff left in `surface.snapshot.md` is `corsPlugin` moving from
third to last: it is installed by junction's `cors` start phase from the config
block now, rather than by hand at module scope.


## 2026-08-22 — the schema half of three findings a rule made

132 tests, 0 fail. `db:check` in sync, `access` / `ddl` / `release` snapshots
regenerated, `db/schema.d.ts` current.

All three came out of `litestone advise`, which reads this schema and reports
two things nothing else can: shapes that parse and fail later, and words the
schema never reached for.

**A caller can no longer update their own membership** (`FJS-410`). A `@@gate` is
per MODEL, so `@@gate("1.5")` says *an admin may update a membership* and has no
way to say *not their own* — while `role` is the column every gate in this app is
graded from. `setMemberRole` is hooked `requireWorkspaceRole('admin', 'owner')`
with one guard on it, *cannot demote the last owner*, so an admin naming their
own `userId` with `role: 'owner'` was granting themselves level 6. The model now
declares `@@deny('update', userId == auth().id)`.

**The first attempt was a field policy and it did nothing.**
`role @allow('write', userId != auth().id)` reads like exactly the rule. A field
write predicate is evaluated against the PAYLOAD rather than the stored row, so
`userId` is `undefined` in a patch of `{ role }`, `!=` is true, and the column is
permitted — and the test asserting it was GREEN, because both the broken form and
the working one are silent and it was watching for a throw. Isolated to a two-line
schema and filed as `FJS-433`: `==` drops the column for the row's own owner and
`!=` permits everybody, from one cause. The form that works is a model-level deny,
which compiles into the WHERE against columns the row actually holds.

**A hook is one door and this is every door** — a job, a hub screen, a
`fli tinker` session at level 5. Nothing legitimately updates a caller's own
membership: the invitation accept CREATES the row with `acceptedAt` on it,
leaving is a delete, and `asSystem()` bypasses this for the hub and setup. The
sentence a person needs is still the service's to say and that half is open.
**`litestone release` grades it `contract`** — it takes a write away from a
release still serving, so this deploy is the pivot. Worth knowing before the
deploy rather than during it.

Two things deliberately NOT done. No `@@allow('update', …)` on the model — it
would be right and it is unverifiable from here, since a policy FILTERS and a
wrong one is an empty screen with a 200, on the model `@@tenant(none)` exists for
(the workspace switcher reads memberships across workspaces). And nothing on
`AuditEvent`, because this schema's own header already argues the other way:
a null `workspaceId` compared to a caller's claim hides exactly the rows the
trail exists for. That is now `FJS-432`, filed as a decision owed rather than a
fix owed.

**Ten foreign keys got an index** (`FJS-413`). SQLite indexes a PRIMARY KEY and a
UNIQUE and nothing else, and litestone emits `CREATE INDEX` only for `@@index` —
so the pattern was a composite leading with the other side. `WorkspaceMember`
declared `@@unique([workspaceId, userId])` and `@@index([workspaceId, userId])`
and got one index, which left *which workspaces is this person in* — the question
every session asks — with nothing to use. Four are on `ON DELETE CASCADE` join
tables, where SQLite scans the child once per deleted parent. Two of the ten are
partial (`WHERE deletedAt IS NULL`), because every `@@index` on a `@@softDelete`
model is, and `Job` is one. All ten grade `expand`. **Never measured**: no query
plan was taken, and at today's row counts none of it is visible — the evidence
was the emitted DDL saying which indexes exist.

One thing worth keeping: **a `///` doc comment lands in `db/schema.d.ts`**. The
first version of the role rationale was seventeen `///` lines and appeared twice
in the generated types, as JSDoc on a column. `///` is what a hover shows;
everything else is a `//` comment.

## 2026-08-22 — frontier.config.js, the deploy half

`api/config/junction.config.js` is what the app reads about itself. This is what
the tooling reads about where the app goes — `fli deploy`, through
`loadFrontierConfig`. Two files, two audiences, which is why they are not one.

Every value in it is the one basecamp's own container already uses: port 8120
from the port scheme, `/health` at the bare path because this app declares no
`apiPrefix`, `deploy/Dockerfile`, and `/data/basecamp.db` — the volume, because
a database inside the image is lost on the next swap and the loss is silent.
Nothing here restates a number the Dockerfile could have been asked for.

`server` and `domain` are left as placeholders on purpose: they are facts about
a deployment and this repo has none. `bun run image` / `image:up` do not read
this file — `deploy/build.mjs` drives compose directly — this is the remote path.

Writing it ran `fli deploy:doctor` here for the first time, whose single
reported failure turned out to be wrong (`FJS-417`).


## 2026-08-22 — the app has a config file, and its CORS was open to everyone

132 tests, 0 fail. Typecheck within baseline.

`api/config/` did not exist. `core/app.ts` had read it since the app was written
and junction could not tell an absent directory from an absent file, so every
boot took the defaults and nothing said so (`FJS-415`).

What that cost was CORS. The app installed it by hand off `config.cors` — a
top-level key no config shape defines; a declared `middleware.cors` lands at
`config.http.cors` — so the read could never produce a value and every boot took
the `['*']` fallback. **The API answered any origin.** It now answers the SPA and
refuses a stranger, which was checked by asking it both ways.

`api/config/junction.config.js` holds what this app DECLARES: the CORS origins
and the five queue concurrencies. What it DERIVES stays in code — the jobs
database is computed from the resolved main one, so a test that redirects the
database takes the queue with it.

The hand call to `cors()` is gone entirely: junction installs it from the config
block, and configuring it as well is a second `OPTIONS /*` and a refusal at boot.
`CORS_ORIGINS` is how a deployment names its own, since the origin an app is
served from is a fact about the deployment and not about the app.


## 2026-08-22 — the queue has a screen

132 tests, 0 fail. Typecheck within baseline.

`DEVTOOLS=1 bun run api` puts junction's console on 8503 beside the app. Until
now nothing here could see the job queue: `/jobs` in the SPA is basecamp's own
`Job` model — a fleet noun, the thing being run rather than the thing running it
— and the five caravan queues under it had no reader at all outside `/metrics`.

Two things were needed for it to be worth wiring and both are junction's
(`FJS-414`): the console read a metrics object it built itself, so conduit's and
caravan's contributed sections had never reached it, and readiness took its
checks from a plugin option, so this app's own `db` probe was graded at `/health`
and silently missing from the console. Both surfaces answer the same set now,
which is what the wiring here was checked against.

Off by default rather than on in development, because 8503 is a global tooling
port: one console at a time, so basecamp's and `example`'s cannot both claim it.
`DEVTOOLS_PORT` moves it for the case where somebody wants both.

The API's startup banner carries it either way — `devtools=http://localhost:8503`
or `devtools=disabled` — so *is it on, and where* is answered where every other
surface this app serves is already listed.

## 2026-08-22 — tenancy is declared, not written out

132 tests, 0 fail. `bun run verify` 301/301. Typecheck at baseline.

Sixteen models carried a hand-written
`@@allow('all', workspaceId == auth().workspaceId)` and the app carried the
machinery to make `auth().workspaceId` mean something: `applyStanding` read the
membership row, built a fresh principal and re-scoped the client, and
`withWorkspaceStanding` arranged for it to happen before junction's own scoping
hook did. All of it is gone. `tenancy { strategy row  column workspaceId  claim
workspaceId }` is the declaration, `createApp({ principal: membershipClaim(…) })`
is the resolution, and eight models say `@@tenant(none)` by name — the five auth
models, `Workspace` itself, `WorkspaceMember` (the standing is READ from it, so
it cannot be scoped by the claim it produces) and `AuditEvent` (nullable
workspace).

**The other twenty-two models gained a scope they did not have.** They carry no
`workspaceId` column, so nothing could be written by hand — they are reachable
through a parent and were relying on it. `@@tenant(via:)` says so, and the
access snapshot went from **17 models with row policies to 31**.

What is left in `core/resource.ts` is what is actually this app's: the 404, the
paging envelope, the slug. `findScoped` and `getScoped` no longer restate the
workspace clause and `stampWorkspace` is `deriveSlug`, because the declaration
desugars a `@default(auth().workspaceId)` that fills the column at the Data
boundary — which covers the paths no hook runs on, and seven services had
written that same line into a stamper of their own.

The migration found four defects in Litestone and one in Junction, three of them
in the tenancy feature itself and none of them findable from inside those
packages: `FJS-378`, `FJS-381`, `FJS-382`, `FJS-383`, and `FJS-380` still open.

## 2026-08-22 — the services read `$` instead of being handed a context

132 tests, 0 fail. Typecheck at baseline (15). The browser drive is NOT part of this —
`bun run verify` needs an empty database and the local one has rows, so what is proven here
is the suite and the compiler, not a screen.

`core/resource.ts` opened with three accessors and a note saying they existed so one fact
was stated once: a `ServiceContext` has no `ctx.params`, and the caller-scoped Litestone
client is at `ctx.locals.db`. Twenty-two services then said `dbOf(ctx)` **160 times**,
`wsOf(ctx)` 66 and `actorOf(ctx)` 25, and every helper that wanted one took a `ctx` parameter
to carry it — `steps(ctx, deploymentId)` threading a context for a client.

**`$` (junction) is the call in progress, so nothing is handed one any more.** Three
app-owned readers over it, named once:

- `db()` — `$.db`, typed `any` **exactly as `dbOf` was**. Junction's `LitestoneClient` is a
  deliberate minimal stand-in for the surface its own adapter uses, so it knows neither
  `exists()` nor what a row of `App` looks like. The cast belongs to the app that owns the
  schema, and it belongs in one place.
- `ws()` — `$.locals.workspaceId`. A workspace is **this app's** idea, not the framework's,
  so it stays on `locals` and never becomes `$.ws`.
- `actor()` — `$.me?.userId ?? 'system'`.

`findScoped`, `getScoped`, `assertSlugFree` and `removeScoped` lost their `ctx` parameter
outright; `getScoped`'s default id is `$.id`. `stampWorkspace` keeps its parameter, because
it is a **hook** and junction hands it one — that is explicit data, not ambient state.

**Fifteen methods then had a `ctx` they never read**, and they are gone too. The other 132
keep theirs and should: they read `ctx.data`, `ctx.query` or `ctx.id`, which is the call's
explicit payload rather than its ambient state. `ctx: ServiceContext` 217 → 198. This is the
shape the migration was expected to have and it is worth saying plainly: `$` removes the
*threading*, not the parameter.

Three self-shadowing locals fell out of the rename and the compiler caught all three —
`const db = db()`, `const actor = actor()` twice. The alias had nothing left to hold once
the value was ambient.

## 2026-08-20 — `engine/` was three species in one folder

132 tests, 0 fail. Typecheck at baseline. `verify --reset` 301/301. The jobs
snapshot is unchanged, which is the proof this moved nothing: same four names,
same queues, same retry budgets.

**There was never an Engine.** Every one of the three was `app.jobs.handle(name,
fn, opts)` wrapped in a factory whose only job was to hold `app` — and caravan
puts the running app on every job context, so the factory existed to supply what
it was already given. The framework's noun for this is **Job**, the convention is
a `*.job.ts` file that names itself, and basecamp had routed around it: five
handlers hand-registered from `core/app.ts`, and six dispatch sites spelling
`'deployment:run'` and `'job:run'` as strings. `api/src/jobs/` now holds one file
per job, autoloaded by `jobsDir`, and the **default export is the dispatch
handle** — `dispatch(deploymentRun, …)` states no name and types its payload, so
a typo is a compile error where it used to be a job that silently never ran.

**Two of the five were not jobs at all.** `executor.ts` answers *who carries this
release* — provider selection, and imported by `deployments.service.ts` too — so
it is `providers/executor.ts` beside the new `providers/outpost.ts`.
`job-schedule.ts` binds a Job row to caravan's clock and is shared with the
service that knows a job changed, so it is `services/jobs/job-schedule.ts`;
`restoreSchedules(app)` moved there whole and `core/app.ts` calls it, because a
job file can declare its own handler but not a schedule that came from a ROW.

**`fleet.engine.ts` was already re-forming as a grab-bag** — its own header said
"one file for both, because they are one shape", which is grouping by mechanism
rather than by subject, and that is how `core/` starts. Split into
`recipe-run.job.ts` and `cleanup-run.job.ts`, with the shape they genuinely share
in `jobs/outpost-run.ts` (a bound on returned output, a line in the machine's
history).

**One fact was written five times.** `workspace:${id}` appeared in four files and
the cast that reaches the channel manager in four — `app.channels` is the
plugin's, so every caller re-derived the same shape by hand. `src/channels.ts`
owns both now, and `core/hooks.ts` reads it rather than spelling it. A channel
name nobody owns is one a single caller can get wrong while every other caller
keeps working, and the symptom is a screen that never updates.

`applyDiskReport` moved to `services/cleanup/disk-report.ts` on the way, because
the cleanup job imports it and the cleanup service imports the job's definition:
one module both can reach is what keeps that from being a cycle.

Found two defects in caravan while doing it, both fixed there
(`packages/caravan/CHANGES.md`): a namespaced job name could not be a file at
all, and two files in different directories could claim one name with the loser
silently ceasing to exist.


## 2026-08-19 — a second human can get in (`FJS-032`)

132 tests, 0 fail. `verify` 301/301, `verify:build` 8/8. Typecheck 15 against a
baseline of 15, ratcheted from 16.

**The setup wizard was the only door into this app for a human.**
`workspaces.addMember` takes a `userId`, so it could only reach somebody who
already had an account, and the one route that makes one — `/auth/register` —
leaves them with no account row and no workspace, after which every scoped
request 400s and they cannot create a workspace either.

`model Invitation` carries the workspace and the role across the gap where there
is no user to hang them on. **The row IS the pending state**: no `acceptedAt`,
no `revokedAt` — accepting writes a `WorkspaceMember` carrying `invitedBy` and
`invitedAt` forward and deletes the invitation, revoking deletes it, and
`@@log(audit)` is what survives either way. Those three columns had been declared
since the schema was written and nothing had ever written one.

The token is `@guarded(all)`, so no scoped read can answer it and the link is
shown once — the shape an issued API key already had.

**`preview` and `accept` run with no session at all**, exempt from
`sessionScope`, because the population they serve is not a member yet and may not
exist yet. Everything a token cannot decide — unknown, expired, workspace gone,
workspace suspended — is decided in one function, because none of the hooks that
normally decide it are running. An address that already has an account must be
signed in as that account: a password on this method would be a second login
door with none of the first one's rate limiting, and an oracle when it refuses.
So `/login/` grew a same-origin `?next=`.

**Mail goes through conduit.** `core/mailer.ts` is `IMail` over
`app.conduit.send()`, the provider a declared target with a credential ref rather
than a key in a closure. `app.mail` is ABSENT where nothing is configured, which
is a supported state — the invitation still issues a working link and the screen
says plainly that nothing was sent, beside the link to copy.

Two defects fell out on the way, both found by running it:

- **`POST /workspaces` 400d for any caller that did not send its own slug**
  (`FJS-352`). `create()` derived the slug in the METHOD, and `autoValidate` runs
  before the method — the same ordering `stampOwnership` in that file already
  exists for, with `accountId` and `ownerId` in it and `slug` left behind. Only
  the browser called it, and its form sends a slug.
- **The invite screen asked *does this address have an account* before *who is
  holding this browser***, so an owner following a link to check it was offered
  a *create my account* form for somebody else's invitation, with no mention of
  the session they were in. Found by the drive.

And one correction: `web/config/api-paths.js` said a missing path was harmless
because the Junction client uses the API's own origin. It does not — it uses
`location.origin`, so it goes through the dev proxy like everything else. What
actually hides a gap is the WEBSOCKET: a signed-in browser makes every service
call as a frame on `/ws`, which one never-stale rule proxies. The HTTP path is
exercised only where there is no socket, which is exactly what accepting an
invitation is — and `/invitations` was missing, so the signed-out screen rendered
`HTTP 404`.

## 2026-08-19 — the machine endpoints take a credential, and there is a machine (`FJS-349`, `FJS-257`)

23 API tests, 0 fail. `verify` 279/279.

**`servers.heartbeat`, `volumes.report` and `cleanup.report` took no credential
at all.** They are exempted from `sessionScope` because an outpost holds no
session, and a comment said the transport verified an HMAC — nothing did.
Measured against a running API: a POST carrying nothing but `X-Service-Method:
heartbeat` answered 200, moved a server to `online`, and registered the Conduit
target `outpost:<serverId>` at an address the caller chose — which points every
later `/exec`, `/deploy` and `/system/prune` for that machine at a host the
caller owns, signed with this app's own secret.

`requireOutpostSignature` is the credential, registered app-level so a new
machine-facing method cannot inherit the exemption without it. It verifies with
`@frontierjs/toolbelt/signature`, the module conduit signs with, over
`ctx.$raw.rawBody` — the bytes, not a re-serialization. Fail-closed in every
direction, and the reason is logged rather than returned.

**The Outpost exists.** `@frontierjs/outpost` answers the protocol this app has
been speaking to nothing, and the drive now runs the real server over a fake
Docker rather than a hand-written sink — so a change to either side of the
protocol shows up in `bun run verify` instead of in production.

## 2026-08-19 — a deploy either reaches a machine or is refused (`FJS-257`, `FJS-031`, `FJS-154`)

128 tests, 0 fail. `verify` 278/278. Typecheck 16 errors against a baseline of 20.

**A release with no Outpost reported six green steps and issued no command.**
`runStep` returned early when no placement resolved — *"log only, don't fail
(supports local/stub mode)"* — and the caller marked each step `success`, so a
deploy finished green in 23ms and set the App to `running`. Eight checks in
`web/test/verify.mjs` asserted that `success`.

Who carries out a release is now one question, asked in one place:
`engine/executor.ts` answers **outpost** (a machine that has registered a Conduit
target), **stub** (asked for by `BASECAMP_STUB_OUTPOST=1`, refused under
`NODE_ENV=production`, and it says so in every step's output), or **none** — a
refusal. `deployments.create` asks it so the 400 lands where the person pressed
the button; the engine asks it again when the job runs, because a placement can
be removed between the two.

**Nothing could create a placement.** `AppServer` was read by three engines and
written by nothing — no service, no seed, no screen — which is what the stub was
really hiding. `apps.place` / `apps.unplace` are the way in: the caller is
checked against the workspace and the `@@gate("2.8")` row is written through
`asSystem()`. The App screen's Placement card edits it, and the seed places its
demo apps, because a seeded app that cannot deploy is a demo of a broken app.

**A tag is not an identity.** Every executor reply may carry a `digest`, and the
one that does is recorded on `Deployment.builtImage`, sent on to `/deploy` and
`/health-check`, and shown on the release screen. Only `sha256:<64 hex>` is
accepted — a `builtImage` nobody can resolve is worse than an empty one, because
it reads as an answer. `IDEAS/deploy-plane.md` §a.

The drive now proves the whole exchange rather than a database write: its outpost
sink speaks `/pull`, `/deploy`, `/stop` and `/health-check` over HTTP, a second
machine (`deploy-01`) registers it, and the release goes out through Conduit and
comes back with a digest. What is still not built is the Outpost itself.

**Every service published after every method, reads included** (`FJS-031`). A
`find` broadcast every row it had just read to every browser in the workspace.
All seventeen now declare `channel: workspaceChannel(app)` on the service instead
of running a `publish()` hook in `after: { all }`: junction decides what to
announce in `callService`, once, and that place excludes `find`/`get` by name,
which no per-service hook list can do for itself. Declaring both is refused at
construction, so the swap cannot half-land.

**The trail recorded that something happened, never what changed** (`FJS-154`).
`AuditEvent.diff` was declared and nothing wrote it, so the trail could say a
server was drained and not what state it was in. It is two hooks now — a
pre-image in `before: { all }`, the diff in `after: { all }` — and both sides of
the comparison are read the same way, through the system client, because a
service is free to answer a projection and a scoped read strips protected
columns: taking the after from `ctx.result` reported an `@encrypted` column as
REMOVED rather than changed. Which columns those are comes from
`db.$protectedFields()`, litestone's own reading of the schema (new in this
release), never a list written down here. `/activity/` shows the changed fields
with before → after behind a disclosure.

**Three checks in `verify.mjs` had gone stale against the shell and were fixed
on the way**: *Sign out* moved into a `DropdownMenu` whose panel is `{#if open}`,
the login form's inputs had no stated `id` (the kit falls back to a generated
uid), and the nav moved out of the topbar into the sidebar. Each read as a
broken app rather than a stale selector.

## 2026-08-18 — `?workspace_id=` works, and the Hub's queue card renders

Two fixes from the framework side, both measured here first.

**The workspace fallback had never worked on a model service.**
`resolveWorkspaceId` reads `X-Workspace-Id` first and `?workspace_id=` second,
and the second was refused by junction's `autoFilter` — no model has a
`workspace_id` column — before this app's hook could read it. Junction grew
`reservedQuery` for it (`FJS-337`). All 20 workspace-scoped services declare it
off one constant, `WORKSPACE_QUERY`, which sits beside `resolveWorkspaceId` in
`api/src/core/hooks.ts` so the spelling that is READ and the spelling that is
DECLARED cannot drift; the resolver reads `ctx.reserved` now.

**The Hub's *Queue depths* card had been rendering nothing at all.** It carried
`{#snippet row(entry)}` and indexed `entry[0]`/`entry[1]` by hand, because the
natural `{#snippet row([queue, depth])}` threw `function is not iterable` from
the compiled file, naming no snippet. That is fixed in mesa (`FJS-339`) and the
card carries the natural spelling again.

## 2026-08-18 — the server filter bar states its own labels

Three controls in one `.cluster`, and one of them was 38px with a visible
"Search (Optional)" label while the other two were unlabelled. Not a styling
choice: only the `<Input>` needs a `name` — the submit handler reads
`e.target.search.value` — and a kit control given a `name` built a visible label
out of it, on top of the `visually-hidden` one this file had already supplied.
Two labels for one control, and a row at two heights.

`label=""` is the documented way to turn that off and it did not work on any of
the thirteen controls that document it (`FJS-340`, fixed in `@frontierjs/ui`).
All three controls state it now, rather than only the one that needed it: the
rule is *this bar has no visible labels*, and stating it per control is what
keeps the next one from arriving taller than its neighbors.

Measured: no invented labels, every control still named (`Status`, `Role`,
`Search` from the visually-hidden labels), and the search still submits. The
remaining 4px is the submit button — `.btn` and a form control use different
padding tokens and nothing in the design system can reconcile them (`FJS-347`).

## 2026-08-18 — the nav is a sidebar

Nineteen `.navlink`s lived in the topbar's `.cluster`. `.cluster` wraps and
`.topbar` is a fixed 56px, so the links laid a second row and drew it outside
the bar — measured at every width from 1920px down, with every one of the
nineteen sitting above or below the bar rather than in it.

`.navlink` is documented as **the sidebar's link** (`css patterns/nav.css`), the
shell grid has had a `sidebar` area this app never used, and the mock's own
shell is "sidebar, top bar, command palette, notice bar" — three answers to the
same question, none of them a topbar row.

So the destinations moved into `<nav class="sidebar">`, grouped the way the
mock's Sidebar groups them: **Daily · Weekly · Manage · System**, with the
design system's `.navlist-label` as the heading. One table drives it, rendered
twice — the sidebar, and a `<Drawer>` below 767px where the package hides the
real one and says its contents belong in a `<dialog class="drawer">`. Two copies
of a nineteen-item list is how one of them silently loses a screen.

`.sidebar-toggle` is the package's class for the control that opens it; opening
is the app's job, which is the `navOpen` flag. Navigating closes it — otherwise
the drawer covers the screen it just reached.

**The topbar's own contents were spilling too**, once the nav was gone and the
width was tight. The email and Sign out are one `<DropdownMenu>` now, which is
what a bar of fixed height can hold. Below ~600px it still wraps: the design
system ships no responsive-visibility vocabulary and explicitly refused one, so
there is no way to say *drop this below md* — `FJS-338`.

Verified in a real browser at eight viewports: no spill and no horizontal
scroll from 1920px to 767px, exactly one `Main` landmark exposed at any width
(the sidebar is `display:none` below md, a closed `<dialog>` is not exposed
above it), the drawer opens from the toggle, closes on Escape with
`aria-expanded` following, and closes on navigation.

**Walking all nineteen links found a screen that had been rendering nothing.**
The Hub's *Queue depths* card used `{#snippet row([name, q])}`, and a snippet
parameter that is a destructuring pattern gets the row ACCESSOR bound to it raw
— `TypeError: function is not iterable`, thrown from the compiled file, naming
no snippet, taking the whole card with it. Rewritten to take the entry; the
compiler defect is `FJS-339`.

## 2026-08-18 — the db suite stopped moving the process out from under itself

`db/test/schema.test.ts`'s two audit tests chdir'd into a scratch directory
because the logger's path was believed to be CWD-relative. It is not: the
`databases: { audit: { path } }` override beats the declaration and Litestone
resolves it to an absolute path before anything opens, so the chdir bought
nothing and cost everyone — CWD is per PROCESS, so for that window every other
test file in the run resolved its relative paths somewhere else, and the failure
landed as `ENOENT: auditLogs.jsonl` naming the test that moved rather than the
one that was moved.

The 1500ms sleep went with it. The writer buffers ~1s and a fixed wait against a
buffer is a coin toss under load. `auditEntries(dir, model, ops)` polls for the
rows the assertions are about, gives up at ten seconds so a real failure is
still a failure, and both tests state a 20s timeout — bun's default 5s does not
fit the poll. FJS-281.

## 2026-08-17 — optimistic locking on the rows a person edits

Ten models declare `@version`: Workspace, Project, Environment, Secret, Network,
Domain, FeatureFlag, NotificationChannel, AlertRule, Dashboard. Two people on
one config row both PATCH and the second silently erased the first; now the
second is refused with a 409 it can act on.

**The exclusions are the substance.** `@version` is per ROW, not per column, so
a row a machine also writes on its own schedule goes stale under an open editor
without anyone editing it — and the conflict is then reported against a change
the person never made. Server, ApiKey and Volume have a heartbeat or a usage
counter; App, Job, Recipe and Deployment have an engine driving status through a
run; DashboardWidget's reorder and its config edit touch disjoint columns and
reorder is deliberately last-write-wins; FlagOverride is reached by natural key
and never read as a row. Deployment is the one worth stating: its guard already
exists and is narrower — `@@transitions(status, …)` is a compare-and-swap on the
one column two writers contend for, so a stale cancel is refused by name, and a
version on top would refuse it again for a build step having moved the row.

Three things had to change beside the declaration:

**A service-side write of a row it just read carries the version it read.**
`demoteSiblings`, `makePrimary`, `uploadCert`, `verify`, the channel test stamp
and `saveVariables` all write a row the same call fetched. That is a real
compare-and-swap rather than a formality — two people promoting different
hostnames at once is exactly the race — so `saveVariables` now takes the row
instead of reaching for `ctx.id`.

**`changesNothing(patch)` replaces `!Object.keys(patch).length`.** The version
rides on every patch of a versioned model, so counting it as a change turns a
form submitted with nothing edited into a real write — which bumps the version
and makes every other open editor stale for a change nobody made.

**A hand-rolled draft pins its own version.** `createResource` fills one in from
what the STORE holds, and the store is live: the WS push from the other person's
save moved the remembered version while the draft sat still, so the save carried
a number nobody on this screen had read and won the race it exists to lose. The
project screen puts `version` in the draft, which is the documented way to pin
it — a stated version beats the remembered one. `<Form record={row}>` is already
right, because it edits the row whole.

The five screens whose write can now conflict show the sentence through
`resource.fieldErrors()` (`web/src/errors.js`), and their error banner is the
kit's `<Alert>` rather than a hand-written `<article class="alert danger">` —
`role="alert"` is what makes a refusal reach a screen reader at all. The other
~20 screens still hand-write theirs.

Eight assertions in a real browser, and four at the API tier through
`@frontierjs/testing`. Two junction defects came out of it: `@version` could not
survive `autoValidate` (`FJS-335`) and the HTTP transport was unreachable
cross-origin (`FJS-336`). A third is open — the `?workspace_id=` fallback this
app documents is refused by `autoFilter` before anything reads it (`FJS-337`).

## 2026-08-17 — `/servers/` is a list that lives in its URL

Filters, sort and page are all `page.query` + `page.directives` now. Nothing on
the screen holds a copy.

Sierra splits a URL's search string over the same table junction's bridge reads
(Invariant 10), so there is nothing to translate: `?role=general&$orderBy=-name&
$offset=20` is the filter, the sort and the page, and `find(page.query, {…})`
sends it back. What that buys is not tidiness — it is that a reload, the back
button and a pasted link all land on the same list, and none of them worked
before.

**Three framework gaps this screen needed and none of them was in the app.**

- **`Table` had no way to REPORT a sort.** `bind:sortKey` makes the component
  the owner, and a component cannot own something in the address bar.
  `onsort={(key, dir) => …}` is new in `@frontierjs/ui`.
- **`normalizeOrderBy` was not exported from Junction.** `autoSort` validates
  `$orderBy` and leaves it raw, so the service has to parse it — and writing
  that parse in a service is a second definition of the grammar.
- **`servers.find` ignored `$orderBy` entirely.** It hardcoded
  `createdAt desc`. Sorting worked in the UI only because nothing had ever
  asked the server to sort.

**The bug this screen found in itself is worth the entry on its own.** `load()`
first read the `$:` values derived from `page.*` — and it runs from the watch on
`page.*`. A derivation that has not settled yet hands back the PREVIOUS value,
so the first click on a header wrote `$orderBy=name` into the address bar and
asked the server for no sort at all; the second click asked for the first one.
The list was one click behind the URL, on a screen whose entire claim is that
the two are the same thing — and it looked like an off-by-one in the sort
direction, which is a much more interesting-looking bug than it was. **Inside a
watch, read the source, not a derivation of it.**

Twelve assertions in a real browser against the seeded fleet: a filter that
matches nothing proves the filter reached the server, the sort is asserted
against what the SERVER returned rather than against row order, a pasted
`$orderBy` link reproduces the list, the header arrow follows the URL rather
than a click, back moves the list, and `$offset` past the end answers an empty
page rather than page one again.

Unrelated flake fixed on the way: the ApiKey audit-trail test slept a fixed
1500ms against a writer that buffers ~1s. It polls now, inside a stated 20s
timeout — it had failed once in a full run and passed alone immediately after,
which is the worst way for a test to be wrong.

## 2026-08-17 — the API tier is tested, through `@frontierjs/testing`

`api/test/services.test.ts` — 8 tests over the REAL app, and this repo's first
consumer of the Testing realm's API half. 109 → 117 tests.

**Why it is not more schema tests.** `db/test/schema.test.ts` grades this app at
the Data boundary and stops. Between a principal and that boundary sit five
steps, four of them basecamp's own, and none was executing:

    session → SessionContext → withWorkspaceStanding → memberRole
            → basecampGateLevel → toDataPrincipal → the scoped client

A principal can arrive correct at every one of them and land wrong. `env.as(user)
.service(name)` is the path a request takes, minus the socket.

**Two seams the app grew to be mountable**, both defaulting to what production
does so the entry point is unchanged:

- `buildBasecampApp({ db, dbPath })`. The Testing realm mounts the app over the
  ENVIRONMENT's client — handing it a second client on the same file would work
  and would be wrong, because `arrange` writes and `announced()` would then be
  looking at different connections. `dbPath` covers **both** databases: the
  queue's file is derived from it, and a redirect that left the queue behind
  would write jobs into the developer's own.
- `autoload:` stated on `createApp`. The default resolves `./services` beside
  `Bun.main`, which is the entry point in production and the TEST RUNNER under
  `bun test`.

**What the first mount found is filed as `FJS-348`** — `autoload-services` was a
`needsHost` phase in Junction, so `_startForTest` skipped it and every app that
autoloads had zero services in a test env. Every call answered a 404 naming the
service, which reads like a wrong name rather than an unloaded app.

**Two of the tests assert the app is better than the test first assumed.** A
non-member is refused by `scopeToWorkspace` with *You are not a member of this
workspace*, not shown an empty list — so the row policy is the second line, not
the first, and the empty-screen hazard does not reach a screen here. The policy
is still asserted, by a caller the hook admits, against a SECOND workspace whose
project must never appear: without that row, "a member sees their own workspace"
is true of a database with only one and the test cannot fail.

**Transport parity ran for the first time.** Every call derivable from the app's
model services, put down HTTP and WebSocket and compared, as an owner and as an
anonymous caller: **no mismatches**. That result is trustworthy because the
runner reports *not graded* as a row when it derives no calls or the socket
never connects — an empty array is what agreement looks like too.

## 2026-08-17 — the API tier is tested through `@frontierjs/testing`

21 services and two test files, none of which called a service. `api/test/services.test.ts`
mounts the **real** app — `buildBasecampApp({ db, dbPath })` over the test
environment's own Litestone client — so the autoloader, the global hooks and
every service factory are the ones production runs.

**The half a Data-realm test cannot reach.** `db/test/schema.test.ts` grades
this app at the Data boundary and stops. Between a principal and that boundary
there are five steps, four of them basecamp's own, and nothing was executing
them: session → SessionContext → `withWorkspaceStanding` → `memberRole` →
`basecampGateLevel` → `toDataPrincipal` → the scoped client. A principal can
arrive correct at every one and land wrong.

Eight tests: standing derived per request from the membership row (a developer
creates, a viewer is refused, a viewer still reads), a non-member refused **by
name** rather than shown an empty list, a member seeing only their own
workspace's rows with a second workspace present to make that falsifiable, a
stranger refused at the transport, what an act announced versus what arranging
below the boundary does not, the HTTP pipeline, and transport parity.

**Transport parity had never run anywhere.** Every derived call for every model
service, as an owner and as a stranger, down HTTP and down a real WebSocket:
**zero mismatches**. Worth stating because a parity check that graded nothing
would also be green — the runner reports an underived call list and a socket
that never connected as findings, and neither fired.

**Two seams this needed, both small and both real.** `buildBasecampApp` takes
an optional `{ db, dbPath }`: a test needs the app to use the environment's
client, because handing it a second client on the same file would leave
`arrange` and `announced()` looking at different connections. `dbPath` covers
the queue too — it is derived from the same path, and a test that redirected
the main database and left the queue behind would write jobs into the
developer's own. Both default to what production does.

`autoload` is now stated with an absolute path rather than defaulted, because
the default resolves `./services` beside `Bun.main` and under `bun test` that is
the test runner. The other half of that was a junction defect — `FJS-332`.

117 pass, 0 fail.

## 2026-08-17 — the release and job state machines are declared, not scattered

`@@transitions(status, …)` on `Deployment` and on `Job`. Eight status enums in
this schema and none of them declared a machine; the rules lived as literal
lists in three places instead, and the copies had already drifted apart.

| Was | Where |
| --- | --- |
| `TERMINAL = ['success','failed','cancelled','rolled_back']` | deployments service |
| `CANCELLABLE = ['pending','building','pushing','deploying']` | deployments service |
| `TERMINAL = […]` again | `deployments/[id]/index.mesa` |
| `['pending','running'].includes(job.status)` | jobs service |
| `['pending','running'].includes(job.status)` again | `jobs/[id]/index.mesa` |

All five are gone. The declaration is the only statement, litestone enforces it
at the Data boundary, and the screens read `resource.transitions(row)`.

**The copies disagreed, and the drift went both ways.** A `failed` job could
not be cancelled from the screen or the service — but `remove()` cancelled
whatever it soft-deleted, from any state, because a job left `pending` behind a
`deletedAt` is invisible to every read and still on the clock. A `success`
release offered no rollback anywhere. Declaring the machine forced both to be
answered once: `cancel` reaches `failed`, and `rollback: success -> rolled_back
@gate(5)` — Deployment's update gate is USER(4), and undoing a release someone
else shipped is not the same authority as shipping one.

**A refusal now names what IS possible.** `TERMINAL.includes(…)` could only say
which move was wrong; the boundary answers *Cannot transition Deployment.status
from 'success' to 'cancelled' — valid transitions from 'success': 'rolled_back'*
with a 409 rather than a 400, which is what the state of the row actually is.

**`remove()` on a job now asks before it writes.** It used to set `cancelled`
unconditionally; `cancelled -> cancelled` is not a transition, so an already
cancelled job would have started failing with a 409 on delete.

The engines are untouched: they run on Caravan's thread through `asSystem()`,
which bypasses transitions by design, and advancing a deployment is their job.
The machine guards the request path — which is the path the deleted lists were
guarding too.

Six tests in `db/test/schema.test.ts` against a real client, **mutation-checked
in two directions**: drop `@gate(5)` from `rollback` and two fail, widen
`cancel` to reach `success` and two fail. Both screens driven in a real browser
against the seeded fleet — the deployment is `success` and the job is `failed`,
which are exactly the two states the old lists got wrong.

`db/access.snapshot.md` grew a **State transitions** section: 11 moves, with the
gated one named. Regenerating the snapshots also picked up a stale
`surface.snapshot.md` — the `captureCredential` hook deleted in the `FJS-D23`
work above was still listed in it, and CI would have failed on that.

## 2026-08-17 — every control and every table is `@frontierjs/ui`

Zero raw form controls and zero raw `<table>` left in `web/src`. What went:

| Was | Count | Now |
| --- | ----- | --- |
| `<table class="table …">` + `.table-wrap` | 22 | `display/Table` |
| `<button class="btn …">` | 25 | `forms/Button` |
| `<a class="btn …">` | 19 | `forms/Button href=` |
| `<input class="field">` | 15 | `forms/Input` |
| `<select class="field">` | 6 | `forms/Select` |
| `<label class="field-check">` + checkbox | 1 | `forms/Checkbox` |

**This is the point of the app.** A screen that hand-writes what the kit owns
reports nothing back about the kit, and the whole reason basecamp exists is to
be the thing that finds out what is missing. Two gaps surfaced the moment the
screens stopped writing their own markup, and both are fixed in the kit rather
than worked around here: a password field with no reveal toggle, and a `Table`
that could not express a visually-hidden actions header (`hideLabel`).

**Three things the migration had to get right rather than translate.**

- **`bind:` does not cross a component boundary onto a member expression.** A
  component binding takes a writable top-level `let`, so every
  `bind:value={draft.name}` became `value={…}` plus an `oninput` callback. On a
  raw `<input>` it was an element binding and legal; the failure is a compile
  error, not a silent one, which is why this is a note and not an entry in
  `ISSUES.md`.
- **The `id` moved from `<tbody>` to the component.** `<Table>` spreads its
  caller's attributes onto its outer wrapper, so `#job-rows` is now a `<div>`
  around the table rather than the `<tbody>`. Every selector the app's own
  drive uses is a descendant one — `#project-rows td`, `#app-rows button`,
  `[...#environment-rows tr].find(tr => …)` — so all of them still resolve.
- **A hand-written `<form>` with kit controls needs `novalidate`.** Kit controls
  carry a real `required`, which is what assistive tech announces and also what
  makes the browser refuse to fire submit. `<Form>` is novalidate by default;
  the forms that stayed hand-written are the ones to watch (`FJS-055`).

All 74 `.mesa` files compile and emit parseable JS. Every screen was walked in
a real browser signed in as a seeded user, in **both** workspaces — the second
one is where the fleet lives, and until the switch every table-bearing screen
was rendering its empty branch, so the row snippets had never run. Checked per
screen: headings, the controls the app's drive selects by id, the header row
(including the hidden `Actions` one), row counts against the database, and
basecamp's own three a11y rules — a `<th>` without `scope`, a control without a
name, a control with no text. No findings, no page errors.

**`bun run verify` has not been run against this.** It needs an EMPTY database
— it asserts the first-run wizard owns the app — and the tree's database has
real data in it. The walk above is the substitute and it is a weaker one: it
does not exercise the gate ladder, the live-update path, or any flow that
writes. Run `bun run verify --reset` on a tree that can afford it.

## 2026-08-17 — the sign-in screen is on the kit

`/login` was hand-written HTML: raw `<input class="field">`, a raw `<button>`,
a hand-rolled `.alert`, and its own `busy`/`error` state. It is `<Form>` +
`<Input>` + `<Button>` now, which is what it should have been — the point of
this app is to be the thing that finds out what the framework is missing, and a
screen that bypasses the kit reports nothing.

What it cost to say: nothing. `<Form>` with no resource is the supported shape
(`onsubmit` + `mapErrors`) — signing in is not a write to a model — and it owns
the in-flight flag, the submit guard and the form-level message, so three
locals and the `.alert` markup are gone. `<Button type="submit">` reads the
form's `submitting` from context.

What it bought: the password field has a show/hide toggle, because
`@frontierjs/ui` draws one for `type="password"` as of the same day.

That was the first screen; the rest followed in the same pass — see the entry
above.

## 2026-08-17 — the channel credential is declared, not conventional (`FJS-D23`)

103 tests, 0 fail. `bun run verify` 271/271.

`NotificationChannel.secret` is `@transient`: the plaintext credential on its way
into an `@encrypted` `Secret` row, declared in the schema instead of held by a
hook and a comment. `captureCredential` is deleted — 26 lines and two hook
entries — and `create`/`patch` read `ctx.transients.secret`.

What it buys here: the form's credential box is a field the schema knows about,
`@length(1, 4096)` applies to it on both sides of the wire, and a misspelt key is
distinguishable from a column the model does not have. What is unchanged is the
part that matters — `notification_channel` still has no `secret` column, and the
drive still asserts the credential appears neither on the page nor in what the
API answers.

## 2026-08-17 — scheduled jobs were on a clock nothing maintained (`FJS-327`, `FJS-328`)

99 tests (11 new), 0 fail. Baseline unchanged at 20.

Both defects are the same mistake: a scheduled `Job` is a database ROW, and its
schedule was treated as a side effect of the request that created it.

**A restart emptied the clock.** The only place a schedule was ever registered
was the jobs service's `create()`, against junction's in-process
`app.scheduler`. Nothing re-read the rows at boot, so the first deploy stopped
every scheduled job in the app — with the row still saying `scheduled` in the
UI, `nextRunAt` still holding a date, and nothing logged. The shape of the
failure is *the job just never ran*.

**An edit kept the old schedule.** `patch()` validated a new `cronExpression`,
wrote it, and never touched the scheduler. Same hole in the other directions:
`kind` and `status` are patchable too, so a job that stopped being scheduled or
was cancelled stayed on the clock — and `remove()` soft-deletes, which makes the
row invisible to every read while its timer keeps dispatching runs for it.

**Caravan owns the clock now** (`FJS-D36`). `app.scheduler` is a timer with no
persistence, no retry and no principal; this app was using it to fire
`app.jobs.dispatch(…)`, which is a clock with none of the queue's durability
while looking like it has it.

- `engine/job-schedule.ts` is the one place a Job row is bound to a clock.
  `syncSchedule(app, job)` is the whole rule — on the clock when the row is
  `scheduled`, carries an expression and is not cancelled; off it otherwise —
  and `patch()` reads it off the UPDATED row, because the expression is only one
  of the ways a schedule changes.
- `restoreSchedules()` in the job engine re-registers every live scheduled job
  at `register()`, where the `job:run` handler already goes. One unparseable
  expression is logged and skipped rather than costing every other job its
  schedule; the call is not awaited, because a fleet that cannot schedule is
  worse served by an API that will not boot.
- `runJob` skips a `cancelled` row. The row is the truth about whether a run
  should happen, and a run queued before the cancel is still in the queue.

Eleven tests, against a real Caravan queue and (for the restore half) a real
Litestone client — the claim is what a scheduler holds after a sequence of
calls, and a stand-in answers whatever it was written to answer, which is how
the original went unnoticed. Both halves mutation-checked.

Also regenerated `db/schema.d.ts`: it predated the `ServiceTypes` block
litestone's typegen emits since `FJS-018`, and `db/test/types.test.ts` was
failing on the gap.


## 2026-08-16 — conduit's `hooks:` is `observers:` (`FJS-287`)

`core/app.ts` names the option conduit renamed. The three callbacks are
unchanged — they log a request, an error result and a failed send, which is the
Observer tier being exactly what it says. `management: { hooks: … }` on the same
call keeps its word: that one is Junction's pipeline and refuses unauthenticated
callers. Typecheck baseline unchanged at 20; it was 26 with the stale name, which
is how the rename was caught here rather than at runtime.

## 2026-08-16 — the API-keys service says which provider it needs (`FJS-D10`)

92/92 tests pass. Typecheck baseline unchanged.

Junction now requires only `verifySession` of an auth provider, so a provider
that verifies sessions and issues no API keys is a legal one. `authOrRefuse()`
already refused an ABSENT provider; it now also refuses one that cannot mint or
revoke, by name. That is a real runtime hole closed rather than a type appeased
— the previous code would have reached `undefined.createApiKey`.

# Basecamp — changes

Newest first. What changed and why; the current state is `PROJECT_STATE.md`.

## 2026-08-14 — an interrupted drive left three servers running

`web/test/verify.mjs` spawns an API, a Vite and a Chrome and killed them only on
its own `fail()` path. Anything else — a `timeout`, a Ctrl-C, an editor stopping
the task, **or any check throwing** — killed the runner and orphaned all three.

The next run then met one of two things: its own port check, or worse, an API
still holding a database this script had already deleted, answering from rows
that no longer exist on disk. That is precisely the failure the port check was
written to name, and this file was the thing creating it. It cost most of an
afternoon: a drive that hung at a login, an API that answered `no such table`
after a `--reset`, and a hundred headless Chrome processes at the end of it,
none of which was a defect in the app.

`SIGINT`/`SIGTERM`/`SIGHUP` and both uncaught-error hooks now run `cleanup()`
before exiting. Proven both ways: a `timeout`-killed run and a run that threw
mid-check each leave **no listener on 8120, 8020 or 3011**, and a clean run
still reports 271/271.

A throw is the common case, not the interesting one — a check calling
`evaluate()` against a control that moved throws, and that path never ran a
single `kill()`.


## 2026-08-14 — Basecamp runs in a container, and packaging it found four framework bugs

`node deploy/build.mjs --run` builds an image from the WORKING TREE and brings
up the stack; `http://localhost:8020` is the same URL `bun run dev` serves, so
containerised and not are the same address.

**The image carries the tree, not the registry.** Basecamp depends on nine
`@frontierjs` packages as `workspace:*`, which a Docker build can resolve no more
than it can resolve the `link:` specs `fli new --source local` writes — that is
`FJS-241`. The answer, now `fli`'s and no longer this app's: `bun pm pack` every
package INTO the build context and depend on the tarballs, with `overrides` so
the packages' own dependencies on each other resolve to the tree as well. A tarball is byte for
byte what `npm publish` would upload, so the image runs what is being edited —
and grades every package's `files:` field on the way past.

Two containers, not one. The API is an image; the SPA is static files behind
Caddy. Serving both from the API would need an `apiPrefix`, because Junction
registers `GET /{service}` and that matches almost any single-segment path — so
`/apps/` in a browser would answer JSON. The proxy makes the same `Accept`-header
decision the Vite dev proxy makes, from **the same list**: `web/config/api-paths.js`
is now one file with two readers, rather than a hand-kept array that had gone
stale four times and would have been copied into the deploy as a fifth.

**Four defects, and none of them was in this app.** Every one is the same shape:
*a path predicate that is true in the workspace for a different reason than it is
true in an install.* Nothing in the repo could see any of them, because an app
here resolves the framework out of `packages/`.

- **sierra** — the Mesa plugin's node_modules allowance named `@frontierjs/sierra`
  alone, so the ui kit's 64 `.mesa` components and email-kit's 22 reached
  rolldown untransformed. It names the scope now.
- **sierra** — `id.includes('_module')` decided whether a file was a layout, and
  **`node_modules` contains `_module`**. Every installed component took the
  layout slot rewrite and died on `'__slot_actions' is already declared`, naming
  a variable absent from the source. The test is the basename now.
- **ui** — `"./stores/*": "./stores/*.js"` mapped `stores/toastStore.js` to
  `stores/toastStore.js.js`. The components entry already handled both
  spellings; the stores entry handled only the one nobody writes.
- **basecamp** — `web/config/vite.config.js` aliased `@frontierjs/ui` to
  `../../../ui` unconditionally. Outside the workspace that directory does not
  exist, and the alias rewrote 22 imports to nothing. Guarded with `existsSync`:
  an alias to a directory that is not there is never right, so it is not a
  `NODE_ENV` question.

`db/generate.js` stays out of the image on purpose. It imports litestone by
relative workspace path so the DDL emitter is the tree's and never the stale copy
`bun install` leaves under `node_modules/.bun` — a deliberate choice that cannot
survive containerisation and should not. Drift is a question about the
repository; `bun run db:check` answers it on the host.

Proven by running the whole app loop against the container through the proxy —
setup, login, two workspaces, projects, environments, apps, deployments, jobs,
domains, 20 checks — plus the SPA shell on a deep route, a hashed asset, and a
release the engine drove to `success` inside the container.

## 2026-08-14 — the credential pair, and a hole it opened in Litestone's own checks

`Secret` and `ApiKey` now declare
`@@allow('all', workspaceId == auth().workspaceId)`. **15 of 37 — every model
carrying a `workspaceId` except `WorkspaceMember` and `AuditEvent`**, and both of
those are exclusions with a reason rather than a backlog: standing is *read from*
`WorkspaceMember` before there is a workspace on the principal to compare
against, and `AuditEvent`'s workspace is nullable because a hub action belongs to
none.

These two were held to last because they are the only models with system readers
that look a row up **by id with no workspace in the query** — the conduit
resolver reading `secret:<id>`, the channels service writing a channel's
credential, the API-key guard deciding whether a key may act. All three are
`asSystem()`. A test says so directly, because a policy reaching any of them
would fail every send and refuse every key with nothing to tell it from a bad
token.

**Declaring `Secret` broke a Litestone check, and the break was the useful part.**
`verifyFieldProtection` seeds a row carrying the policy's targeted value so the
row is visible to the reader it is about to grade — and that value is almost
always a foreign key, so the child was refused by the constraint and the model
reported *no row could be built … FOREIGN KEY constraint failed*. Its sibling
`verifyRowPolicies` already called `_ensureParent()` for exactly this; the field
check did not. Fixed upstream the same day. `Secret` is the only model in 37 with
both a protected field and a row policy, which is why nothing had put the two
attributes together before.

Three older tests changed with it, all the same shape as the ones the first batch
touched: a principal built with no `workspaceId`. `applyStanding()` puts one on
for every real request, a system administrator included — **standing decides the
level, the policy decides which rows** — so a test omitting it was describing a
request this app never makes. The sysadmin test now asserts both halves: with the
workspace on the principal it reads the vault, and pointed at another workspace
it reads nothing, because reading across tenants is the hub's job and the hub
uses `asSystem()`.

Over HTTP the thing worth proving is that a key still works: minted in A, it
reads A's servers (200), is refused against B (403) and refused a service outside
its scopes (403) — three answers that all come off a row the guard reads through
`asSystem()`. And `@encrypted` still keeps `data` off the answer for the secret's
own owner, which is the other half of the pair: losing either would look
identical on a cross-workspace read.

`bun run test` 92/92, litestone 1986/0, typecheck at baseline 20,
`bun run verify --reset` 271/271, `db/access.snapshot.md` at **16 policied**.

## 2026-08-14 — the tenancy sweep reaches every model that can carry it

`Network`, `Recipe`, `FeatureFlag`, `NotificationChannel`, `AlertRule` and
`Dashboard` now declare `@@allow('all', workspaceId == auth().workspaceId)`.
**13 of 37 — which is every model carrying a `workspaceId` except four**, and the
four are worth naming because they are exclusions rather than a backlog:

- **`WorkspaceMember`** is what standing is *read from*. `applyStanding()` reads
  it through `asSystem()` before there is a workspace on the principal to
  compare against, so a policy graded off `auth().workspaceId` would be reading a
  field it is in the middle of deciding.
- **`Secret`** and **`ApiKey`** hold credential material and have real system
  paths — `core/credentials.ts` resolving a `secret:<id>` ref, the scope resolver
  asking whether a key may act. Those want reading line by line rather than
  waved through with the batch.
- **`AuditEvent`**'s `workspaceId` is nullable, because a hub action belongs to
  no workspace. A policy comparing a null to a caller's workspace would hide
  exactly the rows the trail exists for.

The audit for these six was the shortest of the three batches: every read goes
through `findScoped`/`getScoped`, the two that build their own where-clause spell
`workspaceId: wsOf(ctx)` out (`flags.resolve`, `alerts.attachChannel`), and the
only crossing readers are the hub's flag list and the fleet engine's recipe
stamp, both `asSystem()`. Four of the six stamp through their own
`stampWorkspace` variant rather than the shared one — `NotificationChannel` and
`FeatureFlag` have no `slug` column — and each still sets `workspaceId`.

Four more tests, driving all six through one table of shapes, plus 30 checks
over HTTP with two workspaces owned by one person — each service lists only its
own row, a cross-workspace `GET` is a 404, and a create naming the other
workspace in the BODY lands in the caller's own. `bun run test` 87/87, typecheck
at baseline 20, `bun run verify --reset` 271/271, and `db/access.snapshot.md` at
**14 policied** (the 13 plus `User`'s own self-only rule).

## 2026-08-14 — the second tenancy batch, and the read that had no workspace in it

`Deployment`, `Job` and `Domain` now declare
`@@allow('all', workspaceId == auth().workspaceId)`. Seven of 37; the other 30
still hold their tenancy in a service where-clause.

These three are not the hierarchy — they hang off an App rather than off the
workspace — and that brought a shape the first batch did not have. Several reads
filter on **`appId` alone**: the ten most recent deployments on an app's detail
screen, the ten most recent jobs beside them, and the sibling hostnames
`makePrimary` demotes. None of them names a workspace. They are correct today
only because the app was fetched scoped a few lines earlier, which is an argument
that lives in the reader's head and nowhere in the query — the exact thing that
is one refactor from being false.

The audit came out clean the same way the first batch did: every scoped read goes
through `dbOf(ctx)`, every create stamps through `stampWorkspace`, and the paths
that legitimately cross a workspace are the three engines and the hub, all
`asSystem()`. `Domain` is the one with a different gate — `"2.5"`, because a
hostname decides where traffic lands and a certificate decides whether it is
private — so its tests act as an admin where the other two act as a developer.

Four tests drive all three through one body, and one of them is new to this
batch: **an `appId`-only read handed the other tenant's `appId` directly must
answer nothing.** That is the claim the declaration adds and the where-clause
never made. Over HTTP, the same question a third way — `GET
/deployments?appId=<B's app>` from A's client is an empty list, `GET
/jobs/<B's row>` is a 404, and a create naming B in the BODY lands in A.

The two reads that had to keep working are the ones the policy could have
emptied without a word: the app detail screen still carries its own releases and
jobs, and the `domains` it reaches through `include:` are still there — an
`include:` enforces the rules of the model it reaches (litestone `FJS-150`), so
a join is exactly where a new policy goes unnoticed.

`db/access.snapshot.md` carries all seven — and it was two entries stale when
this started, `Project`/`Environment`/`App` never having been regenerated into
it. `bun run test` 83/83, typecheck at baseline 20, `bun run verify --reset`
271/271.

## 2026-08-14 — the tenancy of the hierarchy moved into the schema

`Project`, `Environment` and `App` now declare
`@@allow('all', workspaceId == auth().workspaceId)`, joining `Server`. Four of
37; the other 33 still hold their tenancy in a service where-clause.

**The line is not the work — the audit before it is.** A policy FILTERS where a
gate REFUSES, so a read that legitimately crosses a workspace and is not
`asSystem()` starts matching nothing, with a 200 and an empty screen. For these
three the audit came out clean: every scoped read already goes through
`dbOf(ctx)` with `workspaceId: wsOf(ctx)` — including the indirect ones, the
flags service resolving an environment and the dashboards service naming apps —
and the only paths that cross a workspace are the three engines and the hub,
which are `asSystem()` and unaffected.

Proven twice, because a where-clause in a service would pass either test alone:

- **At the Data boundary, with no service and no hook.** Four tests driving all
  three models through one body — a caller with no `where` at all sees only
  their own rows, another workspace's row is `null` by id and by name, a create
  or a move into another workspace is refused by the policy, and `asSystem()`
  still writes across (which is what the deployment engine does to `App.status`).
- **Over HTTP, two workspaces owned by one person.** Each lists only its own,
  a cross-workspace `GET` is 404, and a create naming the other workspace in the
  BODY lands in the caller's own workspace rather than smuggling a row across.

Two older gate tests had to change with it, and the change is the point: they
built a principal with no workspace and created rows into one. `applyStanding()`
puts the workspace on the principal for every real request, so a test that
omitted it was describing a request this app never makes.

`db/access.snapshot.md` carries all four models. `bun run test` 79/79 and
`bun run verify --reset` 271/271 — the drive is what proves the three engines,
the hub and every screen still read what they are meant to.

## 2026-08-14 — the boot path could not see its own migration, and the seed had no channels

Two things the new seed test found by running the whole path.

**`db/test/seed.test.ts` is that test.** `bun run db:seed` is the only thing here
that writes every model and nothing ran it, which is how it stayed broken for two
phases — a dead enum value, a dead column, and a `--force` list eleven models
behind the schema. It runs the real SCRIPT as a process from a throwaway
directory (DATABASE_URL and the declared `audit` path both resolve against the
CWD, so a developer's own fleet is untouched), three times over: an empty
database, a `--force` re-seed, and a second plain run that must be a no-op.
Every table is asserted non-empty individually rather than by a total — a
seeder that stops three models in still writes hundreds of rows.

What it catches was measured rather than assumed: removing `account` from the
`--force` list fails it exactly as it failed by hand, on `account.slug`.
Removing a CASCADING child (`server`) passes, and correctly — the workspace
delete takes those rows anyway.

**The app migrated from `db/migrations` and the migration lives in
`db/migrations/main/`.** Migrations are per DATABASE because the schema declares
`database main`; junction's `dbClient.migrate(dir)` globs one level and answers
`{applied: [], skipped: []}` for a directory it cannot read. So a boot against a
fresh database created **no tables and said nothing**, and the first request
answered `no such table: workspace`. `bun run verify --reset` had stopped working
for exactly this reason, and a first deploy would have started against an empty
database — the same silent-success class as `FJS-193` itself.

Both call sites — `api/src/core/app.ts` and `db/seed.js`, which had a comment
saying it made "the same call app.ts makes on boot" and did — now use
**litestone's** `apply()`, which knows the per-database layout and separates *no
files* from *no files MATCHED*. Basecamp throws on `unmatched` rather than
booting empty. Verified: delete the database, boot, 40 tables.

**Nothing seeded a `NotificationChannel`.** Both halves of the delivery chain
have existed since Phase 5 and the seeder wrote neither the channel nor the
`AlertRuleChannel` join, so `/channels/` read as broken in a seeded fleet and
the join that replaced a Json array of ids had no example anywhere. Now two
channels per workspace, and only the Slack one carries a `secretId` — a channel
without a credential is a state the screen has to render, and a fleet where
every row is complete never shows it. The webhook URL goes into a `Secret`
(`kind: 'notification'`), which is where a bearer credential lives here.

## 2026-08-14 — the client has the schema's own types

`db/schema.d.ts` is generated by `bun run db:types` (`litestone types`,
`audience=system`) and committed, and `api/src/core/db.ts` types `BasecampDb`
from it. **The cast is one line in that one file**; nothing downstream casts.

Typecheck went **63 → 20**, and the baseline is locked at 20. Two thirds of the
old count was one class — every row read out of an untyped Proxy was `unknown`
and got cast at the call site.

`audience=system` because this types the API: `Secret.data` is `@encrypted` and
`core/credentials.ts` reads it through `asSystem()`, so the client audience —
which strips protected columns — would call a real read an error.

**What the types found, none of which any suite could:**

- **`job.engine.ts` carried a hand-written `JobRow` in snake_case** —
  `workspace_id`, `timeout_seconds`, and `service_id` from before `model
  service` became `App`. Litestone emits columns verbatim camelCase, so every
  field on that interface was a name no row has ever had. The CODE was right
  (`job.timeoutSeconds`, `job.appId`); the type was three renames stale, and it
  had been lying since the raw-SQL era. Replaced with the generated `Job`.
- **`setStepStatus(status: string)`** wrote an enum column from an unconstrained
  string — a typo would have surfaced as a CHECK constraint failure at the end
  of a deploy. Now `StepStatus`.
- **`addMember` / `setMemberRole` wrote `role` straight from the wire.** They
  write a `WorkspaceMember` row by hand, so `autoValidate` — which is scoped to
  the service's own model, `Workspace` — never saw it, and an unknown role
  reached SQLite as a constraint error rather than a 400 naming the field. Now
  refused by name against the same map `core/gate.ts` grades on, which is the
  app's one home for that vocabulary. Same shape as the `AlertRule.severity`
  finding: a vocabulary with two owners disagreeing.

`db/test/types.test.ts` fails if the committed file is not what the schema
generates right now — verified by adding a column and watching it go red. The
file is committed because every service imports through it and generated because
a hand-kept copy of 37 models is a second schema; that pair only works if the
staleness is loud.

Four defects in `litestone types` had to be fixed first — see litestone's
`CHANGES.md`; the generated interface was missing twelve members a real client
has, emitted a duplicate key that made the file unusable, and typed a nullable
column so that clearing it could not compile.

`bun run test` 71/71 · `verify` 271/271 · `verify:build` 8/8.

## 2026-08-14 — the committed migration was invisible to `migrate apply`, in two ways

`FJS-193`. `db/migrations/001_initial_schema.sql` was never applied by anything.
Two independent causes, either one enough:

- **The name.** `listMigrationFiles` matches `<14-digit>_<lower_snake_label>` and
  nothing else, so `001_…` was not a migration as far as litestone was concerned.
- **The directory.** `schema.lite` declares `database main`, so `migrate apply`
  reads `db/migrations/main/` — while `db/generate.js` wrote one level up.

`createTestEnv` reads a migrations directory loosely, so `db/test/schema.test.ts`
replayed the file either way and 68 tests were green against a database a deploy
could not build. That is the whole shape of it: the suite proved the SQL, and
nothing proved the SQL was reachable.

Now `db/migrations/main/20260801000000_initial_schema.sql`, and it applies —
verified end to end against the real schema, 1 migration applied, exit 0. The
test file asks `listMigrationFiles` where the migration is rather than spelling
the name, and a new assertion pins that a deploy can find it at all.

## 2026-08-14 — a level graded on a column the caller could write

`FJS-177`, closed. `@frontierjs/auth` moved `model User` from `@@gate("8")` to
`"4.4.4.5"` (`FJS-170`) so an app can list its own people, and this app's hand
copy of the fragment moved with it — one line in a mixed commit, with no doc
following. The suite said so for three days as a single failing assertion about
SYSTEM access, and both that row and `FJS-170` recorded the opposite: *basecamp
keeps 8*.

**A gate is per MODEL, so update at 4 meant any signed-in caller could rewrite
any other person's row.** Probed with the app's own resolver rather than
reasoned about: a `developer` listed every user in the database, rewrote
another's row, and set `isSystemAdmin: true` on their own — the column
`basecampGateLevel()` grades SYSADMIN(7) from. Nothing exposed it over HTTP;
there is no `users` service, and every User write in `api/src` is `asSystem()`.

Closed with two declarations, neither of them a level, because the level is
auth's and it is right:

- `@@allow('update', id == auth().id)` — whose row.
- `@allow('write', auth().isSystemAdmin)` on `isSystemAdmin`, `status` and
  `kind` — which columns. Exactly the three the resolver reads.

`@guarded(all)` was tried first and does not do it: the write lands and the
column is stripped from the ANSWER, which reads like a refusal. Filed as
`FJS-248` against litestone's docs, which call it a lock on all operations.

`bun run test` 68/68 (three new, all reading the row back through `asSystem()` —
a policy filters, so the refused write answers `null` rather than throwing),
`bun run verify --reset` 271/271 unchanged, `bun run verify:build` 8/8,
`db/access.snapshot.md` regenerated.

## 2026-08-13 — the process a server runs is an Outpost, not an agent

`FJS-D29`. The word had two meanings in this repo already — the resident fleet
process here, and the MCP caller `IDEAS/agent-surface.md` proposes — in a codebase
whose `UserKind` enum has an `ai` member. The rule that settles it and the next one:
**infrastructure takes place nouns, AI takes personified nouns.**

Renamed: `Server.outpostVersion` / `outpostUrl` (migration regenerated from the seed
with `bun db/generate.js`, never hand-edited), the Conduit target `outpost:<server-id>`
and its `kind`, the snake_case heartbeat payload `outpost_version` / `outpost_url`,
`OUTPOST_SECRET`, `outpostFor()` in `fleet.engine.ts`, `outpostTarget` in
`deployment.engine.ts`, and the prose throughout the schema, services, screens and
the drive.

**Three of those are wire contracts, which is why this happened now rather than
later.** Basecamp's half of the protocol is written — both engines dispatch through
Conduit and `servers.service.ts` registers the target on heartbeat — and the machine's
half does not exist. The caller existed and the callee did not, so this was a
find-and-replace instead of a compatibility window.

`@frontierjs/conduit` moved with it: its `TargetKind` union carried an `'agent'`
member, and `testing.ts` derives the kind from the id prefix, so a target id that no
longer started with `agent:` would have graded as the wrong kind.

`bun run verify --reset` 271/271, which covers the heartbeat, the Conduit dispatch
and the *"No outpost is registered"* refusal. `bun run test` 65/66 — the one failure
is `FJS-177`, unrelated and already allowed in CI.

Not renamed: `userAgent` (an HTTP header), `db/legacy-sql/002_server_agent.sql` (it is
history and `db/README.md` explains it never worked), and the entries above this one.

## 2026-08-13 — the hub prints the subscriber count it used to apologize for

`IEventBus` grew `stats()` in Junction (`FJS-143`), so the hub's badge shows
`N event subscribers` instead of *has listeners / idle*, and the "Not shown
here" card drops the paragraph explaining why the number could not exist. CPU is
the one figure left on that card, and it still says so rather than printing
something derived from a single reading.

The drive's assertion changed with it: it used to check the screen contained the
words *cannot produce*, which is a check that passes hardest exactly when the
gap is never closed. It now asserts the number is there and rendered.
`verify` 271/271 (`--reset`).

## 2026-08-10 — the first `@@allow`, and what it found under it

`Server` declares row-level tenancy in the schema:

```
@@allow('all', workspaceId == auth().workspaceId)
```

One model of 37, deliberately. The declaration itself is a line — the work is
the audit that has to come before it, because **a policy filters where a gate
refuses**: any read that legitimately crosses a workspace and is not
`asSystem()` stops matching, with no error and a 200. Here that audit came out
clean, which is the only reason this was a one-line change: the three engines
each open with `app.data.asSystem()` and say why, the hub reads through
`asSystem()` because `User` is gated above SYSADMIN, and the outpost's heartbeat
does too. `workspaceId` reaches `auth()` the way `memberRole` does —
`applyStanding()` puts both on the principal for the workspace being addressed.

Five tests in `db/test/schema.test.ts` run it with **no service and no hook**,
which is the only way to tell a policy from the where-clause the service was
already writing: a caller reads one workspace's servers with no `where` at all,
naming another workspace's row by id answers null, and creating or moving a
server into another workspace is refused.

**Two Litestone defects were in the way, and neither was visible from here.**

`include:` applied **no** access rule of the model it reached — not `@@allow`,
not `@@gate`, not `@guarded` (`FJS-150`). So the declaration would have held on
`/servers/` and leaked one join away, and the `@@gate` work of the previous
session had the same hole underneath it the whole time.

And a post-update denial did not roll back on a model with a Json column
(`FJS-151`) — which `Server` is, four times over. *Move this server into another
workspace* is exactly what post-update refuses, and the revert threw a SQLite
binding error on its way out: the caller saw a `TypeError` about bindings, and
the write the policy had just refused stayed in the database.

`verify` 270/270, 61 data tests (was 56).

## 2026-08-10 — the gate, and why it could not be `example`'s four lines

All 37 models declare `@@gate`. `FJS-007` had been open since Phase 1 and
deferred on purpose until every screen existed; what it was actually blocked on
was never the resolver.

`sessionGateLevel()` grades standing that travels with the user —
`isAdmin`/`isOwner`/`isSystemAdmin`, the lifecycle stamps. None of that can say
*admin of THIS workspace*, and here the same person is `owner` in one workspace
and `viewer` in the next. Graded from their user row they would be USER(4)
everywhere, including workspaces they are not in.

So the level is resolved per request from the `WorkspaceMember` row for the
workspace being addressed: viewer/billing READER(2), developer USER(4), admin
ADMINISTRATOR(5), owner OWNER(6), `isSystemAdmin` SYSADMIN(7) above any
membership, and an authenticated caller with no membership VISITOR(1) — which
reads `Workspace` and nothing else, because that is the screen a fresh login
needs before it can name a workspace at all.

`applyStanding()` (`core/hooks.ts`) does it once and replaces the two membership
queries the hooks were each making. Three things it has to get right, each of
which was a way to ship a gate that does nothing:

- **It puts `memberRole` on the PRINCIPAL, not on the client.** Junction's
  `getTable()` re-derives its own scoped copy from `ctx.auth.user`, so a
  standing that lives only on `ctx.locals.db` is dropped the moment a service
  touches a model.
- **A fresh object, never a mutation.** Over WebSocket the session is resolved
  once at upgrade and shared by every frame — and the internal-call path freezes
  it — so mutating would either throw or leak one call's role into the next.
- **It re-resolves when the workspace changes mid-request.** The workspaces
  service addresses `ctx.id`, not the header; without this an admin of the
  workspace on screen carried level 5 into a patch of any other workspace they
  could name.

The levels are not a design drawn on paper: they are the `requireWorkspaceRole`
calls the services were already making, moved to the one place that also covers
an engine calling a service in-process, a custom action nobody wired a hook
onto, and a where-clause built by hand. The hooks stay — a gate refuses with a
level, a person needs the sentence.

Two departures from the levels `db/README.md` had recorded since Phase 1, both
because a path reads what it needs: `Recipe` reads at 4 rather than 5 (running
one is a developer's act, and running it means reading the script), and the
machine-written models read at 2 rather than being SYSTEM throughout (a person's
action writes the `ServerEvent` beside it; only the engine's updates are 8).
`AuditEvent` is `"5.8.9.9"` — LOCKED on update and delete, which `asSystem()`
does not pass either, so `db:seed --force` no longer clears the table and lets
the workspace FK cascade do it instead.

`runSeeder` also ran on the root client, which grades STRANGER(0). The seed's
own header said everything runs as system; that was the one line that did not.

**Proven by refusal.** The drive signs in as the setup user, who is
`isSystemAdmin` and clears every gate in the schema, so 262 green checks proved
only that the app still works. Eight new checks ask the same API as a second
human: a viewer reads the fleet and creates nothing, a developer writes projects
and is still refused `GET /secrets` **with the level named in the message** —
the check that fails if `memberRole` never reaches the principal, since no hook
refuses that read. Plus 8 tests at the Data boundary against the app's own
resolver. `verify` 270/270, `bun run test` 56.

It found a framework defect on the first request: `db.asSystem().$transaction()`
handed its callback the ROOT client, so `POST /setup` failed with *"Account.create"
requires SYSTEM access (use asSystem())* about a call that was using it
(`FJS-149`, fixed in litestone).

## 2026-08-10 — the drive stopped stepping around the thing it found

`verify.mjs` § 13c-ter is the only reproduction of `FJS-139` — a reload driven
from a channel subscriber that does not settle — and it had an
`await goto('/volumes/')` immediately before the check that would have caught it.
The check therefore passed against a fresh navigation whether or not the live
reload ever settled: the test that found the defect was also the reason it could
not be observed again.

The goto is gone. That check now reads whatever the push-driven reload produced,
and `bun run verify --reset` passes **262/262 three runs consecutively** in that
state, so FJS-139 is closed as not reproducible. Which change stopped it is not
known — the register says so rather than crediting the nearest fix. What makes
closing it acceptable is that the live path is now asserted: if it comes back,
the drive fails on it instead of navigating past it.

The same run is what proves this app against three junction changes landed the
same day — `find` must answer a list, an action's answer is no longer rebuilt as
a list, and a dropped WebSocket frame is now held and re-sent. Roughly fifteen
services here answer `{ total, limit, offset, data }` from a custom action and so
now arrive unwrapped; every consumer reads `.data`, and 262/262 says so in a
browser rather than in a grep.

## 2026-08-10 — the tier above every tenant

Phase 10: `/hub/`, `/hub/workspaces/`, `/hub/users/`, `/hub/flags/` — the last
group of screens whose blocker was an API rather than a model, and the run-up to
`FJS-007`. 21 services, 37 models, 31 of 41 screens. Details in
`docs/SCREENS.md` § Phase 10; three rulings in the repo's `DECISIONS.md`.

**A tier above every tenant is a separate service.** Nineteen of the twenty
services here take `X-Workspace-Id` and refuse without it. Widening them with
`?scope=hub` would have put the tenancy decision in a query string on nineteen
services, each of which has to get it right. `/hub` takes no workspace at all,
sits behind one `requireSystemAdmin` hook, and reads through `asSystem()` —
which is not a convenience: `User` is gated at level 8 by auth's own schema
fragment, one above SYSADMIN, so once `FJS-007` lands no caller-scoped client
can read a user list. Those reads are already written the way they will still
have to be. Refusal is 404, not 403.

**The privileged bit is `User.isSystemAdmin`, and the name is load-bearing.** Not
auth's `role`, which defaults to `"user"` and which nothing here reads — that
would be one column with two owners. The name is the one `sessionGateLevel()`
already grades SYSADMIN(7) on, so the column filling these screens today is the
column `@@gate` will read tomorrow. `/setup` grants the first one, because it is
the only place a system administrator is created rather than granted.

**Suspension was a word nothing honored.** `User.status` had been a free
`String` since the schema was written and @frontierjs/auth never reads it, so a
Suspend button would have reported success and revoked nothing. Three things
make it real and no two are enough: an enum, so the column carries a CHECK and
the service's copy is held against it by a test in both directions; the front
door, checked AFTER the password so it does not disclose which addresses are
suspended; and the door already open — a token issued before the suspension
stops resolving, because deleting the `Session` rows misses an API key, which is
a `Credential`. For a workspace the one door is `scopeToWorkspace`, so it bites
in nineteen places by being written in one. Suspension is not deletion:
`@@softDelete(cascade)` stamps every child, a status change stamps nothing.

**Bot accounts, and the API-key gap they close.** The Users screen creates
`UserKind.bot` users and ships without the mock's Invite button. A bot has no
password credential, so creating one hands nobody anything; creating a human
here would be an admin minting an account with a password only they know
(`FJS-032`). Its address is at `bots.invalid` — RFC 2606 reserves the TLD, so it
resolves nowhere and can never be mailed. It may not own a workspace and may not
hold the hub tier. This closes what `api-keys.service.ts` had recorded in its own
comment since Phase 6: a key was always minted for the caller, so CI's key was a
person's key. A key may now name a bot — only a bot, only in this workspace, and
only one that does not outrank you.

### What building it found

- **An app could not get its own User columns onto the session.** auth owns
  `model User`, every app extends it, and the only route to `isSystemAdmin` per
  request was to wrap `verifySession` and re-read the user — a third query on
  the hottest path in the app, forever, for a row auth had just fetched. Closed
  in @frontierjs/auth with `createLitestoneAuth(db, { sessionFields })`, called
  from `toContext()`, the one place every issued session is built, so it covers
  login, `verifySession`, an API key and `createUser` alike. Spread last, so an
  app that states a field wins.
- **A `find` that answers one object becomes an EMPTY list in the browser**
  (`FJS-144`). `GET /hub` was the overview; the client normalises anything that
  is not a list into `list(name, [])`, so the screen received `{ data: [] }`
  with a 200 and rendered nothing at all. The API was correct throughout — only
  the browser could see it. `find` means a list; the overview is an action now.
  Same class as `FJS-140`, from the other end.
- **The typechecker caught a stat that would always have read zero.**
  `app.conduit.list()` is async, and `.length` on the promise is `undefined`,
  which `?? 0` turns into a confident *no targets registered* on a hub with
  twelve. Both answers render, so nothing in a browser could have found it.
- **The in-process event bus cannot be counted** (`FJS-143`). `IEventBus`
  answers `hasListeners()` and nothing else — no subscriber count, no list of
  subscribed names. The mock's "Event subscribers" tile does not exist; the
  overview shows the true half and says which.
- **A fifth stale dev server, again.** An `example` API five hours old held
  :3610 and would have answered the auth regression run with pre-change code.

## 2026-08-10 — the two ways to act on a machine

Phase 9: `/recipes/` and `/cleanup/`, over four new models — `Recipe`,
`RecipeRun`, `DiskUsage`, `CleanupRun`. 20 services, 37 models. Details in
`docs/SCREENS.md` § Phase 9; the ruling is in the repo's `DECISIONS.md`.

**A vocabulary cannot bound a script, so the record does.** The obvious move was
to apply yesterday's saved-view ruling again, and it does not transfer: a stored
query is dangerous because it is executed at the Data boundary, where `@@gate`
and `@@allow` grade a caller against a model; a script is handed to an outpost and
run on a machine, where there is no model and no grade at all. So the two
screens carry opposite safeguards. A cleanup stores target NAMES from a fixed
list and refuses anything else by name; a recipe stores code, authoring it is
admin-or-owner, running it is developer, and every run keeps the script it ran.

**Authoring and running split on purpose.** Writing the script is the privileged
act; running a vetted one is what somebody on the pager does at 3am. Collapsing
them makes recipes admin-only in practice, which is how people end up pasting
the script into a terminal instead.

**One run row per SERVER**, because a fleet run is N executions with N exit
codes and a single row must pick one status for *three succeeded and two
failed*. Neither screen executes anything: both queue on Caravan's new `fleet`
queue and `api/src/engine/fleet.engine.ts` asks the outpost through `app.conduit`
— one file for both, because the shape is one shape (resolve the outpost, send,
record, push) and only the safeguards differ.

**Every number on the cleanup screen was measured by Docker.** `DiskUsage`
carries `docker system df`'s own per-category reclaimable figures; the mock
multiplied a count by an average and printed gigabytes next to figures that were
real. The estimate sums by SOURCE rather than by target, since both image
targets draw on one reclaimable figure and adding them would promise twice what
a sweep can deliver. A machine that has never reported says so instead of
rendering zeroes, and unused volumes — the one target no registry can undo — are
off by default.

`DiskUsage` counts no volumes and stamps no last-cleanup: `Volume` owns per-disk
sizes and `CleanupRun` owns when a sweep ran. A sweep's answer carries a fresh
`usage` snapshot from the outpost that just measured it, written through the same
function the report endpoint uses, and volumes it removed are forgotten only by
the names it confirms — the rule `volumes.prune` already follows.

### What building it found

- **A set-valued vocabulary has no home in the schema** (`FJS-141`).
  `targets ReclaimTarget[]` does not parse — *array [] is only supported for
  Text, Integer, File, or a model name for many-to-many* — so a declared enum
  beside a `String[]` column would be two homes with nothing joining them, the
  shape that let `AlertRule.severity` default to a value its own API refused.
  One home in `api/src/services/cleanup/targets.ts`; a data test asserts the
  schema declares no competing enum.
- **`stampWorkspace` is not optional bookkeeping on a resource.** `Recipe.mesa`
  shipped without it because the service stamps `workspaceId` itself — but
  browser-side validation runs first, so every save was refused in the form with
  *workspace is required*, a field the form does not show. Caught by the browser
  drive on its first run, which is the only place it is visible.
- **`enum JobRunStatus` became `enum RunStatus`**, shared by `JobRun`,
  `RecipeRun` and `CleanupRun`. Three copies of the same five words drift apart
  one value at a time; a data test names all three models.

Not built, and said on both screens: a schedule. A sweep or a recipe on a timer
is a `Job` with a cron expression, and a second scheduler on either screen would
be a second owner of when the fleet gets touched.

## 2026-08-10 — a saved view names a kind

Phase 8: `/dashboards/` + `/dashboards/[id]/`, over two new models, `Dashboard`
and `DashboardWidget`. 18 services, 33 models. Details in `docs/SCREENS.md`
§ Phase 8; the ruling is in the repo's `DECISIONS.md`.

**A widget names a declared KIND. It never stores a query.** A widget carrying
`{ accessor, where }` is a read in a row, and a row travels while a policy does
not — `@@gate` and `@@allow` grade a caller against a model, never against a
string, so the server would run one person's query at another person's
privilege. `enum WidgetKind` is the vocabulary instead, and one declaration does
three jobs: the column's CHECK, the API's validation, and the Add-widget picker,
which reads it as a `$def` on the model's JSON Schema the way every other enum
already reaches the browser.

**Nothing on a board reads on the board's behalf.** Each card calls the service
that owns its data with the reader's own session, so a dashboard shows exactly
what its reader could have opened for themselves — and the activity card tells a
developer the trail is admin-only rather than rendering empty.

**What the schema cannot say lives in one file.** Which kinds take a server,
which take an app, which config keys each reads, and the sentence a thin card
prints — `api/src/services/dashboards/kinds.ts`, fetched by the screen through a
collection-level `kinds` action rather than copied into the bundle. A data test
holds the enum and that table together in both directions.

All nine of the mock's widget types ship. Three say what they cannot show:
nothing here stores a time series, so `server_health` is the last heartbeat
rather than a trend, `service_health` is a live ping with no latency, and
`alert_status` has rules but no evaluator (`FJS-123`). The mock's counter holds
a number typed in when the widget is added; this one names a source from a
declared list and reads that service's own `total`.

A widget's subject is a real relation (`serverId`, `appId`) with
`onDelete: SetNull`, so a card whose machine was really deleted keeps its place
and loses its subject. `config` is knobs, and an unknown key is refused by name.
The pin is the workspace's, not the reader's, and says so. No color column —
`@frontierjs/css` styles by tone, and a stored hex is one the theme cannot
follow.

### What building it found

- **A custom action that answers `data` plus anything else loses the anything
  else** (`FJS-140`). `kinds` returned `{ total, data, statSources,
  portalServices }`; `wrapResult` read the first two keys as a paginated list
  and rebuilt the envelope from those alone, so the picker received nine kinds
  and neither vocabulary needed to configure them — 200, no warning. Three named
  keys instead makes it a `single`, which unwraps whole. `volumes.usage`
  documents the same trap from the other side.

`bun run test` 39 · `bun run verify` **207** · `bun run verify:build` 8 ·
typecheck unchanged at 77.

## 2026-08-10 — the first thing here that is observed

Phase 7: `/volumes/`, over the `Volume` model that had landed with no service,
no screen and no seed data. 17 services. Details in `docs/SCREENS.md` § Phase 7.

**A volume is OBSERVED, not declared.** Every other model in this app is
something a person created and Basecamp then acts on. A volume exists because
Docker made it and an outpost found it, so the service has no `create` — a row
appears because a machine reported it, through `report`, which replaces that
server's whole set and is exempted from `sessionScope` by name the way
`servers.heartbeat` is.

**Deleting a row is not deleting a volume.** `remove` and `prune` ask the
outpost, through `app.conduit`, at the `outpost:<id>` target a heartbeat registers,
and forget the row only once the machine says the disk is gone — `prune`
forgets exactly the names the outpost confirms, never the ones it asked about. A
server whose outpost has never checked in refuses in words and keeps the row: the
alternative leaves the disk full and the fleet's picture wrong in the one
direction nothing can detect. A mounted volume refuses too, naming the
containers.

**No `workspaceId` on the model**, so the scope is the join through its server
— the same two indexed queries `servers.feed` runs. Sizes are bytes; the screen
decides MB or GB.

### What building it found

- **Nothing had ever sent to an outpost, and it could not have.**
  `servers.heartbeat` registered the conduit target with
  `auth: { type: 'hmac', secret }`, but conduit's hmac signer reads **`ref`** —
  so every outbound call to an outpost failed `auth_failed` naming credential
  `undefined`, and the shared secret was written into the registry in plaintext
  where `GET /conduit-targets` hands it back. Both halves gone: the target
  carries `env:OUTPOST_SECRET` and `createSecretResolver` resolves an `env:` ref
  through `core/env.ts`, so an undeclared name fails closed. The literal it used
  to sign with was not the app's `OUTPOST_SECRET` either.
- **The outpost was only registered on a status transition**, inside the
  `came_online` branch, while the comment beside it claimed "first heartbeat /
  IP change". A machine already online when its outpost first reports a URL never
  transitioned, so it was never registered. Registration is keyed on the URL now.
- **Omitting a method does not remove it.** With `model:` set, Junction's
  Litestone base answers every CRUD verb the service leaves out — validated, so
  `POST /volumes` answered **201** and wrote a row no disk corresponded to.
  `methods:` is the allow-list that makes an absence real, and Junction's own
  docs say so.
- **`bun run db:seed --force` could not run on a fresh database.** SQLite
  resolves a table at prepare time, so the `DELETE FROM "_litestone_seeds"`
  threw `no such table` before anything was reseeded — which is every database
  `verify --reset` leaves behind. The delete list had also drifted: eleven
  models were missing from it, so a `--force` left their rows behind.
- **`FJS-139`** — a service call issued from a channel subscriber can hang until
  some other call is made. Open, not worked around here.

## 2026-08-09 — the token this app issues

Phase 6: `/api-keys/`, and the third direction of "proving identity" that the
two credential models did not cover between them. A `Credential` is how a
person proves identity **to** Basecamp; a `Secret` is how Basecamp proves
identity **to** a provider; an `ApiKey` is a token Basecamp **issues**. 30
models. Details in `docs/SCREENS.md` § Phase 6.

**The token is nowhere in this app.** `@frontierjs/auth` mints it and keeps an
HMAC of it in a `Credential`; `ApiKey` owns the operational half — workspace,
scopes, usage, revocation — and stores a hint (`fjs_AbCd…wXyZ`) and nothing
else. So the mock's `reveal` button is not a feature that was skipped. Building
it would mean storing the token, which is the one thing an API key exists not
to do, and a db test asserts against the generated DDL that no column could
hold one.

**A scope is `<service>:<read|write>`, and the resource half IS the service
name.** No mapping table: the vocabulary is derived from the service registry
at call time, so a service added tomorrow is grantable tomorrow, and a checkbox
can never offer a scope the guard does not recognize. The screen fetches it
from a collection-level `scopes` action rather than shipping a copy. Two
services are off limits to a key at all — `api-keys` itself, because a key that
can mint keys escalates past its own scopes, and conduit's management service.

**Revoked is a state, not a deletion.** Revoking deletes the credential — the
token stops working on the next request — and keeps the row, so an operator can
still see what was taken away and when. There is no `@@softDelete` on the
model: revoked and deleted are two states, and a third hidden one would make
four out of two.

**Usage is attributed per key**, in an app-level after hook, and only counts
what the key was allowed to do. `lastUsedAt` + `totalUses` + a day-stamped
counter (`usageDate` / `usesOnDate`), so "uses today" rolls over by comparison
rather than by a scheduled job. One write per authenticated key request, which
is what last-used costs.

### What building it found — three defects, all in @frontierjs/auth

None were visible from inside this app, and all three failed in the direction
that looks like success. Full write-ups in `../../ISSUES.md`:

- **`FJS-134` — an issued key authenticated nothing.** Junction's transport
  resolves a Bearer token through `verifySession()` and calls `verifyApiKey`
  nowhere, and the native provider never fell through. Every key this screen
  minted would have been anonymous.
- **`FJS-135` — a key's scopes were dropped on verification.** Stored on the
  credential, built from the user row, so every key carried its owner's full
  standing. The scope picker would have been decoration.
- **`FJS-136` — `revokeApiKey` revoked nothing here.** It coerced
  `Number(keyId)` because auth's own fragment declares an `Int` id; this schema
  uses uuids, so it matched no row and threw nothing. Revoke would have
  reported success and the key would have kept working.

The pattern is the one this app keeps producing: a feature that is fully
implemented, fully unit-tested, and has never been used end to end.

### And `bun run db:seed` had been broken for two phases

Nothing runs it, so nothing noticed. Two breaks, each left by the phase that
made the schema change:

- `severity: 'high'` on every seeded `AlertRule`. `AlertSeverity` became an enum
  in Phase 3 (`info warning critical`) precisely because the vocabulary had been
  owned twice — and the seed was the third owner, refused by the CHECK
  constraint the migration generates.
- `channels: ['email']` on the same factory, a column Phase 5 replaced with the
  `AlertRuleChannel` join. `table alert_rule has no column named channels`.

Both fixed, and the seed now issues three API keys per workspace — one revoked —
each with a REAL credential from auth, because a key row pointing at no
credential is refused by `apiKeyGuard` and would have seeded the failure path.
The plaintext is dropped on the floor: nothing can read it back, which is the
property, and a seed that printed one would teach the opposite.

**`db:seed` belongs in whatever proves a schema change.** It is the only thing
here that writes every model, and it is the one path `verify` does not take.

## 2026-08-08 — where an alert goes, and what is behind a flag

Phase 5 of the rebuild: `/channels/` and `/flags/`, two screens from the "needs
new models" pile, each chosen because it closed a hole in something already
built. `bun run verify` is **156 checks**; `bun run verify:build` is new.
Details in `docs/SCREENS.md` § Phase 5.

**`NotificationChannel` is the model `AlertRule.channels` was already pointing
at.** That column was `Json @default("[]")` — an array of ids for rows no model
declared, a foreign key with no constraint and no reader. It is now
`AlertRuleChannel`, a real join, and attaching is `alerts.attachChannel`. The
credential is not on the row: a Slack webhook URL is a bearer credential, so it
goes into a `Secret` (`@encrypted`) and only the reference is kept. **`test`
really sends** — through `app.conduit`, with the credential resolved from its
Secret at send time by `core/credentials.ts`, because conduit's default resolver
reads `process.env` and cannot see something a person typed into a form five
seconds ago.

**`FeatureFlag` + `FlagOverride`.** The mock keyed per-environment state by tier
name; that vocabulary already exists as `model Environment`, so an override
points at the real row. `resolveIn()` is the one definition of what a flag is
set to in an environment, exported so `flags.resolve` and the screen cannot
disagree.

**Two gaps closed**: `servers.feed` (`FJS-104`) puts the fleet's own events in
`/activity/` beside the human trail, and `bun run verify:build` (`FJS-085`)
probes the production build, which nothing here had ever done — it cost this app
a blank page once.

**Resource files are now PascalCase singular, one per file** — `App.mesa`, not
`apps.mesa`; 13 renamed, 36 call sites. Repo Invariant 19, ruled 2026-08-08.

Five defects found, four in the framework: a JSON Schema `default` emitted with
the wrong type (`FJS-120`), raw SQL unable to write (`FJS-118`), conduit
refusing a non-JSON response (`FJS-121`), a collection-level action unreachable
from the browser (`FJS-122`), and the kit's toasts having no updatable handle
(`FJS-119`). Still open: nothing evaluates a rule (`FJS-123`), and a rollout
percentage is stored but never applied (`FJS-124`).


## 2026-08-06 — a missing record still needs a heading

134 checks (was 133). The app detail screen rendered its error alert and
**nothing else** when its record was gone — no `<h1>`, so a screen reader landed
on a document with no heading at all and the only statement of what had happened
was styled as a decoration. Reached in the ordinary way: deleting a project
cascades to its apps, and any bookmark or back button then lands there. It now
has an `{:else}` branch with a heading and a way back.

Found by adding the dynamic route to `verify`'s a11y loop, which runs *after* the
deletion checks. Every static screen had passed that audit for days; the branch
that only exists when something is missing had never been audited at all.

## 2026-08-04 — the UI realm

`web/` went from a 12,557-line React mock that had never made a request to a
Sierra SPA over every service. Phases and what each found: `docs/UI_PLAN.md`.

- **Screens.** Setup wizard, login and a navigation guard; workspace switcher;
  Projects → Environments → Apps with environment variables; deployments with a
  live step timeline; the server fleet (drain/undrain/reboot/sync, event trail,
  outpost heartbeat); jobs with run history; an admin zone (members, audit trail,
  appliance adapters).
- **`bun run verify`** — drives all of it in a real browser over CDP and asserts
  **90 facts**, including an accessibility pass on all ten screens. `--reset`
  starts from an empty database. Checks that wait on something arriving poll
  rather than sleep, after a fixed sleep produced one 89/90 run.
- **`bun run db:seed`** — an example fleet: 4 users, 2 workspaces, 9 servers, 80
  deployments with steps, 30 jobs with runs, secrets, audit events. Idempotent;
  `--force` re-seeds.
- **`/audit`** — a new read-only service over `AuditEvent`, admin/owner only.
- **`database main`** is now declared in `db/schema.lite`, so the schema decides
  the database file and `DATABASE_URL` steers that declaration.
- Scripts regrouped: `dev` (both servers, after a port preflight), `api`, `web`,
  `stop`, `build`/`build:*`, `db:*`, `verify`.
- `VISION.md` moved to `docs/` per the root doc convention.

### Fixed in the framework, found by building this

- **Junction dropped the workspace on the WebSocket.** The browser client routes
  CRUD over the socket once one is open and the frame carried no
  `X-Workspace-Id`; the server only sees the upgrade request's headers, so a
  per-call value could not arrive. Client now sends `meta.workspaceId` and the
  channels transport merges that one key onto `ctx.client.headers`.
- **Channels had never delivered anything.** The connection joined
  `workspace:${session.workspace_id}` — the field is `workspaceId`, and auth
  never populates it — and both engines called `channel.publish()`, which does
  not exist (`publish()` is on the manager; a channel has `send()`). Their own
  guards made it a silent no-op.
- **`POST /workspaces` was unreachable**: `autoValidate` demanded `accountId`
  and `ownerId`, which `create()` takes from the session on purpose.

### Fixed here

- **The audit trail was writable.** `createService({ model })` grants the full
  CRUD set, so declaring only `find()` left create/patch/remove answered by the
  base service — an admin could forge a row, verified. Now 405.
- **Four custom methods answered a partial row** — `setVariable`, the deployment
  engine's projection, `heartbeat`, `jobs.trigger` — each breaking a caller that
  assigned the result over the record it was rendering. All return the record.
- **The outpost heartbeat published to nothing**: `workspaceChannel` reads
  `ctx.locals.workspaceId`, which `sessionScope` sets, and heartbeat is exempt
  from it. It now stamps the workspace from the server row.
- **The job engine published nothing**, so a triggered job wrote its `JobRun`
  and told nobody.
- **Tests were opening the development database.** They passed
  `createClient({ db: <tmpdir> })`, which a `database` declaration silently
  overrides; they steer `DATABASE_URL` now.

## 2026-08-03 → 2026-08-04 — Data and API realms

Rebuilt from "cannot start" to an app that boots and serves. `db/schema.lite` is
the seed (24 models, 15 enums); the migration is generated from it. All services
moved onto Litestone accessors — **zero raw SQL in `api/src`** — with identity on
`@frontierjs/auth`'s schema fragments. The `/api` prefix was removed from auth
and setup so every path in the app agrees. Detail in `PROJECT_STATE.md`.
