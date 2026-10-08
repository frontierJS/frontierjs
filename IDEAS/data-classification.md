---
id: data-classification
status: proposed
dated: 2026-10-08
---

# Idea — data classification: how a field's sensitivity and retention are declared

**Status: IDEA, nothing built.** Dated 2026-10-08. Every "exists" line below
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

All paths under `packages/litestone/`. The set of "protected" kinds is
restated in at least four places that do not import each other:
`src/export.js:40` (`PROTECTED_ATTRS`, includes `hashed`),
`src/jsonschema.js:546` (`guarded || secret`), `src/validate-rows.js:99`
(`encrypted || secret`), `src/testing.js:1256` (all four). `$protectedFields`
(`src/core/client.js:10348`) answers `guarded | encrypted | hashed` per field.

**Redaction in the audit trail — shipped (Invariant 7).** Protected fields log as
`[redacted]`; the access report states it (`src/access.js:416`), and
`testing.js:1330` grades it against `$protectedFields`.

**Audience — shipped, two values.** `generateJsonSchema({ audience: 'client' |
'system' })` drops `@guarded`/`@secret` for the client (`src/jsonschema.js:186`,
`FJS-D454`). Audience as a word is held `open` (`DECISIONS.md:38`).

**Retention — shipped, per database, not per field.** `database audit {
retention 90d }` (`docs/audit-logging.md:13`), swept by `db.asSystem().$retain()`
(`src/core/client.js:8942`), which an app schedules as a job (`FJS-521`).

**A name-guessed PII list — shipped, in the transform kit.**
`REDACT_DEFAULTS.PII` in `src/transform/framework.js:951` is a list of column
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

1. The audit trail keeps the email in every `before`/`after` snapshot forever —
   Invariant 7 only covers the protected kinds.
2. `redact('PII')` catches it only because the column happens to be spelled
   `email`; `applicantEmail` is copied to staging in the clear.
3. There is no data map: *which columns are personal, and how long do we keep
   them* is a spreadsheet.
4. "Delete rejected applicants after 180 days" is a hand-written job whose
   window lives in code, invisible to `litestone access` and to the schema.

The protection attributes answer **who may read** and **how it is stored**.
Nothing answers **what kind of data this is** or **how long it may live**, and
every downstream consumer (trail, redact, export, erase, types) re-derives a
guess.

## 3. Options

### **A** — one word, `@personal`, and a clock on the model

```prisma
model Candidate {
  email String  @personal
  ip    String? @personal
  @@subject
  @@retain(180d, from: rejectedAt)
}
```

Binary: a column is about a person or it is not. Trail writes `[personal]`;
`redact()` reads the declaration instead of `REDACT_DEFAULTS.PII`; retention is a
row-level clock compiled into the `$retain` sweep.
**Cost:** grammar for two attributes, one consumer rewrite (redact), the trail
change. **Refuses:** categories (contact vs. health vs. financial), so a RoPA
cannot group by them; per-column clocks.

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

### **C** — `@personal(category)` plus one shared protection table

```prisma
model Candidate {
  email       String  @personal(contact)
  coverLetter String? @personal
  @@subject
  @@retain(180d, from: rejectedAt)
}
```

A only, with an optional category from a closed list (`contact`, `identifier`,
`financial`, `health`, `biometric`) that feeds the data map and nothing else.
In the same change, the four restated "protected" sets in §1 collapse into one
table — `fieldProtection(field) → { reads, stores, trail }` — owned beside
`$protectedFields`, which `@personal` joins as the row *caller reads, trail does
not keep*. **Cost:** A's, plus the consolidation (four call sites). **Refuses:**
a sensitivity ladder; a category changing enforcement (it is documentation the
generator reads, and saying so is the refusal); per-column retention.

## 4. Recommend C — why

- **Behavior first, label second.** A and C give every declared word an effect
  the suite can grade (trail, redact, erase walk). B coins levels before any
  consumer needs more than two.
