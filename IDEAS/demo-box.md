---
id: demo-box
status: proposed
dated: 2026-10-26
---

# Idea — the demo box: a 24-hour Basecamp anyone can try

**Status: PROPOSED. Nothing is built.** Probed against the tree 2026-10-26.
Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-10-26): a server where ten to twenty strangers at once
can try Basecamp — sign up, create apps, deploy them — and are told up front it
all vanishes in 24 hours. Otherwise it is the real thing. The questions are what
shape it takes and how big a box it needs. A second thought the same day: the
website shows them "running" `fli basecamp:create <name>` step by step and ends
with a link to their own subdomain.

---

## What exists (probed 2026-10-26)

| Piece | State |
| --- | --- |
| The tenant | `Workspace` is the tenant: `tenancy { strategy row column workspaceId claim workspaceId }` (`packages/basecamp/db/schema.lite`), resolved per request from `WorkspaceMember`, never from `Host`. `WorkspaceType` is `personal team enterprise`; status `active` or `suspended`; `@@softDelete(cascade)`. |
| Per-app limits | `App` carries `cpuLimit`, `memLimitMb`, `exposesPort`, `volumePath`; Outpost passes them to Docker and `verify-outpost.mjs` reads them back off `docker inspect`. |
| Builds | A git-source release is built **on the machine that runs it** (`deployment-run.job.ts` → Outpost `/build`); a registry release is pulled. `fli basecamp:deploy` builds on the laptop and ships the image over ssh. |
| Expiry precedent | `ApiKey` derives `expired` from `expiresAt`; `Invitation` throws `Gone` past its date. Suspension is refused once, in `scopeToWorkspace` (`api/src/core/hooks.ts`), the hook every scoped service runs. Recurring sweeps live in `jobs/retention.job.ts`. |
| Sandboxes | `IDEAS/sandboxes.md` (a tenant with a parent) already holds the open bullet *Expiry, and who cleans up*. This paper answers that bullet rather than growing a sibling. |
| A box | `fli basecamp:create` buys one at DigitalOcean (Hetzner is `hetzner-host.md`, Phase 1 done), `basecamp:install` puts Basecamp on it, `--outpost` enrolls the box in its own fleet so apps run beside it. `confirm: human` — it cannot run unattended. |
| Subdomains | Junction can resolve a tenant off the request subdomain (`TenantResolution { kind: 'subdomain' }`), but Basecamp does not use it. Nothing routes `<name>.demo.<domain>` today. |

---

## The shape

Two shapes were weighed with `decision-rules`; A passes, B fails on owner and
proportion.

- **A — one shared Basecamp, one Outpost, a demo Workspace per visitor.** The
  visitor is a `Workspace` row of a new type `demo` with an `expiresAt`. Their
  apps run as containers on the shared Outpost under their subdomain. A leaked
  demo is a row. Expiry is the existing hook plus the existing sweep.
- **B — a whole Basecamp per visitor.** `basecamp:create` per sign-up. A stranger's
  click bills the owner's cloud token, the box takes minutes, twenty of them idle,
  and nothing indexes the fleet of Basecamps — a demo Basecamp cannot destroy
  itself, since `server-destroy.job` runs inside the Basecamp that made the box.

**A is the proposal.** `frontier-cloud.md` § The claim says it for the product:
one more tenant is a file, not a server. B reopens only if the demo must show
*provisioning itself*; then it is `hetzner-host.md`'s `--cloud` under a budget
cap, not a Basecamp per visitor.

**There is one box.** That is the noun this file is named for: `demo-1`, a
Basecamp with its Outpost enrolled, rebuilt from scratch on a schedule because it
is cattle. The per-visitor noun is a **demo Workspace**, never a demo box.

## What a visitor gets

Not "just an Outpost". An Outpost is the daemon on a machine; nobody links to
one. The link lands on **their Workspace** in the shared Basecamp — the same
screens, the same `fli` against it, the same deploy — and the apps they deploy
answer at `<app>.<name>.demo.<domain>`, run by the shared Outpost under the
`demo` limits. Everything a demo cannot do is refused by the Workspace's type,
not hidden from the screen (§ The gate).

## The front door

The owner's picture: the site shows a terminal running `fli basecamp:create
<name>`, steps tick past, and the last line is the link. The one rule is **the
terminal shows what ran.** A developer's first move is to run the printed
command, and `basecamp:create` buys a box, which this does not. So either the
site runs a real command and streams its real steps, or it shows a sign-up and
no prompt. The real-command version:

```
$ fli basecamp:demo acme
  workspace   acme ........................ created
  member      you@example.com ............. owner
  subdomain   acme.demo.frontierjs.dev .... routed
  expires     2026-10-27 14:02 UTC ........ in 24h
  open        https://acme.demo.frontierjs.dev
