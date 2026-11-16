---
id: release-record
status: proposed
dated: 2026-11-14
---

# Idea — one release record for both deploy paths

**Status: PROPOSED. Phase 0 done 2026-11-14: Q1–Q4 ruled (`FJS-D2171`, `D2178`, `D2181`, `D2182`). Phase 1 is the build: 1.1 done 2026-11-16, Q5–Q6 ruled (`FJS-D2217`, `D2216`) as 1.3 and 1.4 raised them. Phase 1's steps were drafted against the recommendations, and every one was taken.**
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
- ~~**Q3 — Does Basecamp adopt `release-transitions.md` invariant 2's pinned secret reference, and what does a revert do when the pinned version is revoked?**~~ **Answered 2026-11-15 (`FJS-D2182`): C — As A, plus a rotation marks the version it replaced as revoked. A rollback that would restore a revoked version refuses by name, and the refusal offers *roll back with today's value* as the explicit way out.**
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
- ~~**Q5 — With Basecamp down, where does a revert get its secret values?**~~ **Answered 2026-11-16 (`FJS-D2217`): A — Outpost copies the values from a container that holds exactly those refs. When the target's refs equal the live release's refs, or `_replaced`'s for a one-step revert, the values are already on the box in that container's env. Otherwise it refuses by name, offering *with today's secrets* (`FJS-D2182`'s exit, applied on the box). The live entry records the refs `/deploy` actually applied, never the revert target's.** Raised by 1.3. `FJS-D2178` caches secret refs, and a ref is not a value. Only Basecamp holds the values (`Variable.secretValue`, `@encrypted`).
  - **A** — Outpost copies the values from a container that holds exactly those refs. When the target's refs equal the live release's refs, or `_replaced`'s for a one-step revert, the values are already on the box in that container's env. Otherwise it refuses by name, offering *with today's secrets* (`FJS-D2182`'s exit, applied on the box). The live entry records the refs `/deploy` actually applied, never the revert target's.
  - **B** — Outpost caches each release's resolved values, 0600 under `/var/lib/outpost`. A revert works after any rotation, at the cost of a plaintext store of N releases at rest.
  - **C** — Restore the image and the plain configuration, and always run the live container's secrets.
  - **Recommend A** — it adds no store of plaintext and is exact or refused by name. B widens exposure from one live container to N cached releases. C runs a credential the release never saw, which `FJS-D2182` rules out.
- ~~**Q7 — Which `app` term do both doors hash?**~~ **Answered 2026-11-16 (`FJS-D2230`): D — `fli`'s mint hashes `BASECAMP_APP_ID` when the project has one, else `deploy.app_id`; container names and box paths keep `deploy.app_id`. A was ruled first and corrected: `deploy:move` writes no project `.env`, and `app_id` names the SSH install's container.** Raised by 1.2. Basecamp mints with `App.id`, a uuid. `fli deploy` mints with `deploy.app_id` from `frontier.config.js`, which is free text such as `shop`. The two ids agree only when those do.
  - **A** — `deploy:move` sets `deploy.app_id` to the Basecamp App id, beside the `.env` it already writes, and its docs and `basecamp:app`'s say why. An app that never meets Basecamp keeps its own id.
  - **B** — Document the rule in `deploy:move` and `basecamp:app`, and enforce nothing.
  - **C** — Both doors hash a slug.
  - **D** — `fli`'s mint hashes `BASECAMP_APP_ID` when the project has one (`fli basecamp:app` writes it), else `deploy.app_id`. Container names and paths keep `deploy.app_id`.
  - **Recommend A** — the move is the one moment both ids are in hand. B leaves the done-when to an operator's memory. A slug can be renamed or reused, so under C a Release id would stop naming one app.
