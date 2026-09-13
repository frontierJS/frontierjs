---
id: declared-field-state
status: shipped
dated: 2026-09-10
---

# Idea — Declared field state: the condition that never reaches the browser

**Status: all three pieces of § The proposal are BUILT** — `FJS-1071` and
`FJS-D259`. What remains open is § Open questions, and the read flag still has
no reader. § *What exists today* is
the opposite — every row of it was RUN against the tree, and the probe output is
quoted rather than described. Do not cite the proposal as behavior; see
`VERIFYING.md`.

**This file was rewritten after that measurement, and the measurement overturned
its own premise.** The first draft opened with *four sentences an application
says constantly, and none of them has a home*, and proposed four keywords:
`@requiredWhen`, `@readOnlyWhen`, `@hiddenWhen`, `@setOnce`. Three of the four
sentences already have a home at the Data boundary. One of the keywords is a
second name for a shipped attribute. What is actually missing is none of the
four — it is the half ServiceNow calls a **UI Policy**, and the first draft cited
ServiceNow while proposing the wrong half.

---

## What exists today — measured

The four sentences, each written as a real schema and run:

| the sentence | Data boundary | reaches the client as |
| --- | --- | --- |
| `trackingCode` is required once `status` is `shipped` | **`@@check("status != 'shipped' OR trackingCode IS NOT NULL", …)`** — refuses, `ValidationError` | **nothing**, and the error's `path` is `[]` |
| `currency` may be set at create and never again | **`@immutable`** — throws, names the field, says what to do instead | `readOnly` in update mode, `x-litestone-kind: 'immutable'` |
| `cancelReason` is read-only until the order is cancelled | **`@allow('write', status == 'cancelled')`** — the WHEN of a `CASE` in the SET, so it reads the STORED row and grades every row of a bulk write separately | `x-litestone-write-policy: true` — **the flag, since 2026-09-10 (`FJS-1071`)**; not the predicate |
| `vatNumber` is shown only for a business customer | `@allow('read', customerType == 'business')` — strips the column from the answer, and closes the filter and sort oracles with it | `x-litestone-read-policy: true`, whose reader is nobody |

The probe:

```
S3 draft row cancelReason      = null          ← the write was dropped
S3 cancelled row cancelReason  = yes           ← the same call, one column different
S2 immutable currency THREW: ValidationError — currency is @immutable …
S1 shipped with no trackingCode = shipped      — NOT REFUSED
S1 via @@check THREW: ValidationError
  message: Validation failed — a shipped order needs a tracking code
  fields : [{"path":[],"message":"a shipped order needs a tracking code"}]
```

Two of those lines are the whole of what this file is now about.

**`@allow('write', status == 'cancelled')` reached the client as nothing.** The
generated JSON Schema for that column was `{"type": ["string","null"]}` in create
mode and in update mode alike — indistinguishable from an ordinary writable
column. So a generated `<Form>` rendered an editable box, a person typed into it,
the save button went green, and the Data boundary kept the old value without a
word. That was the failure the first draft described as hypothetical, and it was
shipped behavior on a shipped attribute: `FJS-1071`, **closed 2026-09-10**, which
is § *The proposal* piece 1 below.

The silence is deliberate and stays: a field write predicate must drop rather
than refuse, because the same payload is legitimate for another caller
(`packages/litestone/CLAUDE.md` § the `@system`/`@guarded`/`@computed` grid says
so in as many words). **What is not deliberate is that the client was never
told.** `@system` gets `readOnly` for exactly this reason and the paragraph
explaining why is three lines further down the same file.

**`@@check`'s refusal names no field.** `path: []`, so `<Form>` has nowhere to
put the sentence and it renders as a form-level error over a five-field form.
The rule is right — a `@@check` is a table constraint and holds against a
migration, a seed, `asSystem()` and a raw statement, which is why `example`
reaches for it — but a table constraint has no field to blame, and *which box do
I fix* is the only question the person reading it has.

## What this reframes the problem into