- **The category is the RoPA's only demand**, and it can ride on an attribute
  that already has teeth instead of being a free-floating label.
- **Invariant 4 already asks for the table.** "Protected" is computed four ways
  today; adding a fifth kind without an owner makes it five.
- **Retention stays a row clock** (`forgetting.md` Q3 measured that the real
  clock is a query over a row's state, not a column trait). A per-column
  `@retain` waits for a second product that asks for it.

## 5. Nouns this would coin, and collisions

| Candidate | Proposed sense | Live senses it collides with (every hit) |
| --- | --- | --- |
| **Personal** (`@personal`) | a column about a person; the trail does not keep it | `forgetting.md` §4 (same sense — adopt); `REDACT_DEFAULTS.PII` in `transform/framework.js:951` (same idea by name-guess — replace); catalog synonym `pii` → `@encrypted` at `catalog.js:1718` (would mis-route a search for "pii"; repoint to `@personal`) |
| **Subject** (`@@subject`) | the model whose row is a person; where erase/export walks start | `forgetting.md` (same sense); a check for other senses (mail subject, test subject) is owed before ruling |
| **Retention** (`@@retain`) | how long a row may live, by a clock on its state | `database { retention 90d }` + `$retain()` (`client.js:8942`) — same verb, database grain, so the model form must compile to the same sweep; litestream `retentionPeriod`/`l0Retention` (`docs/replication.md:21`) — backup window, different thing; ARCHITECT.md:206 "client retention window" (Release pivot) — different thing; `IDEAS/metric-store.md:65` rollup retention; `@unit(mo)` example `retention Int` in `docs/exact-numbers.md:276` (app column) |
| **Classification** | *not coined* — the paper's title only | `packages/cli/core/terms.js:19` (term classifier); `IDEAS/static-safety.md:128` and `IDEAS/form-actions.md:114` (route classification); `litestone/docs/internals.md:819` (release-verdict classification); `IDEAS/intent-recognizer.md:235`; `IDEAS/sandboxes.md:68` ("classification of models", nearest to this sense). Too loaded to take. |
| **Sensitivity** | *not coined* under C | no live hit in `packages/*/src`, docs or `DECISIONS.md`; free if B is chosen |
| **Category** (the argument) | kind of personal data | generic; no framework noun — stays an argument value, not a noun |

## 6. Open questions for the owner

- **Q1 — One word or a ladder?** **A** `@personal` binary · **B**
  `@sensitivity(level)` · **C** `@personal(category?)` + one protection table.
  **Recommend C** — every word has a graded effect; the ladder can come later as
  a widening of the argument.
- **Q2 — Is the category closed?** **A** closed list, refused by name ·
  **B** open string. **Recommend A** — a typo in a RoPA category is otherwise
  silent.
- **Q3 — Does `@personal` imply `@omit` from the client audience?** **A** no,
  reads follow the gate as written · **B** yes. **Recommend A** — `FJS-D205`
  keeps visibility a separate axis; implying it hides a recruiter's email.
- **Q4 — Does the parser warn on an undeclared column spelled like PII**
  (`email`, `phone`)? **Recommend yes, as a warning**, the shape of the
  `@@geo` ruling (`FJS-D322`), and it retires `REDACT_DEFAULTS.PII`.
- **Q5 — The misleading parse error.** `@pii(x)` reports *unknown function*;
  that is a defect independent of this paper and wants an `FJS-###`.

## See also

- [`compliance-from-the-seed.md`](compliance-from-the-seed.md) — the generators
  this feeds (data map, DSAR, erasure)
- [`forgetting.md`](forgetting.md) — `@personal`/`@@subject`, measured
- [`logbook.md`](logbook.md) — the database-grain retention sweep
- `FJS-D205`, `FJS-D454`, `FJS-D322`, `FJS-521`, Invariants 4 and 7
