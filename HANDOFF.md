# Handoff — 2026-08-10

> **Basecamp declares `@@gate` on all 37 models and `@@allow` on one** — `Server`,
> as of 2026-08-10. The gate ladder is per WORKSPACE, not per user, which is why
> `example/api/gate.ts` could not be copied; the policy is graded off the same
> principal. Every screen whose blocker was an API is built —
> `packages/basecamp/docs/SCREENS.md` is the map, 41 mock screens, **31 built**.

Session state for picking up cold. Read `CLAUDE.md` first (the map), then this.

Everything below was verified by running it, not by reading. Where I could not
verify something, it says so.

**Sessions are recorded here, newest first.**

---

## Next — the other 36 models (2026-08-10)

`Server` declares `@@allow('all', workspaceId == auth().workspaceId)` and holds.
The rest is repetition with an audit in front of each one, and the audit is the
part that matters: **a gate refuses, a policy filters**, so a read that
legitimately crosses a workspace and is not `asSystem()` returns nothing with a
200. For `Server` that audit came out clean — the three engines, the hub and the
agent's heartbeat were already system paths. The next model may not be.

Do them one at a time with `bun run verify` between. Two shapes to look at
before each: **who reads this model without a workspace** (grep the service for
`asSystem`), and **which parent includes it**, now that an include really does
apply the child's rules.

`Volume` and `ServerEvent` are the interesting pair, because neither carries a
`workspaceId` — their tenancy is the join to `Server`, and `check(server)` is
the policy expression for exactly that. Worth doing early: it is the shape most
of the remaining models are not, and it will say whether `check()` through a
belongsTo is enough.

**Still unruled**: `/metrics` is unauthenticated (`healthPlugin` got no token),
so the service registry and every action name is world-readable. Untouched
again this session because the drives and any external probe read it — it wants
a decision, not a quiet edit.

**Not run this session: `example`'s browser drives.** A `bun run api` from
another session has held :3600 since 03:50 (11h54m at the time of writing) and
serves pre-change code; killing it is not mine to do, and probing it would have
proved the old build. If you can clear that port, `example`: `verify` +
`verify:public` are the two the litestone read-path change most deserves.

---

## Session — auth was written as a folder, not as a package (2026-08-10)

```
packages/auth        83 tests unchanged · typecheck 4, unchanged (its baseline)
example              verify 37/37 · basecamp verify 270/270 (--reset)
```

`FJS-003`, closed. The row named three things and all three were the same
mistake: the package was written as a directory that happens to sit next to
junction, rather than as something that leaves the workspace.

**Eight imports of `../junction/index.ts`** across `auth.ts`, `plugin.ts`,
`types.ts`, `crypto.ts` and `cleanup.ts` — a path *out of the package root*.
Three of the eight are runtime values (`parseTtl`, `createScheduler`, the three
error classes), so an installed copy did not typecheck wrong, it threw on
import. They are now `@frontierjs/junction`. Worth knowing why this was only
ever auth's bug: conduit, caravan, notifications, basecamp and `sierra/example`
were all already writing the specifier, so **auth was the one package resolving
by adjacency**, and nothing in the repo could see it because adjacency held.

The peer range was `"*"` (now `^0.1.0`) and there was no `files` field (now
`["*.ts", "README.md"]`, a 10-file tarball rather than one carrying `tests/`
and the state docs).

**Proven the way the row asked**: `npm pack`, install the tarball into an empty
project, import it, build a plugin. Two things that probe teaches, neither
obvious from the diff:

- **`bun install` cannot satisfy a semver peer from a `file:` dep.** The probe
  404s on `@frontierjs/junction` even with junction's own tarball installed
  beside it — and it does that with `"*"` as the range too, so it is not the
  range. `npm install` resolves it from the tree and the import passes. Do not
  read that 404 as a regression.
- **auth still cannot reach npm, and it is junction's turn now.**
  `@frontierjs/junction` is unpublished, and it is a peer. Nothing left on
  auth's side of that.

