---
id: app-platforms
status: proposed
dated: 2026-10-29
---

# Idea — a Platform is somewhere an App runs that Basecamp deploys to without owning a machine

**Status: PROPOSED.** Dated 2026-10-29. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. The noun is provisional until
Q5 is ruled. `decision-rules` ran on 2026-10-28 and its verdict is § The shape.

An App today runs where an `AppServer` row says, which is always a machine with
an Outpost. A Cloudflare Worker static site, a Vercel project or a Netlify site
runs on a vendor's platform, and Basecamp should ship it, see it and manage it
like any other App. **An App's destinations are a list**: some machines, some
platforms, or both.

## What the tree already does

Read 2026-10-28.

- **A static App built from git already deploys to a Worker.** `releaseSite`
  (`api/src/domain/site/site-publish.ts`) sends `/site/publish` to the App's
  placement. The Outpost builds there in throwaway containers (`FJS-D1251`) and
  uploads with the workspace's Cloudflare account, whose token travels in the
  call body (`FJS-D1252`).
- **That App still needs an `AppServer` row**, because `resolveExecutor`
  (`api/src/providers/executor.ts`) reads one. For a site, the row means *where
  it builds*. The schema reads it as *where it runs*. This tangle is the gap.
- **A vendor account is a `Secret`** of kind `provider_key` (`FJS-D558`).
  `ProviderKind` already lists `cloudflare`, and `ComputeProvider` narrows it
  for machines (`FJS-D1607`). That narrowing is the pattern this paper copies.
- **The connector shape exists twice**: `providers/compute/` and
  `providers/edge/`. Each is an interface of functions over
  `send: AccountSend`, plus `descriptor()` and `verify()`.
- **Sierra's Cloudflare adapter is the build-side half** (`FJS-D1213`).
  `packages/sierra/src/site/cloudflare.js` turns a built site into what a Worker
  runs and derives the Worker's name from `siteUrl`. It knows nothing about
  Basecamp, and `FJS-D1213` keeps it that way: a deploy must not depend on
  Basecamp being up. `IDEAS/site-hosting.md` § The shape calls Basecamp the
  *control plane*, and that is the layer this paper fills.

## Prior art

| Tool | What it splits | Takeaway |
| --- | --- | --- |
| HashiCorp Waypoint | Builder → Registry → **Platform** → ReleaseManager, each a plugin; a Docker host is a Platform the same way Kubernetes or Lambda is | where it builds and where it runs are separate components, and the word is *Platform* |
| Cloudflare Workers Builds | Deploy Hooks: a POST to a per-branch URL starts a build and returns `build_uuid`; List builds reports it; the hook URL is itself the credential | the platform builds, and Basecamp only triggers and watches |
| Cloudflare build events | start, succeed, fail and cancel, published to a Queue rather than a webhook | for Cloudflare, poll the Builds API rather than stand up a forwarder Worker |
| Cloudflare versions | a version is an upload; a deployment is one or two versions serving traffic; rollback promotes an older version, up to the 100 most recent | rollback is a promote with no rebuild |
| Vercel | outgoing webhooks (`deployment.succeeded`, `.error`, `.promoted`…) signed with `X-Vercel-Signature`; deploy hooks inbound | a signed Receiver |
| Netlify | build hooks inbound; deploy notifications outbound, signed as a JWS in `X-Webhook-Signature`, hashed over the raw body | a signed Receiver |

All three vendors have a CLI that deploys a directory built elsewhere:
`wrangler deploy`, `vercel deploy --prebuilt` and `netlify deploy --dir`. That
is what lets an Outpost build and any platform receive (Q2). The Vercel CLI
flag is recalled from memory, not sourced this session.

## The shape

**Two tables, one list, one interface.** `AppServer` stays as it is: a
machine, a replica index and a container. A new `AppPlatform` row is one
platform deployment of the App. The App screen lists both as *where it runs*.

`decision-rules` refused widening `AppServer`. A nullable `serverId` breaks
`@@relator([appId, serverId])`, makes `replicaIndex` and `containerId`
meaningless, and puts a guard in every reader: `domain-dns`, `job-run`,
`volumes`, `posture` and `replicate-sync`. It also cuts against `FJS-D1607`.

