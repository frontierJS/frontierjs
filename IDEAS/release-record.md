---
id: release-record
status: proposed
dated: 2026-11-14
---

# Idea — one release record for both deploy paths

**Status: PROPOSED. 0.1–0.3 done (prior art read, Outpost and both pivot paths probed); Q1–Q4 wait on the owner, Q2 first.**
Probed against the tree 2026-11-14. Do not cite this file as behavior — see `VERIFYING.md`.

This continues `IDEAS/release-transitions.md` (overview row 2.3b). That paper fixed the recorded-state format for `fli deploy`, and its Phase 1 shipped on 2026-08-26. Since then Basecamp started deploying through Outpost and writing release state of its own, in a different shape. A recorded-state format is the one thing that cannot be added later, so the two have to be reconciled before more depends on either.

## The finding — two writers, two formats

`FJS-D746` ruled that the journal lives on the deploy machine, that `fli` is its only writer, and that Basecamp is a reader through the Outpost. That held while `fli deploy` was the only path. Today ELA (chartered) and kapp (yuma) ship through Basecamp → Outpost, and that path writes none of it.

| Term | `fli deploy` path | Basecamp → Outpost path |
| --- | --- | --- |
| Where the record lives | `.fli/deploy.db` on the machine (`packages/cli/db/deploy.lite`) | Basecamp's own db: `Deployment` + `DeploymentStep` (`packages/basecamp/db/schema.lite`) |
| Release identity | `mintRelease` (`packages/cli/core/release.js`): a hash of app, digest, `configurationHash` and schema | None. A `Deployment` row id, `imageSha256` and `commitSha` |
| Configuration on revert | `deploy:revert` refuses once the generation has moved, because `fli` writes no `.env` on a machine | `rollback` restores the target release's `configSnapshot` (`deployments.service.ts`). It never applies today's settings to the old image |
| Secrets on revert | Pinned by reference (the paper's invariant) | A secret is recorded as the id of its `Variable` row (`domain/release/variables.ts`). A rollback after a key rotation runs the new value |
| Configuration generation | A `generation` field beside `configurationHash`, outside the id | `Environment.version` is an `@version` concurrency guard, not a generation. The per-release `configSnapshot` does that job |
| History depth | `FJS-D748` counts, measured by `deploy:status` | `previousDeploymentId` chains every release. Outpost keeps images past a per-repository `keep` count, plus one `_replaced` container |
| Schema pivot | Both doors ask Outpost's classifier (`livePivot`) and run a contract or unknown stop-first. The journal records the verdict, and `deploy:revert` refuses past it by name (`--past-pivot`) | Outpost returns the verdict, and Basecamp stores only `swap` and `swapReason`. A rollback skips the classifier (`FJS-D2044`), and nothing refuses one across a contract up front. The old image's own boot refuses (`FJS-D2041`), and `isRestoringVolume` crosses back at the cost of writes since |

**What Outpost holds alone** (`packages/outpost/src/docker.js`). Outpost keeps the images and the `_replaced` container. It keeps no record of which release ran with which configuration. Basecamp sends the image, the digest and the configuration on every request, rollbacks included. With Basecamp down, the bytes to revert to are on the machine, but nothing there says which release they belong to or what it ran with. A rollback whose image a prune removed refuses by name.

## What 15 systems record (prior art, 2026-11-14)

The August survey in `release-transitions.md` read single-tool deploys (Capistrano, Kamal, NixOS, OTP), which is why its answer was *on the target*. This round asked the question that survey did not: **when a control plane AND an agent on the machine both exist, which side is authoritative, and can the agent revert alone?** Quotes marked ✓ were re-read on the primary page. The rest came through a page summarizer, and *inferred* means nobody read it stated.

| System | Where the history lives | Machine reverts with the control plane down | Config on rollback | Secrets on rollback |
| --- | --- | --- | --- | --- |
| Heroku | Control plane | No | **Restored** ✓ | **Old values** — config vars are its secrets ✓ |
| Dokploy | Control plane: the whole app record snapshotted per release | No | **Restored** (from code) | Current — vault refs resolve at rollback (inferred) |
| Cloud Run | Control plane: immutable revisions | n/a | The revision's own | **Pinned if you pin a version number**; `latest` resolves at instance start ✓ |
| Cloud Foundry | Control plane (CAPI) | No (inferred) | A revision references env vars; restore not stated | — |
| Kubernetes, Argo CD | Control plane (etcd, the Application record) | No | Pod template only | Current — Secret contents are not versioned (inferred) |
| Nomad | Servers | No (inferred) | Job spec only | Current (inferred) |
| Fly.io | Control plane | — | **Current** ✓ | **Current** ✓ |
| Coolify | Control plane; images on the machine | No | **Current** ✓ | Current |
| CapRover | Control plane on the same box | Same box | Current (docs, via a mirror) | Current |
| Kamal | On the machine: old containers, an audit log | **Yes** | Current — rollback re-runs boot, which uploads today's env (code) | Current |
| Dokku | On the machine only, no history | Yes | Current | Current |
| NixOS + deploy-rs | On the machine: generations | **Yes, and the machine decides** (magic rollback on timeout) | Whole generation | What the generation holds |
| Mender | Server, plus A/B partitions on the device | **Yes**, depth 1 | Whole image | Whole image |
| balena | Control plane is the source of truth; the device keeps a local SQLite copy of its target state | Keeps running the last target; offline rollback undocumented | Undocumented | — |

**What it changes, one line per open question:**

- **Q1 — every system with both halves makes the control plane authoritative.** That covers Nomad, Kubernetes, Argo, Cloud Foundry, Fly, Heroku, Dokploy and balena. History lives on the machine only where there is no control plane (Kamal, Dokku, NixOS). An agent reverts alone only where it holds a whole previous image and a local rule (NixOS, Mender), or a local copy of its target state (balena).
- **Q2 — identity is a counter paired with a content hash** (Kubernetes revision + `pod-template-hash`, Argo ID + git SHA, NixOS generation + store path). No PaaS shares a content-addressed id between its control plane and its machine. The recorded split bugs are disagreements about what is running (CapRover #1685 showed v43 while v38 ran; Dokploy #5193's db and live service disagreed), which a shared id makes detectable.
- **Q3 — only Heroku, and Cloud Run with a numbered pin, put old secret values back.** Basecamp already restores configuration, which puts it ahead of Coolify, CapRover, Kamal and Fly. No system addresses what pinning costs: a revert can bring back a key that was rotated out because it leaked.
- **Q4 — no system keeps a configuration generation apart from the release.** Heroku, Cloud Run and Cloud Foundry each mint a new release or revision when configuration changes.
- **Retention — the bound is always a count** (Kubernetes 10, Nomad 6, Heroku 20 releases or 30 days, Coolify 2). What breaks a rollback is the artifact pruned out from under a record that survives: Fly's registry, Cloud Foundry's droplets, Heroku's `expired` releases. Outpost's refusal for a pruned image is that case already named.

**Sources.**
- Heroku: devcenter.heroku.com/articles/releases.
- Fly: docs.fly.io/blueprints/rollback-guide.
- Coolify: coolify.io/docs/applications/deployments/rollbacks.
- Cloud Run: docs.cloud.google.com/run/docs/configuring/services/secrets and …/managing/revisions.
- Kubernetes: kubernetes.io/docs/concepts/workloads/controllers/deployment.
- Argo CD: `pkg/apis/application/v1alpha1/types.go` and argo-cd.readthedocs.io (auto_sync, app rollback).
- Nomad: developer.hashicorp.com/nomad/docs/job-run/versions and …/configuration/server.
- Cloud Foundry: docs.cloudfoundry.org/devguide/revisions.html.
- Kamal: `lib/kamal/cli/main.rb`, `lib/kamal/cli/app/boot.rb`, `lib/kamal/commands/auditor.rb`.
- Dokploy: `packages/server/src/db/schema/rollbacks.ts`, `packages/server/src/services/rollbacks.ts`.
- CapRover: `src/models/AppDefinition.ts`, `src/user/ServiceManager.ts`.
- Dokku: dokku.com/docs/deployment/methods/image.
- deploy-rs: `src/bin/activate.rs` and its README.
- Mender: docs.mender.io/artifact-creation/state-scripts.
- balena: docs.balena.io (update strategies, release policy) and the supervisor wiki.

## Open questions

Rule them in the order Q2, Q1, Q4, Q3. Q2 gives Q1's cache its key, and Q4 settles what the id contains before Q3 pins secrets into it.

- ~~**Q1 — Where is the authoritative release record for an app Basecamp deploys?**~~ **Answered 2026-11-15 (`FJS-D2178`): B — `Deployment` is authoritative for apps Basecamp deploys. Outpost keeps a one-way copy of the last N release records (Release id, image digest, configuration snapshot, secret refs) beside the images it already keeps, so a revert works with Basecamp down. `D746` is amended to cover only `fli deploy`, which has no control plane.** `FJS-D746` says on the machine, written by `fli` alone. Basecamp's `Deployment` is the record in practice.
  - **A** — Outpost writes the same `deploy.lite` journal on the machine, and `Deployment` becomes Basecamp's view of it. `D746` stands as written.
  - **B** — `Deployment` is authoritative for apps Basecamp deploys. Outpost keeps a one-way copy of the last N release records (Release id, image digest, configuration snapshot, secret refs) beside the images it already keeps, so a revert works with Basecamp down. `D746` is amended to cover only `fli deploy`, which has no control plane.
  - **C** — Two records, never synced, joined by a shared Release id (Q2).
  - **Recommend B** — the balena shape. Every system surveyed that has both a control plane and an agent puts history in the control plane. A would make Outpost write a journal that Basecamp then mirrors back, which is two writers for one fact.
  - **What B owes.**
    - **The amendment says why `D746`'s rejection of *in Basecamp* does not apply.** That rejection was *two operators get two histories of one server*. One control plane per machine cannot produce two histories.
    - **The copy is checked, not trusted.** Outpost refuses by name a revert whose cached Release id or digest disagrees with the request or with the image on disk. A stale or pruned copy then says so instead of reverting to the wrong thing.
    - **It retires a rule for this path.** `release-transitions.md`'s *Basecamp is a viewer and a trigger, never the source of truth* was written before Basecamp deployed anything. Its purpose, *a revert works without Basecamp*, is what the Outpost copy keeps.
- ~~**Q2 — Does a Basecamp release carry the same content-addressed Release id as `fli deploy`?**~~ **Answered 2026-11-15 (`FJS-D2171`): A — Yes. `mintRelease` and `RELEASE_FORMAT` move to a package Basecamp, Outpost and `cli` all import, and `Deployment` gains a `releaseId`.**
  - **A** — Yes. `mintRelease` and `RELEASE_FORMAT` move to a package Basecamp, Outpost and `cli` all import, and `Deployment` gains a `releaseId`.
  - **B** — No. Basecamp keeps its row id, and drift grading (`FJS-D740`) and *promote* (`FJS-D636`) stay `fli`-only.
  - **Recommend A** — `D740` splits drift by Release id and `D636` recognizes a promotion by digest, and both are worth most on the fleet path. The mint is one pure function and a format constant. Two things to settle while moving it:
    - **Dependency direction.** The new home must not make `cli` import Basecamp or the reverse (Invariant 1's spirit).
    - **One id test.** It proves both paths mint the same id for the same terms, because a format bump on one side alone would silently split them.
- **Q3 — Does Basecamp adopt `release-transitions.md` invariant 2's pinned secret reference, and what does a revert do when the pinned version is revoked?**
  - **The gap.** Invariant 2 already rules that a Release records a secret as `name@version`, refuses `latest`, and treats a rotation as a configuration change. Basecamp records a bare `Variable` id, which is `latest` by another name. A rollback after a rotation runs the new value.
  - **A** — Adopt it as written. `Variable` keeps versions, `configSnapshot` records the version, and a rollback restores that reference.
  - **B** — Keep today's behavior (current value) and amend invariant 2 for Basecamp. Document it on the rollback screen the way Coolify and Fly do.
  - **C** — As A, plus a rotation marks the version it replaced as revoked. A rollback that would restore a revoked version refuses by name, and the refusal offers *roll back with today's value* as the explicit way out.
  - **Recommend C** — invariant 2 names the risk itself (*a revert can resurrect a credential*) and leaves it unanswered. The revoked marker answers it, so a revert never quietly brings back a leaked key and never runs against a credential the release never saw. Heroku and Cloud Run show pinning works, and none of the 15 systems handles the revoked case.
  - **What C owes.**
    - **Old values are a new store of plaintext.** Keeping superseded secret values means `@encrypted` and audit redaction (Invariants 6 and 7) apply to every kept version.
    - **One sentence in invariant 2 changes.** *Never "the same secret values"* becomes *the same reference, refused by name once revoked*.
- ~~**Q4 — Does the configuration generation stay a counter beside the Release, or fold into the Release?**~~ **Answered 2026-11-15 (`FJS-D2181`): B — Fold configuration into the Release, as the code already does. `generation` leaves `mintRelease`. Order and the readable list are carried by the release sequence: journal rows on `fli`'s side, `Deployment` rows on Basecamp's. `Environment.version` stays a concurrency guard. Invariants 1 and 2 are amended together, with invariant 1 rewritten as `D636` puts it: the digest promotes, and the Release does not.**
  - **The tension.** `release-transitions.md` invariant 2 keeps both: `generation` *for order and for a person reading a list*, `configurationHash` for identity. `mintRelease` already hashes `configurationHash` into the id, so any configuration change is already a new Release. Invariant 1's *a Release is environment-independent and promotes unchanged* no longer describes the code. `FJS-D636` already says *what moves is the digest, not the Release*.
  - **A** — Keep the generation as the paper wrote it, and add it to Basecamp's `Environment`.
  - **B** — Fold configuration into the Release, as the code already does. `generation` leaves `mintRelease`. Order and the readable list are carried by the release sequence: journal rows on `fli`'s side, `Deployment` rows on Basecamp's. `Environment.version` stays a concurrency guard. Invariants 1 and 2 are amended together, with invariant 1 rewritten as `D636` puts it: the digest promotes, and the Release does not.
  - **Recommend B** — none of the 15 systems keeps a configuration counter apart from the release. Heroku, Cloud Run and Cloud Foundry each make a configuration change a new release, and the per-release `configSnapshot` already holds what a generation would point at. A counter beside a hash that already moves is two answers to *did the configuration change*.

## Plan

### Phase 0 — Know

Goal: the two paths' records and the field's precedent, measured before anything is ruled.
Done when: Q1–Q4 are ruled into `DECISIONS.md`.

- [x] 0.1 Prior art: 15 systems read for where the release record lives and what a rollback restores
  - Above. Two research passes on 2026-11-14, with four load-bearing quotes re-read on the primary page (Heroku, Fly, Coolify, Cloud Run).
- [x] 0.2 What Outpost holds with Basecamp down
  - The images and the `_replaced` container, but no record. A rollback's image, digest and configuration all arrive in Basecamp's request (`docker.js` `deploy`, `server.js`).
- [x] 0.3 Is a contract deploy refused on the Basecamp path, as `fli deploy` refuses one?
  - The question's premise was out of date: neither door refuses a contract deploy now. Both run `livePivot` and `swapFor` (`packages/outpost/src/swap.js`) and swap stop-first, and a failed contract stays down (`FJS-D2044`). The paths differ on the way BACK. `fli deploy:revert` reads the recorded verdict and refuses past a pivot by name. Basecamp's `Deployment` never stores the verdict, so its `rollback` cannot refuse up front, and the protection is the old image refusing at boot (`FJS-D2041`). Read in code, not driven. Step 1.7 closes it.
- [ ] 0.4 Rule Q2, Q1, Q4, Q3, one at a time

### Phase 1 — One record

Drafted against the recommendations. A ruling that differs rewrites this phase before it starts.
Done when: a Basecamp release and a `fli deploy` release of the same digest and configuration mint the same Release id, and a rollback driven with `frontier-basecamp` stopped restores the image and configuration from Outpost's cache.

- [ ] 1.1 `mintRelease` and its format constant move to a package Basecamp, Outpost and `cli` all import
- [ ] 1.2 `Deployment` gains `releaseId`, minted when the build reports its digest
- [ ] 1.3 Outpost caches the last N release records (digest, configuration snapshot, secret refs) under `/var/lib/outpost`, with N equal to its image `keep` count
- [ ] 1.4 Secrets pin by version, and a rotation revokes the version it replaced (Q3); kept versions are `@encrypted` and redacted in the trail
- [ ] 1.5 Outpost refuses a revert whose cached Release id or digest disagrees with the request or the image on disk (Q1)
- [ ] 1.6 The drill: stop `frontier-basecamp` and revert an app from the machine
- [ ] 1.7 `Deployment` records the pivot verdict Outpost already returns, and `rollback` refuses by name across a contract, naming `isRestoringVolume` as the way back, the way `deploy:revert` names `--past-pivot`
- [ ] 1.8 `generation` leaves `mintRelease`, the journal's `Release` row and the transition id, and `deploy:revert`'s configuration check reads `configurationHash` (Q4); 79 mentions across `packages/cli/core`, `db/deploy.lite` and `commands/deploy/` — the journal's `formatVersion` moves with it

## See also

- `IDEAS/release-transitions.md` — the Release and journal format this extends. Its § What is already recorded listed five stores; Basecamp's `Deployment` is the one that grew.
- `IDEAS/deploy-plane.md` — the build-once digest, which makes a shared Release id mean the same bytes on two machines.
- `IDEAS/backups-plan.md` and the memory's *Basecamp-down drill* — 1.6 extends that drill from *still serving* to *can still revert*.
