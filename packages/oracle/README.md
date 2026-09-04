# Oracle

**A domain-modeling recogniser: describe a thing in prose, get back the canonical entity it already is.** You type "customers book a recurring cleaning slot and get invoiced after"; Oracle answers `Contact:customer`, `Visit`, `Document:invoice`, names the actors, and writes the sentence that connects them. It is the step before `db/schema.lite` — the argument about *what nouns exist* that every app has and almost no app writes down.

> **Status: V2, deferred.** Nothing is owed here until FrontierJS core leaves alpha — `FJS-D14`.
> See § Status below for what reopening it would cost.

Claimed, not built. What is here is a mockup — `mockup/oracle.jsx`, one file, exported from a Claude artifact and now runnable locally. It is **not a workspace member**: `mockup/` holds its own `package.json` and its own React toolchain, the same convention `packages/mesa/mesa-bench` and `packages/orion/mockup/api-engine` use, so nothing it depends on reaches the rest of the repo. Run it from its own directory.

## Running it

```sh
cd packages/oracle/mockup
npm install
export ANTHROPIC_API_KEY=sk-ant-...    # or: export ANTHROPIC_AUTH_TOKEN=$(ant auth print-credentials --access-token)
npm run dev                            # http://localhost:8070
```

**The key never enters the browser bundle.** The page posts to `/anthropic/v1/messages` and Vite's dev server proxies that to `api.anthropic.com`, attaching `x-api-key` (or `Authorization: Bearer` plus the OAuth beta header, when `ANTHROPIC_AUTH_TOKEN` is what you set) on the way out. Requests are unauthenticated without one of the two — the server says so at startup and the recogniser returns a 401. Catalogue browsing and the graph view need no key at all.

`npm run build` and `npm run preview` produce and serve the static bundle, which has **no proxy** and therefore no working recogniser. The build exists to prove the page compiles, not to deploy.

## What it knows

The catalogue is hand-written and is the durable part of this package:

| | Count | Where |
| --- | --- | --- |
| Canonical entities, 8 categories over a core/domain tier | 32 | `ENTITY_CATALOG` |
| Patterns, on a trigger × verb-home grid | 36 | `PATTERN_CATALOG` |
| Actor archetypes | 7 | `ACTOR_ARCHETYPES` |
| Modifiers | 5 | `MODIFIERS` |

Recognition runs three questions in order — *is this a property of something more fundamental? a variant of a catalogue entry? genuinely novel?* — and most candidates fail at the first two, which is the whole point. The collapses are opinionated and stated: an order is `Document:order`, an audit log is `Event:audit`, a fee is a line item, a thread is a chain of `Message`. Colon notation is reserved for kinds that change an entity's lifecycle; domain flavor goes in prose beside the bracket, never inside it.

## What it does not do

**It emits markdown, not a schema.** There is no mention of `.lite`, Litestone, or `model` anywhere in the file. Oracle decides that `Contact:customer` is the right noun and then hands you a paragraph — one step short of the seed the rest of FrontierJS grows from. That gap is the reason this is a mockup rather than a package.

Two more things a real version would have to fix. The catalogue's collapse rules are stated twice, once as data and once inside ~1,300 lines of prompt text, so the two drift. And the UI is one 6,471-line React component in a repo whose UI substrate is Mesa — a rebuild is a rewrite, not a port.

## Status: V2, deferred

**Nothing is owed here until FrontierJS core leaves alpha** — `FJS-D14`, `DECISIONS.md` § Repo conventions. Oracle is a tool built on the framework rather than a gap in it, and the version worth having asks a question the CLI has not answered: it would be **the first `fli` command to call an LLM**, which is a posture decision about offline behavior, key handling and CI, not about Oracle.

When it is reopened, the choice is narrower than for the other claimed folders, because the thinking here is worth keeping even if the code is not:

- **Lift the catalogue into `IDEAS/`** and drop the JSX. The 32 entities, 36 patterns and verb vocabulary are design content the framework can cite; the React is disposable. This half costs nothing and does not wait on the ruling above.
- **Build it as an `fli` command** that ends at `db/schema.lite` instead of at prose. That is the version that earns a package slot, and it needs a Mesa UI, a test suite, a `package.json` at this level rather than one directory down — and a rewrite: `mockup/oracle.jsx` is 6,471 lines of React in a repo whose UI substrate is Mesa.
