---
id: frontier-cloud
status: partial
dated: 2026-09-27
---

# Idea — Frontier Cloud: paid hosting over the fleet FJS already runs

**Status: PARTIAL — steps 1 to 3 are built; nothing is built as a product.** Dated 2026-09-27. Do not
cite this file as behavior — see `VERIFYING.md`. It is a sustainability proposal,
not a framework feature: the framework stays MIT and the plane is what is sold.

**The question:** which part of FJS can be charged for without paywalling the
framework, and when is it ready to be?

---

## The claim

Outpost, the deploy plane (build once, promote a digest — `deploy-plane.md`) and
Basecamp as the fleet app are most of a hosting product already. SQLite gives
cheap per-tenant isolation, so the unit cost of one more app or tenant is a file,
not a server.

## What would be charged for

- **Managed backups and point-in-time restore of the `.db` files.** Basecamp's
  `backups` service writes `local` only today and refuses `s3`; `litestone restore`
  is owed under `FJS-552` and its verify half is `FJS-D477` in `owed-rulings.md`.
- **Promote and roll back by digest, with the audit trail included.** The digest
  and the journal have shipped; the promote half is `deploy-plane.md`'s unbuilt one.
- **Homestead offline sync as a metered service** — the differentiator, since
  almost no host sells it. Engine state is `homestead.md`.
- **An MCP agent endpoint for each app, governed by the gate, as an upsell** —
  `@frontierjs/mcp`, `FJS-D258`.

Pricing unit: per app or per tenant.

## The gate

**Not before three of our own apps run on it.** The plane has to have hosted
paying clients' work before a stranger pays for it. Nothing enforces this gate —
it is a judgment, recorded here so it is not skipped by accident.

## What stays free

Every Invariant. Gates, `@encrypted`, the audit trail and self-hosting the plane
remain MIT — relicensing core or paywalling an invariant costs the trust the
funnel depends on.

## Sequence

**Steps 1–6 are owed to our own apps whether or not anything is ever sold.** A
client app on FJS needs a backup that comes back, a deploy that rolls back, and a
server nobody SSHes into by hand. The product is step 7 onward, and it is thin
because the first six were built for ourselves.

State below was read from the tree on 2026-09-27; re-probe before starting a step.

| | Step | Effort | What exists | What is owed | Done when |
| --- | --- | --- | --- | --- | --- |
| **1** | **Replicate every file an app writes — BUILT for tenant files** | S | `litestone replicate`/`backup` now cover `strategy database`'s tenant files and registry (`FJS-1389`); `example` `verify:replicate` streams to a real S3 API, restores, and compares | `jobs.db` and stored files (`FJS-1391`); the key demand (`FJS-1392`); pointing a real app at a real bucket, when there is one | `verify:replicate` green, and `deploy:doctor` clean on the first client box |
| **2** | **The way back — `litestone restore` — BUILT** | M | `litestone restore` (`FJS-552`, `FJS-D477` A): every target `replicate` streams, all or nothing, `--at`, `--from-backup` for the logger trail; `verify:replicate` drives it | — | A real client database restores from its bucket into a scratch dir and the app boots on it |
| **3** | **Restore drills — BUILT** | M | `litestone restore --verify <dir>` (`FJS-1395`, `IDEAS/restore-verify.md`): schema-derived checks, key optional and loud when absent, every tenant | A cron line per app until step 5 | A scheduled `--verify` per app exits 0, and a failed one is noticed |
| **4** | **Outpost on a real machine** | M | Real daemon, local: `verify:docker` drives the process against this machine's Docker (`FJS-1398` found and fixed); basecamp `verify:outpost` enrolls a real Outpost and releases an INLINE app and a CONTAINER app through it — `/pull` → `/deploy` → `/health-check` on the real daemon (`FJS-1418` found and fixed: an image app's release never named its image). Per-machine keys: every machine enrolls for its own and the fleet-wide `OUTPOST_SECRET` is gone from basecamp (2026-09-08, `docs/PROVISIONING.md` P3/P5) | A real VPS installed by cloud-init with an enrollment token (`FJS-D241` — a provisioned machine is never reached over SSH; an imported one runs the pasted install), the network and a provider | One client server enrolled and heartbeating in Basecamp |
| **5** | **App backups in Basecamp** | M | A `backups` service for Basecamp's OWN database — `VACUUM INTO`, `local` only, `s3` refused, no restore | Per-app: replication status per `App`, an `s3` target, and restore as an Outpost command (stop → `litestone restore` → start), since restoring under a live process is what Basecamp refuses for itself | Restore an app from the Basecamp screen, drill result shown beside it |
| **6** | **Build once, promote a digest** | L | Digest stamped and recorded (`deploy-plane.md` step **a**); `Deployment.builtImage`/`toImage` | Steps **b** (build off the target) and **d** (Outpost-driven deploy) | Stage and prod run the same digest; rollback by digest from Basecamp |
| **7** | **The gate: three of our own apps on it** | — | — | Move client apps (maid.tech, ELA) from `fli deploy` onto the plane | A month of deploys, backups and drills with no hand SSH |
| **8** | **Productize** | L | Basecamp's `Workspace` tenancy; the billing phases built in `example/` (`IDEAS/billing.md`) | Workspace = customer; metering per app/tenant; the billing rig lifted out of `example/`; the paid/free ruling and the rename below | A stranger signs up, deploys, is billed |
| **9** | **Upsells** | L | Homestead (`homestead.md`), `@frontierjs/mcp` | Sync metered per tenant; an MCP endpoint per hosted app | Each has one paying user |

**2 before 5.** Basecamp's restore is an Outpost running `litestone restore`, so
building a Basecamp-only restore first would make two ways back — the second
owner `FJS-552` exists to prevent.

**4 is the riskiest line.** Nothing has run Outpost against a real daemon, and
every step after it assumes it works.

## Open before this could move

- **Where the paid/free line sits** for the plane itself: is self-hosted Basecamp
  free and the managed instance paid, or is the plane source-available?
- **Names.** *Basecamp* is a 37signals trademark in the same software category,
  and *Oracle* is Oracle's; a paid product cannot ship under either.

## Related

The nearer revenue path — client apps built on FJS with a monthly care plan — needs
none of this and is what would put the first three apps on the plane.
