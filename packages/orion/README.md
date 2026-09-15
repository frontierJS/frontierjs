# Orion

> **Status: being ported.** The engine, its data layer, execution on Caravan,
> the triggers, the actions and the services are built (`FJS-D275`; plan in
> `IDEAS/orion-port.md`); the screens are next, from `mockup/ui/`. Orion is a package
> built ON the framework and installed into an app (`FJS-D269`). Its primary
> trigger is litestone's write tap, which Orion subscribes to directly (`FJS-D247`).
> This file is the intent, not a description of behavior.

An automations engine. Triggers, conditions, actions — wired into flows that run on their own. Think Zapier or n8n, except it runs inside your own app, against your own schema, with your own gates enforced.

Orion is a **package installed into an app** (`FJS-D269`), in `@frontierjs/auth`'s shape: `.lite` models, a Junction plugin, and the engine inside. Basecamp is its second host after `example/` — where basecamp operates a fleet, Orion automates the operating.

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

A package over all three realms (`FJS-D269`). Orion *consumes* the framework rather than extending it:

| Realm             | Orion uses                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Data (Model)      | litestone — flows, versions, runs, step results, all as declared models with real `@@gate` |
| API (Service)     | junction — authoring, inspection and manual runs; a step's action may call a service       |
| UI (Resource)     | sierra + mesa + `@frontierjs/ui` — the flow builder and the run inspector                  |
| Jobs              | caravan — cron and dispatch at the edge of a run, never a job per step                     |
| Outbound          | conduit — the single boundary for any call leaving the app                                 |
| Notify            | notifications — flow failure, approval requests                                            |

If Orion needs something the framework cannot express, that is a finding against the framework and belongs in `ISSUES.md` — not a local workaround.

---

## The engine is written for speed

**`src/engine/` is the one place in Orion built for throughput, and it still runs inside the host app.** The compiler, the expression language, the executor and the step store are plain modules, not services. The loop checkpoints the run once per stage, so what that write goes through is the engine's cost:

- **The executor writes its checkpoint through the litestone client directly.** Not through a Junction service, which roughly doubles the per-step cost, and not through a Caravan job per step, which adds a second checkpoint to the one the engine already writes. The gate stays on, since it costs almost nothing.
- **A step's ACTION is not the engine's bookkeeping.** An action that touches app data runs as the flow's principal through the gated client or a service (§ Non-negotiables); only the engine's own run and step records take the direct path.
- **`RunStep` carries no `@@log`.** Run history is already a log, and auditing it writes the trail twice at the rate the engine runs. `Flow`, `FlowVersion` and credentials are what the audit trail is for.
- **The step store sits behind one interface.** If a measured flow shows checkpointing dominates, that one table moves to prepared statements and nothing above it changes. Measure first: an action spends milliseconds on I/O where a checkpoint spends microseconds, so the gap shows only in flows that do little I/O.

The measurements behind this are `IDEAS/operational-edge.md` § durable workflows.

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
packages/orion/
  db/      orion.lite — the models the host imports
  src/     plugin.ts, services/, and engine/ — the executor (§ The engine is written for speed)
  web/     .mesa routes the host's web/ mounts under a prefix (FJS-D270)
```

The full sketch, and the rulings behind it, are `IDEAS/orion-port.md`.

---

## Read next

- `../basecamp/PROJECT_STATE.md` — the sibling app; read its sharp edges before repeating them
- `../../example/` — the kitchen sink, all three realms end to end
- `../../CLAUDE.md` — invariants and live hazards
- `../caravan/README.md`, `../conduit/README.md` — the two engines Orion is expected to sit on
- `../../IDEAS/orion-port.md` — the plan for turning `mockup/` into this, module by module, and the rulings it rests on (`FJS-D269`–`FJS-D283`)
