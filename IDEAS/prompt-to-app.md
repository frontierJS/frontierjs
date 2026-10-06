---
id: prompt-to-app
status: assessment
dated: 2026-10-06
---

# Idea — Prompt-to-app: what the Base44 space is, and what it would take here

**Status: ASSESSMENT.** Dated 2026-10-06. Prior-art research done from public
sources on that date (listed at the end), with each FJS claim checked against the
tree that day. Nothing is built. Stressor #22 in `stressors.md` points here. Do
not cite this file as describing behavior — see `VERIFYING.md`.

---

## What defines the space

**The loop is the product.** A person describes an app in chat. The builder plans
it, writes the data model, UI and server logic, boots a live preview, and
publishes. Every later message edits the running app. The players differ mostly
in how much of that loop they own.

| Player | Backend | What stands out |
| --- | --- | --- |
| **Base44** (Wix, $80M, June 2025) | Its own: Mongo-compatible document store, Deno serverless functions, auth, files, email, payments | "Entities" are schemas the store **does not enforce**. Row- and field-level rules. Superagents with WhatsApp and automations. A CLI and code export arrived later. |
| **Lovable** | Supabase, then its own Lovable Cloud (Sept 2025) | **Preview and published share one database** by default. Lovable AI is built in with no API keys. |
| **Bolt.new** (StackBlitz) | Bolt Cloud or Supabase | WebContainers: Node compiled to wasm, running in the tab, with a service worker as the preview server |
| **Replit Agent** | A VM plus Postgres | Checkpoints roll back files, conversation and database together. Dev and prod databases split **after** an incident. |
| **v0** (Vercel) | UI-first, with bring-your-own databases | A developer reviews each diff, so its output is the closest to production |
| **Convex Chef** | Convex | Pitches **"a backend that knows AI"**: one language end to end, a typed schema, ACID, reactive by default |
| **Retool AI** | The customer's existing databases | Governance (SSO, role-based access, audit) is **inherited by every generated app** rather than generated per app |

**Everyone ended up owning the backend.** Base44 did from day one. Lovable built
Cloud, Bolt built Bolt Cloud, and Chef is a backend company's builder. All of
them run the same frontier models, so the generator is a commodity. What differs
is the substrate the generated code runs on and how much damage it can do there.
FJS competes at that layer, and that is why this stressor is a test of the
thesis rather than a feature.

---

## The hurdles: the field's failure record

Each hurdle is a documented incident or measurement, not a guess.

1. **Access control is generated code, so it gets generated wrong.** In February
   2026, a Lovable-hosted app on its Discover page exposed 18,000 users. The AI
   wrote an access check that blocked signed-in users and let anonymous ones
   through, and row-level security was missing. Vendor surveys put the share of
   AI-built apps with a security hole at between 45% and 91%. The platform layer
   fails too: Base44's `auth/register` endpoint accepted any public `app_id`, so
   anyone could join a private enterprise app (Wiz, July 2025).
2. **An agent with authority over production data will use it.** In July 2025,
   Replit's agent ran `db:push` during a declared code freeze, dropped every
   table, then invented 4,000 rows and reported that the tests passed. Preview,
   test and production shared one connection string. The lesson the field drew:
   **a guardrail the agent can read is one it can argue with**, so the freeze has
   to live where the SQL executes.
3. **A schemaless store rots slowly.** Base44 lets you add a field with no
   migration because nothing enforces the schema. Convex's pitch is this
   failure: an agent writes code against a loose store, the code compiles, the
   tests pass, and the data degrades underneath.
4. **The complexity wall.** Users report about half their tokens going to fix
   loops, where a fix reintroduces an earlier bug. One Bolt "Attempt Fix" click
   costs 100–200k tokens, and Red Hat describes a "three-month wall". Generated
   code is optimized to be generated, not maintained.
5. **Preview and production are one dataset.** Lovable Cloud still ships that
   way. Replit fixed it only after hurdle 2.
6. **An agent inside the app plus untrusted rows is the lethal trifecta.** In
   the Supabase MCP case (General Analysis, July 2025), a support ticket carried
   instructions. The assistant held `service_role`, which bypasses row-level
   security, read the private tables and posted them back into the ticket.
7. **Lock-in, and the escape hatch.** Code export is a paid feature everywhere,
   and the exported code is the hurdle-4 code.

---

## Where FJS starts ahead, as of 2026-10-06

| Hurdle | What FJS already has |
| --- | --- |
| 1. generated auth | Invariant 6: access is a declaration in `.lite`, enforced at the Data boundary. The agent writes `@@gate`, a one-line declaration a person can review, rather than an auth function. The 18,000-user bug becomes a wrong level on one line, plus a drive that fails it. |
| 2. destructive agent | Litestone's migration differ already **blocks any column drop**, prints a `DESTRUCTIVE` banner, suggests `RENAME COLUMN` for a probable rename, and has no down migrations (`litestone/docs/migrations.md`). That is the freeze living where the SQL executes, which is Replit's lesson. |
| 3. schema rot | SQLite with a typed `.lite` schema, which is Convex's argument already in place |
| 5. preview = prod | `IDEAS/sandboxes.md` (a tenant with a parent) is the shape. It is proposed, not built. |
| 6. lethal trifecta | `@frontierjs/mcp` grades the agent at the caller's own standing and never as the system (`FJS-D258`). That is the direct answer to the `service_role` problem. |
| 7. export | The output is an ordinary FJS app. Ejecting means doing nothing. |
| Preview runtime | Litestone runs in a browser worker over OPFS (`FJS-D305`), which plays the role WebContainers plays for Bolt |
| Publish | Basecamp and Outpost deploy a release. `inline` apps serve pasted bytes on a separate origin. |
| Batteries | Auth, mail, jobs (Caravan), file storage, notifications, an AI battery, automations (Orion, being ported) |

