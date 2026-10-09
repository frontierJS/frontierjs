---
id: data-classification
status: partial
dated: 2026-10-08
---

# Idea — data classification: how a field's sensitivity and retention are declared

**Status: ruled as `FJS-D657`; built 2026-10-08 except the data map and `forget()`'s stop at a second person model, which wait on `forgetting.md`'s ruling.** The grammar, the trail's `[personal]`, the warning, `redact()` over declarations and the three call sites moved onto the owner are in `docs/changes-archive/litestone.md`. The regime table is `PERSONAL_CATEGORIES` in `src/core/personal.js` and nothing reads it yet. Corrections from the re-probe before ruling: the protected-set owner already exists (`buildFieldPolicyMap`), so C moves three call sites onto it rather than adding a table; `@@retain` is dropped, because the measured clock is a query over children; `subject` had five live senses, all roles, so the model word is `@@person`. Dated 2026-10-08. Every "exists" line below
cites a file and line, and the parser claims were probed by running
`parse()` from `packages/litestone/src/index.js`, not read from docs. Do not
cite this file as describing behavior — see `VERIFYING.md`.

It is the vocabulary half of two papers that already propose syntax:
[`compliance-from-the-seed.md`](compliance-from-the-seed.md) (`@pii(category)`,
`@retain(duration)`) and [`forgetting.md`](forgetting.md) (`@personal`,
`@@subject`, `@@personal`). They were written apart and coin three words for
one region. This paper picks the nouns before either is built.

---

## 1. What exists today (measured)

**Access protection — shipped, four attributes, one axis each.**

| Spelling | What it does | Where |
| --- | --- | --- |
| `@guarded` | system-context lock, read and write; takes no argument | `docs/reference.snapshot.md:549`; probe: `@guarded(admin)` → *"@guarded takes no argument"* |
| `@encrypted` | at-rest encryption | `reference.snapshot.md` § encrypted; catalog synonyms `pii`, `at-rest` at `src/core/catalog.js:1718` |
| `@secret` | expands to `@encrypted @guarded @log(<logger>)` | `reference.snapshot.md:668` |
| `@hashed` | one-way, compared at the boundary | `reference.snapshot.md` § hashed |
| `@system` | app-written, caller-readable, refused on write | `reference.snapshot.md:564` |
| `@omit` | default-payload visibility, AND'd with `@guarded` | `FJS-D205` |

All paths under `packages/litestone/`. **The owner already exists:**
`buildFieldPolicyMap(schema)` (`src/core/schema-maps.js:335`) is a pure function
of the parsed schema, `@secret` lands in it as `guarded` + `encrypted`, and both
the trail's redaction set (`src/core/client.js:2017`) and `$protectedFields`
(`src/core/client.js:10492`) read it. What does not read it is every tool that
works from the AST without a client — about a dozen inline restatements across
`src/export.js:40` (`PROTECTED_ATTRS`), `src/jsonschema.js:546`,
`src/tools/typegen.js:612`, `src/access.js:248`, `src/validate-rows.js:99`,
`src/core/query.js:2515`, `src/testing.js:1257`, `src/tools/cli.js:7013` and
`src/tools/studio.html:4610`. Some of those ask a narrower question on purpose
(`query.js` wants *is this column filterable*), so not every one is a duplicate;
`export.js`, `testing.js` and `query.js:2515` each rebuild the full protected
set.

**Redaction in the audit trail — shipped (Invariant 7).** Protected fields log as
`[redacted]`; the access report states it (`src/access.js:416`), and
`testing.js:1330` grades it against `$protectedFields`. The trail also redacts
`@hashed` (`FJS-1250`, `client.js:2014`), which Invariant 7's wording and the
`@@log` catalog entry (`src/core/catalog.js:1227`) both leave out.

**Audience — shipped, two values.** `generateJsonSchema({ audience: 'client' |
'system' })` drops `@guarded`/`@secret` for the client (`src/jsonschema.js:186`,
`FJS-D454`). Audience as a word is held `open` (`FJS-D636`).

**Retention — shipped, per database, not per field.** `database audit {
retention 90d }` (`docs/audit-logging.md:13`), swept by `db.asSystem().$retain()`
(`src/core/client.js:9003`), which an app schedules as a job (`FJS-521`;
`FJS-1480` is the new app that ships no such job).

**A name-guessed PII list — shipped, in the transform kit.**
`REDACT_DEFAULTS.PII` in `src/transform/framework.js:953` is a list of column
NAMES (`email`, `phone`, `dob`, `firstName`…) that `redact('PII')` nulls. It is
the only place the tree says *personal*, and it decides by spelling, not by
declaration.

