# Reference models

**The shape we think a common model should have, one file each.** A catalog
you read before writing a model that half a dozen apps have already written
differently. **A model is copied; a trait is imported.** A model names a
foreign key the host has to wire, so the file is a starting point and the
host's copy is the truth. A trait (`Grant`, `Interval`) carries no key and no
relation, so there is nothing to rewire and a copy is only drift:
`import "@frontierjs/litestone/references/Grant.lite"` then `@@trait(Grant)`.

The question these answer is *what columns does an `AuditEvent` actually need*,
which is exactly the question that gets answered from memory at 11pm and then
diverges between two apps in the same repo. Copy a model into your `schema.lite`
and edit it; import a trait.

## Why they are `.lite` and not prose

Because a reference that cannot parse is a reference that is wrong, and `.lite`
is the one format where that is checkable. `references.test.js` parses every file
in this folder and fails on an error, so a rule that moves in the parser takes
the catalog with it rather than leaving twenty plausible stale examples.

The notes are `///` doc comments, which is where the notes belong anyway — the
example app's own schema is written that way, and this is that habit extracted.

## The two constraints, both measured

**A file declares one model and is self-contained.** A standalone model parses
clean: 0 errors, 0 warnings.

**No `@relation` to a model the file does not declare.** A dangling one is two
errors, not one:

```
Model 'Webhook', field 'createdBy': unknown type 'User'
Model 'Webhook', field 'createdBy': @relation references unknown model 'User'
```

So a reference carries the **foreign key column** and not the relation —
`userId String`, with a note saying to wire it. That is honest rather than a
workaround: the column is the shape, and which model it points at is the app's.
An app's identity model may be `User`, `Person` or `Account`, and its key may be
`Int`, `String` or a uuid.

## What a file contains

The model, and prose for anything a reader would otherwise get wrong. In
particular: **what is deliberately absent**, which is the half a field list can
never show — a column left off on purpose looks identical to one nobody thought
of.

Where the tree already has an instance, it is named, and where instances
disagree, the disagreement is the finding.

## Two things this catalog found on its first pass

**The polymorphic subject exists twice under two names.** `AuditEvent` in
basecamp carries `subjectType` / `subjectId` with an `@@index` on the pair;
`Notification` in `@frontierjs/notifications` carries `contextType` / `contextId` for the same
idea — *which row is this row about*. Two apps in one repo, one concept, two
spellings, and nothing anywhere could have noticed.

The catalog's preference is **`subjectType` / `subjectId`** for anything new.
That is a recommendation for the next model, not a demand to migrate the two that
exist: renaming a column is a migration, and neither is wrong.

**`@frontierjs/notifications` wrote to a model it did not ship, and now it
ships it.** `drivers/inapp.ts` calls `asSystem().notification.create()` naming
five columns, and for a while the only description of that shape was a
hand-written structural type plus a file in this folder. A reference model is
the wrong home for a shape a package's own code depends on: the package changes
a column, every app's copy is stale, and nothing can compare them. It ships
`db/notification.lite` now, `fli check`'s `package-model-drift` grades an app's
copy against it, and this catalog's entry is a POINTER rather than a second
copy — the same shape `User` and `Credential` already had.

## A reference may be a trait

Some shapes never stand alone — a bearer token's four columns, an occupying
interval's derived pair — and a model file for them would invent a host that
does not exist. Those ship as a `trait`, and the install is `@@trait(Name)` on
the row that has the shape. The test finds the file's noun on `schema.traits`
when `schema.models` has none. What a trait deliberately leaves to the host is
the half that names the host's own columns: the `claim`, the row policy, the
`@@exclude` scope.

## The running list

Written means a file exists in this folder. Everything else is a name and a
group; add a file when you have an instance worth deriving from, not before —
a reference invented from nothing is the stale example this folder exists to
replace.

| Group | Model | Status |
| --- | --- | --- |
| META | `AuditEvent` | **written** — basecamp |
| COMMUNICATION | `Notification` | ships — `packages/notifications/db/notification.lite` is the reference |
| META | `Tag` | **written** — no instance in this tree; the shape is argued rather than derived, and the file says so |
| IDENTITY & ACCESS | `User` | ships — `packages/auth/db/user.lite` is the reference |
| IDENTITY & ACCESS | `Credential` · `Session` · `Verification` · `OauthFlow` | ships — `packages/auth/db/auth.lite` |
| IDENTITY & ACCESS | `Organization` (+ `Member`) | **written** — derived from nine instances (linear, notion, connectteam, remnant, portal, basecamp, trigger.dev, documenso, cal.com); the role enum and the second level stay the host's, and the file says why |
| IDENTITY & ACCESS | `Grant` | **written, a trait** — eleven instances under six names; the claim and the row policy stay the host's |
| IDENTITY & ACCESS | `Group` · `Role` · `Invitation` | not written — an `Invitation` is a `Grant` with an email and a role, and basecamp's is the instance |
| TIME | `Interval` | **written, a trait** — the derived UTC pair under `@@exclude`; the local input stays the host's |
| TIME | `Window` (+ `enum Weekday`) | **written, a trait** — the recurring slot; the enum ships because the weekday was encoded three ways |
| LIFECYCLE | `Decision` | **written, a trait** — who settled it and when, `@system`, one pair under one name where the corpus had four spellings; wants to become an attribute on the transition |
| STRUCTURE | `Tree` | **written, a trait** — `parentId` + a fractional `rank`; the self-relation stays the host's, and linear's `rank`+`position` is the row it prevents |
| INTEGRATION | `Poller` | **written, a trait** — the inline bookkeeping around a scheduled fetch, every column `@system`; the run log (`Run`, from transit's `SyncRun`) is the model it pairs with and is not written |
| COMMUNICATION | `Delivery` | **written** — one row per attempt, from transit; the one model whose check (`(status = 'skipped') = (skipReason IS NOT NULL)`) the whole corpus should have had, and the record `@frontierjs/notifications` does not keep |
| IDENTITY & ACCESS | `ApiKey` | not written — basecamp has one |
| COMMUNICATION | `Message` · `Template` | not written — no instance in this tree |
| COMMUNICATION | `NotificationChannel` · `NotificationPreference` | not written — basecamp has both |
| INTEGRATION | `Webhook` · `Integration` · `Listener` · `Flow` | not written — no instance in this tree |
| CAPTURE | `Form` · `Submission` · `Note` | not written |
| READ SURFACES | `Report` · `Dashboard` · `View` | not written — basecamp has `Dashboard` + `DashboardWidget` |
| OPERATIONS | `Event` · `FeatureFlag` | not written — basecamp has `FeatureFlag` + `FlagOverride` |
| storage | an upload record | not written — open whether a row per file is machinery at all |

**Not in this catalog, deliberately**: `Offer`, `Payment`, `Document`,
`Contact`, `Visit`, `Task`, `Schedule`, `Asset`, `Location`. Each is a real noun
in some app and a different one in the next — a landscaping `Offer` carries
`rate`, `mode` and `unit`; a shop's product carries `slug`, `brand`, images and
variants. Sharing the word is not sharing the model.
