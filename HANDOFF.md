# Handoff — 2026-08-10

> **Basecamp rebuild: every screen whose blocker was an API is built.**
> `packages/basecamp/docs/SCREENS.md` is the map — 41 mock screens, **31 built**,
> and the 10 left each need a new model or a real third party. **Gating
> (`FJS-007`) was deliberately scheduled last and nothing is in the way of it
> any more.** It is still S1.

Session state for picking up cold. Read `CLAUDE.md` first (the map), then this.

Everything below was verified by running it, not by reading. Where I could not
verify something, it says so.

**Sessions are recorded here, newest first.**

---

## Next — `FJS-007`, the gate that was deferred ten phases (2026-08-10)

**Declare `@@gate` in `db/schema.lite` and delete the service hooks that stand
in for it.** This is the outstanding gap against repo Invariant 6 — access is
declared in the schema, not in hooks — and it has been deferred since
2026-08-06 on the grounds that it would be in the way while the app was being
assembled. That reason has expired: every screen is built.

**What Phase 10 already put in place, so it is not re-derived:**

- **`User.isSystemAdmin` is a column and it reaches the session.** The name is
  the one `sessionGateLevel()` grades **SYSADMIN(7)** on, so the field the hub
  screens are gated by today is the field `@@gate` reads tomorrow. The path is
  `core/session-auth.ts` → auth's `sessionFields` → `ctx.auth.user`.
- **The hub's reads already go through `asSystem()`**, because `User` is
  `@@gate("8")` in auth's own fragment — a level even SYSADMIN does not pass.
  The screen `FJS-007` breaks first will not need rewriting.
- **The intended level for every model is recorded** in `db/README.md`
  § Access control, and `example/api/gate.ts` is the pattern.

**What is genuinely undone, and it is the hard part**: a `getLevel` that
resolves the ACTIVE WORKSPACE and maps `WorkspaceMember.role` onto the 0–7
scale. Litestone's scale is global and this app's roles are per tenant, so the
mapping needs the workspace in hand at grading time — which `ctx.locals.workspaceId`
has and a `getLevel(user)` signature does not. That is the design question to
settle first; do not start by writing `@@gate` lines.

**Also worth knowing**: `/metrics` is unauthenticated here (`healthPlugin` got
no token), so the service registry and every action name is world-readable. Not
touched in Phase 10 because the drives and any external probe read it — it wants
a decision, not a quiet edit.

---

## Session — the tier above every tenant (2026-08-10)

```
packages/basecamp   verify 262/262, twice consecutively  (was 230) · verify:build 8/8
                    49 data tests  (was 45) · typecheck 76, baseline lowered from 77
                    db:seed + --force clean · db:check clean
packages/auth       83 tests, unchanged · example/ verify 37/37, unchanged
```

Phase 10 — `/hub/`, `/hub/workspaces/`, `/hub/users/`, `/hub/flags/`. 31 of 41
screens, 21 services, 37 models. The last group whose blocker was an API.

**A cross-tenant surface is a separate service, not nineteen widened ones.**
Nineteen of the twenty services here take `X-Workspace-Id` and refuse without
it, which is the tenancy boundary working. Widening them with `?scope=hub` puts
the decision *may this caller see every tenant* into a query string, on nineteen
services, each of which has to get it right — nineteen chances to leak, and the
one that forgets looks exactly like the eighteen that did not. `/hub` takes no
workspace at all, so there is nothing for a caller to widen, and sits behind one
`requireSystemAdmin` hook. It reads through `asSystem()`, not for convenience:
`User` is gated at level 8 by auth's own fragment, one above SYSADMIN, so those
reads are already written the way `FJS-007` will force. Refusal is 404, not 403.

**`suspended` was a word nothing honoured.** `User.status` had been a free
`String` since the schema was written, and @frontierjs/auth — which owns the
model — never looks at it. A Suspend button written against it would have
reported success and revoked nothing. Making it real took three things, and no
two of them are enough: an **enum**, so the column carries a CHECK and the
service's copy is held against it by a test in both directions; the **front
door**, checked after the password so the refusal does not disclose which
addresses are suspended accounts; and **the door already open** — a token issued
before the suspension stops resolving, because deleting the `Session` rows
misses an API key, which is a `Credential`. For a workspace the one door is
`scopeToWorkspace`, so it bites in nineteen places by being written in one. It is
not deletion: `@@softDelete(cascade)` stamps every child, a status change stamps
nothing.

**A machine account is created from an admin screen; a human is not.** The Users
screen makes `UserKind.bot` accounts and ships without the mock's Invite button.
A bot has no password credential, so creating one hands nobody anything; creating
a human here would be an admin minting an account with a password only they know
(`FJS-032`, still open). It closes what `api-keys.service.ts` had recorded in its
own comment since Phase 6 — a key was always minted for the caller, so CI's key
was a person's key and revoking it when they left broke the pipeline.

All three ruled in `DECISIONS.md`.

### What it found

**An app could not get its own `User` columns onto the session.** auth owns
`model User`, every app extends it, and the only route to `isSystemAdmin` per
request was to wrap `verifySession` and re-read the user — a third query on the
hottest path in the app, forever, for a row `toContext()` had just fetched.
Closed in @frontierjs/auth with `createLitestoneAuth(db, { sessionFields })`,
called from `toContext()`, the single place every issued session is built, so it
covers login, `verifySession`, an API key and `createUser` alike. Spread last, so
an app that states a field wins. Additive — 83 auth tests and `example/`'s 37
unchanged.