**Not in the grammar (probed):**

- `@pii(contact)` → *"@pii references unknown function 'pii'"* — the error
  misnames the problem (an unknown attribute read as a function call).
- `@retain(90d)` → *"Expected IDENT, got '90'"*.
- `@sensitive` → *"Unknown field attribute '@sensitive'"*.
- `compliance-from-the-seed.md:48` writes `@guarded(5)`, which the parser now
  refuses — that paper's sketch is stale.

## 2. The gap, as a failure a real app hits

The jazzhr applicant tracker (`forgetting.md` §1) holds `Candidate.email`. It
must be readable by recruiters, so it cannot be `@guarded`; it is not a
credential, so `@encrypted` is a cost with no reader. Today it is therefore
**undeclared**, and four things follow:

1. The audit trail keeps the email in every `before`/`after` snapshot for as
   long as the trail lives — Invariant 7 only covers the protected kinds, and a
   new app's trail retention never runs (`FJS-1480`).
2. `redact('PII')` catches it only because the column happens to be spelled
   `email`; `applicantEmail` is copied to staging in the clear.
3. There is no data map: *which columns are personal, and how long do we keep
   them* is a spreadsheet.
4. "Delete applicants whose every application was rejected 180 days ago" is a
   hand-written job. That one stays: `forgetting.md` §2 measured it at 15 lines
   and found the clock is a query over CHILDREN (`Application.rejectedAt`, not a
   column of `Candidate`), so no column trait can say it.

The protection attributes answer **who may read** and **how it is stored**.
Nothing answers **what kind of data this is**, and every downstream consumer (trail, redact, export, erase, types) re-derives a
guess.

## 3. Options

### **A** — one word, `@personal`

```prisma
model Candidate {
  email String  @personal
  ip    String? @personal
  @@person
}
```

Binary: a column is about a person or it is not. Trail writes `[personal]`;
`redact()` reads the declaration instead of `REDACT_DEFAULTS.PII`.
**Cost:** grammar for two attributes, one consumer rewrite (redact), the trail
change. **Refuses:** categories (contact vs. health vs. financial), so a RoPA
cannot group by them; a declared retention clock (`forgetting.md` Q3).

### **B** — a graded `@sensitivity(level)` and a field `@retain`

```prisma
model Patient {
  email     String  @sensitivity(personal)
  diagnosis String  @sensitivity(special)
  ip        String? @sensitivity(personal) @retain(90d)
}
```

A closed ladder `public < internal < personal < special`; `@secret` and
`@hashed` imply the top. Retention per column, nulling it when the clock runs.
**Cost:** a ladder every consumer must interpret (what does `internal` do to the
trail?), a per-column sweep `$retain` does not have. **Refuses:** nothing
explicitly — which is its weakness: a level with no behavior is a label, and a
label nothing grades is the "silent when broken" shape `fli check` exists to
catch.

### **C** — `@personal(category)`, read through the existing owner

```prisma
model Candidate {
  email       String  @personal(contact)
  coverLetter String? @personal
  @@person
}
```

A only, with an optional category from a closed list (`contact`, `identifier`,
`financial`, `health`, `biometric`) that feeds the data map and nothing else.
`@personal` lands in `buildFieldPolicyMap` as one more flag, so the trail and
`$protectedFields` pick it up where they already look — the row *caller reads,
trail does not keep*. In the same change the AST-side tools that rebuild the
full protected set (`export.js`, `testing.js:1257`, `query.js:2515`) read
`buildFieldPolicyMap` instead. **Cost:** A's, plus three call sites moved onto
an owner that exists. **Refuses:** a sensitivity ladder; a category changing
enforcement (it is documentation the generator reads, and saying so is the
refusal); a declared retention clock; a new protection table beside the one
that exists.

## 4. Recommend C — why

- **Behavior first, label second.** A and C give every declared word an effect
  the suite can grade (trail, redact, erase walk). B coins levels before any
  consumer needs more than two.
- **The category is the RoPA's only demand**, and it can ride on an attribute
  that already has teeth instead of being a free-floating label.
- **Invariant 4 already has the owner.** `buildFieldPolicyMap` is pure over the
  AST, so a tool with no client can read it; the restatements exist because
  nobody pointed them at it. `@personal` added beside them would be one more.
- **Retention gets no word.** `forgetting.md` Q3 measured the real clock as a
  query over children, and the jazzhr clock column is on `Application`, so a
  `@@retain(…, from:)` on the person model could not have expressed the one product
  that asked. A word waits for a second product whose clock is a column trait.