## Session — an include enforced nothing, and one model got a policy (2026-08-10)

```
packages/litestone   1480 tests (was 1462) · junction 919 · sierra 833 + 5 safety
packages/basecamp    verify 270/270 · 61 data tests (was 56) · typecheck 63, unchanged
```

The ask was `@@allow` on `Server`, one model, as the start of moving row-level
tenancy out of service where-clauses. The declaration is one line and it works.
Everything else here is what was found underneath it.

**The audit named in the last handoff was the `include:` graph, and the answer
was worse than the question.** The question was *does a policy on a child model
apply to a parent's include* — asked by probing rather than reading, and the
answer is that **nothing** did. Not the policy, not `@@gate`, not `@guarded`,
not a field `@allow`. A caller refused `Vault.findMany` by a level got the whole
table back as `team.secrets`, with the `@guarded(all)` column in plaintext and
the `@encrypted` one as raw ciphertext. `resolveIncludes()` builds its own SQL
below the query pipeline — which is why the soft-delete and `@@hasTemplates`
filters in it are hand-appended, and why the access rules, which nobody
hand-appended, were absent. 1462 tests and not one asked a policy question
through an include (`FJS-150`).

That is also the sentence that matters for the previous session's work: **the
gate the last handoff called landed was one join away from not being enforced
at all**, for a day, in an app whose whole tenancy model is nested.

Three fixes, because the three rules answer at different times. The gate is a
**preflight** in `GatePlugin.onBeforeRead`, walking `include:`, `select:` and
`_count`: `getLevel` is async and the include resolver is not, and a gate is per
model, so refusing by name beats returning an empty list that reads as *no rows*.
The row policy is compiled into all three relation SQL shapes and both `_count`
shapes — subqueried in the m2m branch, where the target is aliased beside the
join table and the policy compiler emits unqualified column names. The field
rules moved out of `makeTable`'s closure into `applyFieldPolicyTo(row,
modelName, …)`, because an include holds rows of a model that is not its own.

**The second defect only appears when a policied model has a Json column, and
`Server` has four.** `@@allow('post-update', …)` reverts a write that became
illegal once it landed, and it reverted from the `read()`-shaped snapshot —
where a Json column is an object, and a SQLite parameter cannot be one. So the
revert threw `Binding expected string, TypedArray, boolean, number, bigint or
null`, the `AccessDeniedError` never reached the caller, and **the write the
policy had just refused stayed in the database** (`FJS-151`). It reverts from
the raw row now; `beforeRow` stays read-shaped for the audit snapshot, which is
what wanted it that way.

**What the declaration itself needed was an audit, not a line.** Every read that
crosses a workspace has to be `asSystem()` before the policy exists, or it
silently filters to nothing — and here all of them already were, each with a
comment saying why. That is the only reason this was a one-liner, and it will
not be true of every model.

Five tests run the policy with **no service and no hook in the picture**
(`db/test/schema.test.ts`), which is the only arrangement that can tell a policy
from the where-clause the service was already writing: a caller reads one
workspace's servers with no `where` at all, naming another workspace's server by
id answers null, creating or moving one into another workspace is refused, and a
`Workspace` carries only its own servers through an `include`.

**A third defect came out of the probe schema rather than the app** (`FJS-152`,
also fixed). Implicit many-to-many only ever worked on models keyed `Int @id`
named `id`: the join table hardcoded `INTEGER … REFERENCES "<table>"("id")` and
six runtime sites read the target's key as the literal `.id`. A uuid key dies
loudly on the first connect; **a key named anything else fails silently**,
because join rows are written `INSERT OR IGNORE` and OR IGNORE swallows a NOT
NULL as happily as a duplicate — connect returns the row, writes nothing, and
the relation reads back empty. Nothing in the repo noticed because nothing here
uses the feature: `basecamp` writes an explicit join model all three times, and
`sierra/example`'s ids are `Int`.

---

## Session — the gate that was deferred ten phases (2026-08-10)

```
packages/basecamp   verify 270/270 (was 262) · 56 data tests (was 49)
                    typecheck 63, baseline lowered from 76
