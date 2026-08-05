# Idea — Compliance derived from the seed

**Status: IDEA. Nothing here is built.** Dated 2026-08-04. No `@pii` or `@retain`
attribute exists in the `.lite` grammar, and nothing generates any of the artifacts
below. Do not cite this file as describing behavior — see `VERIFYING.md`.

---

## The claim

Data-protection work — GDPR, CCPA, SOC 2 evidence — is a recurring, expensive,
manual engineering cost in every application, and every framework makes you do it by
hand for the same reason: **their authorization lives in handlers, so nothing can be
derived from it.** You cannot generate a data map from code that a caller might
route around.

FJS declares three things no other framework declares together:

- **who may read a column** — `@@gate`, `@guarded`
- **whose rows these are** — `@scoped`, and the FK/relation graph
- **where data leaves the building** — Conduit's declared targets

Add two attributes and the seed becomes a compliance artifact.

```
model User {
  email     String   @unique @pii(contact)
  ip        String?  @pii(identifier) @retain(90d)
  notes     String?  @guarded(5)
}
```

## What can be generated

### 1. A data map / Record of Processing Activities

Every field holding personal data, its category, its retention period, the minimum
gate level that can read it, and — via Conduit — which third parties receive it.
This is the document organisations currently maintain by hand in a spreadsheet that
is wrong within a month. Here it is `fli marshal:map`, regenerated on every schema
change, and **wrong is a build failure rather than a discovery during an audit**.

### 2. A subject access request that is correct by construction

"Export everything you hold about this person" is a traversal: start at the subject,
follow `@scoped` and the relation graph, collect every `@pii` field. The schema
already has the graph — `buildRelations()` reads it, and the browser already
consumes it. Today every app writes this by hand and misses three tables.

### 3. Erasure that actually cascades

Same traversal, with `onDelete` semantics the migration already encodes. The
interesting part is what erasure means for columns that *must* survive — an
`AuditEvent` that is `LOCKED` cannot be deleted even by `asSystem()`, which is
correct, and means the schema must be able to express **anonymise** distinctly from
**delete**. That is a ruling to make, not an implementation detail.

### 4. A permission diff on every pull request

The one to build first, because it is nearly free and it is the most persuasive.

```
$ fli marshal:diff main
User.email        read  5 → 2      ⚠ widened
Invoice.total     delete —  → 7    narrowed
Secret.data       @guarded(all) removed   ⚠⚠ now readable at level 5
```

Authorization-as-data means a change to who can see what is **reviewable in a
diff**, by a person who is not the author, before it merges. No framework whose
authz lives in middleware can offer this, because the change is spread across files
that do not look like permissions. It is also the single most convincing artifact
to put in front of a security-conscious buyer, and it costs one parse of two schema
versions.

### 5. The outbound surface report

Already half-argued in `IDEAS/offline-first-and-release.md` under FOSS hygiene:
Conduit's declared targets make "what does this app phone home to" answerable. Here
it joins the data map — a target that receives a `@pii` field is a processor, and
naming it is a legal requirement, not a nicety.

## Why this is a wedge, not a feature

Compliance is the rare area where **the buyer is not the developer**. A framework
that emits a defensible data map, a working DSAR endpoint, and a permission diff in
CI is arguing to a different person than the one comparing DX. It is also the
clearest possible demonstration of why the schema-first bet was worth making —
these artifacts are impossible without it, not merely harder.

Adjacent, and worth stating: this is the same substrate `IDEAS/operational-edge.md`
wants for provisioning and `IDEAS/agent-surface.md` wants for tool scoping. All
three read the same declarations. Build the reader once.

## What would have to be built

1. **`@pii(category)` and `@retain(duration)` in the parser.** Grammar plus
   validation. Both are annotations with no runtime behavior at first, which makes
   them cheap and safe to land early — and every field annotated before the tooling
   exists is a field that does not need revisiting.
2. **`fli marshal:diff`** — parse two schema versions, diff the gate/guard tables,
   exit non-zero on a widening unless acknowledged. Genuinely small.
3. **The subject traversal** — one graph walk, shared by DSAR export and erasure.
4. **`fli marshal:map`** — the report, joining fields to gates to Conduit targets.
5. **Retention enforcement** — a Caravan job per `@retain`, which is the only piece
   with a runtime cost and should be opt-in.

Proposed home: **`@frontierjs/marshal`** (see `IDEAS/package-map.md`).

## Open questions

- **Anonymise vs delete.** `LOCKED` models cannot be deleted at all, by design. So
  the schema needs to say what erasure *means* per model, and the honest default is
  probably "refuse, loudly" rather than a silent partial erasure.
- **Is `@pii` a category or a boolean?** A category (contact, identifier, financial,
  special) is what a data map needs, and a boolean is what people will actually
  write. Probably accept both.
- **Does retention interact with `@@softDelete`?** A soft-deleted row still holds the
  data. This is exactly the kind of thing that is obvious in hindsight and missed in
  every hand-rolled implementation.
- **Where does lawful basis live?** It is per-processing-purpose, not per-column, so
  it may not belong in the schema at all — possibly a sidecar file the map joins
  against. Resist putting non-derivable prose in the seed.
- **Does a Slice declare its own PII?** It must — a billing slice contributes
  personal data to the consuming app's data map, and if that does not flow through,
  the map is wrong the moment anyone installs anything (`IDEAS/slices.md`).

## See also

- `IDEAS/package-map.md` — `marshal`, and the packages it shares substrate with
- `IDEAS/agent-surface.md` — the same declarations read for a different purpose
- `IDEAS/offline-first-and-release.md` — the outbound-surface command, in its
  original FOSS-hygiene framing
- `IDEAS/operational-edge.md` — `project:map --json` is the app model this extends
- `CLAUDE.md` § Bridge index — `buildRelations()`, `buildGate()`, and the `@guarded`
  behavior verified against a live db in the Basecamp entry
