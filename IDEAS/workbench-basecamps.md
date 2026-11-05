---
id: workbench-basecamps
status: proposed
dated: 2026-11-03
---

# Workbench over Basecamps — ring 0 on a screen

**Status: PROPOSED.** Dated 2026-11-03. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want: Workbench talks to every Basecamp this laptop has made, and gives each
one a small control plane — back it up, restart it, and later create and destroy
one. Small next to being inside Basecamp: Apps, servers, people and per-App
backups stay on Basecamp's own pages.

**This is ring 0** (`deploy-plane.md` § The bootstrap ring). A control plane
cannot restart, upgrade or destroy itself — the plane never holds the knife to its
own throat — so those calls come from outside it, and ring 0 is defined as *from a
laptop*. Workbench is the laptop's app. It adds an index and a screen over verbs
fli already has; it adds no noun to Basecamp and no import between the two
packages (`packages/workbench/CLAUDE.md`).

---

## What exists

- **Every verb, as a fli command.** `basecamp:create` buys a box and runs
  `basecamp:install`; `basecamp:key` mints an admin API key over ssh into
  `~/.config/fli/.env`; `server:destroy` deletes a box `server:create` made.
  Basecamp backs itself up through `hubBackups.take`
  ([hub-backups.service.ts](../packages/basecamp/api/src/services/hub-backups/hub-backups.service.ts)),
  system-admin only. Restart has no command; deploy restarts units over ssh
  (`packages/cli/commands/deploy/_module.md`), and the API container's name is
  `apiContainerName()` in `packages/cli/core/ports.js`.
- **No index of Basecamps.** Each `fli basecamp:*` command reads one
  `BASECAMP_URL` and one `BASECAMP_API_KEY` from the environment, so a second
  Basecamp is a hand-edited env file. `demo-box.md` names the gap: nothing indexes
  the fleet of Basecamps, and `server-destroy.job` runs inside the Basecamp that
  made the box.
- **The name already exists.** `basecamp:create` writes a `Host <name>` block to
  `~/.ssh/config`. That name is the entry's key here, so no new noun is coined.
- **Workbench dials one Basecamp already**, as a signed peer for previews
  ([basecamp.ts](../packages/workbench/api/src/domain/peer/basecamp.ts)),
  from `BASECAMP_URL` and `BASECAMP_KEY_ID`. It imports `packages/cli/core/*`
  by path, as `atlas.ts` does.

## Prior art

- **Kamal** — a laptop CLI over ssh boots, restarts and removes the stack, and
  nothing on the box manages it. This paper takes that role for Basecamps.
- **Portainer** — an agent on each box answers to one console. Basecamp already
  plays that role for Apps through the Outpost; reusing the Outpost on
  Basecamp's own box would be Basecamp restarting itself.

## Security

Workbench now holds an admin key for every Basecamp this laptop made. It binds
loopback behind one pass-phrase (`WORKBENCH_KEY`), and the file is `0600`, the
same posture as `~/.config/fli/.env` today. ssh stays the root of trust: a lost
key is minted again over ssh, and Workbench never asks Basecamp for a credential
it could not get by ssh. Under Q4 an entry also holds the preview peer's key id,
so one entry carries two credentials of different power: the admin key reaches
every system-admin call, and the peer key reaches only what `FJS-D1188` grants a
peer.

## Phases

### Phase 0 — Groundwork

Goal: what each verb needs, measured against a real Basecamp.
Done when: each probe's finding is written under its step.