```

Each line is a step of one job, streamed as it completes — the shape
`deployment-run.job.ts` already has (`pending → building → …`). The verb is its
own (`basecamp:demo`) rather than a flag on `create`, because a flag that makes
`create` not create is a lie with a shorter spelling. The command is real: the
owner can run it from a laptop against the demo Basecamp, and the site's page
is a client of the same job.

## Sizing — builds dominate, running is nearly free

From `IDEAS/speed-and-footprint.md` and prior Docker builds of `example/`; the
numbers are to be replaced by Phase 0's measurements.

| Thing | Cost |
| --- | --- |
| One FJS app at rest | Bun 70–200 MB RSS, idle CPU near zero |
| One build on the box (`bun install` + vite) | 1–2 GB RAM peak, 1–2 vCPU for 1–3 min, 0.5–1 GB disk per image plus layer cache |
| 20 visitors × 1–2 apps, resting | 4–8 GB RAM |
| 3 builds at once | +4–6 GB RAM, ~6 vCPU |

So **8 vCPU / 16 GB / 160+ GB disk** carries twenty visitors with builds capped
at three at a time; ten fit 4 vCPU / 8 GB. Hetzner CPX41, or CAX41 (ARM — only
if builds happen on the box, since a laptop-built amd64 image cannot run there,
`hetzner-host.md` § Three traps); DigitalOcean `s-8vcpu-16gb`. Prices are from
memory and Phase 2 reads the catalog. Per demo App: `memLimitMb 512`,
`cpuLimit 0.5`, `exposesPort false`, no `volumePath`.

Two things change the size by half: **who builds** (Q4) and whether Outpost
**serializes builds** today, which is unverified and is step 0.3.

## The gate — what a demo refuses

Open sign-up plus arbitrary `docker build` is a miner farm by the second day,
and the Hetzner abuse desk powers a box off before it emails. Caps make it
survivable; the gate makes it boring. A `demo` Workspace refuses, by type,
at the owner of each refusal:

- **`servers.provision`, `Secret`, ingress zones, backup destinations** —
  otherwise a visitor buys boxes on the shared Basecamp's cloud token, which is
  shape B's bill one hop in.
- **Outbound mail** — Conduit in sink mode; `sandboxes.md` § The line nobody else
  can write: *a sandbox that can send a real email is not a sandbox*.
- **Egress** — the box firewalls 25/465/587 and rate-limits outbound; no
  `exposesPort`.
- **Sign-up** — one identity per demo (Q5), per-IP cap, and a seat count: the
  job refuses a new demo past N live ones rather than degrading everyone's.

Expiry is **derived, never stored**: `expiresAt <= now` is `Gone` at
`scopeToWorkspace`, one line beside the suspended refusal, and the sweep in
`retention.job.ts` soft-deletes (cascade) what is past, stopping its containers
through the same path a deleted App takes. No `expired` enum value.

## Open questions

- ~~**Q1 — The per-visitor noun.**~~ **Answered 2026-10-27 (`FJS-D1537`): A — `WorkspaceType` gains `demo`; `expiresAt DateTime?` with a check that it is set exactly when the type is `demo`.** Where a demo's identity and its clock live.
  - **A** — `WorkspaceType` gains `demo`; `expiresAt DateTime?` with a check that
    it is set exactly when the type is `demo`.
  - **B** — a `Demo` model pointing at a Workspace.
  - **Recommend A** — expiry precedent (`ApiKey`, `Invitation`) puts the date on
    the row it governs, and `demo` is a type the hook already reads.
- ~~**Q2 — The terminal.**~~ **Answered 2026-10-27 (`FJS-D1538`): A — `fli basecamp:demo <name>`, a real command whose job the page streams.** What the demo page's prompt shows and what it runs.
  - **A** — `fli basecamp:demo <name>`, a real command whose job the page streams.
  - **B** — a sign-up form, no prompt shown.
  - **C** — the animation of `basecamp:create` as pictured, with a box bought by
    nobody.
  - **Recommend A** — C is the one thing a developer tests first; B drops the
    idea's charm for nothing A does not keep.
- ~~**Q3 — The subdomain.**~~ **Answered 2026-10-27 (`FJS-D1539`): A — Caddy wildcard to the one SPA; the shell reads the first host label and opens that Workspace (`/w/<slug>`), so the Data realm is untouched.** How `<name>.demo.<domain>` reaches the Workspace.
  - **A** — Caddy wildcard to the one SPA; the shell reads the first host label
    and opens that Workspace (`/w/<slug>`), so the Data realm is untouched.
  - **B** — junction's `subdomain` tenant resolution, making Host the claim.
  - **C** — a path, `demo.<domain>/<name>`.
  - **Recommend A** — cosmetic, one wildcard certificate, and B changes how every
    Basecamp resolves a tenant for a demo's sake.
- ~~**Q4 — Who builds.**~~ **Answered 2026-10-27 (`FJS-D1540`): A — the visitor is a developer with `fli` and the laptop builds; the box only runs, and halves.** Whether the box builds, or only runs.
  - **A** — the visitor is a developer with `fli` and the laptop builds; the box
    only runs, and halves.
  - **B** — the box builds git sources, so a browser-only visitor can deploy
    (`prompt-to-app.md` is the far end of this).
  - **Recommend A** — it is what ships today, and B's seat count follows from
    Phase 4's numbers; B reopens as its own question then.
- ~~**Q5 — The sign-up gate.**~~ **Answered 2026-10-27 (`FJS-D1541`): A — GitHub sign-in (Basecamp's OIDC path, `verify:sso`).** What a visitor does before the job runs.
  - **A** — GitHub sign-in (Basecamp's OIDC path, `verify:sso`).
  - **B** — email verification.
  - **C** — invite code from the site.
  - **Recommend A** — one account per demo, and the audience is developers.
- ~~**Q6 — After 24 hours.**~~ **Answered 2026-10-27 (`FJS-D1542`): A — gone, with a "keep it" link that is `frontier-cloud.md`'s conversion.** What the clock does when it runs out.
  - **A** — gone, with a "keep it" link that is `frontier-cloud.md`'s conversion.
  - **B** — extendable once.
  - **Recommend A** — the clock is the honest part of the pitch, and the keep
    link is the product.

---

## Plan

### Phase 0 — Measure before sizing

Goal: every number in § Sizing is measured, not remembered, and the six questions are ruled.
Done when: the table carries readings from `dev:outpost`, and Q1–Q6 cite rulings.

- [ ] 0.1 Deploy `example/` through `dev:outpost` on this laptop and read RSS at rest, build seconds, image MB and layer cache MB off `docker stats` and `docker system df`
- [ ] 0.2 Open a Workspace from the first Host label in the SPA by hand (Q3 A) and note what the shell needs
- [ ] 0.3 Read whether Outpost runs builds one at a time or all at once; if all, note the cap's owner
- [x] 0.4 Rule Q1–Q6 in `DECISIONS.md` (`FJS-D1537`–`FJS-D1542`)

### Phase 1 — A demo Workspace

Goal: a Workspace that expires, refuses what a demo must, and sweeps itself.
Done when: `services.test.ts` has a scoped call on an expired demo answering `Gone`, a `retention.job` test counting swept demos, and a demo calling `servers.provision` refused by type.

- [ ] 1.1 `demo` in `WorkspaceType`; `expiresAt` on `Workspace` with its `@@check`
- [ ] 1.2 `Gone` at `scopeToWorkspace` when `expiresAt` is past, beside the suspended refusal
- [ ] 1.3 `retention.job.ts` sweeps expired demos: soft-delete cascade, containers stopped through the App path, a count row
- [ ] 1.4 The gate: `demo` refuses provision, secrets, ingress zones, backup destinations and outbound mail, each at its owner
- [ ] 1.5 Demo App defaults — `memLimitMb 512`, `cpuLimit 0.5`, `exposesPort false`, `volumePath` refused — set where an App is created, not where it runs
- [ ] 1.6 Seat count: the demo job refuses past N live demos

### Phase 2 — The box

Goal: `demo-1` exists, answers on a wildcard, and cannot hurt anyone.
Done when: `https://<name>.demo.<domain>` opens a demo Workspace over a valid certificate, SMTP egress is refused from inside a container, and a prune runs nightly.