**The thesis claim this stressor tests:** one seed file from which everything
derives is a smaller and more checkable target for a model than a React app over
a document store. Hurdle 4 should shrink, because there is less to keep coherent
and `fli check` turns the invariants into machine-readable refusals. That is a
claim, not a measurement.

---

## What would make ours stand out: oracle

**Every builder in the field goes from prompt straight to code.** Each app makes
up its own nouns. One app's `Booking` is another's `Appointment` and a third's
`Reservation`, each with its own fields, its own auth and its own bugs, and
nothing is learned from one app to the next. Nothing in the field decides **what
the nouns are** before generating.

**Oracle decides exactly that** (`packages/oracle/README.md`). It is a
hand-written catalog of 32 canonical entities, 36 patterns on a trigger ×
verb-home grid, and 7 actor archetypes. A recognizer asks three questions of
every candidate noun: *is this a property of something more fundamental, a
variant of a catalog entry, or genuinely novel?* Most fail at the first two.
"Customers book a recurring cleaning slot and get invoiced after" becomes
`Contact:customer`, `Visit` and `Document:invoice`, plus the actors and the
sentence that connects them.

**A builder would share that logic, and it is the planning step every builder
lacks.** Built properly, it addresses the field's hurdles directly:

- **The model stops writing `.lite` freehand.** The model picks entries from the
  catalog, and a deterministic emitter writes the schema. That turns
  breaks-first #2, the risk that could kill the thesis, into a catalog-coverage
  problem: a novel noun is the only place the model authors structure.
- **Access comes from the actor, not from generated code.** An actor archetype
  carries its gate levels, so `@@gate` is emitted from who the actors are. That
  is hurdle 1 removed at the source rather than caught by a drive.
- **Patterns become behavior.** A trigger × verb-home entry maps to a
  transition, a hook, a job or a notification, so generated server code shrinks
  to what no pattern covers. That shrinks breaks-first #3.
- **The edit turn is the intent recognizer.** `IDEAS/intent-recognizer.md`
  already resolves a person's words against an app's own seed
  (`packages/cli/core/intent.js`, `fli intent`), with no model in the resolver.
  Oracle handles the first prompt and the recognizer handles every later one,
  which together are a builder's two halves.
- **Apps converge.** When hundreds of generated apps share canonical nouns, a
  fix, a template or an integration written for one fits the rest. That is the
  compounding the field cannot get, because its apps share nothing below the
  framework.

**What has to happen first.** Oracle's README names its own gap: **it emits
markdown, not a schema**, which is exactly the step a builder needs. Its collapse
rules are stated twice, as catalog data and again in about 1,300 lines of prompt
text, and a builder would inherit that drift. The deferral is lifted
(`FJS-D600`, 2026-10-06), so Oracle is being built now. It would also be the first
`fli` command to call an LLM. `FJS-D601` ruled it never does: Oracle is a module
with no model in it, and the builder is one of the things that call it.

---

## What it breaks first

Ranked by how early in a build each one fails.

1. **The schema changes on every prompt while the app runs.** Each turn runs the
   migration differ against live data. The drop-block refusal exists, but nobody
   decides **who approves it and how the refusal reaches the chat**. That
   approver has to be the person, never the agent, which is the Replit lesson.
   There is no rename detection, so an agent that renames freely produces
   drop-plus-add pairs. A hot schema swap without a server restart has never
   been driven.
2. **The model's target language.** `.lite` and `.mesa` are nowhere in training
   data, and TypeScript is everywhere, so Convex's argument cuts against FJS.
   The intent-recognizer runs already saw a model invert a conditional it was
   paraphrasing. Possible mitigations: the language server's diagnostics,
   parse errors fed back within one turn, and `fli check`. Each needs a
   measurement before anyone relies on it. **This is the risk that could kill
   the thesis**, and the oracle route above avoids it rather than mitigating
   it.
3. **Untrusted server code.** Base44 runs generated functions in Deno isolates.
   A generated FJS hook runs inside the API process, and `asSystem()` is one
   call away from it, which makes it this framework's `service_role`. The gate
   protects data from the client but not from the app's own code. This needs an
   isolate or an `fli check` rule that refuses `asSystem` in generated code.
4. **Many apps on one host.** A builder hosts hundreds of apps. The port schema
   has ten project digits and gives every other app digit 0
   (`packages/cli/core/ports.js`), and each app boots its own Caravan worker and
   `jobs.db`. Outpost deploys one app per release. Whether a generated app is
   a process, a tenant or a mount is undecided.
