# Basecamp

**Developer command central for the FJS World.**

Basecamp is where you go when you stop building one application and start operating several. It provisions servers, ships releases, installs the self-hosted infrastructure your applications depend on, and shows you what is running where.

> ⚠️ **Status: aspirational.** This document describes what Basecamp is supposed to be, not what it currently does. Nouns, commands, and boundaries here are proposals. Open questions are marked and are genuinely open.

---

## The Problem Basecamp Exists to Solve

FrontierJS closes the accidental gaps *inside* an application. One schema radiates to the Data, API, and UI realms, and the developer never says the same thing twice.

Then the application ships — and every gap comes back.

The schema knows the shape of the data. The manifest knows the shape of the deployment. But nothing knows which version of that manifest is actually running on which machine, whether the migration applied, which secrets that environment holds, or whether the Postgres instance three projects share is the same one you patched last month. That knowledge lives in a mix of SSH history, a spreadsheet, a Notion page, and memory.

This is the same coherence problem the framework was built to solve, displaced one level outward. The declarations exist. The realizations exist. Nothing connects them.

Basecamp is the connection. It is not a dashboard bolted onto a framework — it is the operational face of declarations the framework already makes.

---

## The Guiding Principle

Basecamp is evaluated against the same question as everything else in FrontierJS:

> **Does this reduce the inertia between developer intent and running software — without enlarging the mental model?**

With one clarification specific to Basecamp:

> **Basecamp adds nothing to the application's mental model.**

A developer who understands Model, Service, and Resource must not need to learn a fourth noun to ship. Basecamp operates on applications from the outside. It is a Domain concern, not a Realm concern. If a Basecamp feature ever requires changing how an application is written, that feature is in the wrong place.

---

## What Basecamp Is

**A fleet view.** Every project, every environment, every server, in one place. What version is live. What migrations are pending. What is healthy.

**A provisioner.** Point Basecamp at a fresh machine and it prepares it to run FrontierJS applications — runtime, reverse proxy, TLS, backups, the deploy user, the directory conventions.

**A shipper.** `fli deploy` from your terminal and Basecamp from the browser do the same thing through the same path. Neither is privileged.

**An installer.** The self-hosted infrastructure your applications depend on — secrets management, databases, object storage, queues — installed, versioned, and operated from one place instead of assembled per-project by hand.

**An FJS application itself.** Basecamp is built in FrontierJS. Its own schema, its own services, its own resources, live by default over the channel system. It is the framework's largest dogfooding surface, and that is deliberate: if operating a fleet cannot be expressed cleanly in FrontierJS, that is a finding about FrontierJS.

## What Basecamp Is Not

**Not a requirement.** Every action Basecamp performs must remain available through `fli` and, beneath that, through SSH and shell. Basecamp is a face over a documented path, never the only path. A team that never opens Basecamp must be able to run FrontierJS applications in production indefinitely.

**Not a hosting platform.** Your servers stay yours. Basecamp does not become an intermediary your applications depend on at runtime. If Basecamp is offline, nothing you have deployed notices.

**Not a second declaration.** Basecamp does not introduce its own deployment format. The Manifest is declared in the project, in source control, next to the schema. Basecamp reads it. Anything a developer can configure in Basecamp that is not reflected in the project's own files is a gap Basecamp created.

**Not an APM.** Basecamp surfaces what the framework already knows about itself. It is not competing with purpose-built observability tooling and should integrate with it rather than reimplement it.

---

## Where Basecamp Fits

FrontierJS operates at two levels: the **Application** (five realms) and the **FJS World** (domains). Basecamp lives entirely at the second level.

The relationship to the Deployment realm is the one that matters most:

| Declaration (Realm)         | Realization (Domain)                        |
| --------------------------- | ------------------------------------------- |
| Manifest, in the project    | Release, executed and recorded by Basecamp  |
| Schema, in `db/schema.lite` | Migration state, tracked per environment    |
| `frontier.config.js`        | Resolved runtime config per environment     |
| Gate rules                  | Trust levels enforced in the running system |