**FJS states ServiceNow's architecture and applies it to exactly one thing.**
A Data Policy enforces server-side across forms, imports and integrations; a UI
Policy guides on the client; the platform converts one into the other, and their
stated practice is *UI policies guide, data policies enforce*. That is
Invariant 6 arrived at independently — and FJS has the Data Policy for all four
sentences above and the UI Policy for one of them (`@immutable`).

So the gap is not vocabulary. **It is the crossing**, and the crossing is one
thing rather than four:

> A per-field condition the Data boundary already enforces does not reach the
> browser, so the screen and the server hold different opinions and only one of
> them is enforced.

## The proposal

Three pieces, smallest first. The first is a defect and the other two are
features; they are listed together because the third is worthless without the
first.

### 1. Emit the write predicate, and read it — **BUILT, `FJS-1071`**

`x-litestone-write-policy` beside the existing `x-litestone-read-policy`, hoisted
past the `anyOf` wrapper the read half builds so `@allow('all', …)` on a
non-optional column carries it where a consumer looks; carried in sierra's
`_CARRIED`; and read by `declinedFields(fields, sent, saved)`, which `<Form>`
calls on the SUCCESS path and renders in the slot a server error would have used.

**Nothing is disabled, and refusing to was the decision in the fix.** A field
carrying a write predicate is `readOnly`-*maybe*, and *maybe* is not a state a
control has: switched off by the flag it is switched off for every caller the
predicate ADMITS, which is most of them. So the only question the flag alone can
answer truthfully is asked AFTER the write — *what came back is not what was
sent* — and answering it beforehand is piece 2.

The write half is done, and **the READ flag now has a reader too** —
`withheldFields()` in sierra, `resource.withheld(record)`, and `<Form>` +
`<Field>` above it. The surface turned out not to be the one guessed here: the
enforcement strips the KEY, so this is not only a display saying *absent because
not yours* rather than *null because empty* — it is a FORM problem, because a
read policy is not a write policy and an ordinary empty box saves that emptiness
over a value nobody on the screen has seen.

`x-litestone-policies`, `x-litestone-from` and `x-litestone-secret` are still
listed in `packages/litestone/docs/jsonschema.md` with `nothing yet` in the
reader column. An extension with no reader is a declaration that derives
nothing, which is the whole argument of § *Everything is a projection*.

### 2. One evaluator, moved rather than added — **BUILT, `FJS-D259`**

The expression has to be evaluated against the record currently on screen, which
changes as somebody types — so either the browser gets an evaluator, or it asks
the server on every keystroke.

Litestone had the evaluator: `evalJs` in `core/policy.js`.

**It could not move whole, and that measurement is what shaped the feature.**
Two of its node types read another model — `check()` and a relation path — and
each opens a database; `affinityOf` reaches `sqlType` in the DDL emitter. So
what moved is the pure core, with those three INJECTED:
`@frontierjs/toolbelt/predicate`. Their defaults are litestone's own answers
when the hop cannot be made, and they fall opposite ways — a path yields a value
and this language spells absent as null, so an allow fails closed; a `check()`
is a predicate and the SQL half allows when the target has no policy.

That restriction is why the row-only condition language (piece 3) matters here:
a `@required(where: …)` predicate contains neither node, so the browser needs
nothing injected at all.

**Moving it to `@frontierjs/toolbelt` makes it one evaluator with two callers,
not a third compilation.** That distinction is the whole safety argument and the
first draft blurred it. `compileSql` and `evalJs` remain the two halves a row
policy is compiled into, held together by `verifyRowPolicies`, which is a real
oracle. The browser runs the same `evalJs` bytes the server runs — so there is
nothing new to drift against. `FJS-195` is the right thing to fear and it is
about a form handled in one compiler and not the other; a second CALLER of one
compiler is not that.

Same argument that put `/jsonschema`, `/hooks`, `/directives` and `/inflect`
there (`FJS-D26`): the pure half both sides need, in the package below the
dependency graph. Sierra cannot import litestone's internals and `@frontierjs/ui`
cannot import sierra.