packages/litestone  1461 tests (was 1458) · junction 919 · sierra 810 + 5 safety
```

`FJS-007` closed. All 37 models declare `@@gate`; `FJS-149` was found on the
first request of the drive and fixed in litestone.

**What it was actually blocked on was never the resolver.** `sessionGateLevel()`
grades standing that travels with the user, and here the same person is `owner`
in one workspace and `viewer` in the next — so grading them from their user row
answers USER(4) everywhere, including workspaces they are not in. The level is
resolved per request from the `WorkspaceMember` row for the workspace being
addressed: viewer/billing 2, developer 4, admin 5, owner 6, `isSystemAdmin` 7
above any membership, and an authenticated caller with no membership 1 — which
reads `Workspace` and nothing else, because that is the screen a fresh login
needs before it can name a workspace.

**Three things about `applyStanding()` are the work; the rest is arithmetic.**
It puts `memberRole` on the PRINCIPAL rather than on the client, because
junction's `getTable()` re-derives its own scoped copy from `ctx.auth.user` and
would drop it. It builds a fresh object rather than mutating, because the WS
session is resolved once at upgrade, shared by every frame on that socket, and
frozen. And it re-resolves when the workspace changes mid-request — the
workspaces service addresses `ctx.id`, not the header, and without it an admin
of the workspace on screen carried level 5 into a patch of any other workspace
they could name.

**The levels were not designed, they were moved.** Each one is the
`requireWorkspaceRole` call the service was already making — into the one place
that also covers an engine calling a service in-process, a custom action nobody
wired a hook onto, and a where-clause built by hand. The hooks stay: a gate
refuses with a level, a person needs the sentence.

**262 green checks proved nothing about the gates and that is the trap.** The
drive signs in as the setup user, who is `isSystemAdmin` — SYSADMIN(7) clears
every gate in the schema. Eight checks now ask the same API as a second human,
and the one that matters is *a developer is refused `GET /secrets`*, asserted on
the message naming the level: no hook refuses that read, so it fails if
`memberRole` never reaches the principal. That is the only check that can tell
a working gate from a wired-up-but-inert one.

**`FJS-149` — `$transaction` on a scoped client handed the callback the ROOT
client.** `POST /setup` writes four models in one transaction as system and
failed with *"Account.create" requires SYSTEM access (use asSystem())* about a
call that was using `asSystem()`. The mirror image is the quiet one:
`$setAuth(u).$transaction(…)` ran with `auth()` null, so `@@allow` matched
nothing and `@createdBy` stamped nobody. The `query()` batcher on those same
proxies already kept its scope and says so in a comment; `$transaction` was the
one that did not.

Two smaller things fell out: `runSeeder` ran on the root client (STRANGER(0)) in
a file whose own header says everything runs as system, and `AuditEvent` at
LOCKED(9) means `db:seed --force` cannot clear the table — it lets the workspace
FK cascade do it.

**Not run: `example`'s browser drive.** The rule table says a litestone client
change wants it. Port 3600 was held by an `example` API from another session
that has been up since 03:50, running pre-change code; killing it is not mine to
do, and probing it would have proved the old build. The change is covered by
litestone's own 1461 (3 written for this), basecamp's 270 in a browser, junction
919, sierra 810 + `test:safety`.

---

## Older sessions

`docs/handoff-archive/2026-08.md` — every session before the two above, newest
first, unedited.

**Rotate when a third session lands here.** This file is read cold at the start
of every session, so it stays at two; the archive is unbounded and read only
when something specific is being traced. Nothing is deleted — the move is a cut
and paste, and the archive keeps its own newest-first order.

What an archived session is NOT: a statement about the current tree. Live
behaviour is `CLAUDE.md`, open defects are `ISSUES.md`, settled questions are
`DECISIONS.md`. If a session note and one of those three disagree, the three win
and the session note is history.