Basecamp is the realization side of that table. It never owns the left column.

### Basecamp and `fli`

Both are developer interfaces; they differ in scope and vantage point.

`fli` acts on **one project, from inside it.** It assumes a working directory, a schema, a config file. It is the tool of the build loop.

Basecamp acts on **many projects, from outside them.** It assumes nothing about where you are standing. It is the tool of the operating loop — which spans projects, servers, environments, and time.

The rule between them: **Basecamp never grows a capability `fli` cannot also perform.** Where the two overlap, `fli` is the implementation and Basecamp is the caller. This keeps the escape hatch real rather than theoretical.

### The Domain Question — Open

Basecamp began as the primary tool of **Domain 7 — Observability**. It has outgrown that.

Provisioning a server, installing Infisical, and executing a release are not observability. They are operational control. The current framing either understates what Basecamp does or the domain is mis-named.

Three candidate resolutions, none chosen:

1. **Rename the domain.** Domain 7 becomes *Operations* — signals and control in one place, on the argument that seeing and acting on a running system are the same concern.
2. **Split the domain.** Observability (signals, passive) stays separate from Operations (control, active). Basecamp becomes the tool of the new domain and merely *reads* from Observability.
3. **Leave it.** Basecamp is the operational face of several domains at once and does not belong to one. Domains describe concerns; tools may span them.

Option 3 is the most honest description of the current state and the least useful as a design constraint. This should be settled before Basecamp's feature surface grows further, because the answer determines what Basecamp is allowed to absorb.

---

## Vocabulary

Basecamp needs nouns. Every one is a threat to the mental model, so the bar is: reuse an existing FrontierJS noun, or justify a new one.

| Noun                | Meaning                                                              | Status                        |
| ------------------- | -------------------------------------------------------------------- | ----------------------------- |
| **Project**         | An FJS application Basecamp knows about, across all its environments | Proposed                      |
| **Server**          | A machine Basecamp can provision and deploy to                       | Proposed                      |
| **Environment**     | A named target within a project — development, staging, production   | Proposed                      |
| **Manifest**        | The declared shape of a deployment                                   | **Reused** — Deployment realm |
| **Release**         | A manifest realized at a point in time                               | **Reused** — Deployment realm |
| **Gate ladder** | Who may do what in Basecamp itself                                   | **Reused** — 0–9 scale        |
| **Outpost**         | The process a Server runs so Basecamp can reach it — heartbeat, health, exec | **Settled** — `FJS-D29` |

**Outpost is the only new noun here that is settled**, and the rule it came from
is worth keeping when the next one is argued: **infrastructure takes place nouns,
AI takes personified nouns.** It replaced *agent*, which this repo had already
spent on the MCP surface (`IDEAS/agent-surface.md`) in a schema that has a
`UserKind.ai`. The name is settled; whether there is a resident process at all is
the open question below.

### One name deliberately avoided

Self-hosted third-party software — Infisical, Postgres, Redis, MinIO — must **not** be called a Service.

Service is the API realm's primary noun and means *the CRUD surface for a model*. Overloading it to also mean *a self-hosted daemon on a box* would corrupt the single most-used word in the framework's vocabulary. Borrowed words import borrowed expectations, and this one is already spent.

