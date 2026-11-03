# basecamp — layout

The file-by-file map of `@frontierjs/basecamp`, moved out of `CLAUDE.md` so a turn in this package does not pay for it. `CLAUDE.md` keeps the owners and the traps; hazards are `hazards.md`.

```
db/       schema.lite (43 models declared, 50 with the two imported fragments;
          32 enums declared, 34 resolved) · generate.js · migrations/ · seed.js ·
          litestone.config.js · test/ · README.md (the depth doc)
api/      index.ts (the entry — start() and nothing else) · config/
tests/    the app's own suites, spanning surfaces (audit-gate-parity-*); each surface keeps its own test/
api/src/  app.ts (builds the app, never starts it) · services/ ·
          jobs/ (*.job.ts) · notifications/ · providers/ · plugins/ · core/ · domain/
          notifications/ is one file per NotificationKind and the FILE NAME is
          the persisted type — so the directory, the enum and kinds.ts are
          three spellings of one vocabulary, held together by api/test/notify.test.ts
          domain/notification/notify.ts is the one owner of *does this person want it*
          domain/host/server-metrics.ts decides WHICH of a check-in is kept and what
          each reading is called; the heartbeat pushes through app.metrics.record
          domain/alert/alerting.ts is the alert comparison, pure — no db, no clock, no app
          domain/alert/deliver.ts pages an alert's channels and closes a rule's open
          alerts when it is deactivated or deleted; domain/monitor/resolve.ts is the
          same close for a down monitor that is paused or deleted
          domain/monitor/probe.ts is the monitor's two judgments, pure: `gradeProbe` (did
          this request count — accepted codes, invert) and `nextState` (what a
          failure does: down only past `retries`, page once, `resendEvery`).
          jobs/monitor-sweep.job.ts probes every due `Monitor` from this process,
          an outside view, and is the only writer of its `@system` columns; a
          monitor is `pending` until graded, and paused ones are never picked
          (`FJS-1557`)
          jobs/release-sweep.job.ts fails a release left pending or building with no
          job behind it, every minute and once at boot from app.ts (`FJS-3861`)
          domain/notification/delivery.ts is the ONE owner of how a NotificationChannel is
          reached; `notificationChannels.test`, the alert evaluator and the `basecamp.page`
          flow node are its callers
          plugins/automations.ts is what this app contributes to orion — one node,
          `basecamp.page`, which reads the channel as the FLOW'S OWNER and hands
          it to domain/notification/delivery.ts. A dry run answers which channel it would have
          reached and moves no `lastDeliveryAt`
          domain/release/app-source.ts is the ONE reader of `App.source` — `git`, `image`,
          `inline`, parsed and normalized, and the paste box's limits (the
          machine's are outpost's, and they win)
          domain/release/dockerfile-template.ts is the two seeds a git App's own
          Dockerfile starts from (`FJS-D1555`): the FrontierJS template that
          clones the framework and links its packages, and the repository's
          file read raw off a public GitHub or Bitbucket
          domain/site/site-checkout.ts is basecamp's bare clone of each static site an
          owner edits, under SITES_DIR: a draft is `draft/<slug>` ON THE REMOTE,
          and a save is a commit built through a temporary index and pushed, so
          the push is the lock (`FJS-D1246`). services/drafts/ is its surface and
          takes no workspace: the caller's own `AppEditor` row is read first and
          the App through asSystem() after it; what may be written is
          site-kit's `editable` (`formOf`, `applyEdit`), never a list here.
          A save's `text` edit (a click on the preview) carries no blob: the
          words are found in the stamped block by toolbelt's `locateText`,
          and the result still goes through `applyEdit`. `drafts.arrange` is
          the lists (`FJS-D1403`–`FJS-D1405`): a `line` names a menu entry,
          written by `applyEdit`'s `entry`; no line is the file as a
          collection item, whose `arrangeCollection` writes may touch every
          item, so `saveDraftFiles` commits them as ONE commit.
          `drafts.photo` is a front-matter photo (`FJS-D1406`–`FJS-D1408`):
          the upload is DECODED AND RE-ENCODED by domain/site/site-photo.ts (what
          does not decode is refused, EXIF is dropped) and committed beside
          the old one with the key's line; `http.maxBodySize` is 10 MB in
          app.ts for it, since the config file has no key for the bound.
          `drafts.ask` is an owner's request to a model (`FJS-D1242`): the
          `site:ask` job runs domain/site/site-ask.ts, which writes the draft's
          `content/**.md` to a temp folder, runs the cli's `runAsk` in EDIT
          mode scoped to it, grades every file it added, changed or removed
          with site-kit's `changeRefusal` (`gradeAsk`; one refusal drops the
          run whole), and hashes what passed into a TREE on the head it read.
          Nothing commits until the owner's `drafts.keep` (one commit on
          the head the run read, refused if the draft moved); `discard`
          forgets it and `undo` reverts the kept commit on the draft.
          The key is `ANTHROPIC_API_KEY`, one for every
          site (`FJS-D1424`), handed to that child only; the limit is the
          argv's $2 a run (`FJS-D1425`). Each draft's last ask is a file beside
          the clone, on `list` as its preview is.
          domain/site/site-preview.ts is a draft's preview: it BUILDS NOTHING — the
          `site:preview` job sends `/site/preview` to the App's placement,
          where Outpost builds in throwaway containers (`FJS-D1251`), with
          the workspace's Cloudflare account and the account id off its zone
          (`FJS-D1252`); each draft's last preview is a file beside the clone,
          and a save during a build is the same run's next round
          domain/site/site-publish.ts is a site's LIVE release: `releaseSite` sends
          `/site/publish` for a developer's Deploy of a static git App and for
          an owner's Publish alike, and the commit it answers is recorded on the
          release. A publish (`drafts.publish`, the `site:publish` job, as the
          app) is a `Deployment` whose refusals are its steps — no release
          recorded (`FJS-D1339`), undeployed commits named by author
          (`FJS-D1229`), a both-sides line — and the site's branch moves only
          after the deploy, so a failed build never strands the owner's merge.
          An API App's `site/` is not a static App: a git container release
          with a volume ends with `SITE_STEP` (`release-record.ts`), sent by
          `deployment-run`'s `runAppSiteStep`, whose failure leaves the release
          a success (`FJS-D1690`).
          `drafts.history` is DERIVED (releases + git diff, nothing stored);
          `drafts.revert` is that merge run backwards into a new draft at the
          `edit` grant, and refuses a developer's deploy.
          A preview SIGNS IN through `drafts.handoff` → `drafts.redeem`
          (`FJS-D1357`): a one-time code to a recorded preview origin only,
          redeemed for an 8-hour `drafts`-scoped key with an `ApiKey` row.
          CORS admits that origin because app.ts asks `isPreviewOrigin`, the
          set `markPreview` keeps; a preview recorded nowhere is refused.
          domain/release/release-record.ts is the ONE writer of a release's run (start,
          step, finish), called by `deployments` at the caller's standing and
          by a publish as the app
          core/credentials.ts owns both conduit ref forms — `secret:<id>` and
          `env:<NAME>`; a target carries the ref, never the material
          domain/host/provision-host.ts and domain/host/host-record.ts are run by `fli
          basecamp:create` and `fli basecamp:dns` on a LAPTOP, never by the app:
          the droplet, and Basecamp's own A record under the fleet's mark,
          each through this app's connector over domain/host/bearer-send.ts, since
          no app is booted to hold a conduit registry
          domain/release/runtime.ts is the ONE reader of how a container starts —
          App's port, volume, health path and limits, each a `docker run` flag;
          a column added there and not applied by outpost is `FJS-1605` again
          domain/release/host-port.ts is which host ports a machine's Apps
          publish, and `allocatePort`, the one allocator: `placeApp` picks the
          port when a container App lands on a machine (`FJS-D1557`); patch
          and place refuse a taken one (`FJS-3563`)
          domain/release/variables.ts is what a container's environment IS — the
          environment's `Variable` rows with the app's own on top, snapshotted
          when a release is made and a secret read only when it is sent
          core/session-auth.ts projects this app's OWN User columns onto the
          session and owns both doors suspension is refused at
          domain/local/local-ssh.ts is the operator's own ~/.ssh/config, read on THEIR
          laptop for the import form (`servers.localSshHosts`/`localSshProbe`). It
          is off unless LOCAL_MACHINE=1 (`bun run api` sets it) and refused under
          NODE_ENV=production whatever it says (`localMachineRefusal`), and nothing
          in domain/local/ runs unless the CALLER asked that first — no check grades
          a new file there for the gate. ssh is always handed `-F` with the file
          that was listed, because ssh finds ~ through passwd and Bun through $HOME.
          The rest of the operator's machine — Claude Code chats, the registers,
          Autopilot, local git checkouts — is `packages/workbench`, which this
          package imports nothing from (`IDEAS/workbench-package.md`).
          plugins/machine-stream.ts is `/ws/stream/{source}/{id}`: a machine's
          output as it is written, relayed from an Outpost `text/event-stream`
          route through `Executor.stream()`. One SOURCES row per stream (`logs`
          is `/logs/follow`), the row graded by `$readAs` under the caller's
          `workspaceClaim` (`FJS-D1550`).
          plugins/app-archive-upload.ts is `PUT /app-archive-upload/{appId}`: an
          archive a person uploads, streamed, behind a link `appBackups.upload`
          signed; domain/backup/app-archive-import.ts checks it and puts it in
          the app's bucket as a `found` row (`FJS-D1732`).
          domain/workbench/workbench-preview.ts is the Basecamp half of a Workbench
          preview: an Environment (tier preview, slug wb-<slug>), a static inline App,
          its Domain and `/route`, written through each row's own service. `freeze`
          publishes the built SPA to the machine ITSELF and releases that digest (the
          files never enter a row — a built SPA is up to 180 files and every row is
          trailed); `thaw` routes back to the port; `retire` removes the rows. Its
          caller is Workbench, over a signed peer call once plan phase 3.1 lands.
          `pages` is never an agent's or a key's: `NOT_FOR_AGENTS` and `OFF_LIMITS` in
          domain/api-key/scopes.ts, proved by verify:mcp
          jobs/ is what runs unattended — a file per job, autoloaded by
          caravan from beside the app root, and the default export is the dispatch handle
          jobs/{recipe,maintenance}-run are both ways this app acts on a MACHINE —
          one shape, opposite safeguards; domain/job/outpost-run.ts is their half
          domain/backup/backup-archives.ts is an archive once it exists — the one
          delete (retention's and backups.discard's, FJS-D1494), the prune
          backup-run calls after a success, and the rescans that write
          `found` rows — the hub's (FJS-D1493) and an app's, hashed before it
          restores (FJS-D1572, jobs/app-archive-rescan.job.ts); not a job, so
          caravan loads nothing from it
          domain/backup/archive-manifest.ts is an archive's `manifest.json` —
          the key fingerprint and each file's sha256 — and `archiveRefusals`, the
          check a restore runs on the staged directory, schema graded by litestone's
          `status()` over each staged database's own migration history
          domain/backup/hub-restore.ts is `/setup`'s *Restore a hub*: the bucket
          listed and fetched over pre-signed URLs (no row exists to be a target),
          an upload received, `restore-staged/` written only after `archiveRefusals`
          passes, and `restoreStaged`, which app.ts runs before `openSqlite` — the
          swap is `litestone restore --from-backup --force`, refused beside an Account
          domain/backup/found-replicas.ts is what the bucket still holds after a hub
          restore: `reconcileFound` sets `replicaFoundAt`/`replicaSyncedAt` on each
          App (and HubConfig) whose replica lists, and sends one `ReplicaFound` per
          workspace; jobs/restore-reconcile.job.ts runs it once, queued by app.ts
          when `restoreStaged` answered `done`
          domain/backup/pre-migrate.ts is the copy app.ts takes between
          `openSqlite` and `apply()` when applied migrations have pending ones
          after them: `pre-migrate/<stamp>.db` beside the database, newest three
          kept, and a copy that fails stops the boot (FJS-3907)
          jobs/app-backup-run.job.ts is the one `/backup` caller (Invariant 4) —
          the schedule's `app-backup:run`, `app-backups.take` and a release's
          `Back up volume` step all take through `takeAppBackup`; `destinationFor`
          reads `App.backupDestinationId` at SYSTEM and refuses a crossed workspace
          providers/ is who the app SPEAKS to — `index.ts` is nine (eight
          self-hosted appliances, plus `cloudSpend`, somebody else's service
          reached with a token), executor.ts and
          outpost.ts are the fleet's own, and outpost-dev.ts is this laptop
          enrolled as one of them (`bun run dev:outpost`). One folder, because FJS-D06 rules
          Provider to mean a party outside the app and Infisical is one in the
          sense Hetzner is. `hosted` on the portal entry is what separates the
          two kinds, and it is there because *unconfigured* means different
          work for each: install it and set a URL, or open an account and hold
          a key. compute/, edge/ and source/ are the vendors held as a workspace
          ACCOUNT — a `providerKey` Secret that compute/accounts.ts registers
          as `provider:<kind>:<secretId>` through `accountConnectorFor`
          (`FJS-D558`); a *-sink.ts beside each connector is its stand-in.
          source/github.ts writes an App's deploy key and push hook to its
          repository with a fine-grained token (`FJS-D1571`), each write
          repeatable, and reads its Dockerfile (`FJS-D1573`) — the token is
          used at connect and at that read, never at a push.
          storage/ is a bucket held as a workspace `BackupDestination` row —
          s3.ts is basecamp's own lift of conduit-s3 over toolbelt's sigv4
          (`FJS-D1490`, no `link:` on the sibling repo survives the image
          build), index.ts registers each row as `storage:s3:<id>` on
          write and at boot, a credential ref and never a key, and s3-sink.ts
          is the connector's SigV4-verifying stand-in lifted the same way
          edge/ writes only records it MARKED, and the connector is where an
          unmarked set is refused (`FJS-D560`, `FJS-D562`), so no caller can
          skip the check by forgetting it
          services/edge/ reads an edge account's zones and records beside the
          workspace's `Domain` rows (the plan), and `sync` pushes one Domain
          and its App's ingress record (the apply) — `syncStep` is the same
          push from jobs/domain-dns.job.ts, which a Domain write, a release and
          a Server crossing `online` dispatch (the last through the one tap in
          app.ts, as the app), and skips what cannot be pushed YET — an App on
          no online machine keeps its record (`FJS-D567`); the ingress addresses are
          `servingAddresses` in domain/release/runtime.ts, which only the deploy job's
          `running` mark feeds. Reads at `Domain`'s read gate — the account
          lookup is `asSystem()` confined to the workspace, since a developer
          is below `Secret`'s 5; the portal's `edge` entry reads the same lookup
          services/hub/ is the ONLY service that takes no workspace
          services/pages/ is fli's own inventory (`runnables`, `children`
          from packages/cli/core) over the workspace this API runs in — the
          pages commands declare, and fli's tools — behind
          `localMachineRefusal` and off-limits to agents and keys. /pages/ opens a page as a
          blob, and a link between two pages is posted back to that tab
          services/infra/ takes one and has no MODEL — `graph` and
          `onboarding`, two projections assembled from several tables, where
          storing either would be a second answer that goes stale
          services/trash/ has no model either, and it only LISTS — a
          restore goes to the row's own service, whose `remove` knows what else
          the delete did; a service whose delete has a side effect overrides
          `restore` beside it (`restoreScoped`)
          services/invitations/ holds the only two UNAUTHENTICATED methods —
          `preview` and `accept`; the token is the credential and the service
          decides everything a token cannot (`FJS-032`)
          core/mailer.ts is the one answer to whether this app can mail at all;
          no provider is a supported state and every caller says so
          core/dependencies.ts is the dependency verdict (`statusOf`, pure)
          and the npm/OSV lookup over two keyless conduit targets.
          services/dependencies/ takes `fli ws:deps --push` (`ingest`, the
          whole truth for one Project) and jobs/dependency-check writes the
          `@system` registry columns — a mirror, so a hosted Basecamp needs
          no checkout
          core/account-mail.ts delivers auth's two links — password reset and
          email verification — to SPA screens; with no mailer it logs the link
          outside production, and it never throws (a failure would tell a
          stranger which addresses are accounts)
web/src/  App.mesa · main.js · session.js · notices.js (one leaf definition the
          shell and the home screen share) · routes/ · components/ ·
          resources/ (PascalCase singular, one Resource per file — Invariant 19)
          components/NoRecord.mesa is what a DETAIL screen renders instead of a
          record, and the reason: gone, signed out, or the read failed. Every
          `[id]/` screen ends in it. `error` is the banner over a page that
          still has its row; `loadError` is why this page has none (`FJS-968`)
web/test/ verify.mjs · verify-build.mjs + preview.mjs (the built output)
cli/      config/cli.config.js (name, tenant header, dev endpoint) · src/main.js ·
          src/routes/<service>/<method>.js — the hand-written commands; every other
          command is /mcp's tool list at the key's standing · test/verify-cli.mjs ·
          dist/bcamp — the binary, which carries the routes only when built by fli cli:build
docs/     screens.md — the mock inventory, 41 of 41 built (FJS-153, closed
          2026-08-30). Four of them are a screen with a skeleton where a third
          party's numbers go — what is owed there is adapters, not UI
          providers.md — that debt, per provider: every boundary declared,
          nothing behind any of them, what wiring one costs and which drive
          assertions flip when you do
          vision.md · provisioning.md
```

---