- **What makes a restatement visible is owed.** Nothing fails today when an
  AST tool inlines its own protected set; a `fli check` rule (or a test in the
  shape of `undeclared-names.test.ts`) refusing `kind === 'guarded' ||` outside
  `schema-maps.js` is the artefact, and until it exists the answer is `none`.

## 5. Nouns this would coin, and collisions

| Candidate | Proposed sense | Live senses it collides with (every hit) |
| --- | --- | --- |
| **Personal** (`@personal`) | a column about a person; the trail does not keep it | `forgetting.md` §4 (same sense — adopt); `REDACT_DEFAULTS.PII` in `transform/framework.js:953` (same idea by name-guess — replace); catalog synonym `pii` → `@encrypted` at `catalog.js:1718` (would mis-route a search for "pii"; repoint to `@personal`) |
| **Person** (`@@person`) | a model whose every row is a person; where erase/export walks start. An `@@auth` model is one by derivation | No framework sense: no `VOCABULARY.md` row, attribute or option. Plain English in comments, and an example model name (`model Person` in `fjs-prototypes/portal` fixtures; `createResource('people', { model: 'Person' })` in `sierra/src/resource/resource.js:553`). Pairs with `@personal` by root. Excludes a company by its own word — personal data is about natural persons. **Near-collision:** `forgetting.md`'s proposed `@@personal` (next row) differs by two letters and means a different thing — see Q8. |
| **Subject** | *not coined as a model word* — the ROLE: the person something is about | **Five live senses, all roles, none in `VOCABULARY.md`:** the claim grammar's `claim <name> from <Model>(<subject>)` (`FJS-D359`, `parser.js:636`, `catalog.js:180`) — the column naming the principal; `membershipClaim({ subject })` (`junction/src/core/litestone.ts:3318`) — the same, as an option; support mode's subject (`FJS-D574`, `auth/types.ts:36`, `audit-log.js:181`) — the person an operator stands in for; the bearer's subject (`FJS-D342`, `FJS-D344`) — the person a link is for; oracle's link actor `subject`, *who the thing exists for* (`oracle/src/catalog.js:107`). A model-grain `@@subject` would have been the one KIND sense among five roles, and a second meaning inside the `.lite` grammar beside the claim's `<subject>` column. Unrelated: mail `subject`, `release.js` finding `.subject`. |
| **Personal** (`@@personal`, model) | the whole row is about the person: deleted, not nulled, by `forget()` | `forgetting.md` Q2 — an erase-verb choice, so it rides with that paper, not this one |
| **Retention** | *not coined* — no `@@retain` | `database { retention 90d }` + `$retain()` (`client.js:9003`) is the one live framework sense; litestream `retentionPeriod`/`l0Retention` (`docs/replication.md:21`) — backup window, different thing; ARCHITECT.md:206 "client retention window" (Release pivot) — different thing; `IDEAS/metric-store.md:65` rollup retention; `@unit(mo)` example `retention Int` in `docs/exact-numbers.md:276` (app column) |
| **Classification** | *not coined* — the paper's title only | `packages/cli/core/terms.js:19` (term classifier); `IDEAS/static-safety.md:128` and `IDEAS/form-actions.md:114` (route classification); `litestone/docs/internals.md:819` (release-verdict classification); `IDEAS/intent-recognizer.md:235`; `IDEAS/sandboxes.md:68` ("classification of models", nearest to this sense). Too loaded to take. |
| **Sensitivity** | *not coined* under C | no live hit in `packages/*/src`, docs or `DECISIONS.md`; free if B is chosen |
| **Category** (the argument) | kind of personal data | generic; no framework noun — stays an argument value, not a noun |

## 6. Open questions for the owner

- ~~**The column word and the model word**~~ **Answered 2026-10-08 (`FJS-D657`):** the column word is **`@personal`**, not
  `@pii` — PII is the narrower US sense (data that identifies), and erase must
  null a `coverLetter` that identifies nobody. No did-you-mean for `@pii`. The
  model word is **`@@person`**, not `@@subject` (§5). `subject` gets a
  `VOCABULARY.md` row as the role.
- ~~**Q1 — One word or a ladder?**~~ **Answered 2026-10-08 (`FJS-D657`): C, by the owner's Q2 and naming calls.** **A** `@personal` binary · **B**
  `@sensitivity(level)` · **C** `@personal(category?)`, read through
  `buildFieldPolicyMap`.
  **Recommend C** — every word has a graded effect; the ladder can come later as
  a widening of the argument.