**What crosses is bounded, and it turned out not to need a split.** A condition
reading `auth()` would be a claim the browser holds and cannot verify — the same
standing `x-gate` has — but `FJS-D259` refuses `auth()` in a
`@required(where: …)` outright, so the question does not arise for this feature.
Invariant 6 still governs the answer: UNKNOWN is not required, no record is not
required, and the server enforces regardless.

Shipped as `x-litestone-required-where` (the AST, client audience only),
sierra's `requiredFor(rule, record)`, and `<Form>` resolving it on every
keystroke — `$:` where the seal is `const`, which is the difference between
grading the row that was opened and grading the record being assembled.

### 3. `@required(where: expr)` — **BUILT, `FJS-D259`**

The only one of the four that was genuinely absent — and it is spelled
`@required(where: …)` rather than the `@requiredWhen(…)` this file first
proposed, because `@@unique([a], where: …)` and `@@index([a], where: …)` are the
same shape and neither coined a second word.

```prisma
model Order {
  status       OrderStatus  @default(draft)
  trackingCode String?      @required(where: status == 'shipped',
                                      "A shipped order needs a tracking code")

  @@transitions(status, ship: draft -> shipped)
}
```

**The predicate reads this row's own columns and nothing else** — `auth()`,
`now()`, `check()` and a relation hop each refused by name. That restriction is
what buys the CHECK, and it is also what makes piece 2 small.

**Does it subsume a transition guard? No, and there is nothing to subsume.** A
move takes `@gate`, `@system` and `@seals` — no predicate exists on one — and
the parser's own note on `@seals` rules the shape: *a seal is an event rather
than a state, which is why it is declared on the move rather than as a predicate
over the state column.* `@required(where:)` is about a STATE: it is true of a row
that has been shipped for a year, not only at the moment of shipping. Different
sentences, and the open question above is closed.

**It compiles to the `@@check` plus the field attribution, so it is one
declaration with two consequences rather than two declarations.** The table constraint is what
holds a migration, a seed and `asSystem()`; the field attribution is what lets
the refusal render beside the control and what lets the form ask for the value
before the person presses save. Neither half is new — the expansion is
`@secret`'s trick (`@encrypted + @guarded + @log(audit)`), and the relationship
to `@@check` is the one `@length(3, 20)` already has to a CHECK constraint: the
table's floor and the boundary's message, one origin.

The expression is the `@@allow` language, not raw SQL, which is what makes it
attributable, checkable at startup by the walk `checkFieldPolicies` already runs,
and evaluable by piece 2.

### What was cut, and why

- **`@setOnce`** — it is `@immutable`, shipped, already crossing as `readOnly` in
  update mode and writable in create mode, which is the one keyword pair that
  says *written once*. A second name for it is the thing `PHILOSOPHY.md` § IV
  *preservation vs. evolution* forbids in the other direction: no second name for
  one idea.
- **`@readOnlyWhen(expr)`** — it is `@allow('write', !expr)`, shipped, per-row,
  graded against the stored row. The first draft's own example is the argument:
  `@readOnlyWhen(status != 'cancelled')` is a double negative where
  `@allow('write', status == 'cancelled')` is not. What was missing was the
  emission, which is piece 1.
- **`@hiddenWhen(expr)`** — two different things wore one word. *The caller may
  not have the value* is `@allow('read', expr)`, shipped and stronger than
  hiding. *The reader has the value and the form should not show the box* is
  presentation, and the first draft's own § *What this is not* rules that out:
  `formFieldList`'s `only`/`except` own what a form shows, and Salesforce's four
  overlapping layout concepts are the argument for not adding a fifth. Parked
  rather than refused — if it comes back it comes back as a form concern.

## Open questions that survive

- ~~**Which row does the condition see on an update?**~~ **Closed for `required`
  by the CHECK**: SQLite evaluates it against the row as WRITTEN, which is the
  merged row, and that is the answer this file guessed at. It stays open for a
  client-side evaluation of the same predicate. The original note follows.

  The stored row, the incoming patch, or the two merged. It is not decoration: `@requiredWhen(status ==
  'shipped')` on a patch that is *setting* status to shipped must see the NEW
  value, while a write predicate must see the OLD one, or a caller can cancel an
  order and write the reason in one request that the rule exists to prevent.
  Salesforce answers it explicitly with `PRIORVALUE` and `ISCHANGED`. Probably:
  the MERGED row for `required`, the STORED row for `readOnly` — which is what
  `compileFieldPredicate` already does — stated rather than inferred.