- [x] 0.1 List every reader of `BASECAMP_URL` / `BASECAMP_API_KEY` and split
  the laptop's from the box's. Laptop-side: the `basecamp:*` commands,
  `ws:deps --push`, `db`, `outpost:status` and the `tutor` fixture — each moves
  to the index. Box-side: `packages/outpost/src/config.js` and Basecamp's own
  providers read the in-box env and keep it. For each laptop reader, note what
  it needs: the origin, the key, or the ssh Host.
  **Listed 2026-11-04.** Origin + key: the shared `originOf` and key readers in
  `basecamp/_module.md`, `app`, `deploy`, `live`, `posture`, `backup`, `restore`,
  `reinstall`, `outpost:install`, `outpost:status` (hub optional: no entry means
  the ssh-only path, not a refusal), `utils/dev.md` (the App's port). Scoped key:
  `ws:deps --push`, `db` and `db:download`. Writers, which 1.2 turns into the
  entry: the key-minting step in `_module.md` (create and install), `key.md`,
  `reinstall.md` fresh mode. Exempt: the `tutor` fixture hands `BASECAMP_URL` to
  the box's Outpost env, box-side in kind; Workbench's `env.ts`/`app.ts` was the
  signed peer's own pair, Q4's, and reads the entry since 1.6. Tests setting the pair: `basecamp-posture.test.js`,
  `vendor.test.js`.
- [~] 0.2 Against the local dev Basecamp, `hubBackups.take` then poll `find`
  with a key `basecamp:key` minted, from outside Basecamp's process — dropped:
  answered by `IDEAS/basecamp-reinstall.md` 1.2. `pullHubArchive` in
  `core/basecamp.js` takes through `hubBackups.take`, polls `hubSettled` until
  the row is `success` and refuses any other status; it has run against a box.
- [ ] 0.3 Restart Basecamp's API container over ssh on a box, and time how long
  until its health route answers again. The box is the owner's; ask first.
  Until measured, restart waits `probeUntil`'s three minutes.

### Phase 1 — The index (fli)

Goal: fli knows every Basecamp by its ssh Host name.
Done when: `fli basecamp` lists the dev Basecamp and one box, each with whether
it answers, and `bun run test` in `packages/cli` is green.

- [x] 1.1 `packages/cli/core/basecamps.js` reads and writes `basecamps.json`
  (`0600`) in the directory `core/global-env.js` owns, never a hand-spelled
  path: per name, the API origin, the ssh Host, the cloud and box id, and the
  API key (Q1, Q2). The Host is optional: the local dev Basecamp is the
  reserved name `dev`, and a CI machine adds an entry with no Host. Restart
  refuses an entry with no Host.
  **Built 2026-11-04:** `readBasecamps`, `writeBasecamp` (0600, re-chmods a
  looser file; `runs: true` moves the Charter designation so one entry holds it),
  `removeBasecamp`, `resolveBasecamp(name?)` (one entry is the default; several
  and no name refuses listing them), `designatedBasecamp`; `test/basecamps.test.js`
  over a temp home. The laptop's file was seeded with `yuma` from the env pair;
  the pair stays in `~/.config/fli/.env` until 1.3 lands and the owner deletes it.
- [x] 1.2 `basecamp:create`, `basecamp:install` and `basecamp:key` write the
  entry; the key moves out of the global env into it.
  **Built 2026-11-04:** `adminKey` in `basecamp/_module.md` (which `create` and
  `reinstall` call; `install` never minted a key) files `{ url, host, cloud,
  boxId, apiKey }` through `fileBasecamp(name, fields)`, a merge that keeps a
  `scopedKey` and the `runs` mark across a re-mint. `basecamp:key` takes
  `--basecamp` and `--domain`. The `dev` entry is written by hand into the file,
  since `basecamp:key` mints over ssh and the dev Basecamp has no box; no add
  verb (cut one level simpler).
- [x] 1.3 Every laptop reader 0.1 found takes `--basecamp <name>`; with one
  entry it is the default, and with several and no flag the command refuses by
  name and lists them. `BASECAMP_URL` / `BASECAMP_API_KEY` leave every laptop
  reader in the same change, with no alias. `ws:deps --push` and `db` keep
  their scoped key: the entry holds the admin key for ring-0 verbs, and a
  scoped key beside it when one was issued.
  **Built 2026-11-04.** `reachBasecamp(name, log, { scoped })` in `core/basecamps.js`
  is the one refusal; `lookupBasecamp` is the soft form for `outpost:status` (a
  named box keeps the ssh-only screen and says the hub was not read) and
  `utils/dev.md` (no entry, no port lookup). A `<server>` positional doubles as
  the entry name in `backup`, `restore` and `reinstall`, since the key is the ssh
  Host. `fli deploy` takes `--basecamp` and passes it to `basecamp:deploy`.
  `ws:deps --push`, `db:download` and `db:import` use `scopedKey ?? apiKey`.
  `--url` is gone everywhere, and so is `LOCAL_BASECAMP`. The only hits left are
  the `tutor` fixture, which hands `BASECAMP_URL` to the box's Outpost env.
- [x] 1.4 `fli basecamp` lists the entries and whether each answers.
  **Built 2026-11-04:** `basecamp:list`, alias `basecamp` (the `server:list` pattern);
  `pingBasecamp` in `core/basecamps.js`, one unsigned GET to `/health` per entry in
  parallel, 3 s each; an HTML 200 is "not the API". A silent entry is information,
  so the exit code stays 0. `--json` prints the rows with keys as booleans.
- [x] 1.5 Pin the boundary in `packages/cli`: no command source reads either
  env var, the file is `0600`, and every entry with a Host names one in
  `~/.ssh/config`. The last two are `fli doctor` rows as well.
  **Built 2026-11-04:** `test/basecamps-boundary.test.js` walks `commands/**/*.md` and
  `core/**/*.js` for the two names, allowing only the tutor fixture's two files and
  checking the allowance is still used. `core/doctor.js` `basecampRows`: a warn when
  the file has a group or other bit set (`chmod 600`), and a warn per entry whose
  `host` has no literal `Host <name>` in `~/.ssh/config`; `dev` is not graded.
- [x] 1.6 Workbench reads its Basecamp from the index by name (Q4, `FJS-D1898`).
  **Built 2026-11-04:** `api/src/core/env.ts` holds `BASECAMP` (default `dev`), the
  name of the entry, and `app.ts` resolves it with `resolveBasecamp`, falling back
  to `http://127.0.0.1:8120` for `dev` alone; any other absent name stops the boot.
  The entry's `peerKeyId` is the id Basecamp's "Add a peer" form answers, and the
  not-enrolled refusal names that field and the file. `basecamps-boundary.test.js`
  also walks `packages/workbench/api/src` for the old pair.

### Phase 2 — Back up and restart (fli)

Goal: both verbs work from a terminal before a screen exists.
Done when: each reports the outcome Basecamp recorded, not the outcome it asked
for — backup the `HubBackup` row's status, restart what `/setup/probe` answers
after the container is back. Backup runs against any entry with a key; restart
needs a Host, so its live run is a box and is 0.3.

- [x] 2.1 Take Basecamp's own backup and wait for it to settle. The spelling is a
  new verb or a flag on `basecamp:backup`, whose default today is an App; settle it
  through `decision-rules` at the step. Settled by `FJS-D1848`: `fli basecamp:backup` is
  Basecamp's own, built as `IDEAS/basecamp-reinstall.md` 1.2.
  **Built there.** `fli basecamp:backup <server>` takes, polls, downloads and
  checks the manifest; a Basecamp whose API cannot back up falls to the ssh copy.
- [x] 2.2 `fli basecamp:restart <server>` restarts the API container over ssh and
  waits until the health route answers. A wrapper over `restartApi` and
  `probeUntil` in `core/basecamp.js`, which `IDEAS/basecamp-reinstall.md` left
  with no caller; the container is `apiContainerName()` in `core/ports.js`. The
  `<server>` positional doubles as the entry name, as `backup` does, and an entry
  with no Host is refused by name (1.1). Proved here by `--dry` against a box
  entry; the live run is 0.3.
  **Built 2026-11-05:** `commands/basecamp/restart.md`. Container and port come
  from `packages/basecamp/frontier.config.js` as `restore.md` reads them
  (`frontier-basecamp`, 8120); the box is the entry's `host`, so `ssh` goes
  through the `Host` alias. The result line is what `/setup/probe` answered
  (users, workspaces, a restore in flight) — it carries no version. `--dry`
  against `yuma` printed the plan and ran nothing.

### Phase 3 — The screen (Workbench)

Goal: the same verbs from Workbench.
Done when: on `/basecamps/`, signed in, every entry in `basecamps.json` is
listed with whether it answers; Back up now against one that answers shows the
row Basecamp recorded; Restart on an entry with no Host is refused by name on
the page, and on a box it shows what the probe answered (the box run is 0.3).
The service's test runs both verbs against a stub Basecamp, the shape of
`api/test/peer-dialer.test.ts`.

- [x] 3.1 A `basecamps` service in Workbench over `core/basecamps.js` and the
  Phase 2 helpers, imported by path. Four methods, all ADMINISTRATOR: `list`
  (entries without their keys, whether each answers, the newest `HubBackup`
  Basecamp holds, and the held outcome of the last verb), `backup` and `restart`
  (each starts the verb and holds its outcome in memory, the shape of `explain`
  in `domain/atlas/atlas.ts`), and `outcome` (what the page polls). Taking
  without downloading splits `takeHubBackup` out of `pullHubArchive` in
  `core/basecamp.js`; the screen never pulls an archive to the laptop. No
  credential leaves the API: `apiKey`, `scopedKey` and `peerKeyId` stay out of
  every answer.
  **Built 2026-11-05:** `api/src/domain/basecamps/basecamps.ts` and
  `services/basecamps/basecamps.service.ts`; `api/test/basecamps.test.ts` runs
  both verbs against a stub Basecamp over a temp index. A key refused by
  Basecamp (a scoped one without `hubBackups:read`, 403) is answered as
  `backupError` so it never reads as "none yet". Basecamp's container and port
  are `basecampApi()` in `core/basecamp.js`, the one reading `restart`,
  `restore` and `reinstall` now share, since Workbench imports nothing from
  Basecamp.
- [x] 3.2 `/basecamps/` lists each entry with whether it answers, plus Back up now
  (with the newest backup's time) and Restart behind a confirm, the kit's
  `ConfirmationPopover`. An outcome line per entry, polled while a verb runs.
  Nav entry in `web/src/lib/nav.js`; the proxied path comes from the regenerated
  `app.snapshot.md` (`packages/workbench/CLAUDE.md` § Traps).
  **Built 2026-11-05:** `web/src/routes/basecamps/index.mesa` over
  `resources/Basecamp.mesa`. Driven in Chrome against the real index: four rows;
  `dev` (hand-written that day, `http://127.0.0.1:8120`, no key, no Host) shows
  both buttons disabled with their reasons; Back up now on `yuma` settled in 3 s
  with the `HubBackup` row Basecamp recorded as `success`; the Restart confirm
  opened and cancelled; no console error or failed request. The live restart
  from the page is 0.3.
- [x] 3.3 Create is a form over `basecamp:create --yes`, run as a job whose output
  streams to the page, since a box takes minutes. The form says the box is
  billed from that moment and that undoing it is `fli server:destroy` (Q3).
  Proved here with `--dry`; the first purchase from the page is the owner's.
  **Built 2026-11-05:** `web/src/routes/basecamps/new/index.mesa` over two more
  service methods, `provision` (a write: the API spawns `fli basecamp:create
  --yes … --approved` detached, its log under `WORKBENCH_DIR/logs/`) and
  `creation` (the held run with the tail of its log, polled until it exits);
  `domain/basecamps/basecamps-create.ts`, `api/test/basecamps-create.test.ts`.
  The page's confirm is the person's yes that `confirm: human` asks for, so
  `--approved` goes with it, as `fli gui` sends. The method is `provision`
  because `create` is every service's CRUD name. Driving it found that
  `basecamp:create --dry` bought anyway — buying runs its own provisioner, and
  `--dry` intercepts only `$.exec` (`FJS-4048`, closed: the command stops at its
  summary). Driven in Chrome against the real tokens: a hostname in no zone the
  token opens exits 1 with Cloudflare's refusal in the log; `dry-proof.awe.dev`
  prints the summary and "The plan ran. Nothing was bought."; no console error
  or failed request. The held run is in memory, so an API restart forgets it
  while the log file stays.

**Done 2026-11-05.** Every verb is on the screen and driven with the real index.
Found: a service over `cli/core` by path needs the cli's own readings
(`basecampApi()`) rather than Basecamp's config, and a dry run is only a proof
once the command answers `--dry` itself. Still the owner's: a live Restart on a
box (0.3) and the first purchase from the page.

## Open questions

- ~~**Q1 — How Workbench authenticates to each Basecamp.**~~ **Answered 2026-11-03 (`FJS-D1827`): A — ssh is the root; an admin API key per Basecamp is minted over ssh as `basecamp:key` does, and restart uses ssh.**
  - **A** — ssh is the root; an admin API key per Basecamp is minted over ssh as
    `basecamp:key` does, and restart uses ssh.
  - **B** — Widen the signed peer to system-admin calls.
  - **C** — ssh for everything; a backup is a command run on the box.
  - **Recommend A** — ring 0 already trusts ssh, and the peer door stays as
    narrow as `FJS-D1188` left it. C skips Basecamp's own record of its backups.
- ~~**Q2 — Where the index lives.**~~ **Answered 2026-11-03 (`FJS-D1828`): A — A fli-owned file, `~/.config/fli/basecamps.json`, read by Workbench through `cli/core`.**
  - **A** — A fli-owned file, `~/.config/fli/basecamps.json`, read by Workbench
    through `cli/core`.
  - **B** — A model in `packages/workbench/db/schema.lite`.
  - **Recommend A** — fli and the screen read one list; under B fli cannot see
    it and the two drift.
- ~~**Q3 — Destroy in the first version.**~~ **Answered 2026-11-03 (`FJS-D1829`): C — No destroy yet; it stays `fli server:destroy`.**
  - **A** — Take and verify a fresh backup, require the name typed, then
    `server:destroy`; DNS and the bucket kept.
  - **B** — A, plus removing the DNS record and the backup bucket.
  - **C** — No destroy yet; it stays `fli server:destroy`.
  - **Recommend A** — the backup-first gate is what makes destroying from a
    screen safe.
- ~~**Q4 — Workbench's preview Basecamp.**~~ **Answered 2026-11-04 (`FJS-D1898`): A — The preview peer reads its Basecamp from the index, by name, and `BASECAMP_URL` / `BASECAMP_KEY_ID` leave `api/src/core/env.ts`.**
  - **A** — The preview peer reads its Basecamp from the index, by name, and
    `BASECAMP_URL` / `BASECAMP_KEY_ID` leave `api/src/core/env.ts`.
  - **B** — Previews keep their own env pair.
  - **Recommend A** — one list of Basecamps on this laptop, not two. The peer key
    id joins the entry.
- ~~**Q5 — Whether the screen edits the index.**~~ **Answered 2026-11-05 (`FJS-D1961`): A — Verbs only. Entries are read; a key is minted by `basecamp:key` over ssh and an entry is written by `create`, `install`, `key` or a hand edit.** The owner minted a `chartered`
  entry by hand on 2026-11-05 and asked whether `/basecamps/` should cover
  enrolling and keys as well as the verbs.
  - **A** — Verbs only. Entries are read; a key is minted by `basecamp:key` over
    ssh and an entry is written by `create`, `install`, `key` or a hand edit.
  - **B** — A form that adds, renames and forgets an entry (url, Host, cloud,
    box id), with no key field; keys stay ssh-minted.
  - **C** — B plus a key field, so a key from Basecamp's API keys screen can be
    pasted in.
  - **Recommend A** — `core/basecamps.js` stays the one writer (`FJS-D1828`),
    and a key typed into a browser is a second way to hold a credential
    `FJS-D1827` ruled ssh the root of. A re-mint by `basecamp:key` would also
    silently replace a pasted key. The reopen is a Forget button over
    `removeBasecamp` if a stale entry ever needs clearing from the screen.

## Out of scope

- **Destroy** — stays `fli server:destroy` (Q3). When it comes back it needs a
  ring-0 path of its own, since `server-destroy.job` runs inside the Basecamp
  that made the box (`demo-box.md`).
- **A box reboot** at the cloud — restart here is the container only.
- **Upgrading Basecamp** — `fli basecamp:deploy` already does it, as ring 0.
