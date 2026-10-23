# basecamp — layout

The file-by-file map of `@frontierjs/basecamp`, moved out of `CLAUDE.md` so a turn in this package does not pay for it. `CLAUDE.md` keeps the owners and the traps; hazards are `hazards.md`.

```
db/       schema.lite (43 models declared, 50 with the two imported fragments;
          32 enums declared, 34 resolved) · generate.js · migrations/ · seed.js ·
          litestone.config.js · test/ · README.md (the depth doc)
api/      index.ts (the entry — start() and nothing else) · config/
api/src/  app.ts (builds the app, never starts it) · services/ ·
          jobs/ (*.job.ts) · notifications/ · providers/ · plugins/ · core/
          notifications/ is one file per NotificationKind and the FILE NAME is
          the persisted type — so the directory, the enum and kinds.ts are
          three spellings of one vocabulary, held together by api/test/notify.test.ts
          core/notify.ts is the one owner of *does this person want it*
          core/server-metrics.ts decides WHICH of a check-in is kept and what
          each reading is called; the heartbeat pushes through app.metrics.record
          core/alerting.ts is the alert comparison, pure — no db, no clock, no app
          core/probe.ts is the monitor's two judgments, pure: `gradeProbe` (did
          this request count — accepted codes, invert) and `nextState` (what a
          failure does: down only past `retries`, page once, `resendEvery`).
          jobs/monitor-sweep.job.ts probes every due `Monitor` from this process,
          an outside view, and is the only writer of its `@system` columns; a
          monitor is `pending` until graded, and paused ones are never picked
          (`FJS-1557`)
          core/delivery.ts is the ONE owner of how a NotificationChannel is
          reached; `channels.test`, the alert evaluator and the `basecamp.page`
          flow node are its callers
          plugins/automations.ts is what this app contributes to orion — one node,
          `basecamp.page`, which reads the channel as the FLOW'S OWNER and hands
          it to core/delivery.ts. A dry run answers which channel it would have
          reached and moves no `lastDeliveryAt`
          core/app-source.ts is the ONE reader of `App.source` — `git`, `image`,
          `inline`, parsed and normalized, and the paste box's limits (the
          machine's are outpost's, and they win)
          core/site-checkout.ts is basecamp's bare clone of each static site an
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
          the upload is DECODED AND RE-ENCODED by core/site-photo.ts (what
          does not decode is refused, EXIF is dropped) and committed beside
          the old one with the key's line; `http.maxBodySize` is 10 MB in
          app.ts for it, since the config file has no key for the bound.
          `drafts.ask` is an owner's request to a model (`FJS-D1242`): the
          `site:ask` job runs core/site-ask.ts, which writes the draft's
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
          core/site-preview.ts is a draft's preview: it BUILDS NOTHING — the
          `site:preview` job sends `/site/preview` to the App's placement,
          where Outpost builds in throwaway containers (`FJS-D1251`), with
          the workspace's Cloudflare account and the account id off its zone
          (`FJS-D1252`); each draft's last preview is a file beside the clone,
          and a save during a build is the same run's next round
          core/site-publish.ts is a site's LIVE release: `releaseSite` sends
          `/site/publish` for a developer's Deploy of a static git App and for
          an owner's Publish alike, and the commit it answers is recorded on the
          release. A publish (`drafts.publish`, the `site:publish` job, as the
          app) is a `Deployment` whose refusals are its steps — no release
          recorded (`FJS-D1339`), undeployed commits named by author
          (`FJS-D1229`), a both-sides line — and the site's branch moves only
          after the deploy, so a failed build never strands the owner's merge.
          `drafts.history` is DERIVED (releases + git diff, nothing stored);
          `drafts.revert` is that merge run backwards into a new draft at the
          `edit` grant, and refuses a developer's deploy.
          A preview SIGNS IN through `drafts.handoff` → `drafts.redeem`
          (`FJS-D1357`): a one-time code to a recorded preview origin only,
          redeemed for an 8-hour `drafts`-scoped key with an `ApiKey` row.
          CORS admits that origin because app.ts asks `isPreviewOrigin`, the
          set `markPreview` keeps; a preview recorded nowhere is refused.
          core/release-record.ts is the ONE writer of a release's run (start,
          step, finish), called by `deployments` at the caller's standing and
          by a publish as the app
          core/credentials.ts owns both conduit ref forms — `secret:<id>` and
          `env:<NAME>`; a target carries the ref, never the material
          core/provision-host.ts and core/host-record.ts are run by `fli
          basecamp:create` and `fli basecamp:dns` on a LAPTOP, never by the app:
          the droplet, and Basecamp's own A record under the fleet's mark,
          each through this app's connector over core/bearer-send.ts, since
          no app is booted to hold a conduit registry
          core/runtime.ts is the ONE reader of how a container starts —
          App's port, volume, health path and limits, each a `docker run` flag;
          a column added there and not applied by outpost is `FJS-1605` again
          core/variables.ts is what a container's environment IS — the
          environment's `Variable` rows with the app's own on top, snapshotted
          when a release is made and a secret read only when it is sent
          core/session-auth.ts projects this app's OWN User columns onto the
          session and owns both doors suspension is refused at
          core/local-ssh.ts is the operator's own ~/.ssh/config, read on THEIR
          laptop for the import form (`servers.localSshHosts`/`localSshProbe`),
          and core/local-git.ts the git checkouts under a folder there
          (`git.localRepos`, /git-activity/local/). Both are off unless
          LOCAL_MACHINE=1 (`bun run api` sets it) and refused under
          NODE_ENV=production whatever it says (`localMachineRefusal`). ssh is
          always handed `-F` with the file that was listed, because ssh finds ~
          through passwd and Bun through $HOME; git is always handed
          `core.fsmonitor=false`, because a status runs that command
          core/workbench.ts is Claude Code chats per PINNED checkout — tabs
          under the message box, one running at a time since they share the
          tree (`workbench` service, /workbench/), behind the same refusal: each
          message is a detached `claude -p` with permissions bypassed, writing
          its own log under WORKBENCH_DIR (~/.config/basecamp/workbench), so a
          `bun --watch` restart neither kills a run nor loses its status. Not in
          the database — a pin is a folder on this machine. A run ending with
          nothing queued starts the checkout's OWN `fli done` as its own process
          (core/workbench-check.ts, only where the checkout carries done.js) and,
          where the pin asks, a read-only reviewer; each is stamped with when it
          started and hidden once a newer message is sent. core/workbench-diff.ts
          is the diff panel — the TREE against HEAD, so another session's edits
          show there too. core/workbench-run.ts is the Run tab: `fli dev` per app
          and every package.json script, read off fli's `findApps`/`tasks` and
          started by ROW ID, detached, its pid on the pin and its output in its
          own log — never `children.js`, whose in-memory table a `bun --watch`
          restart would lose with the server still up. The checkout's OWN fli,
          and no FRONTIER_PORT_* or PORT of this API's; Unpin and Archive stop it.
          Every spawn the API makes takes junction's `childEnv(env)`, never `...process.env`:
          a git hook, an ssh ProxyCommand and a vite config are not handed
          ENCRYPTION_KEY or the `_FILE` that holds it (`FJS-3359`).
          plugins/workbench-terminal.ts is the Terminal tab: `/ws/terminal/{pin}`
          (under /ws/ because both proxies forward that prefix as a socket),
          Bun's own PTY in the pin's folder, xterm.js in web/src/components/
          Terminal.mesa. Same refusal and ADMINISTRATOR as the service, a key
          refused, and an Origin that is not this machine refused at the
          upgrade. core/workbench-shell.ts names the shell: a tmux session on
          basecamp's OWN tmux server (`-L basecamp`), so a closed socket
          detaches rather than ends it; Unpin and Archive end it.
          A pin may carry PLANS (`plans: [{ path, steps }]`, IDEAS/shipped/workbench-plans.md),
          and `plan` is the path of the SHOWN one, as `chat` is for chats — Go,
          Next, tick and decide act on it; `openPlan` shows one, adding a file
          already written, and `closePlan` forgets one here and keeps the file.
          A step's rows and cost stop at the next step of ANY plan, since the
          registers and the chats are the checkout's. Every status carries
          `questions`, the unruled `Q`s of every plan on the pin (`parsePlan`'s
          `blocking`, kept per file on its mtime) — the card's *needs you*,
          which seeing the chat does not clear and a ruling does.
          `plan` parses the shown file through fli's `parsePlan` on every read, and
          `buildPlan` writes one from a goal in a new chat that may edit THAT
          FILE and nothing else (`askArgv({ edit })`, `buildPlanPrompt`). `go`
          sends the first open box's `stepPrompt` into the shown chat and records
          the step with fli's `registerHigh` — refused while any run is live, or
          the marks would be read under a run still filing. `next` is the
          same step in a NEW chat (`fresh`), sent fli's `nextHandoff` — the
          plan's path and the final text of the checkout's latest run — and
          recorded the same way; refused while the plan's parse has a
          `blocking` (unruled) `Q`, before the chat opens. `tick` is the
          owner's tick on a box a Go'd step's run left open — fli's `tickStep`,
          the one write the UI makes to the file (`FJS-D969`). A step's cost
          is summed on read off its chat's fold (`runs`), from its Go to the
          next Go in that chat — never stored on the pin; so are the register
          rows it filed (fli's `filedSince`), from its marks to the next step's.
          `file` is the tab's File issue / Ask question — fli's `fileIssue`
          into the checkout's ISSUES.md, not refused while a run is live.
          `decide` is a letter on a plan `Q` — fli's `decide` with the plan
          as its `file`, so a PLAN.md outside IDEAS/ is reachable; refused
          while a run is live, since the strike rewrites the plan file.
          `commit` is the Diff tab's: the files the owner ticked, each sent
          with the `blob` the diff read, committed through `git commit --only`
          (core/workbench-diff.ts's `commitFiles`) — so another session's
          staged files stay staged, the checkout's hooks run, and a file
          written since the diff was read is refused by name. A step never
          commits (`FJS-D968`); a branch lands, then commits on its checkout.
          core/workbench-branch.ts is a BRANCH: Fork snapshots the parent's tree through a temporary index (its real index and HEAD
          are only read), cuts wb/<slug> into a worktree under WORKBENCH_DIR/trees
          and pins it, then sets it up before it answers — the parent's copy
          list (gitignored globs, default **/.env) copied across and
          `bun install --no-save`; Land is `git apply --check` then apply, into the
          parent's working tree only. A branch's ports are `fli dev`'s
          (FJS-D841, +N×10000), which is why the API and SPA read FRONTIER_PORT_BE/FE;
          Archive releases them. A checkout pinned with `preview` settings forks
          a PREVIEW: the worktree marked (fli's `markPreview`), its web port
          claimed at the cut, and core/preview.ts's Open — an Environment
          (tier preview, slug wb-<slug>), a static inline App on that port, its
          FRONTIER_PUBLIC_API_URL, the Domain <slug>.<domain>, the placement, and `/route`
          with the port — written through each row's own service as the
          caller; a failed Open removes the rows and archives the branch.
          `freeze` builds web/ with the App's VITE_ and FRONTIER_PUBLIC_ variables, publishes the
          build to the machine ITSELF and releases that digest (the files never
          enter a row — a built SPA is up to 180 files and every row is
          trailed); `thaw` routes back to the port; `archive` on a preview
          RETIRES it first, before the port it routed to is released. verify:provision
          drives it against a stand-in claude (CLAUDE_BIN). Never an agent's
          or a key's: `NOT_FOR_AGENTS` and `OFF_LIMITS` in
          services/api-keys/scopes.ts, proved by verify:mcp
          jobs/ is what runs unattended — a file per job, autoloaded by
          caravan from beside the app root, and the default export is the dispatch handle
          jobs/{recipe,cleanup}-run are both ways this app acts on a MACHINE —
          one shape, opposite safeguards; jobs/outpost-run.ts is their half
          providers/ is who the app SPEAKS to — `index.ts` is nine (eight
          self-hosted appliances, plus `cloudSpend`, somebody else's service
          reached with a token), executor.ts and
          outpost.ts are the fleet's own, and outpost-dev.ts is this laptop
          enrolled as one of them (`bun run dev:outpost`). One folder, because FJS-D06 rules
          Provider to mean a party outside the app and Infisical is one in the
          sense Hetzner is. `hosted` on the portal entry is what separates the
          two kinds, and it is there because *unconfigured* means different
          work for each: install it and set a URL, or open an account and hold
          a key. compute/ and edge/ are the vendors held as a workspace
          ACCOUNT — a `provider_key` Secret that compute/accounts.ts registers
          as `provider:<kind>:<secretId>` through `accountConnectorFor`
          (`FJS-D558`); a *-sink.ts beside each connector is its stand-in.
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
          `servingAddresses` in core/runtime.ts, which only the deploy job's
          `running` mark feeds. Reads at `Domain`'s read gate — the account
          lookup is `asSystem()` confined to the workspace, since a developer
          is below `Secret`'s 5; the portal's `edge` entry reads the same lookup
          services/hub/ is the ONLY service that takes no workspace
          services/pages/ is fli's own inventory (`runnables`, `children`
          from packages/cli/core) over the workspace this API runs in — the
          pages commands declare, and fli's tools — behind the workbench's
          refusal and off-limits to agents and keys. /pages/ opens a page as a
          blob, and a link between two pages is posted back to that tab
          services/registers/ is the workspace's ISSUES.md, DECISIONS.md and
          IDEAS/ through fli's `collectRegisterAtlas` (core/registers.ts caches
          it on the files' mtimes), behind the same refusal. It writes one
          thing itself — a ruling, through fli's `decide` under the register
          guard; everything else is `discuss`, a send to `app.workbench`
          (owned in app.ts, ONE instance, because a queued message lives in
          the instance that started the run) with the prompt
          core/registers.ts composes per intent — `fix` and `frame` are the
          repo's `/fix-next` and `/frame-next`, never a restatement of them.
          /registers/decide/ is `fli decide`'s walk on a phone — `queue` is
          fli's `openDecisions` (the walk's order, with each question's prose),
          a swipe is the same `decide`, held five seconds in the BROWSER for
          Undo; `explain` is fli's read-only `runAsk`, not the workbench, kept
          in this process's memory per question and resumed for a follow-up
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
docs/     SCREENS.md — the mock inventory, 41 of 41 built (FJS-153, closed
          2026-08-30). Four of them are a screen with a skeleton where a third
          party's numbers go — what is owed there is adapters, not UI
          ADAPTERS.md — that debt, per adapter: every boundary declared,
          nothing behind any of them, what wiring one costs and which drive
          assertions flip when you do
          VISION.md · PROVISIONING.md
```

---

