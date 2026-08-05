# Orion

> **Status: stub.** Folder claimed, nothing implemented. This file is the intent, not a description of behaviour.

An automations engine. Triggers, conditions, actions — wired into flows that run on their own. Think Zapier or n8n, except it runs inside your own app, against your own schema, with your own gates enforced.

Orion is a **partner to [`basecamp`](../basecamp/)**: same posture, an FJS *application* rather than a library, and the second large dogfooding surface. Where basecamp operates a fleet, Orion automates the operating.

---

## Why it exists

The hosted automation tools stop at the edge of your data. They see an API, not a schema. So they cannot know that `Deployment.status` has declared transitions, that `Secret.data` is `@encrypted`, or that this trigger's principal grades below the gate on the model it wants to write.

Orion starts from `db/schema.lite` like everything else in FrontierJS, so a flow is built out of nouns the app already has:

```
Trigger            Condition            Action
─────────          ─────────            ──────
model event        field predicate      create / patch / remove a Model
schedule (cron)    gate level           call a Service action
inbound webhook    expression           send via app.conduit
manual run         previous step        notify via app.notify
                                        enqueue a Caravan job
                                        run another flow
```

**"On steroids"** is the deliberate part — the ambition is past the hosted tools, not level with them: real branching and fan-out, loops over collections, durable multi-day waits, typed step I/O checked against the schema at author time rather than at 3am, versioned flows with replay, and a run history you can actually debug.

---

## Realm

D7 / app — like basecamp. Orion is expected to *consume* the framework across all three realms rather than extend it:

| Realm             | Orion uses                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Data (Model)      | litestone — flows, versions, runs, step results, all as declared models with real `@@gate` |
| API (Service)     | junction — services + hooks; model events as the primary trigger source                    |
| UI (Resource)     | sierra + mesa + `@frontierjs/ui` — the flow builder and the run inspector                  |
| Jobs              | caravan — every step execution is a job; retries and backoff are already solved            |
| Outbound          | conduit — the single boundary for any call leaving the app                                 |
| Notify            | notifications — flow failure, approval requests                                            |

If Orion needs something the framework cannot express, that is a finding against the framework and belongs in `HANDOFF.md` — not a local workaround.

---

## Non-negotiables

Inherited, and worth restating because an automations engine is exactly where they get bent:

- **Access is declared in the schema, not in flow logic** (Invariant 6). A flow runs *as* a principal and is refused by the same gates as a human. A step must not reach for `asSystem()` to make itself work.
- **Protected fields are redacted** (Invariant 7). Run history is a log — an `@encrypted`/`@guarded`/`@secret` value logs as `[redacted]` in step inputs, outputs, and snapshots alike.
- **Caller-supplied names never enter a SQL pattern** (Invariant 8). Flows are user-authored strings by definition; every one of them is caller-supplied.
- **Styling is `@frontierjs/css`** (Invariant 13) — a tone and a treatment, no utility classes, no exceptions for a canvas UI.

---

## Shape (sketch)

```
orion/
  db/      schema.lite — Flow, FlowVersion, Trigger, Step, Run, RunStep
  api/     services + the execution engine (Caravan-backed)
  web/     src/resources/*.mesa — builder canvas, run inspector
```

Root layout per Invariant 3; `src/resources/` is `.mesa`, per Invariant 18.

---

## Open questions

- **Flow representation.** A `.lite`-adjacent DSL, or rows in the database? A DSL gets diffs, review, and version control for free; rows get a builder UI without a parser round-trip. Both means two sources of truth, which is the thing to avoid.
- **Who owns scheduling** — Caravan's cron, or an Orion scheduler over it? Caravan, unless something concrete says otherwise.
- **Durable waits.** A step that sleeps three days cannot hold a worker. Continuation state has to live in the Data realm, which makes resume a query, not a memory read.
- **Which principal does a flow run as?** Its author, a service account, or the triggering user? This decides what gates see, so it is a Data-realm question, not a config toggle.
- **Trigger source for model events.** litestone `onEvent` currently has no Junction subscriber (`CLAUDE.md` § Bridge index) — Orion is the use case that would force that seam to exist.
- **Blast radius.** A flow that patches every row on every write is one edit away. Rate limits, dry runs, and a kill switch are day-one features, not hardening.

---

## Read next

- `../basecamp/PROJECT_STATE.md` — the sibling app; read its sharp edges before repeating them
- `../../example/` — the kitchen sink, all three realms end to end
- `../../CLAUDE.md` — invariants and live hazards
- `../caravan/README.md`, `../conduit/README.md` — the two engines Orion is expected to sit on
