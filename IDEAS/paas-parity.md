---
id: paas-parity
status: proposed
dated: 2026-10-06
---

# Idea — PaaS parity: what a self-hosted PaaS does that Basecamp does not

**Status: IDEA.** Basecamp was compared against [HivePaaS](https://github.com/hivepaas/hivepaas)'s
feature list on 2026-10-06 by reading the code (schema, services, jobs, outpost). Nothing
was run, so *absent* here means no code path was found.
HivePaaS is a Go control plane with a gRPC agent, Docker Swarm, Traefik v3, Postgres, Redis,
Kopia and VictoriaLogs; it is Apache-2.0. It is the nearest current shape of what
`VISION.md` calls "FJS's Coolify".

**Before building any row, read `packages/basecamp/docs/VISION.md`.** Basecamp is "not a
hosting platform" and "never grows a capability `fli` cannot also perform". So a build,
a terminal or a log store is implemented in `fli` and Outpost first, and Basecamp calls it.
A row that only fits as a Basecamp-only feature belongs in *Not taken*.

---

## Filed as issues

These are the gaps that keep Basecamp from being a PaaS at all.

| Gap | Row |
| --- | --- |
| Nothing builds an image from a git source | [FJS-1496](../ISSUES.md#fjs-1496) |
| Nothing releases on a git push: `IGit` is a stub and no route takes a push event (blocked by FJS-1496) | [FJS-1781](../ISSUES.md#fjs-1781) |
| No app data is backed up: only Basecamp's own database is | [FJS-1782](../ISSUES.md#fjs-1782) · [FJS-1766](../ISSUES.md#fjs-1766) |
| No OAuth or OIDC sign-in, although `@frontierjs/auth` ships it | [FJS-1783](../ISSUES.md#fjs-1783) |
| A `Domain.redirectTo` is routed on no machine | [FJS-1615](../ISSUES.md#fjs-1615) |
| Nothing probes a deployed URL | [FJS-1557](../ISSUES.md#fjs-1557) · [uptime-monitoring.md](uptime-monitoring.md) |

## The rest, in rough order of value

1. **Pull-request previews.** `EnvironmentTier` already has `preview`, but nothing creates
   a preview environment on a PR or tears one down on merge. This needs FJS-1781's push
   route plus a PR-event branch, an environment cloned from the target, and a generated
   hostname. Blocked by FJS-1781.
2. **Log history.** Outpost's `POST /logs` returns a bounded tail of `docker logs`, so
   anything older than the tail is lost. The owner question is where the logs live:
   the machine, Basecamp, or a store reached through an adapter (`ADAPTERS.md`'s
   `/observability/` already waits on one). HivePaaS makes VictoriaLogs optional, and that
   is the shape to copy. Read `logbook.md` first: it already capped the container log and
   owns what an app writes to stdout.
3. **A terminal into a container.** It runs `docker exec -it` over the signed command
   channel. The command channel is request/response today, so this needs a streaming
   route on Outpost and a socket through Basecamp. Grade it at least as high as a
   secret write, and record each session in the audit trail. `fli` gets the same path
   first (`fli app:shell`).
4. **Per-route edge policy**: basic auth, an IP allowlist and a rate limit per hostname.
   Each one is a Caddy directive on the route `ingress.js` already writes, so this is a
   few `Domain` columns plus Outpost's route builder. Wildcard certificates are a separate
   question: `fleet-ingress.md` D6 turned them down because they need a DNS token on every
   machine.
5. **Per-container metrics.** `vitals.js` reads `/proc` for the machine. The per-app
   figure would come from `docker stats` on the same report tick, as a series keyed by
   app, so the existing `AlertRule` and dashboard widgets cover it unchanged.
   HivePaaS's eBPF route metrics are out of reach and out of scope (VISION: "not an APM").
6. **More blueprints.** The catalog has 8 entries against HivePaaS's 300+. The bottleneck
   is not entries: it is that a blueprint is one container with no companion service, so
   an app that needs Postgres beside it cannot be expressed. Fix the shape first, and
   consider importing from an existing template catalog after that.
7. **Clone an app and export or import it.** A clone copies an App with its Variables and
   Domains into another environment (secrets re-encrypted, hostnames left blank). Export
   and import are the same structure written as a file.
8. **Replicas and autoscaling.** `AppServer` already records placements with a
   `replicaIndex`, but nothing sets a replica count and nothing balances across replicas.
   A count is the first step. Autoscaling depends on per-container metrics (5) and on a
   balancer in front of the replicas, so it comes last.
9. **Functions.** `AppType.function` deploys exactly like `container` (an image is
   required). HivePaaS gives a handler-only path where the platform supplies the image.
   The FJS version would be an image template per runtime, built by FJS-1496's build.
10. **A hosted registry.** `/registry/` mirrors an outside registry. A private registry
    (zot or `registry:2`) installed on a `build` server would let a multi-machine fleet
    build once and pull a digest, which is what `deploy-plane.md`'s build-once-promote
    asks for.

## Already ahead of HivePaaS

These came out of the same comparison. Keep them when rows above are built.

- **Alerting**: alert rules with firing and resolved events (HivePaaS has none).
- **Dashboards and feature flags.**
- **Server provisioning**: Hetzner and DigitalOcean.
- **DNS**: Cloudflare.
- **Operations**: recipes, disk cleanup, trash.
- **Declared state machines** on `Server`, `Deployment` and `Job`.
- **Digest-addressed releases** that put the previous container back when a release
  fails its health check.

## From SST

[SST](https://sst.dev/docs/) is a different kind of tool: TypeScript infrastructure-as-code
on Pulumi that wires managed cloud services (Lambda, S3, RDS) for an app, instead of
hosting the app itself. Most of it does not apply to a framework that owns the
server. It was compared on 2026-10-06 against `fli deploy` and its docs; nothing was run.
Four of its ideas carry over:

1. **An environment is a name, not one of three.** `resolveTarget` in
   `packages/cli/commands/deploy/_module.md` knows `dev`, `stage` and `production`
   only. An SST stage is any string, and by default each developer gets one named after
   them. A PR preview (row 1) is then just an environment named `pr-42`, so `fli` needs
   named environments before Basecamp can create previews. Basecamp's `Environment`
   already has the shape: `name`, an immutable `slug`, a `tier`
   (`development … production`) and `isProtected`. So `fli`'s three names are really
   tiers, and `fli` should adopt that shape rather than invent a second one. Under
   SQLite an extra environment costs one file, a port slot and a hostname, so this is
   cheaper here than in SST.
2. **Removal is a command.** `sst remove --stage x` tears down everything that stage
   created. `fli deploy` has `pause` and `rollback` but nothing that removes an
   environment. Without it, previews pile up. Build the teardown alongside named
   environments, not after them. Removing an environment deletes its database, so it
   refuses a `production` tier or an `isProtected` environment.
3. **Linking: one declaration both grants access and supplies a typed value.**
   `link: [bucket]` attaches the permission and exposes `Resource.Bucket.name` to the
   code, so nothing is copied into an env var by hand. FJS has parts of this: Conduit
   targets hold a credential reference rather than the secret, and `fli env` edits one
   dotenv file per environment. What it lacks is the typed read: a value the app needs
   from its deployment (the web origin, a credential ref) is still an untyped env
   string. Before a row is opened, check whether boot refuses a missing value. If it
   only fails on first use, that is the defect. Run `decision-rules` before coining a
   noun for it, since `Conduit` may already be the owner. Keep SST's shape but not its
   word: in SST a linked thing is a "Resource", and in FJS that name belongs to the
   UI realm.
4. **Generated infrastructure gets a `transform` escape hatch.** Each SST component sets
   defaults and accepts a callback that edits the underlying resource. Row 4 currently
   adds one `Domain` column per Caddy directive. The alternative is a few columns plus
   a raw route fragment that Outpost appends, so the next directive needs no schema
   change. A fragment is untyped input, and a bad one takes down every route on the
   machine, so Outpost must refuse any fragment `caddy validate` rejects before the
   swap. Nothing does that today. *Paved road vs. the workaround* applies: a fragment
   that keeps reappearing is the signal to make it a column. Price both options before
   building row 4.

## Not taken

- **SST's serverless model** (Live Lambda, `sst dev` proxying to the cloud, Pulumi state).
  Junction runs only on Bun and keeps its database on a local disk, so it has no
  Lambda shape to target.
- **Swarm or Kubernetes as the orchestrator.** A fleet machine runs Outpost, `docker run`
  and the Caddy that `FJS-D564` puts there, and none of it assumes a cluster. Replicas (8)
  grow inside that shape. Adopting an orchestrator would be a ruling, not a row here.
- **Postgres and Redis as the control plane's state.** Basecamp is an FJS app on Litestone.
