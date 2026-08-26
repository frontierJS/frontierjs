---
id: value-sets
status: partial
dated: 2026-08-21
---

# Idea — Value sets: where the options in a picker come from

**Status: PARTIAL.** The shape is settled — `FJS-D120` — and both halves are
built and running in `example`: `valueset` and `@values` parse, `x-values` is
emitted, a strength is enforced at the Data boundary through the caller's own
accessor, and `controlFor` answers a picker or a combobox from the binding. The
crossing is proven end to end by `example`'s `verify:values`, in a real browser
against a real API — the declared `@@scope` travels as a filter, so the list a
picker offers is the list the boundary accepts. Dated 2026-08-21, ruled and
built 2026-08-22, proven in an app 2026-08-23.

Both narrowings now cross: a declared `@@scope` by name, and a declared `where`
by minting a scope of its own (`FJS-430`, closed 2026-08-23). A capped list says
how many rows it is not showing and the two searchable controls send what was
typed to the server (`FJS-391`, closed the same day).

What is still open: `FJS-D121` (ordering) and `FJS-D122` (dependent sets). **No
screen in `example` mounts the picker yet** — there is no variant edit form, so
the control is proven by `@frontierjs/ui`'s own browser drive and by the
resource, not by a rendered app screen.

**Three pieces shipped 2026-08-22 and are behaviour, not proposal**, each
buildable without the declaration and each useful without it: `@label` on an
enum member (a caption per value of a literal set), `@@label(field)` on a model
(which column a picker SHOWS for a row — FHIR's `display`), and one resolution
seam, `resource.options()` / `$context.form.optionsFor()`, answering
`{ options, total, truncated }` for a literal set and a table-backed one alike.
That is axis 1 working for the two provenances that already existed, behind one
interface.

**What the ruling changed about the sketch below.** Two of the four provenances
turned out to need no new syntax: an `enum` with `@label` is already a complete
literal set and is `required` by construction, and an account-editable list in a
row-tenant app is already scoped by `tenancy { strategy row }`. And **strength
moved off the set onto the binding** — one list is legitimately enforced on one
field and merely offered on another, which a strength on the set cannot express.
The `Sketch` section below is superseded by `DECISIONS.md` § `FJS-D120`; it is
kept because the reasoning that produced it is the reasoning behind the ruling.

Do not cite the rest of this file as describing behaviour — see `VERIFYING.md`.

---

## The problem it solves

An app fills a `<Select>` from four different places, and only two of them have a
home in the seed:

1. **A list fixed at design time** — `draft`, `published`, `archived`.
2. **A list that is rows** — pick a customer, pick an assignee.
3. **A list the ACCOUNT edits** — this workspace's own task tags, lead sources,
   priority names. Every tenant has a different one and no deploy is involved.
4. **A list the USER edits** — their own saved filters, their own categories.

Today (3) and (4) have no declaration, so they become a hand-written service, a
hand-written control and a hand-written validation rule, three times per list.
The schema — which is supposed to be the one place a fact about the data lives —
knows nothing about them, so nothing derives: not the form control, not the
validator, not the API's 400, not the browser's affordance.

The trap is that these look like four features. **They are one noun with four
provenances**, and the systems that treat them as four end up with four
mechanisms that disagree at the edges.

## What exists today

Two of the four are shipped and neither is named as an options mechanism:

- **A fixed list is an `enum`.** It reaches `$defs` as
  `{"type":"string","enum":[…]}` and a field refs it
  (`packages/litestone/docs/jsonschema.md`). One list per declaration, no sharing
  between two enums that hold the same values, no labels per value — the value
  IS the label.
- **A list of rows is a `@relation`.** It reaches the browser as `x-relations`,
  and `resource.options(fieldName)` fetches it
  (`packages/sierra/src/junction/resource.js:868`), with `optionsQuery` on the
  resource as the narrowing hatch.

So the two shipped cases already differ in every respect — where they are
declared, how they reach the client, what narrows them, whether a value can carry
a label. A third and fourth case added the same way makes four.

## Prior art

**Salesforce — the list is a named, shared thing.** A *global value set* is
defined once and referenced by many picklist fields across many objects; editing
it changes every field at once. They are **always restricted and cannot be made
unrestricted**, which is the right call for a shared list: one that any field may
silently extend is not shared, it is four lists that happen to agree today. They
also have *dependent picklists*, where a controlling field filters another's
values — and the seam their model could not close is that a global value set
cannot be the controller.

**FHIR — the model worth copying, and it is three objects rather than one.**

| Object | Question it answers |
| --- | --- |
| `CodeSystem` | Where are these codes *defined*? The universe. |
| `ValueSet` | Which subset is *allowed here*? Composed by include/exclude over CodeSystems. |
| binding | This field uses that ValueSet — *how tightly?* |

The binding carries a **strength**: `required` (only these codes), `extensible`
(these, or your own **only if none of them fit**), `preferred` (a suggestion,
with no conformance expectation), `example` (illustrative; rebind freely).

That last column is the one nobody invents unprompted, and it is what cases (3)
and (4) actually need. *The account may add to this list* is not a different kind
of list — it is the same list at a different binding strength.

**Frappe/ERPNext — the split made legible as a field TYPE.** `Select` is static
options on the doctype, `Link` points at a doctype and the values are its rows,
`Dynamic Link` lets *another field* choose which doctype is being pointed at. A
reader knows where the values live by reading the type, which is the property
this repo's `enum`-vs-`@relation` split already half has.

**ServiceNow — the cautionary tale, and it is about identity.** All choices for
all fields live in one `sys_choice` table. Their own documentation warns against
making a reference field point at a choice row: editing the choices **deletes and
replaces the records**, generating new ids, so a stored reference is silently
invalid afterwards. Whatever a row stores must be a stable **code**, never the
primary key of the row that describes it. A tenant-editable list makes this
sharper, not softer — renaming a label must not rewrite data.

## The shape

**Two nouns, and three axes that must not be fused.**

The nouns:

- **A value set** — a named list, with a *source*. The four cases in the problem
  statement are four sources of one noun.
- **A binding** — this field uses that set, at a stated strength.

The axes:

1. **Provenance** — literal, a table, a table scoped to the tenant, a table
   scoped to the user. Answers *where do the values come from*.
2. **Strength** — required, extensible, suggested. Answers *may this field hold
   something the set does not contain*, which is a validation question and
   therefore a Data-boundary question.
3. **Order** — which of the allowed values appear first. **Not membership**, and
   the reason to keep it out is that it is the only one of the three that is
   per-caller and non-authoritative. A learned ordering, a pinned favourite and
   an alphabetical default are all this axis; none of them changes what is legal.

Fusing 2 and 3 is the common failure — a *suggested* binding and a *suggested
order* are different sentences, and a system with one word for both cannot say
"anyone may be assigned, but show me the three I actually use."

## Sketch

```prisma
valueset Priority {
  source  literal("low", "medium", "high")
  binding required
}

valueset TaskTag {
  source  model(Tag, scope: workspace)   // the account edits this one
  binding extensible                     // a value not in the set creates a row
}

valueset Assignee {
  source  model(User, where: "workspaceId = :tenant")
  binding required
  order   recent("task.assignee")        // per-caller, changes nothing legal
}

model Task {
  priority   String  @values(Priority)
  assigneeId String  @values(Assignee)
}
```

What each realm would derive, with no app code:

- **Data** — the validator. `required` refuses a value outside the set;
  `extensible` accepts and (for a table source) creates. Enforced at the Data
  boundary, like every other access and legality rule (Invariants 6, and the
  `@@transitions` precedent).
- **API** — the 400, and the set itself as a described surface, so the browser
  need not know whether a set is four literals or four thousand rows.
- **UI** — `controlFor` picks a `<Select>` over a combobox by set SIZE rather
  than by field type, and an `extensible` set gets a control that can add.

## Open questions

Two remain and both are FLAGGED rather than parked — they are wanted, and each
has a row in `ISSUES.md`.

- **Order — axis 3. `FJS-D121`.** Which of the allowed values appear first, and
  whether the schema says it at all. It is the case this whole line of work
  started from: a person assigns the same three people over and over and an
  alphabetical list makes them search every time. Held out of `FJS-D120` because
  fusing it with strength is the failure this shape exists to avoid, and open
  rather than built because it needs somewhere to KEEP the recency — per-caller
  state, which is not obviously a fact about the data the way membership and
  strength are.
- **Dependent sets — `FJS-D122`.** A set whose members depend on another field's
  value. Salesforce's controlling field, Frappe's Dynamic Link. The prior art is
  a warning rather than a model: it is the one feature Salesforce could not
  compose with global value sets, which is the shape just adopted.

Answered by building:

- ~~**Labels.**~~ **Both halves, and they were two questions.** A caption per
  member of a literal set is `@label` on the member, emitted as `x-labels`
  BESIDE the `enum` array rather than as `oneOf: [{const, title}]`, because that
  array is what three readers validate against. A label for a ROW of a
  table-backed set is *which column*, not *what text*, and that is
  `@@label(field)` → `x-label-field` (`FJS-392`). Fusing them was available and
  would have been wrong.
- ~~**How a set reaches the browser.**~~ `resource.options()` and
  `$context.form.optionsFor()` are the seam, answering
  `{ options, total, truncated }` with `search` reaching the server as
  `contains` on the display column. A literal set travels whole and reports
  `truncated: false`; a table-backed one is a page and says so.

Answered by ruling (`FJS-D120`):

- ~~**Who may extend an `extensible` set.**~~ Nobody new decides. The create runs
  through the caller's own scoped client, so the target model's `@@gate` and
  `@@allow` answer it. No permission concept, no hook tier.

## What this is not

- **Not `cascading-fields.md`.** That is propagating a value to related ROWS when
  a parent changes. Same smell, different problem — this one never writes another
  row except in the `extensible` case.
- **Not the ordering feature by itself.** A learned ordering is one implementation
  of axis 3 and is buildable today, per-app, with no schema change. It is in here
  because designing the options system without a place to put it is how axis 3
  gets fused into axis 2.

## Prior art — sources

- Salesforce: [global value sets](https://trailhead.salesforce.com/content/learn/modules/picklist_admin/picklist_admin_global) · [why they are always restricted](https://www.salesforceben.com/global-picklists-in-salesforce-explained/)
- FHIR: [Terminologies](https://www.hl7.org/fhir/terminologies.html) · [binding strength](https://build.fhir.org/valueset-binding-strength.html)
- Frappe: [field types](https://frappeframework.com/docs/user/en/basics/doctypes/fieldtypes) · [dynamic links](https://docs.frappe.io/erpnext/dynamic-link-fields)
- ServiceNow: [why a reference to sys_choice breaks](https://www.servicenow.com/community/developer-blog/how-to-fix-a-reference-to-the-choice-sys-choice-table/ba-p/2860768)
- JSON Schema: [enumNames is not in the spec](https://github.com/rjsf-team/react-jsonschema-form/issues/532)
