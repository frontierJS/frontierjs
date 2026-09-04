---
id: declared-field-state
status: proposed
dated: 2026-08-22
---

# Idea — Declared field state: required, read-only and hidden, as a condition

**Status: IDEA. Nothing here is built.** Dated 2026-08-22. There is no
`@requiredWhen`, no `@readOnlyWhen`, no `@setOnce` and no conditional field
state of any kind in the tree. The *What exists today* section is read off
shipped code and cited; every other section is a proposal. Do not cite this file
as describing behavior — see `VERIFYING.md`.

---

## The problem it solves

Four sentences an application says constantly, and none of them has a home:

1. **`trackingCode` is required once `status` is `shipped`.**
2. **`currency` may be set when the order is created and never again.**
3. **`cancelReason` is read-only until the order is cancelled.**
4. **`vatNumber` is only shown when `customerType` is `business`.**

Today each is written twice — a before-hook on the API side, and an `{#if}` or a
`required={…}` in the form — and the two are free to disagree. When they do, the
failure has the shape this repo keeps finding: the screen and the server hold
different opinions, and only one of them is enforced. A form that does not ask
for `trackingCode` and a server that refuses without it is a save button that
does nothing.

The declaration is missing, so nothing derives: not the control's `required`,
not the 400, not the browser's affordance, not the committed surface a reviewer
reads.

## What exists today

- **`@@transitions`** says *which value may follow which* on an enum field, with
  an optional `@gate(N)` per move (`packages/litestone/CLAUDE.md` § Model
  attributes). It knows the states. It says nothing about which fields those
  states require.
- **`@@allow` / `@@deny`** are the expression language this would reuse. Already
  compiled twice — into SQL (`compileSql`) and into JS (`evalJs`) — with the
  two halves held together by `verifyRowPolicies`.
- **`@system` and `@guarded`** lock a column by WHO, never by WHEN. `@system`
  refuses a caller's write and reaches the client as `readOnly`; there is no
  form of either that depends on the row.
- **`required`** is the absence of `?` and is fixed for the life of the model.
  `@required("msg")` only supplies the wording and is a parse error on an
  optional field, precisely because it cannot make anything required.
- **`x-gate`** is the precedent for the client half: a declaration that reaches
  the browser as an affordance and is never a boundary (Invariant 6).

## Prior art

**ServiceNow splits the enforcement point and names both halves.** A **Data
Policy** runs server-side across forms, imports, web services and integrations
and cannot be bypassed; a **UI Policy** runs client-side on forms only. They
carry the same rule — mandatory, read-only, visible — and the platform has a
button that converts one into the other. Their own stated practice is *UI
policies guide, data policies enforce*, and a Data Policy takes precedence when
a record is saved.

That is Invariant 6, arrived at independently by a platform with two decades of
production behind it, and FJS currently applies it to exactly one thing: access.

**Frappe puts it on the field, in three properties over one expression
language** — `depends_on`, `mandatory_depends_on`, `read_only_depends_on`. One
grammar, three questions. It is display-first: `depends_on` hides, and hiding is
not enforcement.

**Salesforce has two mechanisms and they do not compose.** A validation rule
enforces (server-side, on every insert and update, for UI and API alike); a page
layout decides what is shown and which fields are marked required *on that
layout*. Nothing ties them. That is why "record types vs page layouts" is a
genre of blog post rather than a settled question, and it is the outcome to
avoid.

Salesforce also supplies the vocabulary for the hardest part: a validation rule
sees `PRIORVALUE(field)` and `ISCHANGED(field)`. Which row a condition is
evaluated against is not a detail.

## The shape

**One question, asked of a field, about a row.** Three answers:

| | enforced where |
| --- | --- |
| `required` | the Data boundary, and the client as an affordance |
| `readOnly` | the Data boundary, and the client as an affordance |
| `hidden` | **the client only** |

**`hidden` is deliberately not a Data-boundary concept.** A server cannot hide
anything; it can refuse, and refusing is what `@guarded` already means. Emitting
`hidden` as an affordance and nothing else keeps that honest — and it makes the
one dangerous combination sayable out loud: a field that is hidden and required
is a form nobody can submit, which is a check the declaration can make at parse
rather than a bug someone finds in production.

## Sketch

```prisma
model Order {
  id           Int          @id
  status       OrderStatus  @default(draft)
  currency     String       @setOnce
  trackingCode String?      @requiredWhen(status == 'shipped')
  cancelReason String?      @readOnlyWhen(status != 'cancelled')
  vatNumber    String?      @hiddenWhen(customerType != 'business')

  @@transitions(status)
}
```

**`@setOnce` is the degenerate case and falls out for free**: read-only whenever
the row already exists. It is worth having its own spelling because it is the
common one — an invoice number, a currency, a tenant id — and because
`@readOnlyWhen(true)` reads as *never writable*, which is a different sentence.

What each realm derives, with no app code:

- **Data** — the refusal. A write naming a `readOnly`-in-this-state column, or
  omitting a `required`-in-this-state one, is a `ValidationError` naming the
  field, in the same shape every other rule throws, so it renders in `<Form>`
  beside the control.