Candidates under consideration, none settled: **Appliance** (self-contained, installed, operated, not written by you — currently favored), **Dependency** (accurate, but overloaded by package managers), **Install** (a verb doing a noun's job).

Whatever it becomes, it must read naturally in the sentence a developer will actually say: *"add a Postgres ___ to this server."*

---

## Capability Sketch

Grouped by the loop each capability serves. Ordering here is not a roadmap.

### Know
- Every project, environment, and server in one view
- Live release state — what version, deployed when, by whom
- Schema drift and pending migrations, per environment
- Health, errors, and throughput surfaced from what the framework already emits
- Feature flag state per environment

### Provision
- Prepare a bare machine to run FrontierJS applications
- Install and version appliances — secrets, databases, storage, queues
- Manage TLS, reverse proxy, and DNS-adjacent concerns
- Backup schedules and restore paths, with restore actually exercised

### Ship
- Execute a release from a manifest
- Run migrations as part of the release, in the new container's entrypoint
- Roll back to a previous release
- Promote a release between environments

### Operate
- Scoped shell and log access without handing out root
- Run a one-off job or REPL against an environment
- Rotate secrets and propagate them
- An audit trail — every operational action attributable to a person

---

## Design Constraints

These are the rules Basecamp features are checked against. They are stricter than the general framework guidelines because Basecamp holds production credentials and can destroy running systems.

**1. Read the declaration; never replace it.**
If Basecamp lets a developer configure something that has no home in the project's own files, Basecamp has created a gap. Find the declaration first.

**2. Every action is reproducible without Basecamp.**
Every button maps to a documented `fli` command. If a capability cannot be expressed as one, that is a finding about `fli`, not a license for Basecamp to grow a private path.

**3. Actions are gated, not roled.**
Basecamp is an FJS application. Access to its models is declared in its schema and enforced at the Data boundary via gates and the gate ladder. There is no parallel permission system. Deploying to production is a gate, not a checkbox.

**4. Gates fail closed.**
In Basecamp this is not a preference. An operational tool whose access checks fail open is worse than no tool.

**5. Destructive actions require an explicit, typed confirmation.**
Provisioning, restoring, rotating, and destroying are not one-click. The friction is the feature.

**6. Live by default.**
Basecamp uses the channel and event system like any other FJS application. A deploy in progress updates every open Basecamp without a refresh. No polling, no parallel sync mechanism.

**7. Secrets are held, never shown.**
Basecamp orchestrates the secrets appliance. It does not become a second store of secret values, and it does not log them, echo them, or render them.

---

## Open Questions

Recorded honestly rather than resolved prematurely.

- **Domain placement.** Rename Domain 7, split it, or accept that Basecamp spans domains. Determines what Basecamp may absorb next.
- **The appliance noun.** Blocking, because it appears in the UI the moment installs ship.
- **Self-hosted or managed.** Basecamp is a tool developers run themselves — but a fleet tool that is itself part of the fleet has a bootstrapping problem. Who deploys Basecamp?
- **Outpost or SSH-only.** Does Basecamp push over SSH, or does each server run an **Outpost** that reports back? Push is simpler and keeps servers dumb; an Outpost makes health and logs far better. This choice constrains everything in the Know group. **The name is settled and the architecture is not** (`FJS-D29`): *Outpost* is reserved for the resident process if there is one, and the word *agent* is retired here because FJS will have AI agents. `IDEAS/deploy-plane.md` argues for keeping both — Outpost as the design, SSH as the degrade path — and notes that the schema (`outpostVersion`, `lastHeartbeatAt`, `installing`) and both engines have already chosen.
- **Multi-user and teams.** The gate ladder handles *what level*, but a fleet tool needs *which projects*. Record-level authorization is deferred to Litestone V2 — Basecamp is likely its first real consumer, and may be what forces the timeline.
- **Where observability data lives.** Basecamp surfacing signals is settled. Basecamp *storing* time-series data is not, and pulls it toward becoming an APM.

---

## The Measure

The same one as the rest of the framework:

> *Does this close an accidental gap, respect an intentional one, and leave the model smaller than it found it?*

The gap between what a project declares and what is actually running is accidental. Basecamp exists to close it.

The gap between building an application and operating a fleet is intentional. Basecamp exists on one side of it and must stay there.

---

*FrontierJS — Basecamp. Aspirational document. Nothing here is committed.*