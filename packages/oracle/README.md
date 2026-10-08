# Oracle

**The step before `db/schema.lite`: describe a domain, settle its nouns against a catalog, get the schema.** A model reads "an applicant tracker for a hiring team" and answers that a candidate is a `Contact`, an application is a `Submission`, and an interview is a `Visit`, each with what it adds and who reaches each row. Oracle checks that answer and writes the `.lite`.

**No model runs inside Oracle** (`FJS-D601`). This package is the deterministic half: the catalog, the checks an answer must pass, and the emitter. Whatever runs the model calls it. That can be a skill for a developer or a prompt-to-app builder for anyone else. `fli` never holds a key, and CI runs all of it.

```js
import { brief, checkAnswer, emit } from '@frontierjs/oracle'

const system = brief()                         // the contract + catalog, for the model
const answer = JSON.parse(modelReply)          // what the model wrote
const out = emit(answer, { scaffold })         // scaffold = the app's db/schema.lite
if (!out.ok) sendBack(out.refusals)            // each one names its rule and where
else write('db/schema.lite', out.text)
```

## What it knows

| | Count | Where |
| --- | --- | --- |
| Canonical entities, 10 categories over a core/domain tier | 32 | `ENTITIES` — typed fields, usual links, named lifecycle moves |
| Actors, each with what a link to `User` through it grants | 7 | `ACTORS` |
| Patterns, on a trigger × verb-home grid | 18 | `PATTERNS` |
| Modifiers | 5 | `MODIFIERS` |
| Field types an answer may name | 23 | `TYPES` — each with the column it becomes |

Two of the entities, `User` and `Notification`, are reserved: every scaffolded app declares them already.

## The answer, and what refuses one

An answer names entities. Each one says which catalog entry it collapses to, which rung of the ladder it stopped at (catalog, variant, property or novel), and why. It adds typed fields, links, a lifecycle, and how a row is reached. Questions the prompt leaves open go in `open` and stay out of the schema. `RULES` holds the thirteen checks, among them:

- **Every row has somebody.** An entity is refused unless the answer names who reaches a row: an actor link to `User`, `via` a required parent, a membership, or `public`/`shared` with a reason.
- **Somebody creates it.** An entity nobody can create is refused, as is one nobody can reach.
- **An inference is a question.** A `why` that says *inferred* or *not stated* belongs in `open`.
- **More than two states is a lifecycle.** A `status` enum with three values is refused until it declares its moves.

## Access is derived, never written

The emitter assembles each op's row policy from the answer:

- **Read** is admitted by any of the actor links, the parent's own read rule, a membership row, or a public condition.
- **Create** needs both: the caller is the owner or author the row names, and the caller may read the parent.
- **Update and delete** go to the actors who may change the row, or to whoever may change the parent.
- **An op nobody holds** is raised to gate 8.

A signed-in level with no row policy, the shape behind most of the freehand run's cross-tenant reads, is emitted only when an answer says `shared`. Every public read, unauthenticated write and shared table is listed as a finding at the head of the emitted section.

## Running the old mockup

`mockup/oracle.jsx` is the React recognizer this package replaces: one 6,471-line component that ended at a paragraph of markdown. It is not a workspace member, and it is kept as reference for its screens.

```sh
cd packages/oracle/mockup
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev                            # http://localhost:8070
```

## What it does not do yet

- **Behavior.** A pattern is cited and written as a comment beside its model. Turning `audit` into `@@log(audit)` is the only pattern that becomes a declaration today. Hooks, jobs and notifications are the next step (`fjs-prototypes/base44` Phase 4).
- **The edit turn.** Oracle writes a first schema. A later prompt is resolved against the app's own schema by `fli intent` (`packages/cli/core/intent.js`), and the two have not been joined.
- **Shapes.** The catalog names entities; the 4–8-column shapes that recur under them across twenty schemas (a grant, an interval, a weekday window, a decision stamp, a tree, a poller) are traits in `packages/litestone/references/`, and `emit` writes those columns by hand rather than spreading `@@trait(Interval)`. The review that found them is *The Ten Shapes* (https://claude.ai/artifact/KFxSqaTYsKfZLcVquhfQVt); the ladder's fourth rung, *shape*, is not in `ENTITIES` yet.
- **Satisfy `transition-methods`.** An emitted lifecycle is a `@@transitions` that no service drives yet, so `fli check` reports it until one does (`FJS-1778`).