- **API** — the 400, and the condition on the field's schema so the browser can
  ask the same question.
- **UI** — `$context.form` already resolves a control's `required` and
  `disabled` from the form's own state. This adds one input to that resolution,
  re-evaluated as the record changes, which is what makes the affordance track a
  status the person just picked.

## The crossing, and why it is the interesting part

`x-gate` crosses as four numbers. `x-transitions` crosses as a table.
**A condition cannot cross as a value** — it has to be evaluated against the
record currently on screen, which changes as someone types.

Three ways, and the third is the one that fits this repo:

1. The expression crosses and the client evaluates it. Needs an evaluator in the
   browser.
2. Only the server evaluates, and the client re-asks on every change. Chatty,
   and wrong the moment the network is slow.
3. The expression crosses and **the evaluator is the same one the server uses**.

Litestone already has that evaluator: `evalJs` in `policy.js`, the JS half of
the two compilers a row policy is compiled into. It is pure, it is small, and it
takes a record and answers a boolean.

**Moving it to `@frontierjs/toolbelt` makes it one evaluator instead of two**,
which is the same argument that put `/jsonschema`, `/hooks`, `/directives` and
`/inflect` there — the pure half both sides need, in the package below the
dependency graph (`FJS-D26`). Sierra cannot import litestone's internals and
`@frontierjs/ui` cannot import sierra; toolbelt is what both may have.

That is the strongest reason to build this feature and the strongest reason to
be careful: it puts a second reader on an expression language that currently has
one owner and two compilers held together by a real oracle
(`verifyRowPolicies`). A third compilation with no oracle is how `@@allow`'s two
halves drifted before (`FJS-195`).

## Open questions

- **Which row does the condition see on an update?** The stored row, the
  incoming patch, or the two merged. Salesforce answers it explicitly with
  `PRIORVALUE` and `ISCHANGED` and that is not decoration — `@requiredWhen(status
  == 'shipped')` on a patch that is *setting* status to shipped must see the new
  value, and `@readOnlyWhen(status != 'cancelled')` must see the old one, or a
  caller can cancel and write the reason in one request that the rule was
  written to prevent. Probably: the MERGED row for `required`, the STORED row
  for `readOnly`, stated rather than inferred.
- **Ordering against the stamps.** `checkCreatePolicy` runs BEFORE
  `applyAuthDefaults`, which is already a documented trap: a tenant column is
  legitimately absent on create because the stamp has not happened yet
  (`packages/litestone/docs/multi-tenancy.md`). A `@requiredWhen` evaluated at
  the same point would refuse a create that is about to be filled in.
- **Bulk writes.** `updateMany` is one statement over a `where` that matches many
  rows and one payload. A condition may hold for some of those rows and not
  others. Salesforce evaluates per record; SQLite does not offer that for free.
  Either the check becomes a pre-SELECT (a cost on every bulk write), or bulk
  writes refuse a model carrying conditions, or the condition compiles into the
  WHERE. The third is the interesting one and is the same trick `@@allow`
  already does.
- **Does this subsume a transition guard, or sit beside one?** *You may move to
  `shipped` only if `trackingCode` is set* is sayable as a `@requiredWhen` and as
  a transition guard, and they are not the same sentence: one is about a field,
  one is about a move. Two ways to say one thing is the failure mode this repo
  files rulings about.
- **How much of the expression language crosses.** `auth()` on the client is a
  claim the browser holds and cannot verify — the same status `x-gate` has. A
  condition reading `auth()` is an affordance only, and the split has to be
  visible rather than assumed.

## What this is not

- **Not `@@transitions`.** That is which value may follow which. This is which
  fields a state requires. They compose and neither replaces the other.
- **Not `@guarded` / `@system`.** Those lock by who. This locks by when.
- **Not a page layout.** Nothing here decides ORDER or grouping;
  `formFieldList`'s `only`/`except` already own that, and Salesforce's four
  overlapping layout concepts are the argument for not adding a fifth.
- **Not validation.** A validator asks whether a value is well-formed. This asks
  whether the field applies at all, which is a question about the row.

## Prior art — sources

- ServiceNow: [Data Policy vs UI Policy](https://www.servicenow.com/community/servicenow-ai-platform-articles/difference-between-data-policy-and-ui-policy/ta-p/2313599) · [Data Policy guide](https://servicenow.github.io/sdk/guides/data-policy-guide) · [Dictionary attributes](https://www.servicenow.com/docs/r/washingtondc/application-development/table-administration-and-data-management/c_DictionaryAttributes.html)
- Frappe: [field types](https://docs.frappe.io/framework/user/en/basics/doctypes/fieldtypes) · [field dependency](https://docs.frappe.io/helpdesk/field-dependency)
- Salesforce: [validation rules](https://trailhead.salesforce.com/content/learn/projects/customize-a-salesforce-object/create-validation-rules-1) · [page layouts](https://help.salesforce.com/s/articleView?id=platform.customize_layout.htm&language=en_US&type=5) · [record types vs page layouts](https://www.salesforceben.com/when-to-use-record-types-vs-page-layouts/)