- ~~**Q6 — How is a kept secret version stored?**~~ **Answered 2026-11-16 (`FJS-D2216`): A — A new model, `VariableVersion`: `variableId`, `revision`, `secretValue @encrypted @immutable`, `revokedAt`, `@@unique([variableId, revision])`, `@@trail(audit)`. `Variable` keeps its current `revision`. A snapshot records a secret as `KEY@revision`, by key rather than row id, so an `fli` ref `KEY@3` and a Basecamp ref hash alike (`FJS-D2171`).** Raised by 1.4. `Variable.version` is an `@version` concurrency counter that bumps on any edit, so it cannot be the pinned version.
  - **A** — A new model, `VariableVersion`: `variableId`, `revision`, `secretValue @encrypted @immutable`, `revokedAt`, `@@unique([variableId, revision])`, `@@trail(audit)`. `Variable` keeps its current `revision`. A snapshot records a secret as `KEY@revision`, by key rather than row id, so an `fli` ref `KEY@3` and a Basecamp ref hash alike (`FJS-D2171`).
  - **B** — A `revision` counter on `Variable` and a JSON column of earlier ciphertexts.
  - **C** — `previousSecretValue @encrypted`, enough for one step back.
  - **Recommend A** — `FJS-D2182` already needs a version, a revoked marker and a kept value, which is an entity. `@encrypted` is per column, so B's array of ciphertext escapes Invariant 6. C cannot mark anything older than one step as revoked.
- ~~**Q8 — How does an operator start a revert on the box with Basecamp down?**~~ **Answered 2026-11-16 (`FJS-D2231`): C — a signed `POST /revert`, and `outpost revert` is a thin wrapper that signs with the box's own `OUTPOST_SIGNING_KEY` (root-only, `/etc/outpost`) and calls it. Every route verifies against the hub's key today, so the verifier also accepts the box's own key on `/revert` alone.** Raised by 1.6. The running unit holds each app's exclusive chain and the swap, so a revert has to run inside it.
  - **A** — `outpost revert <app> [release] [--with-todays-secrets]` calls the running service over a loopback-only, unsigned route, checked on the socket peer.
  - **B** — the CLI acts on docker directly.
  - **C** — a signed `POST /revert`, and `outpost revert` is a thin wrapper that signs with the box's own `OUTPOST_SIGNING_KEY` (root-only, `/etc/outpost`) and calls it. Every route verifies against the hub's key today, so the verifier also accepts the box's own key on `/revert` alone.
  - **Recommend C** — it gives A's ergonomics without a new unsigned door, and whoever can read that key already has root and docker on the box. B races a live `/deploy` outside the chain and skips Caddy's route logic.

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
- [x] 0.4 Rule Q2, Q1, Q4, Q3, one at a time
  - Ruled 2026-11-14, every recommendation taken: Q2 `FJS-D2171`, Q1 `FJS-D2178` (amends `FJS-D746`), Q4 `FJS-D2181` and Q3 `FJS-D2182` (both amend `release-transitions.md` invariants 1 and 2).

### Phase 1 — One record

Drafted against the recommendations. A ruling that differs rewrites this phase before it starts.
Done when: a Basecamp release and a `fli deploy` release of the same digest and configuration mint the same Release id, and a rollback driven with `frontier-basecamp` stopped restores the image and configuration from Outpost's cache.

- [x] 1.1 `mintRelease` and its format constant move to a package Basecamp, Outpost and `cli` all import
  - `@frontierjs/outpost/release`: `RELEASE_FORMAT`, `mintRelease`, `configurationHash(values, secretRefs)`, `schemaSurfaceHash`, `ConfigurationError`. `cli` already depends on Outpost, and Basecamp's api already imports `outpost/layout` and `/cert`, so no new edge. `cli/core/release.js` re-exports them and keeps `configurationSet` (the `frontier.config.js` shape) and `formatRelease`. The shared mint carries no `generation`, since no caller passed one.
- [x] 1.2 `Deployment` gains `releaseId`, minted when the build reports its digest
  - Done 2026-11-16. `Deployment.releaseId`, `schemaHash` and `pivot` (one migration). `recordStep` mints with `App.id`, `builtImage`, `configurationHash(env, secretRefsOf(snapshot))` and the `schema_hash` Outpost's `/build` now returns off the clone (null for a pulled image); static and site releases mint through the same path. `fli` hashes `BASECAMP_APP_ID` where the project has one (`FJS-D2230`), and its journal row keeps `deploy.app_id`. The one-id test in `rollback.test.ts` mints both ways and compares.
