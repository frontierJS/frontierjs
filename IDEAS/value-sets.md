---
id: value-sets
status: idea
dated: 2026-08-21
---

# Idea — Value sets: where the options in a picker come from

**Status: IDEA. Nothing here is built.** Dated 2026-08-21. There is no `valueset`
declaration in the `.lite` grammar and no binding-strength axis anywhere in the
tree. The *What exists today* section is read off shipped code and cited; every
other section is a proposal. Do not cite this file as describing behaviour — see
`VERIFYING.md`.

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

- **Labels.** JSON Schema's own answer is `oneOf: [{const, title}]`; RJSF's
  `enumNames` is non-standard and deprecated. A value set needs a label per value
  and litestone currently emits a bare `enum` array, so this is a real emitter
  change with three readers (`packages/litestone/docs/jsonschema.md`).
  Interacts with `FJS-D12` — a label is a default string, never a key.
- **Who may extend an `extensible` set**, and by which mechanism. It is a write
  to a different model performed as a side effect of a write to this one, which
  is exactly the shape `ctx.transients` and `@transient` already handle for
  payload keys that are not columns.
- **Whether `order` belongs in the schema at all.** It is per-caller and lives in
  the UI realm; the argument for declaring it here is that a hand-written picker
  and a generated one must not disagree, which is the same argument that put the
  control table in one module.
- **Dependent sets** — a set whose members depend on another field's value
  (Salesforce's controlling field, Frappe's Dynamic Link). Probably a second
  wave; it is the feature Salesforce could not compose with global value sets.
- **How a set reaches the browser.** A literal set travels whole. A table-backed
  set of four thousand rows cannot, so `resource.options()` and its
  `optionsQuery` narrowing are the existing seam to extend rather than replace.

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