- [ ] 2.1 `fli basecamp:create` + `basecamp:install --outpost` for `demo-1` at the size § Sizing settles on, reading the live catalog
- [ ] 2.2 `*.demo.<domain>` at Cloudflare through the DNS pane; the wildcard certificate — DNS-01 on this one machine (the control plane, so `fleet-ingress.md` D6's objection does not apply) or Cloudflare's proxy with an origin certificate
- [ ] 2.3 Egress firewall on the box: 25/465/587 closed, outbound rate-limited
- [ ] 2.4 Nightly `docker system prune` and a weekly rebuild of the box from 2.1, scripted
- [ ] 2.5 Build concurrency cap at the owner 0.3 named

### Phase 3 — The front door

Goal: the site runs the real command and lands the visitor in their Workspace.
Done when: a stranger with a GitHub account reaches their demo from the site in under a minute, and the terminal on the page shows only lines the job emitted.

- [ ] 3.1 `fli basecamp:demo <name>` and its job: workspace, member, subdomain, expiry — each a streamed step
- [ ] 3.2 The site page: sign-in (Q5), name, then the job's steps rendered as a terminal, the link last
- [ ] 3.3 The banner in the SPA: "expires in Nh", with the keep link (Q6)
- [ ] 3.4 A seeded first app in every demo, so the first screen is not empty

### Phase 4 — Twenty at once

Goal: the box holds the stated load.
Done when: a script spawns 20 demos, each deploying `example/`, and the box stays under 80% RAM with p95 build time recorded and the seat count set from it.

- [ ] 4.1 The load script, from a laptop, against `demo-1`
- [ ] 4.2 Resize or recap from the numbers; write the final seat count into 1.6