```lite
// A vendor that runs an App without a machine. A subset of ProviderKind, as
// ComputeProvider is (FJS-D1607); a Secret whose providerKind is not in it is
// refused at the write.
enum PlatformProvider { cloudflare }

// Where the build runs. `outpost` builds on builderServerId and the Outpost
// uploads the result; `platform` asks the platform to build from git.
enum PlatformBuild    { outpost platform }

model AppPlatform {
  id              String   @id @default(uuid())
  workspaceId     String
  appId           String   @immutable
  app             App      @relation(fields: [appId], references: [id], onDelete: Cascade)
  accountId       String   @immutable          // the provider_key Secret
  provider        PlatformProvider @immutable
  // The platform's own name: a Worker's script name, a Vercel project id, a
  // Netlify site id. Adopting reads it, and creating derives it (FJS-D1213).
  name            String   @immutable
  build           PlatformBuild @default(outpost)
  builderServerId String?                      // which Outpost builds; null with build = platform
  hookUrl         String?  @encrypted          // a deploy hook URL is a credential
  receiverSecret  String?  @encrypted @system  // signs inbound status events (Vercel, Netlify)
  status          AppStatus @default(unknown) @system
  liveVersion     String?  @system             // what serves traffic, as the platform last said
  observedAt      DateTime? @system
  @@unique([appId, accountId, name])
  @@trail(audit)
}

// Deployment: + platformVersion String?, which is what a rollback promotes.
// DeployTrigger: + observed, a release the platform ran that Basecamp did not start.
```

### The interface — two halves, as `site-hosting.md` splits them

**The Outpost half uploads a directory.** `/platform/publish { provider, name,
dir, credential }` runs that provider's CLI and answers the version id. It
replaces `/site/publish`'s Cloudflare-only upload step. The credential arrives
per call, as it does today, and is never stored on the machine.

**The Basecamp half is everything else**, in `providers/platform/` beside
`compute/` and `edge/`:

```ts
export interface PlatformConnector {
  provider: PlatformProvider
  descriptor(opts: { accountId: string; ref: string }): TargetDescriptor
  verify(send: AccountSend): Promise<boolean>

  // Adopt — what the account already runs.
  projects(send: AccountSend): Promise<PlatformProject[]>
  project(send: AccountSend, name: string): Promise<PlatformProject | null>

  // Ship with build = platform. The hook needs no token; the poll does.
  trigger(hookUrl: string, opts: { branch?: string }): Promise<{ buildId: string | null }>
  buildState(send: AccountSend, name: string, buildId: string): Promise<PlatformBuildState>

  // Record and roll back. A rollback is a promote: no rebuild, no Outpost.
  versions(send: AccountSend, name: string, opts?: { since?: string }): Promise<PlatformVersion[]>
  live(send: AccountSend, name: string): Promise<{ versions: { id: string; percent: number }[] }>
  promote(send: AccountSend, name: string, versionId: string): Promise<void>

  // Manage.
  // Applied with a release, never alone: Cloudflare refuses a secrets edit
  // while an older version serves (10215), which is every rolled-back App.
  setVariables(send: AccountSend, name: string, vars: Record<string, string | null>): Promise<void>
  domains(send: AccountSend, name: string): Promise<PlatformDomain[]>
  attachDomain(send: AccountSend, name: string, host: string): Promise<void>
  detachDomain(send: AccountSend, name: string, host: string): Promise<void>
  tail?(send: AccountSend, name: string, signal: AbortSignal): AsyncIterable<PlatformLogLine>

  // Inbound. Absent where the vendor signs nothing to a URL (Cloudflare): the
  // observe job polls versions() instead.
  readEvent?(raw: Request, secret: string): Promise<PlatformEvent | null>
}
```

**Who carries a release stays one decision.** `resolveExecutor` gains a third
real answer, `platform`, beside `outpost` and `stub`. `none` stays a refusal by
name. A release across several destinations is one `Deployment` with a step
per destination (Q3).

**Three doors write a platform release:**

