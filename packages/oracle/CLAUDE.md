# oracle — package map

**`@frontierjs/oracle`** — the step before `db/schema.lite`. A model reads a
person's words and writes an ANSWER: which catalog entries the domain already
contains, what each adds, who reaches each row, how each thing moves. This
package grades the answer and writes the seed. **No model runs here**
(`FJS-D601`): whatever runs the model calls this module, so CI runs all of it
and the same answer is graded and emitted the same way twice.

`bun run test` — one suite, `test/oracle.test.js`, bun. It parses every
emitted schema with litestone and runs one emitted app on a real client.

---

## Layout

```
src/catalog.js   THE ORIGIN. 32 entities with typed fields, usual links and
                 named lifecycles; 7 actors and what each may do; 18 patterns;
                 5 modifiers. Lifted from mockup/oracle.jsx, where the same
                 collapses were stated as data and again in prompt text
src/types.js     the words an answer types a field with, and the column each
                 one is. `date` is `String @date`, `money` is `Int @money(USD)`
src/answer.js    checkAnswer(answer) → { ok, refusals, findings, plan }. RULES
                 is the list of what it refuses, and brief.js renders it
src/emit.js      emit(answer, { scaffold }) → { ok, text, models, … }. Grades
                 first and writes nothing from a refused answer
src/brief.js     brief() → markdown for a model: the contract, the types, the
                 actors, RULES and the catalog, all rendered from the data
mockup/          the old React recognizer. Not a workspace member, not ported,
                 kept as reference (scripts/ci-allowances.json nonMembers)
```

## Traps

- **A delegation may only name an op the parent holds a POLICY for.**
  litestone compiles `check(parent, 'update')` against a parent held only by a
  gate as *no restriction at all*. `accessTable` computes parents first and
  falls back to `read`; a membership that delegated to `update` on a container
  with no update policy let any signed-in caller join any container.
- **`check(parent)` carries the parent's PUBLIC clause.** Under a parent read
  at gate 0 a child delegates to `check(parent, 'update')`, or to nothing when
  the parent holds no update policy; `check(shop)` let every signed-in caller
  read and add to the orders of a published shop (`FJS-1789`).
- **A create is an AND.** The caller is the owner/author the row names AND may
  read the parent. Either alone files a row under somebody else's name or
  under a parent the caller cannot see.
- **`via` must be a REQUIRED link.** `check()` over a null key allows, so an
  optional parent link admits every row that names no parent.
- **An op nobody holds is gate 8, never a signed-in level with no policy.**
  That shape is what read every tenant's rows in the freehand run
  (fjs-prototypes/base44, Phase 1). `shared` and `public` are the only ways to
  ask for it, and each is a finding.
- **The catalog's `links` are advice.** The emitter never adds one the answer
  did not declare; `brief()` shows them as *usual links*.
- **`User` and `Notification` are reserved** — every scaffolded app declares
  both. The emitter never edits `User` and gives a link to it no back-relation.
- **`inferred` is a word check.** It refuses `why`/`cost`/`escape` that say
  *inferred* or *not stated*, which also catches a sentence documenting an
  omission; the rule text tells a model to put omissions in `open`.

## What proves a change

`bun run test` first. A change to what is emitted is proved by
`fjs-prototypes/base44`'s corpus run (`bun builder/run.ts --condition oracle`),
which emits 21 apps, grades each with `parseFile` + `fli advise` + `fli check`,
boots it, and runs an access drive reading every model as a stranger and as a
second tenant.
