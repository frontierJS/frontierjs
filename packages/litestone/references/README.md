# Reference models

**The shape we think a common model should have, one file each.** Not shipped,
not imported, not installed by anything — a catalogue you read before writing a
model that half a dozen apps have already written differently.

The question these answer is *what columns does a `Notification` actually need*,
which is exactly the question that gets answered from memory at 11pm and then
diverges between two apps in the same repo. Copy one into your `schema.lite` and
edit it; that is the whole intended workflow.

## Why they are `.lite` and not prose

Because a reference that cannot parse is a reference that is wrong, and `.lite`
is the one format where that is checkable. `references.test.js` parses every file
in this folder and fails on an error, so a rule that moves in the parser takes
the catalogue with it rather than leaving twenty plausible stale examples.

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

## Two things this catalogue found on its first pass

**The polymorphic subject exists twice under two names.** `AuditEvent` in
basecamp carries `subjectType` / `subjectId` with an `@@index` on the pair;
`Notification` in `example` carries `contextType` / `contextId` for the same
idea — *which row is this row about*. Two apps in one repo, one concept, two
spellings, and nothing anywhere could have noticed.

The catalogue's preference is **`subjectType` / `subjectId`** for anything new.
That is a recommendation for the next model, not a demand to migrate the two that
exist: renaming a column is a migration, and neither is wrong.

**`@frontierjs/notifications` writes to a model it does not ship.**
`drivers/inapp.ts` calls `asSystem().notification.create()` naming five columns
against a hand-written structural type that is the only description of the shape
anywhere. `Notification.lite` here is that shape, written down. See
`IDEAS/machinery-models.md` for whether it should be shipped rather than
referenced — a separate question, deliberately not answered here.

## The running list

Written means a file exists in this folder. Everything else is a name and a
group; add a file when you have an instance worth deriving from, not before —
a reference invented from nothing is the stale example this folder exists to
replace.

| Group | Model | Status |
| --- | --- | --- |
| META | `AuditEvent` | **written** — basecamp |
| COMMUNICATION | `Notification` | **written** — `example`, plus the driver's own column names |
| META | `Tag` | **written** — no instance in this tree; the shape is argued rather than derived, and the file says so |
| IDENTITY & ACCESS | `User` | ships — `packages/auth/db/user.lite` is the reference |
| IDENTITY & ACCESS | `Credential` · `Session` · `Verification` · `OauthFlow` | ships — `packages/auth/db/auth.lite` |
| IDENTITY & ACCESS | `Organization` · `Group` · `Role` · `Invitation` | not written — basecamp's `Workspace` / `WorkspaceMember` / `Invitation` are the instance to derive from |
| IDENTITY & ACCESS | `ApiKey` | not written — basecamp has one |
| COMMUNICATION | `Message` · `Template` | not written — no instance in this tree |
| COMMUNICATION | `NotificationChannel` · `NotificationPreference` | not written — basecamp has both |
| INTEGRATION | `Webhook` · `Integration` · `Listener` · `Flow` | not written — no instance in this tree |
| CAPTURE | `Form` · `Submission` · `Note` | not written |
| READ SURFACES | `Report` · `Dashboard` · `View` | not written — basecamp has `Dashboard` + `DashboardWidget` |
| OPERATIONS | `Event` · `FeatureFlag` | not written — basecamp has `FeatureFlag` + `FlagOverride` |
| storage | an upload record | not written — open whether a row per file is machinery at all |

**Not in this catalogue, deliberately**: `Offer`, `Payment`, `Document`,
`Contact`, `Visit`, `Task`, `Schedule`, `Asset`, `Location`. Each is a real noun
in some app and a different one in the next — a landscaping `Offer` carries
`rate`, `mode` and `unit`; a shop's product carries `slug`, `brand`, images and
variants. Sharing the word is not sharing the model.