- [x] 1.3 Outpost caches the last N release records (digest, configuration snapshot, secret refs) under `/var/lib/outpost`, with N equal to its image `keep` count
  - Done 2026-11-16. `src/release-cache.js`, `<state>/releases/<app>.json`, newest first, written inside the app's chain after the swap with every `secret_refs` key's value dropped (`FJS-D2217`). Basecamp sends `release_id` (re-read at send, minted at the build step) and `secret_refs`; a `/deploy` that builds inline has no id yet and records null. A record lives as long as its image: `inspector.prune` asks the daemon after a sweep and answers `removed.releases`; a cap of 20 bounds a box never pruned. A failed record write never fails the deploy (`recorded: false`).
- [x] 1.4 Secrets pin by version, and a rotation revokes the version it replaced (Q3); kept versions are `@encrypted` and redacted in the trail
  - Done 2026-11-16. `Variable.revision` (from 1) is the pin; `VariableVersion` keeps each value a rotation replaced, born revoked, so the current value has one home (`Variable.secretValue`) and the four direct writers of a secret needed no change. A snapshot pins `secretEnv: {KEY: {variableId, revision}}`, `secretRefsOf` spells `KEY@revision`, and a bare-id snapshot from before resolves to today's value. `rollback` refuses a revoked pin by name before it writes a row; `withTodaysSecrets` re-pins the replacement to today's revisions, so its record says what shipped. A deploy queued before a rotation and run after it now fails by name.
- [x] 1.5 Outpost refuses a revert whose cached Release id or digest disagrees with the request or the image on disk (Q1)
  - Done 2026-11-16. A rollback `/deploy` with a `release_id` is checked before anything stops: another digest than the cache's, or an image not held under that digest (`docker.held`), is a 409 by name; no record answers `cache: 'absent'`. `revertPlan` is the pure Basecamp-down revert (`FJS-D2217`). The operator's entry point is Q8.
- [ ] 1.6 The drill: stop `frontier-basecamp` and revert an app from the machine
- [x] 1.7 `Deployment` records the pivot verdict Outpost already returns, and `rollback` refuses by name across a contract, naming `isRestoringVolume` as the way back, the way `deploy:revert` names `--past-pivot`
  - Done 2026-11-16. `crossesPivot` moved to `@frontierjs/outpost/release`, so both doors grade with one rule. A real `/deploy` that answers no verdict records `unknown`; null means not asked (first deploy, rollback, rows from before). `rollback` refuses by name across a non-rollback release that crossed, any status, and `isRestoringVolume: true` lifts it.
- [x] 1.8 `generation` leaves `mintRelease`, the journal's `Release` row and the transition id, and `deploy:revert`'s configuration check reads `configurationHash` (Q4); 79 mentions across `packages/cli/core`, `db/deploy.lite` and `commands/deploy/` — the journal's `formatVersion` moves with it
  - Done 2026-11-16. `JOURNAL_FORMAT` 6→7 rebuilds `release`, `configuration_set` and `transition` without `generation`; `ConfigurationSet` is unique on `(app, environment, hash)`. `revertRefusals` compares `configurationHash` and names both short hashes, under the same `--onto-current-configuration`. The deploy precondition lost its configuration term; it already compared one `state` read with itself.

## See also

- `IDEAS/release-transitions.md` — the Release and journal format this extends. Its § What is already recorded listed five stores; Basecamp's `Deployment` is the one that grew.
- `IDEAS/deploy-plane.md` — the build-once digest, which makes a shared Release id mean the same bytes on two machines.
- `IDEAS/backups-plan.md` and the memory's *Basecamp-down drill* — 1.6 extends that drill from *still serving* to *can still revert*.
