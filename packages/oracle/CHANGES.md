# Changes — @frontierjs/oracle

## 2026-10-06 — A child of a published parent is not published with it (`FJS-1789`)

A row reached `via` a parent delegated its read to `check(parent)`, and the parent's read policy holds its `publicWhen` clause, so every signed-in caller read every order of a published shop, every application to an open job, and filed rows under them through `check(parent, 'read')`. Under a parent read at gate 0 the child now delegates to `check(parent, 'update')` — the parent's owners, members and whoever changes ITS parent — and to nothing when the parent holds no update policy, which leaves the op at gate 8. A create that names its caller still asks only `check(parent, 'read')`, so a buyer orders from a published shop; a create naming nobody asks what the read asks. A membership row under a public container follows the same rule. Measured in base44 Phase 4 on the etsy app. Proof: `test/oracle.test.js`, *a published parent opens itself and none of its children* (a real client: a stranger reads the open job and no application, and files no scorecard or application under it) and *a child of a public parent delegates to whoever may change it*.

## 2026-10-06 — `Organization` is the reference's shape

`packages/litestone/references/Organization.lite` was read off nine instances after the catalog entry was written, and the two disagreed. The catalog `Organization` carried a required `owner` link to User and a `planTier`; the reference has neither, because `role == owner` on the membership row already names the owner and a second answer drifts. The entry now has `name` and `slug`, no links, and is reached through its `members` entity: a member reads AND updates the container, `system` on it means the onboarding that creates it and the teardown that deletes it. A membership with a required person emits `@@relator([<container>Id, userId], once)` rather than `@@unique`, which is the one shape a row may decide a claim through (`FJS-D361`) and indexes both relata itself; an optional person keeps the `nullsDistinct` unique, because a relator refuses an optional relatum and that row is an invitation. Proof: `test/oracle.test.js`, *a membership delegates to the container's update rule*; the hiring fixture's `Company` now has no owner link.

## 2026-10-06 — The README names the shapes the catalog does not hold

A cross-schema review of twenty schemas (*The Ten Shapes*) found the reuse one rung below `ENTITIES`: 4–8-column shapes — a grant, an interval, a weekday window, a decision stamp, a tree, a poller — that recur byte-for-byte under six names each and are now traits in `packages/litestone/references/`. `emit` writes those columns by hand rather than spreading `@@trait(…)`, so the two are two origins for a shape's columns until joined. The README's *What it does not do yet* says so; nothing in `src/` changed.

## 2026-10-06 — A unique secret emits as deterministic

A `secret` field marked `unique` emitted `@secret @unique`, which litestone refuses at parse: the IV is random, so the same value never stores the same bytes. It now emits `@secret(deterministic: true) @unique`, which can be looked up by value and is still readable. The base44 stressor's edit turns found it (jazzhr's answer gave an applicant a private status link). Proof: `test/oracle.test.js`, *a unique secret is deterministic*.

## 2026-10-06 — The module: catalog, checks, emitter (`FJS-D600`, `FJS-D601`)

The rebuild `FJS-D600` reopened, as `FJS-D601` shaped it: one module with no model inside. `src/catalog.js` is the catalog lifted out of `mockup/oracle.jsx` — the 32 entities, now with typed fields and named lifecycle moves, the 7 actors with what each may do, the 18 patterns and the 5 modifiers. `checkAnswer(answer)` grades what a model wrote against it, under thirteen rules (`RULES`). `emit(answer, { scaffold })` writes the graded plan onto the scaffold's `db/schema.lite`. `brief()` renders the contract, types, actors, rules and catalog for a model from the same data, so the prompt and the grader are one list.

Access is derived, never written. Each op's row policy is assembled from the actor links, `via`, `members`, `public` and `shared` the answer declared. An entity nobody reaches is refused, and so is one nobody creates. An op nobody holds goes to gate 8.

Proof: `test/oracle.test.js` emits every catalog entry and every kind's lifecycle and parses each with litestone, refuses one case per rule, and runs the hiring fixture on a real client, where a second company reads none of the first company's six models. The README's counts were stale: the mockup holds 18 patterns, not 36.