- ~~**Q2 — Is the category list open or closed?**~~ **Answered 2026-10-08 (`FJS-D657`): closed**,
  refused by name. The list itself, from prior art (2026-10-08):

  | Category | Covers | GDPR | CPRA sensitive | fideslang | In our apps |
  | --- | --- | --- | --- | --- | --- |
  | `contact` | name, email, phone, postal address | — | no | `user.contact`, `user.name` | every app |
  | `device` | IP, cookie, device id | Recital 30 | no | `user.device`, `user.unique_id` | connectteam, quo `deviceId` |
  | `location` | GPS, precise position | — | yes (precise) | `user.location` | connectteam `lat`/`lng` |
  | `government` | SSN, passport, licence, immigration status | Art. 87 | yes | `user.government_id` | — |
  | `financial` | bank account, card number | — | yes (with access code) | `user.financial` | — |
  | `employment` | job title, salary, performance | Art. 88 | no | `user.workplace`, `user.job_title` | jazzhr `salary`, scorecards |
  | `communication` | the body of a message the person sent | — | yes (content) | `user.content` | quo SMS, chatwoot |
  | `demographic` | date of birth, age, gender, language | — | no | `user.demographic` (part) | — |
  | `health` | diagnosis, medical record, insurance id | Art. 9 | yes | `user.health_and_medical` | — |
  | `genetic` | DNA, genetic test results | Art. 9 | yes | `user.health_and_medical.genetic` | — |
  | `biometric` | fingerprint, face or voice template | Art. 9 | yes | `user.biometric` | — |
  | `characteristic` | ethnicity, religion or belief, politics, union membership, sex life or orientation | Art. 9 | yes | `user.demographic` (the rest) | — |
  | `criminal` | convictions, offences, background checks | Art. 10 | no | `user.criminal_history` | — |

  Each row maps to its regimes in ONE framework table, so the data map
  derives *special (Art. 9/10)* and *sensitive (CPRA)* rather than each app
  restating them. **Deliberately absent:** credentials (already `@hashed` /
  `@secret`, a protection axis, not this one); behavior and free text (bare
  `@personal`); children (a fact about the PERSON, not a column — Q2a).
  **Owner's calls:** `genetic` is its own row (GDPR, CPRA and Illinois GIPA
  each name it apart, though fideslang folds it into health); the name
  `characteristic` stands; thirteen rows. `demographic` is split from `characteristic` because fideslang's single
  `demographic` mixes Art. 9 data (ethnicity) with ordinary data (language).
  Sources: fideslang taxonomy (`ethyca.github.io/fideslang`), GDPR Arts. 9–10,
  Cal. Civ. Code § 1798.140, Open edX OEP-30 (`pii_types`, 15 values with an
  `other` escape — the shape this list refuses).
- ~~**Q2a — How does a model say its people are children?**~~ **Answered 2026-10-08 (`FJS-D657`): `@@person(child)`.** Every row of
  the model is a child in the legal sense (`model Student`, `model Child`). It
  feeds the data map only — parental consent under COPPA and GDPR Art. 8, the
  lowered CPRA sale age — and enforces nothing. `child`, not `minor`: the
  regimes that change obligations say *child* and draw the line below 18, at
  an age that varies by jurisdiction, so the word states the status and never
  a number. `child` is the argument's only value: every other category of
  data subject Art. 30 asks for (fideslang's `customer`, `employee`,
  `job_applicant`…) is the model's name already, and a legal status is the one
  thing a name does not carry; any other value is refused by name. A model
  mixing adults and children cannot say it — that is a row clock over a
  `demographic` column, refused here for the reason retention was. fideslang
  has no child data subject; it files children as a DATA category
  (`user.childrens`), the column-grain reading this refuses.
- ~~**Q3 — Does `@personal` imply `@omit` from the client audience?**~~ **Answered 2026-10-08 (`FJS-D657`): A.** **A** no,
  reads follow the gate as written · **B** yes. **Recommend A** — `FJS-D205`
  keeps visibility a separate axis; implying it hides a recruiter's email.
- ~~**Q4 — Does a personal-looking column with no `@personal` warn?**~~ **Answered 2026-10-08 (`FJS-D657`): warn, on `@@person` models only.**
  A column on a `@@person` model named like personal data (the names
  `REDACT_DEFAULTS.PII` holds today) and carrying no `@personal` is a parse
  WARNING naming the attribute to add — the shape of `FJS-D322`, which warns
  only where the gate makes the point matter. Scoped so a false positive is
  near impossible: `Company.email` never warns, and there is no word for *not
  personal*. It still reaches every app with sign-in, because an `@@auth`
  model is a person by derivation. **Follows from it:** `REDACT_DEFAULTS.PII`
  is retired and `redact()` reads the declaration; the redact mode `'PII'` is
  renamed `'PERSONAL'` with Studio's picker, no alias; the auth package's
  `User` fragment declares its own `email @personal(contact)`. Refused: a
  warning on every model (B), and a `fli check` advisory in its place (C).
  **Out of scope, owed as its own defect:** `REDACT_DEFAULTS.SECRETS` guesses
  by name too, where `@secret`/`@hashed` already declare it.
