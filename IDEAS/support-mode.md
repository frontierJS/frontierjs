---
id: support-mode
status: shipped
dated: 2026-09-04
---

# Idea — Support mode: bounded, audited impersonation

**Status: PROPOSED. Nothing here is built.** Dated 2026-09-04, **cut down 2026-09-05**
against the question *what does this buy over one level simpler* — which removed a model,
a gate, two indexes and a phase. What that pass found is recorded in § *What was cut and
what it cost*, because the pieces are worth adding in the order they earn it rather than
worth forgetting.

Promoted out of `compliance-from-the-seed.md` §6, which argued the *why* in eleven lines
and named no mechanism. It closes [`FJS-142`](../ISSUES.md#fjs-142), which is filed
against basecamp and is a framework question — two screens carry an *Impersonate* button,
neither is built, and both say so on the screen instead.

**The dependency it was waiting for has cleared.** The row in `overview.md` (4.17) says
this sits behind a complete audit trail; `logbook` phases 0–3 shipped 2026-08-31 and the
trail now records `correlationId`, `source`, `origin`, `ip`, `userAgent` and `tenant`
beside the actor, through one seam (`installLogContext`) that this feature extends rather
than invents.

---

## The problem, and why it is structural elsewhere

*A customer says it is broken and nobody can reproduce it* is the most common day-two
task in any application. Everywhere else the answer is a god-mode switch, for a reason
that is not laziness: **where authorization lives in handlers there is no way to say *act
as this person and no higher***, so what gets built is a support agent browsing as an
administrator, with a trail that records the victim rather than the operator.

Here the bound is already declared. `sessionGateLevel` grades the principal in scope, so
a session resolved to the subject cannot exceed what the subject can do, enforced at the
Data boundary by the same mechanism as every other request. Nothing has to remember to
check.

`FJS-142` names the three things that make it real, and they are the outline of the work:
**a trail that keeps saying who is really acting**, **a way back that cannot be forgotten
or lost with the tab**, and **a rule for what an impersonator may not do**.

---

## What it is

**Three columns on the operator's own `Session`, and no new model.**

```
model Session {
  …
  impersonatingUserId  String?
  impersonationReason  String?
  impersonationEndsAt  DateTime?
}
```

An operator with the capability asks for an episode against a subject, with a reason.
Those three columns are stamped on **their own session row** — nothing is minted. From
then until they clear, `verifySession` resolves that token, sees the column, and returns
the SUBJECT's principal, re-resolved through `IAuth.sessionFor`, which already exists for
`app.runAs` and already reads the user afresh and grades them afresh rather than replaying
a stored session. Every layer above the token is unchanged, which is why the ceiling is
free: nothing in junction, sierra or litestone learns that impersonation exists.

**No second credential exists at any point**, which is the correction prior art made
(§ *Prior art*). A design that mints a session for the subject has to keep the operator's
somewhere, swap two keys in `tokenStorage`, and hope the tab holding the way back
survives. Clearing a column needs none of that.

**The record is the audit trail, not a second table.** `Session` already carries
`@@log(audit)`, so stamping these columns writes an entry with `before` and `after`, and
`token` is `@guarded` so Invariant 7 redacts it there. The trail is the thing that
outlives the row by construction — which is what a trail is — so the episode needs no
model to survive logout. `episodeId` on the entry is the session's own id: stable, and
still meaningful after the row it names is gone.

**Who may start one is a capability**, for free: the column carries `@capability`, so the
grant is the mechanism that shipped 2026-08-26 and not a level, an env var or a hard-coded
admin check. **`Session` is `@@gate("8")`**, so nothing outside `asSystem()` writes these
columns and no caller can aim their own session at a subject.

---

## The three answers `FJS-142` asks for

### 1. The trail keeps saying who is really acting

Today an entry records `actorId: ctx.auth?.id`, so an impersonated write files under the
impersonated person — which is `FJS-142`'s complaint stated exactly, and is a live open
grievance against Laravel Nova (§ *Prior art*).

**`actorId` becomes the operator and the subject moves to a column of its own.** The
direction is decided by which error is worse: attributing a support agent's write to the
customer is a false accusation in the record, where attributing it to the operator with
the subject beside it is complete. Two columns on the logger auto-model
(`makeLoggerAutoModel`, `litestone/src/core/client.js`):

| column | outside an episode | inside one |
| --- | --- | --- |
| `actorId` | the principal | **the operator** |
| `subjectId` | null | the principal the boundary enforced as |
| `episodeId` | null | the operator's session id |

`actorType` reads `support`, which is what makes a reader who knows none of this stop and
look. **`episodeId` is what turns a DSAR from a list of data into an answer**: *who looked
at my record, when, and why* is one query on the trail.

**It rides the seam that already exists.** `installLogContext`
(`junction/src/core/litestone.ts`) hands litestone a closure over junction's own request
store and litestone never learns a request exists; this adds three keys to the object it
already returns. An app carrying no episode answers nulls, as it does for every other
provenance column.

**Not `meta`.** The `onLog` escape could carry the operator today, and an app that forgets
to write it files every impersonated action under the victim with nothing said — the
failure this feature exists to prevent, reintroduced as a default.

### 2. A way back that cannot be forgotten

**There is nothing to find the way back to.** The operator's session never left; ending an
episode clears three columns. A tab closed mid-episode loses no credential, because none
was minted.

What remains is the clock and the socket:

- **Every episode has a hard ceiling in time.** `impersonationEndsAt` is required and
  capped by the app's config, and `verifySession` stops honoring the columns the moment it
  passes — read at resolution, so nothing has to sweep to make it true.
- **A live socket is resolved once at upgrade** and hands the same principal to every
  frame (`junction/src/core/litestone.ts`, § claims). So ending an episode must **close the
  sockets that session holds** — blunt on purpose; re-resolving each one is the careful
  version and buys a reconnect the operator would not notice. Without it an operator ends
  an episode and keeps acting as the subject down a connection nobody re-asked. Same class
  django-hijack flushes the session for, one transport along.

The client's `session` carries `support: { operatorId, subjectId, reason, endsAt }`, which
is what a banner renders from. **Nothing derives the banner from a heuristic** — it is a
field on the session or it is not shown.

### 3. What an impersonator may not do

**Two rules, and neither is a new word in the schema.**

The first is the auth package's own: **a support principal is refused by the methods that
change how a person authenticates or who they are** — password change, credential and
API-key mint, session revoke, and the `role`/`emailVerified` writes `user.lite` already
restricts to an admin. One owner (`packages/auth/services.ts`), refused by name. **This is
the piece the feature IS**: without it an operator impersonates, mints an API key, ends
the episode, and holds a permanent credential the ceiling never bounded.

The second is the app's, and the mechanism ships: **a top-level `claim`.** litestone's own
`docs/access-control.md` names an impersonation as the example of a claim that is on no
row, so `claim support` plus `@@deny('update', auth().support)` on the app's own model is
the escape hatch — already parsed, already graded at startup, already a snapshot line.
Nothing here coins a `.lite` word.

**Invariant 7 holds unchanged.** `@encrypted`/`@guarded`/`@secret` redact in the trail and
are not readable by the subject, so they are not readable by an operator standing in the
subject's shoes. *See what the user sees* and *see everything about the user* stay two
features and this is the first.

---

## Prior art

Read after the plan was written, which is the wrong order and is recorded as such. It
changed the shape once and confirmed the sharpest call.

**Laravel Nova files the impersonated user as the actor**, and it is a known open
complaint against the product rather than a subtlety: an action taken while impersonating
writes the impersonated user's id as the owner of the change. Nova's extension points are
`canImpersonate` / `canBeImpersonated` on the model and `StartedImpersonating` /
`StoppedImpersonating` events — hooks an app is expected to log from. **That is the default
this design inverts**, and finding it as a live grievance in the largest commercial admin
panel in the field is the best evidence available that the inversion is right.

**django-hijack flushes the session on both edges** — entering and releasing — so no
session data leaks between principals, and it deliberately does not extend the original
session's life. Its audit surface is two signals carrying both user ids plus the request.
The flush is the part worth stealing: the FJS analogue is the WebSocket, resolved once at
upgrade, and it is named in §2 above.

**GitLab records the start AND the stop as audit events**, and its open gap is the
impersonation *token* lifecycle — a credential minted for the purpose that outlives the
episode. This design mints no such credential, which is that gap closed by not having the
feature rather than by covering it.

**Two of the seven applications in litestone's own import corpus ship this, and they
disagree about where it lives** — which is the useful part:

| | shape | bounded | reason recorded |
| --- | --- | --- | --- |
| `discourse.lite` | `impersonatedUserId` + `impersonationExpiresAt` **on the auth token**, with a partial index `where: impersonationExpiresAt != null` | yes, a column | no |
| `triggerdev.lite` | `ImpersonationAuditLog` — a separate model, `START`/`STOP` rows, admin + target + ip | no | no |

**This design is discourse's, plus a reason.** triggerdev's separate model is the half
deliberately not built (§ *What was cut*): a trail already outlives a token, and a second
record of the same fact is a second origin of it. Neither of them records a reason, and
neither is bounded and recorded at once — which is the combination proposed here, and the
reason to write it down rather than assume somebody has.

The corpus is prior art that was already in the tree and had never been read for this.
`litestone import` was built to find what `.lite` cannot express; it is also seven real
applications' answers to questions this repository keeps asking from first principles.

---

## What was cut and what it cost

The first version of this file built a `SupportSession` model, a `$audit()` call on a
refused start, a `litestone advise` rule and a `fli check` rule. Each is defensible and
none is load-bearing, so they are recorded here rather than in the build order.

| Cut | What it would have bought | When to add it |
| --- | --- | --- |
| **`SupportSession` model** (`@@gate("8")`, two indexes, a sweep column) | a QUERYABLE episode list — *every support session this quarter* as a table read rather than a trail read, since a jsonl trail joins to nothing and its `before`/`after` are JSON strings — plus `endedBy` | the first time somebody asks for the report. It is additive: the columns stay, the model gains an id they point at |
| **`db.$audit()` on a refused start** | a record of an attempt nobody was entitled to make. A refusal is not a write, so the logger sees nothing — the same reason a failed sign-in needs it | when the capability grant becomes wide enough that a refusal means something |
| **A `litestone advise` rule for declared trails** | an app whose `@@log` names a DECLARED model keeps only the columns that model declares and drops the rest — measured: `written: 1, dropped: 0`, no error. So a hand-declared trail records episodes with the operator missing | when a second app declares its own trail model. Every scaffolded app uses the auto-model and is unaffected |
| **`fli check` rule + `access.snapshot.md` section** | findability — *who may impersonate* as a committed diff | with the next `fli check` batch. It grades a thing that must exist first |

**What is NOT cuttable is three lines long**, and it is worth stating as a set because
each one alone reads like a detail: `actorId` is the operator, the credential-changing
paths refuse from inside an episode, and the expiry is mandatory and read at resolution.
Drop any one and what ships is credential sharing with a banner on it.

---

## The nine questions (`PHILOSOPHY.md` § V), answered before the first edit

- **Another origin of truth?** No, and the cut removed the one it had: the trail is the
  record of an episode, not a table beside it. The principal still comes from
  `verifySession`, the ceiling from `sessionGateLevel`, the grant from `@capability`.
- **Concept budget?** +3 columns on an existing model, +3 columns on the logger model, +2
  routes. No new model, no new `.lite` word, no new realm noun, and one fewer credential
  than any implementation surveyed.
- **Whose complexity?** The problem's. A bounded episode with a reason and an end is what
  the feature IS; the alternative is a boolean nobody can audit.
- **Predictability?** Raised. Every request during an episode goes down the ordinary path
  and is graded by the ordinary rules; the one surprise — `actorId` is the operator — is
  named by `actorType: 'support'` on the same row.
- **Derived rather than restated?** The episode's state is derived from one timestamp, the
  ceiling from the subject, the grant from the column, and the permanent record from a
  trail that was already being written. Only `reason` is stated, and it cannot be derived —
  it is why a human did something.
- **Exactly one owner?** Resolution: `verifySession`. Provenance: `installLogContext`.
  Entry shape: litestone's logger model. Refusals: `packages/auth/services.ts`. The banner:
  the session field.
- **Boundary explicit?** Named (the three columns), typed (the session field and the trail
  columns), tested (`example`: `verify:support`).
- **Failure proportional?** The cost of being wrong is a credential-sharing hole, so the
  defaults refuse: no episode without a reason, none without an expiry, none without the
  capability, and no credential-changing path reachable from inside one.
- **Can it be wrong silently — and what artefact says so?** Yes, in one place, and it is
  ACCEPTED rather than answered: an app that declares its own trail model drops the two new
  columns without a word. Every scaffolded app uses the auto-model, so the exposure is one
  app in the repo and none in the field; the `advise` rule that closes it is cut above and
  named there rather than pretended away.

**Adjudication in tension (§ IV): ergonomics against strictness.** Resolved by cost, per
the standing ruling: a mandatory reason and a mandatory expiry are friction on the exact
path where being wrong is a breach.

**Tier (§ VII): Assessment** while this file stands; the inversion of `actorId` is
**Register** the day it lands, as a ruling in `DECISIONS.md`, because a shipped
application cannot take back what its trail means.

---

## Build order

Four phases. The first lands with no behavior change and no app edit.

1. ~~**The trail learns who really acted.**~~ **BUILT 2026-09-05.** `subjectId` and
   `episodeId` on the logger auto-model plus `@@index([episodeId])`
   (`makeLoggerAutoModel`, `litestone/src/core/client.js`), the swap and the `support`
   value for `actorType` in `buildLogEntry`, and **two** keys on `installLogContext`'s
   closure (`junction/src/core/litestone.ts`) — `operatorId` and `episodeId`, because
   `subjectId` is the principal already in scope and asking for it would be restating what
   the entry can read. `SessionContext.support` is declared with it, since junction reads
   it now and phase 2 fills it. `test/support-attribution.test.ts`: five rows, every one a
   PAIR, and **3 of the 5 fail with the swap stubbed out** — measured, not assumed. The
   fifth asserts the declared-trail silence as still-broken, so the `advise` rule that
   closes it announces itself when it lands.
2. ~~**The columns, the routes and the refusals**~~ — **BUILT 2026-09-05**, one phase as
   planned. `impersonatingUserId`, `impersonationReason` and `impersonationEndsAt` on
   `Session` (nullable, so `ALTER TABLE ADD COLUMN` and no rebuild); `startSupport` /
   `endSupport` on the provider and on `IAuth` as optional methods;
   `POST /auth/support/{start,end}` in `packages/auth/plugin.ts`; `verifySession` following
   the columns and enforcing the expiry there; `SessionContext.support`; and
   `refuseInSupport()` at six call sites in `packages/auth/services.ts`.
   `tests/support-mode.test.ts` (12) and `tests/support-refusals.test.ts` (9) — the second
   over a real Junction app, because the refusals are only true where a request meets them.
   Measured with each half stubbed: **3 of 12 fail without the resolution branch, exactly 1
   without the expiry comparison, 4 of 9 without the refusals.**

   **Three things the build decided that the plan had not.**

   **Who may is a guard, not a capability.** `createAuthPlugin({ canStartSupport })`, Guard
   tier (`FJS-D06`), and **absent refuses** — an app that has not written one gets a 403
   naming the option, so impersonation is never acquired by upgrading a dependency. The
   plan said the grant would be a `@capability` on the column and that is unenforceable
   here for `FJS-519`'s reason: every write to `Session` goes through `asSystem()`, which
   drops the capability grid with every other rule, so the declaration would be graded by
   nothing. An app whose principal carries a set still writes one line, and the check is in
   the one place there is a caller to check.

   **Four refusals belong to the provider rather than the app**, because no app should be
   able to allow them: no reason, yourself, a subject who does not exist, and an episode
   inside an episode — the last because chaining would record the SUBJECT as the operator
   of the next one, and the trail would name a person who did nothing.

   **`body()` in `plugin.ts` is an ALLOW-LIST** (`BODY_FIELDS`, from `FJS-296`), so a route
   added without adding its fields reads its whole payload as absent and answers 400 on a
   request that carried everything. Cost twenty minutes and is the kind of thing that reads
   as a broken client.

3. ~~**The two transports.**~~ **BUILT 2026-09-05.** `client.auth.startSupport()` /
   `endSupport()` (`junction/src/client/index.ts`), and `manager.disconnectSession(sessionId,
   reason)` on the channel manager, called by BOTH routes — a start as well as an end,
   which the plan had not said: after a start the operator's open tabs go on acting as
   themselves, and the two transports disagreeing about who the caller is is the same defect
   in the other direction. `tests/disconnect-session.test.ts`, three rows, each PAIRED with a
   session that must survive; all three fail if the close stops filtering.
   **Neither client call answers the new principal**: who the caller is now is
   `account.get('me')`, the same question asked of the same place, and a second answer here
   would be one more thing to keep in step. **The operator's token never changes**, so there
   is nothing to store and nothing to swap — the whole of what phase 3 was before prior art
   removed the second credential.
4. ~~**Adoption and proof.**~~ **BUILT 2026-09-05**, and `FJS-142` is closed. basecamp:
   `canStartSupport` wired to the hub tier with a system administrator refused as a SUBJECT,
   an *Act as* button on the users screen, a `SupportBanner` in the shell (not on the hub
   screens — an episode is global, so a banner that only rendered where it was started is
   missing from every screen where forgetting it matters), and `AuditEvent` gaining
   `onBehalfOfId` plus a fourth `ActorKind`. The workspaces screen's *Impersonate* alert now
   points at the users screen: a workspace is not somebody you can act as.
   `example`: `verify:support`, 24 assertions, no browser.

   **The drive found the defect the unit tests could not**, and it is the shape this phase
   exists for: **an expired episode blocked the next one.** Resolution reads the clock and the
   start path read the COLUMN, so a lapse was permanent — the operator resolves as themselves
   again, correctly, and every start after that is refused for an episode nobody is in, with
   no way out a person could find. Both now ask one predicate, `liveEpisode()`. It is
   invisible to every test that ends an episode the way the happy path does, which is every
   test written before this one.

   **Two things cost time and are worth carrying**: `apiPrefix: '/api'` moves every route the
   app registers, auth's included, so `/auth/support/start` is `/api/auth/support/start` in
   `example` — the hazard is written down and I still wrote the wrong path. And a trail entry
   is written fire-and-forget, so every read of the file polls to a deadline rather than
   sleeping once.

Phases 1–3 are the framework and are about half a week. Phase 4 is most of the time and
all of the risk.

---

## Open questions

- **An operator who impersonates an administrator inherits administrator.** The ceiling is
  the subject's by design, and that is correct — but it is also the one shape where the
  feature is indistinguishable from god mode. Options: refuse an episode against a subject
  standing above the operator, or allow it and let the trail carry it. The first is one
  comparison and probably right.
- **Does the subject get told?** The record supports it and nothing sends it. A
  notification (`SupportSessionStarted`) is one file and is the difference between an
  audited feature and a defensible one.
- **Reads.** `@@log(audit, reads: true)` is opt-in and high volume; *who looked at my
  record* is the DSAR question and it is a READ. Probably: reads are logged for the
  duration of an episode regardless of the model's setting, which is a rule with no home
  yet.
- **`asSystem()` inside an episode.** A service that legitimately bypasses rules would
  bypass the subject's ceiling too. The trail still names the operator; whether an episode
  should refuse `asSystem()` outright is `FJS-519`'s shape one layer up.