**A `find` that answers one object becomes an EMPTY list in the browser**
(`FJS-144`). `GET /hub` was the overview. The client normalises three shapes
into a `ListResult` and everything else falls through to `list(name, [])`, so
the screen received `{ data: [] }` with a 200 and rendered nothing at all while
the API was answering correctly throughout. Only a browser could see it.
Worked around by making the read an action — **`find` means a list**. Same family
as `FJS-140`, from the other end.

**The typechecker caught a number that would always have been zero.**
`app.conduit.list()` is async; `.length` on the promise is `undefined`, which
`?? 0` turns into a confident *no targets registered* on a hub with twelve. Both
answers render, so no browser check could have found it — and the baseline
ratchet is what made the regression visible at all.

### Worth knowing next time

**Smoke over curl first — a third phase running.** Every refusal in the hub
service was proved in ten minutes of `curl` before a line of UI existed, and both
remaining defects were ones only a browser could see. That split is now reliable
enough to plan around: the API is a debugger, the browser is the proof.

**A stale dev server, again, and it was five hours old.** An `example` API from
before this session held :3610 and would have answered the auth regression run
with pre-change code — the exact hazard `CLAUDE.md` documents. Check the port
before starting; a run against a server started before your fix reads as "the
fix did not work".

**Two vocabularies, two homes, one test.** `UserStatus` and `WorkspaceStatus` are
in the schema because the column needs a CHECK, and copied into the service so a
bad value is refused by NAME rather than by a SQLite constraint message. The db
suite imports the service's copy and holds them together in both directions —
the same shape the widget-kind test uses, and the reason `AlertRule.severity`
could once default to a value its own API refused.

## Session — the two ways to act on a machine (2026-08-10)

```
packages/basecamp   verify 230/230, twice consecutively  (was 207) · verify:build 8/8
                    45 data tests  (was 39) · typecheck 77, unchanged
                    db:seed writes 6 recipes / 4 runs / 7 disk pictures / 2 sweeps · db:check clean
```

Phase 9 of the basecamp rebuild — `Recipe`, `RecipeRun`, `DiskUsage`,
`CleanupRun`, and the screens `/recipes/` and `/cleanup/`. 27 of 41 screens, 37
models, 20 services. They were built together because each is the other's
argument.

**A vocabulary cannot bound a script, so the record does.** The obvious move was
to apply yesterday's ruling again — a saved view names a declared kind — and it
does not transfer. A stored query is dangerous because it is executed at the
Data boundary, where `@@gate` and `@@allow` grade a CALLER against a MODEL and a
string cannot be graded. A script is not executed there at all: it is handed to
an agent and run on a machine, where there is no model, no caller and no grade.
It runs at whatever the agent has, for everyone, every time.

So the two screens carry opposite safeguards. A cleanup stores target NAMES from
a list the service owns and refuses anything else by name; a recipe stores code,
**authoring it is admin-or-owner and running it is developer**, and every run
keeps the script it ran. That split is the point: writing the script is the
privileged act, running a vetted one is what somebody on the pager does at 3am,
and collapsing them is how people end up pasting the script into a terminal
instead. Ruled in `DECISIONS.md`.

One run row per SERVER, because a fleet run is N executions with N exit codes.
Neither screen executes anything — both queue on Caravan's new `fleet` queue and
`api/src/engine/fleet.engine.ts` asks the agent through Conduit, one file for
both because the shape is one shape and only the safeguards differ.

**Every number on the cleanup screen was measured by Docker.** `DiskUsage`
carries `docker system df`'s own per-category reclaimable figures; the mock
multiplied a count by an average and printed gigabytes beside figures that were
real. The estimate sums by SOURCE rather than by target — both image targets
draw on one figure, and adding them would promise twice what a sweep delivers.

### What it found

**A set-valued vocabulary has no home in the schema** (`FJS-141`).
`targets ReclaimTarget[]` does not parse — *array [] is only supported for Text,
Integer, File, or a model name for many-to-many*. A declared enum beside a
`String[]` column would be two homes with nothing joining them, the shape that
let `AlertRule.severity` default to a value its own API refused. One home in the
service instead, and a data test asserts the schema declares no competing enum.

**A resource needs `stampWorkspace` even when the service stamps the column.**
`Recipe.mesa` shipped without it, reasoning that the service fills `workspaceId`
itself — but browser-side validation runs first, so every save was refused in
the form with *workspace is required*, naming a field no form shows. The API was
correct throughout; only the browser drive could see it.

**A fixed Chrome debugging port drove another session's browser.** Two runs
failed as `no field #workspace on /packages/css/guide/index.html` — a page from
another package, in a Chrome another session had left on :9333, twenty checks
into a run that was green. Chrome refuses to start a second browser on a bound
debugging port and exits quietly, so the harness's `/json/list` poll found the
other browser's tabs. Both basecamp harnesses now ask for port 0 and read it
back off stderr, which is what `example/`'s four already did.

### Worth knowing next time

**Smoke over curl first — again.** Every API-side defect in this phase was found
in ten minutes of `curl` before a line of UI existed, and the browser suite then
had only UI bugs left to find. Both of the ones it did find were invisible from
the API side.

**A refusal has to be readable in the DOM you assert on.** The kit renders a
field message as `.field-hint.danger` with `role="alert"`; there is no
`.field-error` class, and a selector for one reports the empty string, which
reads as "nothing was refused" rather than "you looked in the wrong place".

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

