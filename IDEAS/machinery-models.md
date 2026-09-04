---
id: machinery-models
status: proposed
dated: 2026-08-28
---

# Idea — Machinery models: the running list, and how one ships

**Status: IDEA for the list; the MECHANISM is shipped and proven twice.** Six
models reach an app from a package today, by two different routes, and the rule
that picks between them was discovered by `@frontierjs/auth` and written down
nowhere. This file is that rule, plus the register of what is machinery and what
is not. Dated 2026-08-28.

## What this is for

Some models are the same in every app. A session, an outbox row, a webhook
registration, a saved report — nobody's *domain* contains those; they are what an
application is made of. Every app that hand-writes one is maintaining a copy of
something the framework could have shipped, and a copy stops being the package's
the first time either side moves.

The counterpart file is [schema-variants.md](schema-variants.md), which decides
when several nouns share a table. **This decides which nouns the framework
should own at all.** The two are easy to confuse and the failure modes are
opposite: variants over-merge one app's schema, and machinery over-generalises
across apps.

## The test

A model is machinery when **no app's business is described by it**. Three
questions, and all three must answer the same way:

1. Would two unrelated apps declare it with the same columns? A `Session` yes; an
   `Offer` no — a landscaping Offer and a shop Product overlap in a word.
2. Does the framework already *write* to it? If a package hardcodes column names,
   the model is the package's whether it ships one or not.
3. Is the app's only interest in it structural — the relation to its own `User`,
   its tenancy, whether it audits? If the answer involves a domain rule, it is
   not machinery.

Everything else is domain, and domain models belong in the app even when several
apps happen to write similar ones.

## The four shapes shared data already takes

Read off the tree, not invented. They are not interchangeable and each answers a
different question about **who owns the columns**.

| Shape | Owner | Example | How the app gets it |
| --- | --- | --- | --- |
| **Imported model** | the package, columns *and* gate | `Credential`, `Session`, `Verification`, `OauthFlow`, `OutboxMessage` | `import "@frontierjs/auth/db/auth.lite"`, then `extend model` for what the package cannot know |
| **Appended model** | the app, seeded by the package | `User` | `fli auth:install` writes it into the app's own `schema.lite`; the app grows it |
| **Package-owned database** | the package, entirely | caravan's job tables | nothing in the app's schema at all — a separate file, opened on first use |
| **Declared database block** | the app declares, litestone writes | the audit trail | `database audit { retention 90d }`, routed to by `@@log(audit)` |

A fifth exists and is unused: **`@@trait`**, a shared set of *columns* rather
than a model. Zero uses in this tree. If the same four timestamps or the same
tenant stamp turn out to belong on twenty machinery models, that is the mechanism
and it needs no new one.

## The rule that picks between imported and appended — it is the gate

`extend model` **adds**, and it refuses a second answer to a single-valued
attribute. `@@gate` is single-valued. So a model a package ships with a gate has
that gate **forever**, in every app that installs it, with no way to say
otherwise short of abandoning the import and pasting a copy.

That is not a limitation to work around. It is the sorting rule:

> **If the gate is right for every app, ship the model. If the app must decide
> the gate, ship the file and let the app own it.**

Auth already does exactly this, and the two halves fall out cleanly:

```
Credential · Session · Verification · OauthFlow    @@gate("8")       imported
OutboxMessage                                      @@gate("8")       imported
User                                               @@gate("4.4.4.5") appended
```

**Every imported machinery model in the tree is `@@gate("8")`** — nothing outside
`asSystem()` has anything to say to it — and the one that is not is the one an
app has opinions about. `User` is where an app puts `isStaff`, its own role
column, its policies; there is no gate that is right for a shop and a fleet
console at once, so it is not imported.

The practical consequence for the list below: **a candidate whose gate varies by
app is not an imported model.** It is an appended one, or it is not machinery.

## What a shipped model may not know

Three things the package cannot know, all of them said by the installing app with
`extend model`:

- **The relation back to the app's own identity model.** A package cannot name
  `User`, because it does not know the app has one or what it is called.
- **Tenancy.** Under `strategy row` every model is scoped or is `@@tenant(none)`,
  and which one a package's rows are is the app's answer, not the package's.
- **Whether it is audited.** `@@log(audit)` names a database the app declares.

One live hazard sits with the third: **`Session` ships carrying `@@log(audit)`**,
so every host schema must declare `database audit` or the import fails. A shipped
model imposing a database on its host is a decision, and the next machinery model
that wants an audit trail should probably leave it to the `extend` instead.

