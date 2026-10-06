# Changes — @frontierjs/oracle

## 2026-10-06 — The module: catalog, checks, emitter (`FJS-D600`, `FJS-D601`)

The rebuild `FJS-D600` reopened, as `FJS-D601` shaped it: one module with no model inside. `src/catalog.js` is the catalog lifted out of `mockup/oracle.jsx` — the 32 entities, now with typed fields and named lifecycle moves, the 7 actors with what each may do, the 18 patterns and the 5 modifiers. `checkAnswer(answer)` grades what a model wrote against it, under thirteen rules (`RULES`). `emit(answer, { scaffold })` writes the graded plan onto the scaffold's `db/schema.lite`. `brief()` renders the contract, types, actors, rules and catalog for a model from the same data, so the prompt and the grader are one list.

Access is derived, never written. Each op's row policy is assembled from the actor links, `via`, `members`, `public` and `shared` the answer declared. An entity nobody reaches is refused, and so is one nobody creates. An op nobody holds goes to gate 8.

Proof: `test/oracle.test.js` emits every catalog entry and every kind's lifecycle and parses each with litestone, refuses one case per rule, and runs the hiring fixture on a real client, where a second company reads none of the first company's six models. The README's counts were stale: the mockup holds 18 patterns, not 36.