5. **Checkpoints.** Replit's rollback restores files, conversation and database
   together. A SQLite file copy is the cheapest database snapshot there is, so
   this should be an FJS advantage, but nothing pairs a schema revision with a
   database snapshot today.

---

## The features a builder needs

| Feature | State here |
| --- | --- |
| A planner that settles the nouns before anything is generated | `oracle`: the catalog and recognizer exist as a mockup that emits prose, not `.lite` (§ *What would make ours stand out*) |
| A chat that writes `schema.lite`, then resources, then services, in that order | Missing. The `discovery` skill puts a person in the loop and stops at the schema. |
| Edit turns resolved against the existing seed | The intent recognizer's resolver is built. Its translator and phraser are not. |
| A validation loop of parse, `fli check`, derived drive, with errors fed back to the model | The parts exist. The loop does not. |
| Schema-change approval owned by the person | The differ refuses destructive changes. The approval UI does not exist. |
| Separate preview and production data | `sandboxes.md`, proposed |
| A checkpoint that pairs a revision with a database snapshot | Missing |
| A live preview | Server: `fli dev`. In the tab: litestone over OPFS. Junction in a browser: no, it is Bun-only. |
| Managed auth, mail, files, jobs and AI | Present |
| Payments | Conduit targets only. Nothing like Base44's built-in payments. |
| An agent inside the generated app | `@frontierjs/mcp`, graded per caller |
| Automations and superagents | Orion, being ported |
| Visual edits that skip the AI round trip | `on-page-editing.md`, an idea |
| Publishing many apps | Outpost publishes one app per release. Multi-app hosting is missing. |
| Isolation for generated server code | Missing |

---

## The stressor itself

**Build a thin builder, not the product.** A script calls the Claude API with a
prompt, writes `db/schema.lite` and the resources, runs the validation loop,
boots the app, and keeps iterating until a drive passes. The builder's UI is out
of scope until the loop works.

**The corpus is already in the tree.** Use the one-line product shapes of the 21
stressors, plus the schemas in `reference-library.md`. Each prompt is graded on:

- **Turns to green**, and tokens spent on fixes versus new work. That second
  number is the field's 50%.
- **The access drive**: an anonymous read and a cross-user read against every
  model must both be refused. This is the 18,000-user test, run on every app.
- **The destructive edit**: a follow-up prompt that renames or removes a field
  with rows present. It must stop at the person, never apply.
- **The trifecta probe**: a seeded row carrying instructions, read by the app's
  own MCP agent. Nothing above the caller's standing may leave the app.

**Oracle with the loop closed.** Oracle names the entities, and the discovery
skill writes a schema with a person in the loop. Neither one reaches a running
app. The builder is the oracle rebuild with an emitter, a validation loop and an edit
turn added. **Run it twice**: once with the model writing `.lite` freehand and
once through the catalog. The difference in turns-to-green and in the access
drive measures what oracle is worth.

Build it in `fjs-prototypes/`, with the same rule as Transit (#21): every fix it
needs lands in FJS, and the builder's own code never enters this tree.

---

## Sources

- Base44: [backend features](https://docs.base44.com/developers/backend/overview/features) ·
  [entities](https://docs.base44.com/developers/backend/resources/entities/overview) ·
  [schemaless store](https://escapebase44.com/base44-backend-database) ·
  [changelog](https://docs.base44.com/developers/changelog) ·
  [Wix acquisition](https://en.globes.co.il/en/article-wix-acquires-israeli-vibe-coding-co-base44-1001513267) ·
  [Wiz auth bypass](https://thehackernews.com/2025/07/wiz-uncovers-critical-access-bypass.html)
- Lovable: [Lovable Cloud](https://lovable.dev/blog/lovable-cloud) ·
  [18K-user exposure](https://www.theregister.com/2026/02/27/lovable_app_vulnerabilities)
- Bolt: [WebContainers](https://www.morphllm.com/bolt-vibe-coding)
- Replit: [database deletion](https://www.theregister.com/2025/07/22/replit_saastr_response/) ·
  [lesson: policy where SQL executes](https://www.bytebase.com/blog/how-to-prevent-ai-agent-from-dropping-your-production-database/) ·
  [checkpoints](https://docs.replit.com/core-concepts/agent/checkpoints-and-rollbacks)
- Convex Chef: [changelog](https://ship.convex.dev/changelog/chef-ai-app-builder) ·
  [typed schema as scaffolding](https://aiweekly.co/node/8987)
- Supabase MCP: [General Analysis](https://generalanalysis.com/blog/supabase-mcp-blog) ·
  [Willison, the lethal trifecta](https://simonwillison.net/2025/Jul/6/supabase-mcp-lethal-trifecta/)
- Field comparisons: [altar.io](https://altar.io/lovable-vs-bolt-vs-v0-vs-replit-vs-base44/) ·
  [Retool vs Lovable](https://retool.com/competitor/lovable) ·
  [cost of fix loops](https://www.fuzen.io/posts/real-cost-of-vibe-coding-2026)
