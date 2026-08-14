# Idea — The deploy plane: build once, promote a digest, and how the plane itself arrives

**Status: IDEA / ARCHITECTURE. Nothing here is built.** Dated 2026-08-13. Produced by
grading the shipped `fli deploy` pipeline against the twelve-factor build/release/run
split, then following the one failure that is *not* forced by an architectural choice
FJS has already made deliberately.

This does not replace `IDEAS/release-transitions.md`, which asks **what a Release is
and what a deploy may promise**, nor `IDEAS/offline-first-and-release.md`, which asks
**what kinds of artefact a Release can be**. It answers the two questions both leave
open: **who builds the artefact and where it lives**, and **how the thing that
promotes artefacts gets installed in the first place**.

---

## The grading, briefly

Against twelve-factor the shipped pipeline is stronger than most of the field on the
factors that are usually faked and weaker on one that is usually free.

**Genuinely strong.** Dev/prod parity is the best thing in the repo: `bun run ci` is
one node script that runs identically on a laptop and in the workflow, `fli check`
shares its engine with CI's `structure` phase, and `fli deploy:local` runs *the same
Dockerfile and the same entrypoint* a real deploy runs. Config is env vars with
`01b-env-check` diffing the server's file against `.env.example` and aborting before
anything moves — that is better than the factor asks for. Logs go to stdout, JSON
under `NODE_ENV=production`, with the file writer an opt-in adapter. One-off admin
work runs in the deployed image via `fli deploy:run`.

**Deviates on purpose, and says so.** Backing services, stateless processes and
scale-out concurrency all fail, and all three fail for one reason: SQLite on local
disk. The database is a bind mount rather than an attached resource, channels hold
socket state in memory, and the deploy lock is a file on the server. `06-swap`'s own
comment names the trade — *"a brief gap (3-10s)… the correct tradeoff for SQLite"*.
That is a chosen ceiling, not drift, and the rest of this document assumes it stands.

**Deviates by accident.** Build, release and run are not separated, and nothing about
SQLite requires that.

---

## The finding

**Every environment builds its own artefact, so no two environments provably run the
same bytes.** The pipeline pulls source on the target server, runs `bun run build`
there, and runs `docker build` there. Dev, stage and production each execute that
independently. What is promoted between them is a git ref; what actually runs is
whatever three separate builds produced from it.

Four consequences, in rising order of how much they cost:

**The build toolchain must live on every production box.** Bun, the source tree and
a Docker daemon with build access, on the machine serving traffic.

**A build failure happens after the deploy lock is taken.** `01-preflight` acquires
`{serverPath}/.deploy.lock`; the build is steps 03 and 04. A compile error therefore
costs a held lock and an operator who has to know that removing a lock file is safe.

**Rollback restores a container, not a known artefact.** `07-health` renames and
restarts `_replaced`, which is genuinely the right mechanism — but the thing it
restores is *the previous build of possibly-the-same source*, and the image it would
otherwise fall back to is a tag rather than a digest.

**The image tag is not unique, and Docker will believe it.** `02-pull` sets
`imageTag = ${appId}:${shortSha}` from the SHA of *the target server's own checkout*.
Two servers at the same commit hold two images with the same name and different
bytes; the same server rebuilding after a dependency change produces a third. Nothing
in the pipeline compares them, and the failure mode is the worst available shape —
stage and production reporting the same version while running different code.

That last one was reachable in a sharper form until this session: **the pipeline
never ran `bun install` at all** (fixed, `packages/cli/CHANGES.md`). The API side was
covered by accident because its Dockerfile installs inside the image; web built
against whatever `node_modules` the server was carrying.