- **Ordering against the stamps.** `checkCreatePolicy` runs BEFORE
  `applyAuthDefaults`, which is already a documented trap: a tenant column is
  legitimately absent on create because the stamp has not happened yet
  (`packages/litestone/docs/multi-tenancy.md`). A `@requiredWhen` evaluated at the
  same point would refuse a create that is about to be filled in.
- **What a HAND-WRITTEN `@@check` does about attribution.** The expansion knows
  its field and carries it, so `@required(where:)` renders beside its control.
  A `@@check` somebody wrote still cannot, and two of them on one model produce
  two unattributed form-level errors. A `field:` argument is the obvious answer
  and is a separate question from this one.
- ~~**Bulk writes.**~~ **Closed by the expansion**: a CHECK is evaluated per row
  by SQLite, so `updateMany` over a `where` matching many rows needs no answer
  here at all. That was a point in the expansion's favor and was not visible
  before the measurement.
- ~~**Does this subsume a transition guard?**~~ **Closed** — see piece 3. No
  predicate exists on a move, and a state invariant is not a move guard.

## What this is not

- **Not `@@transitions`.** That is which value may follow which. This is which
  fields a state requires. They compose and neither replaces the other.
- **Not `@guarded` / `@system`.** Those lock by who. This locks by when.
- **Not a page layout.** Nothing here decides order or grouping.
- **Not validation.** A validator asks whether a value is well-formed. This asks
  whether the field applies at all, which is a question about the row.

## Prior art

**ServiceNow splits the enforcement point and names both halves.** A **Data
Policy** runs server-side across forms, imports, web services and integrations
and cannot be bypassed; a **UI Policy** runs client-side on forms only. They
carry the same rule — mandatory, read-only, visible — and the platform has a
button that converts one into the other. A Data Policy takes precedence when a
record is saved. That is Invariant 6, and § *What this reframes the problem into*
is what the measurement did to this citation: it stopped being a supporting
argument and became the finding.

**Frappe puts it on the field, in three properties over one expression
language** — `depends_on`, `mandatory_depends_on`, `read_only_depends_on`. One
grammar, three questions. It is display-first: `depends_on` hides, and hiding is
not enforcement. The shape is right and the words half-fit, which is § IV
*familiarity vs. precision* exactly: `@allow` and `@@check` are this house's
words for two of the three.

**Salesforce has two mechanisms and they do not compose.** A validation rule
enforces (server-side, on every insert and update, for UI and API alike); a page
layout decides what is shown and which fields are marked required *on that
layout*. Nothing ties them, which is why "record types vs page layouts" is a
genre of blog post rather than a settled question. It also supplies the
vocabulary for the hardest part: `PRIORVALUE(field)` and `ISCHANGED(field)`.

### Sources

- ServiceNow: [Data Policy vs UI Policy](https://www.servicenow.com/community/servicenow-ai-platform-articles/difference-between-data-policy-and-ui-policy/ta-p/2313599) · [Data Policy guide](https://servicenow.github.io/sdk/guides/data-policy-guide) · [Dictionary attributes](https://www.servicenow.com/docs/r/washingtondc/application-development/table-administration-and-data-management/c_DictionaryAttributes.html)
- Frappe: [field types](https://docs.frappe.io/framework/user/en/basics/doctypes/fieldtypes) · [field dependency](https://docs.frappe.io/helpdesk/field-dependency)
- Salesforce: [validation rules](https://trailhead.salesforce.com/content/learn/projects/customize-a-salesforce-object/create-validation-rules-1) · [page layouts](https://help.salesforce.com/s/articleView?id=platform.customize_layout.htm&language=en_US&type=5) · [record types vs page layouts](https://www.salesforceben.com/when-to-use-record-types-vs-page-layouts/)