| Door | Trigger | What runs |
| --- | --- | --- |
| Basecamp, built on an Outpost | `button` / `push` / `publish` | the Outpost checks out, builds, then `/platform/publish` |
| Basecamp, built on the platform | `button` / `push` | `trigger(hookUrl)`, then `buildState` polled to an end |
| Somebody else (wrangler on a laptop, the platform's own git build) | `observed` | `platform:observe` reads `versions()`, or a signed Receiver hears it, and writes the row |

**Domains move off the ingress path.** A Domain on a platform App is attached at
the platform, which writes its own record on Cloudflare. `edge.sync` writes no
ingress A record for it, and `servingAddresses` on an App with no `AppServer`
refuses by name rather than pushing nothing (`decision-rules` Q9).

## Phases

### Phase 0 — probes and rulings

- [ ] **0.1** Against the hand-run awe.dev account: which token scopes list
  Workers scripts, versions, deployments and builds. Write down what one
  account-owned (`cfat_`) token needs.
  *Read 2026-10-29 with `cf`'s OAuth login on the awe.dev account
  (`0a207b9b…`):* `cf workers list`, `versions list --worker-id` and
  `deployments list --script-name` all answer. A deployment carries `source`
  (`dash`, `wrangler`), `author_email`, `versions[].percentage` and
  `created_on`, which is all an `observed` row needs. A version carries
  `annotations["workers/triggered_by"]`. That login cannot list
  permission groups or create tokens (403, code 9109), so the account-owned
  token's scope list is still open.
- [ ] **0.2** Create a deploy hook on a test Worker, POST it, and follow
  `build_uuid` to `success` through List builds. Record the latency.
  *Read 2026-10-29, the half that needs no repository,* on the throwaway
  Worker `fjs-platform-probe` (awe.dev account), with the `cfut_` user token.
  `wrangler deploy` uploads and deploys. `GET …/scripts/<name>/deployments`
  lists each deployment with its `source`, `author_email`, the
  `workers/message` annotation and its versions. A rollback is
  `POST …/deployments` naming an older `version_id` at 100%: v1 was serving
  again 1.1 s later, with no rebuild. That deployment reads `source: api` and
  carries whatever `workers/message` the caller wrote, so the message is where
  Basecamp marks its own. **Trap:** `PUT …/secrets` on a rolled-back Worker
  is refused (10215, "the latest version of your Worker isn't currently
  deployed"). The build half waits on a GitHub repository for the probe.
  Connecting private `jdkdev/fjs-platform-probe` with `PUT …/builds/repos/connections`
  is refused (8000008, "disconnected from your Git account") until
  Cloudflare's GitHub App holds the repository. That grant is a person in a
  browser and no API makes it, so `build = platform` needs a one-time GitHub
  step, and Basecamp's adopt and create screens must name it.
- [ ] **0.3** Find out whether the Builds API has a token-authenticated
  trigger. If it has, Q6 has an answer and no hook URL is stored.
  *Read 2026-10-29:* `cf builds create <trigger-uuid>` starts a build "for a
  branch or commit using the selected trigger", authenticated with the account
  token, so a hook URL looks unnecessary. None of the account's four Workers is
  connected to a repository (`builds list` is empty), so this is not yet run.
- [x] **0.4** Rule Q1–Q5 (through the question tool, one at a time). Ruled 2026-10-29: `FJS-D1629`–`FJS-D1633`.

### Phase 1 — see what runs (read only)

- [ ] **1.1** `PlatformProvider`, `PlatformBuild` and `AppPlatform`, plus
  `Deployment.platformVersion` and `DeployTrigger.observed`. Add a test that
  `PlatformProvider` stays a subset of `ProviderKind`, as `FJS-D1607` has one.
- [ ] **1.2** `providers/platform/cloudflare.ts`: `verify`, `projects`,
  `project`, `versions`, `live`.
- [ ] **1.3** Adopt: pick a Worker from the account, and Basecamp makes an App
  (`static` or `worker`) and its `AppPlatform`.
- [ ] **1.4** `platform:observe` writes `observed` releases and keeps
  `liveVersion` current.
- [ ] **1.5** The App screen lists machines and platforms together as *where it
  runs*.

### Phase 2 — ship, built on the platform

- [ ] **2.1** `trigger` + `buildState` as a release's steps.
- [ ] **2.2** Rollback promotes `platformVersion` with no rebuild.

### Phase 3 — ship, built on an Outpost

- [ ] **3.1** `/platform/publish` on Outpost (wrangler first). `releaseSite`
  reads `AppPlatform.builderServerId`, and a site needs no `AppServer` row.
  `resolveExecutor` answers `platform`.

### Phase 4 — manage

- [ ] **4.1** Variables reach the platform as secrets on each release, inside
  the version upload. A separate secrets call is refused while a rolled-back
  version is live (0.2), so `setVariables` cannot be standalone.
- [ ] **4.2** Domains: `attachDomain`, and `edge.sync` leaves the record alone.
- [ ] **4.3** A Monitor HTTP check is made with the App, since a platform sends
  no heartbeat.
- [ ] **4.4** `tail` behind the App's log pane.

### Phase 5 — a second adapter proves the interface

- [ ] **5.1** Netlify or Vercel, with its signed webhook as a conduit Receiver.
  A method this adapter cannot fill is an interface defect, fixed before 5.1
  closes.

## Open questions

- ~~**Q1 — How are the rows shaped?**~~ **Answered 2026-10-29 (`FJS-D1630`): A — `AppPlatform` beside `AppServer`, listed together on the App screen.**
  - **A** — `AppPlatform` beside `AppServer`, listed together on the App screen.
  - **B** — one destination table with a kind, `AppServer` folded in.
  - **Recommend A** — B is the widening `decision-rules` refused: a nullable
    `serverId` breaks the relator and guards five readers (§ The shape).
- ~~**Q2 — Who uploads an Outpost build to the platform?**~~ **Answered 2026-10-29 (`FJS-D1631`): A — the Outpost runs the platform's CLI with the credential sent per call, as `/site/publish` does today.**
  - **A** — the Outpost runs the platform's CLI with the credential sent per
    call, as `/site/publish` does today.
  - **B** — the Outpost hands the built directory back through a bucket, and
    Basecamp uploads it through the API.
  - **Recommend A** — all three vendors' CLIs take a prebuilt directory; B is a
    multipart upload client per vendor, and its gain is only that the token
    never leaves Basecamp.
- ~~**Q3 — Is a release across several destinations one row or many?**~~ **Answered 2026-10-29 (`FJS-D1633`): A — one `Deployment` with a step per destination.**
  - **A** — one `Deployment` with a step per destination.
  - **B** — a `Deployment` per destination.
  - **Recommend A** — one row still answers *what shipped*; a partial success
    is a failed step, and a retry targets that step's destination.
- ~~**Q4 — How is a release Basecamp did not start recorded?**~~ **Answered 2026-10-29 (`FJS-D1632`): A — stored as an `observed` `Deployment`.**
  - **A** — stored as an `observed` `Deployment`.
  - **B** — read live from the platform and never stored.
  - **Recommend A** — rollback, notifications and the trail all read
    `Deployment`, and under B a laptop deploy is invisible to each of them.
- ~~**Q5 — What is the noun?**~~ **Answered 2026-10-29 (`FJS-D1629`): A — *Platform*.**
  - **A** — *Platform*.
  - **B** — *Destination*, already `BackupDestination`'s word.
  - **C** — *Target*, already Conduit's.
  - **Recommend A** — Waypoint's word, and how Vercel, Netlify and Heroku
    describe themselves; it takes a `VOCABULARY.md` row once ruled.
- **Q6 — Is a platform build triggered by a deploy hook or by the account token?**
  Waits on 0.3: if the Builds API has a token-authenticated trigger, `hookUrl`
  goes and nothing more is stored.

---

## See also

- `IDEAS/site-hosting.md` — the build-side adapter and the four layers.
- `IDEAS/cloudflare-edge.md` — the account, the `adopt` verb for DNS, `edge.sync`.
- `IDEAS/git-deploy.md` — push → release, which a platform build reuses.
- `packages/basecamp/docs/ADAPTERS.md` — the connector conventions.

Sources:
[Waypoint plugin SDK (third-party fork)](https://github.com/swisscom/waypoint-plugin-sdk) ·
[Cloudflare Deploy Hooks](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks) ·
[Deploy Hooks changelog, 2026-04-01](https://developers.cloudflare.com/changelog/2026-04-01-deploy-hooks) ·
[Workers Builds API reference](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference) ·
[Builds event subscriptions](https://developers.cloudflare.com/workers/ci-cd/builds/event-subscriptions) ·
[Workers rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks) ·
[Vercel webhooks](https://vercel.com/docs/integrations/marketplace/webhooks) ·
[Netlify deploy notifications](https://docs.netlify.com/deploy/deploy-notifications)