**The pipeline's advertised path has also never been run end to end.** `fli
make:deploy` writes a Dockerfile against a layout `fli new` does not produce —
`FJS-232`. Worth stating plainly here because it is evidence about the whole seam,
not one bad template: nothing has forced these two commands to agree.

---

## What to do instead

**Build once, address by digest, promote the digest.** The artefact is produced in
one place, named by content, and every subsequent environment transition references
that name and never rebuilds. `fli deploy` becomes pull-tag → swap → health, which
is most of what steps 05–09 already do.

Three things follow, and only the first is real work.

**A builder needs somewhere to stand.** `fli` is a laptop CLI, so building locally
trades server drift for developer-machine drift, which is worse. The builder has to
be a machine with an identity and a lifecycle — which Basecamp already models:
`ServerRole` has a `build` member.

**Distribution does not have to mean a registry, but identity does.** FJS's bet is
portable and self-hosted — *"No registry required — image lives on the server"* is
written into the scaffolded Dockerfile's own header, and that instinct is right. The
mandatory part is the **digest**; how the bytes travel is a strategy. A registry is
the simplest and adds a dependency; `docker save | ssh docker load` needs no new
infrastructure and works today; a content-addressed store on the Basecamp host is
the middle option and the one that fits the fleet story. Keep all three, make none of
them the definition. **What may not vary is which bytes ran.**

**`deploy:local` becomes exact rather than merely faithful.** Today it proves the
same Dockerfile works. Under build-once it can run *the digest that will be promoted*,
which turns "it passed locally" from an argument into a fact.

**This is the build half of `release-transitions.md` 2.3b.** That row specifies a
content-addressed Release as image ⨯ config values ⨯ secret references ⨯ schema
version ⨯ declared pivot, and assumes the image term is well-defined. It is not yet.
Basecamp's `Deployment` model is further along than the CLI here — it already carries
`builtImage` separately from `fromImage`/`toImage`, which is exactly the distinction
between *what was produced* and *what is being promoted*.

---

## The bootstrap ring

**Basecamp is FJS's Coolify — and a control plane that installs applications cannot
install itself.** The schema has already committed to the harder half of this:
`Server` carries `outpostVersion`, `outpostUrl`, `lastHeartbeatAt` and `registerMethod`,
and `ServerStatus` runs `pending → provisioning → installing → ready` before it ever
reaches `online`. Those are not fields an SSH-push design needs.

**Basecamp's half is already written; the machine's half is not.** `fleet.engine.ts`
resolves an Outpost per server and dispatches through Conduit to `outpost:<server-id>`,
registered on heartbeat, with a stated fallback when none is; `deployment.engine.ts`
forwards each step the same way; `servers.service.ts` accepts the heartbeat and
registers the Conduit target. So the protocol has a caller and no callee — which makes
ring 1 smaller than it looks, and makes the naming urgent rather than cosmetic, since
`outpost:<id>` and the snake_case heartbeat payload are wire contracts nothing speaks
yet (`FJS-D29`).

The two are one question, and separating the rings answers both.

**Ring 0 — `fli deploy` installs Basecamp.** The SSH + Docker + nginx pipeline that
exists today is precisely the right size for exactly one job: put one FJS application
on one Linux box, from a laptop, with no control plane in existence yet. That
resolves what otherwise reads as a rivalry between `fli deploy` and Basecamp. **`fli
deploy` is not a competitor to the fleet tool; it is the fleet tool's installer**, and
it should be scoped and judged by that job — which is also why it does not need to
grow multi-node, blue-green or a scheduler.

**Ring 1 — Basecamp installs the Outpost.** One-shot over SSH, authenticated with a
`Secret` of kind `ssh_key` (already modelled), driving `pending → provisioning →
installing → ready` and writing `ServerEvent` rows as it goes. After the first
heartbeat, SSH stops being the channel and becomes the recovery path.

**Ring 2 — the Outpost deploys applications.** `Deployment` and `DeploymentStep` are
the record; the Outpost is the executor. This is where build-once pays: the Outpost pulls
a digest rather than a source tree, and needs no build toolchain at all.

**The plane never upgrades itself through ring 2.** A control plane that deploys its
own replacement has to survive its own restart mid-transition, and the honest answer
is that it cannot — the process holding the journal is the process being replaced.
Basecamp's own upgrade goes through ring 0. One installer, used twice, and the plane
never holds the knife to its own throat.

**On resident-process versus SSH-push, follow the seed, but let it degrade.** The
schema has chosen a resident process. The failure mode to design against is a fleet
bricked by an Outpost that will not start, so **the absence of a heartbeat must
degrade a server to SSH-managed rather than to unmanageable** — which ring 1 already
requires the code for. `registerMethod` is the field that records which way a given
server arrived.

---

## What FJS has here that Coolify and Forge structurally cannot

A generic fleet tool sees an opaque image and a shell script. Basecamp holds the
`.lite` schema of every application it deploys, which makes two things available for
free that the field cannot offer at any price:

**A deploy can be classified before it runs.** `release-transitions.md` 2.3a reads a
schema diff and answers expand / contract / unknown. Wired into ring 2 that is a
`Deployment` that *knows whether it is reversible* — the exact question every surveyed
rollback button guesses at.

**A fleet action already has the right cardinality.** `RecipeRun` is one row per
server rather than per invocation, with the comment explaining why: a single row for
"three succeeded and two failed" has to pick one status, and that is the answer an
operator most needs. Agent installation across a fleet is the same shape and can
reuse it rather than inventing a second one.

---

## Sequence

| | | Effort | Note |
| --- | --- | --- | --- |
| **a** | **Digest, not tag** — build stamps a digest, `Deployment.builtImage` records it, `deploy:status` shows it, health and rollback address it | S | No new infrastructure; makes the current pipeline honest about what ran |
| **b** | **Move the build off the target** — build on a `build`-role server or in CI, ship by `docker save`/registry/CAS, deploy becomes pull → swap → health | M | Requires **a**; retires the toolchain-on-prod requirement and the lock-held-during-build window |
| **c** | **Ring 1 — Outpost install over SSH** — `pending → installing → ready`, `ServerEvent` trail, `RecipeRun` cardinality, SSH retained as the degrade path | M | Answers VISION's resident-process question by implementing what the schema already declares |
| **d** | **Ring 2 — Outpost-driven `Deployment`** — the Outpost pulls a digest and runs the swap; the pivot classifier (2.3a) grades it first | L | Requires **b** and **c** |

**a** is worth doing whether or not the rest happens, which is the test this file
was written to apply.

---

## Open questions

- **Where the artefact store lives when there is no registry.** On the Basecamp host
  is the obvious answer and makes Basecamp a single point of failure for deploys —
  acceptable for a control plane, but it should be stated rather than discovered.
- **What ring 0 does about the Basecamp database.** `fli deploy`'s SQLite swap window
  is the control plane's own downtime, and it is the one application where somebody
  is likely watching a deploy through the thing being deployed.
- **Whether the Outpost is an FJS application.** If it is, it inherits the whole stack
  on every fleet server, which is heavy for something whose job is to run Docker
  commands and report health. If it is not, it is the first thing in the repo that
  does not derive from a seed.
- **Whether a build-role server is a `Server` row.** Modelling it as one is free and
  makes the builder visible in the fleet; it also means Basecamp's build capacity is
  fleet state, with everything that implies for the tenancy work.
- **How ring 0 and ring 2 stay one implementation.** Two deployers is how a framework
  ends up shipping two behaviours — the same argument `core/checks.js` settled for
  architecture rules. Whether the Outpost can literally reuse `_steps-docker` is the
  question to answer before writing a second one.

---

## See also

- `IDEAS/release-transitions.md` — what a Release is, the pivot, and reversibility
- `IDEAS/offline-first-and-release.md` — which artefact kinds a Release may be
- `IDEAS/operational-edge.md` — the wider operational gap this sits inside
- `packages/basecamp/docs/VISION.md` § Open Questions — the two this proposes to close
- `FJS-232` — the scaffolded Dockerfile does not match the scaffold