- ~~**Q5 — `@@person` or `@@subject`?**~~ **Answered 2026-10-08 (`FJS-D657`):** `@@person` is the kind, `subject` is the role.
- ~~**Q6 — One invariant or two?**~~ **Answered 2026-10-08 (`FJS-D657`): A, one invariant.** Invariant 7
  becomes *`@encrypted`/`@guarded`/`@secret`/`@hashed` log as `[redacted]` and
  `@personal` as `[personal]`, in field entries and in `before`/`after`
  snapshots*. `@hashed` joined the trail's set in `FJS-1250`'s fix
  (`client.js:2018`) without the invariant, its proof row or the `@@log`
  catalog entry (`catalog.js:1227`) saying so, and no test names it — `rg`
  over `unique-redaction.test.ts` and `litestone.test.ts`, not a mutation
  run. The same change adds both rows to the audit-redaction test in
  `litestone.test.ts`; `fli ws:invariants` regenerates the snapshot's
  *Covers*. Refused: `@personal` alone with `@hashed` left unstated (B); a
  separate invariant for `@personal` (C).
- ~~**Q7 — One human, two person models.**~~ **Answered 2026-10-08 (`FJS-D657`): A.** An `@@auth` model is a person by
  derivation, not by a second declaration. A `Candidate` who also signs in is
  then two person rows for one human, and a relation between two person
  models is either *the same person* (`Candidate.user`)
  or *another person* (`Candidate.referredBy`) — the schema cannot say which,
  so a walk that crosses forgets a colleague and a walk that stops leaves the
  login behind. Unmeasured: jazzhr's applicants have no session (bearer link,
  `FJS-D343`), and `packages/auth` has no forget or delete-account path at all.
  **A** `forget()`/export refuse at a relation into another person model,
  naming it · **B** a relation attribute declaring *same person* · **C** only
  the `@@auth` model is a person. **Recommend A** — refused by name, nothing
  destroyed, no word coined before a second product measures the shape; C
  breaks the one product that asked. Under A the app answers *same person*
  in its own code, calling `forget()` per row the refusal names; two
  products writing that code is the signal for B. **`@@relator` does not
  answer it** — a relator relates two or more DISTINCT relata (`FJS-D350`)
  and is a row, where *same person* is identity on a plain foreign key. Its
  source ontology names the shape (UFO: Candidate and User as two roles of
  one kind, Person), but *role* is the auth `role` column, so B's word is not
  free either.
- ~~**Q8 — `@@person` beside `@@personal`.**~~ **Answered 2026-10-08 (`FJS-D657`): A, deferred to `forgetting.md`'s ruling with the constraint recorded.** `forgetting.md` Q2 proposes
  `@@personal` for *delete this model's rows on forget*. Two model words two
  letters apart, both legal on the same schema, one marking where the walk
  STARTS and one what it DELETES — a slip between them parses and does the
  wrong thing silently. Belongs to that paper's ruling, and wants a word that
  is not a sibling of `@@person`. **`@@relator` shrinks its job:** a relator
  cannot outlive its relata and is forced to `Cascade` or `Restrict`, so the
  walk derives that relator rows naming the person go with them (a
  `Restrict` gets the by-name refusal `forgetting.md` already plans). What
  is left for a model word is a non-relator row ABOUT the person — a note, a
  message body.
- ~~**Q9 — The misleading parse error.**~~ Filed as [FJS-2060](../ISSUES_ARCHIVE.md#fjs-2060):
  `@pii(x)` reports *unknown function*. Q4's `SECRETS` half is
  [FJS-2059](../ISSUES_ARCHIVE.md#fjs-2059).

## See also

- [`compliance-from-the-seed.md`](compliance-from-the-seed.md) — the generators
  this feeds (data map, DSAR, erasure)
- [`forgetting.md`](forgetting.md) — `@personal` and the walk, measured; its
  Q2 owns the word for *delete on forget* (Q8 here)
- [`logbook.md`](shipped/logbook.md) — the database-grain retention sweep
- `FJS-D205`, `FJS-D454`, `FJS-D322`, `FJS-D359`, `FJS-D574`, `FJS-521`,
  `FJS-1250`, Invariants 4 and 7