The safety net for the appended shape already exists: `fli check`'s
**`package-model-drift`** compares an app's copy against the `.lite` the package
ships, reached through that package's own `exports`, and reports a column the
package declares that the copy declares differently. Keyed on the package's
columns rather than on the copy's existence, because `User` is meant to be grown.

## The running list

Grouped as the vocabulary groups them. Status is about the FRAMEWORK, not about
whether some app has one.

### Shipped

| Model | Package | Shape |
| --- | --- | --- |
| `User` | auth | appended |
| `Credential` · `Session` · `Verification` · `OauthFlow` | auth | imported, `@@gate("8")` |
| `OutboxMessage` | junction | imported, `@@gate("8")` |
| job + owner tables | caravan | package-owned database |
| the audit trail | litestone | declared database block |

### Candidate — the package already writes to a model it does not ship

**`Notification` — build this one first.** `packages/notifications/drivers/inapp.ts`
calls `litestone.asSystem().notification.create({ … })` and names six columns —
`userId`, `type`, `data`, `contextType`, `contextId` — against a hand-written
structural type that is the only description of the shape anywhere. The package
ships no `.lite`. `example` hand-writes the model; the second app to install
`@frontierjs/notifications` reverse-engineers it from a driver's source, and
nothing anywhere compares the two.

It is the exact shape of the failure `extend model` was built to remove, one app
earlier in its life than basecamp's auth copies were. Its gate does not vary —
`example` writes `@@gate("0.8.4.8")` with two `@@allow`s scoping it to the
recipient, which is right for every app — so it is an **imported** model.

### Candidate — machinery by the test, nothing ships it

| Group | Models | Note |
| --- | --- | --- |
| COMMUNICATION | `Message`, `Template` | conduit and notifications both want a rendered template; a template is a row in every app that has one |
| INTEGRATION | `Webhook`, `Integration`, `Listener` | junction has the transport and the signature (`@frontierjs/toolbelt/signature`); nothing holds the registration |
| IDENTITY & ACCESS | `Organization`, `Group`, `Role` — the membership tier | `membershipClaim()` ships and basecamp's `WorkspaceMember` is hand-written. Under tenancy the capability grid lives on the membership row (`FJS-D149`), so this one is closer to shipped than it looks |
| CAPTURE | `Form`, `Submission` | the schema already describes a form; what is missing is a row for one somebody authored |
| READ SURFACES | `Report`, `Dashboard`, `View` | a saved query is machinery; what it queries is not |
| META | `Event` | an app-level event log, distinct from `@@log(audit)`, which records writes |
| storage | an upload record | the `File` column type and `FileStorage` ship; whether a *row* per file is machinery is open |

**`Tag` is the hard one and should not be taken for easy.** Tagging is
polymorphic — one tag attaches to rows of many models — and a foreign key names a
table, not a union, which is the same wall [schema-variants.md](schema-variants.md)
hits. The two honest answers are a join table per taggable model (referential
integrity, N tables) or a `(subjectType, subjectId)` pair (one table, no
integrity, and every read is a join the database cannot check). Neither is
obviously right and the framework has no polymorphic relation to lean on.

### Not machinery

`Offer` · `Payment` · `Document` · `Contact` · `Visit` · `Task` · `Schedule` ·
`Asset` · `Location`.

Each is a real noun in some app and a different one in the next. A landscaping
`Offer` carries `rate`, `mode` and `unit`; a shop's product carries `slug`,
`brand`, images and variants. Sharing the word is not sharing the model, and the
cost of getting this wrong is the one variants have: every app's difference lands
as nullable columns on a table nobody owns.

## Open

- **Does a machinery model get a service too?** A model with no service is half a
  feature, but a package registering routes into the app's API is a bigger claim
  than shipping columns. Auth already does both and splits them by whether the
  thing establishes a session (`FJS-D20`).
- **Versioning.** An imported model's columns change with the package version,
  which is a migration in every installed app on upgrade. `fli release:check`
  classifies the pivot, but nothing today tells an app *this upgrade is a
  contract*.
- **Where the list lives once it is more than a list.** A `@frontierjs/machinery`
  package shipping `.lite` fragments and nothing else is one answer; each package
  shipping its own is what happens today and keeps ownership obvious.

## See also

- [schema-variants.md](schema-variants.md) — the sibling question, one app's
  nouns rather than every app's
- `packages/litestone/docs/traits.md` — `extend model` and `@@trait`, the two
  mechanisms this rests on
- `packages/auth/db/user.lite` · `packages/auth/db/auth.lite` — the split, done
