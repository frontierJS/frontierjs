---
id: basecamp-reinstall
status: proposed
dated: 2026-11-03
---

# Idea — back up, restore and reinstall Basecamp from one terminal

**Status: PROPOSED. Ruled: `FJS-D1848`–`FJS-D1851`, Q1–Q4 as `FJS-D1852`–`FJS-D1855`, Q5 as `FJS-D1883`; Phase 0, Phase 1, 2.1 and 2.3 done; 2.2 built, its box run open.** Probed against
the tree 2026-11-03. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-03): a `basecamp:reinstall` that does retire and install together and
asks every question worth asking first, with `basecamp:backup` and `basecamp:restore` beside it. The
reinstall that prompted it walked past the DNS provider (`FJS-D1836`).

## What exists (probed 2026-11-03)

- `fli deploy:retire --production` from `packages/basecamp/` takes Basecamp off `deploy.server`
  (`yuma` in `frontier.config.js`): container, images, Caddy routes, the bare Outpost uninstall, and
  the database directory and `.env.production` unless `--keep-data`.
- `fli basecamp:install <server> --admin <email>` runs `deploy:setup`, the env pair, `fli deploy`,
  `POST /setup` over ssh and `basecamp:dns`. `fli deploy` ships `git archive HEAD`
  (`deploy/_steps-docker/02-ship.md`), so an uncommitted change is not installed.
- `fli basecamp:backup` today pulls one App's archive — the job `fli db:download` already does
  (`FJS-D1717`). `FJS-D1848` hands that job to `db:download` alone.
- The hub side is built (`IDEAS/backups.md` Phase 4): `hub-backups.take` and `.download`,
  `hub-config.attestEscrow`, archives with a `manifest.json`, `/setup` restore from a file or a
  bucket (`HUB_RESTORE_*` for a box with no browser), staged and applied at the next boot, then found
  replicas. Run only against SeaweedFS on a laptop.
- `archiveRefusals` (`basecamp/api/src/domain/backup/archive-manifest.ts`) refuses a damaged
  archive, one under another key, one that applied a migration this code lacks (newer) and one whose
  applied migration was **edited** — what a squash does. `/setup` runs it after the old box is gone.
- `outpost-uninstall --purge` removes every container on the box, every Docker volume, Docker,
  Caddy, Litestream and the Outpost's state (`providers/compute/enrollment.ts`). On a box that runs
  apps beside Basecamp that is their data.

## The target

```
fli basecamp:backup  [server] [--out dir] [--list]
fli basecamp:restore [server] --from <archive dir | bucket> [--key file]
fli basecamp:reinstall [server] [--fresh | --restore] [--plan] [--yes]
```

Reinstall is backup → retire → install → restore, with every question asked before step one and
one typed confirmation, then unattended. `--plan` prints the plan and stops. Both modes back up
first (`FJS-D1849`): **fresh** keeps the archive as insurance, **restore** round-trips through it,
so every restore-mode reinstall is also a restore drill.

## Plan

### Phase 0 — Read the seams

Goal: each command's reused half is named, and the archive check runs on a laptop.
Done when: `archiveRefusals` refuses a pre-squash archive from a laptop, against HEAD's migrations.

- [x] 0.1 Name what `deploy:retire` and `basecamp:install` expose for reuse — steps called with
      answers, or the commands run as children — and which prompts each would ask that reinstall
      has already answered.
      **Retire runs as a child**, `runFli(['deploy:retire', '--production', '--server', dest,
      '--approved'])` from `commands/basecamp/_module.md`: it lives in the `deploy` namespace,
      `--server` is that namespace's flag, and its one prompt is the typed app id
      (`_steps-retire/01-preflight.md`), which `--approved` skips. So reinstall declares
      `confirm: human` itself, and its typed confirmation is what licenses that `--approved`.
      **Install's helpers are already in-process**: `ringZero`, `adminThenFleet`, `zoneRefusal`,
      `pointHost`, `turnOffUnneeded` and `offerProxy` are in the `basecamp` namespace module. Its
      questions are inline in `install.md`'s body: admin email, password, Outpost, fwupd/multipathd,
      the Cloudflare token paste inside `zoneRefusal`, and the proxy flip after. 3.2 lifts them into
      an `askInstall` → answers / `runInstall(answers)` pair that `install.md` and `reinstall.md`
      both call, rather than a second copy. **Restore mode skips `makeAdmin`**: `/setup` answers 409
      once an admin exists, so the restore posts in its place and `joinFleet` runs after the restore.
- [x] 0.2 A script fli runs by path (the `enroll-host.ts` precedent) over `archiveRefusals`:
      archive dir, key, migrations root in; reasons out. Confirm what `/setup`'s
      `stageHubArchive` passes for the key and the install id, since its opts carry only
      `migrationsRoot`.
      `basecamp/api/src/domain/backup/check-archive.ts`: JSON argv `{ dir, keyFile, migrationsRoot }`,
      with the last stdout line `{ ok, takenAt, installId }`, `{ refused }` or `{ error }`. It checks
      a scratch copy, because `archiveRefusals` gives a database with no tracking table one, and
      that write would make the backup fail its own sha256 the next time. `stageHubArchive` passes
      neither: the key is the running process's `ENCRYPTION_KEY`, and the install id is unchecked.
      That is right for a fresh box. Proved against the 2026-10-28 archive in `db/backups/`: refused
      for `initial_schema.sql` as it read before it was rewritten, refused under the development key,
      and the archive's `main.db` sha256 unchanged.
- [x] 0.3 What `hub-backups.take` needs: the API key's scope, whether `basecamp:key --scopes admin`
      covers it, and where the archive lands on a hub with no backup destination.
      `hubBackups:write` for `take`, and `hubBackups:read` for `find`, `get` and `download`. A key
      is built through auth's `toContext` like a session, so it carries its holder's
      `isSystemAdmin`, and `requireSystemAdmin()` answers 404 for a holder without it.
      `basecamp:key` picks its holder among workspace owners and admins, not sysadmins, so 1.2
      names the 404 as "the key's holder is not a sysadmin". The `/setup` admin is one. `take`
      refuses with 400 when the hub has no App row, which only an enrolled box gets (`useHost` →
      `placeHub`), so a `--no-outpost` Basecamp takes 1.3's ssh path. With no destination, the
      archive lands in `backups/` beside the live database, and `download` answers a five-minute
      signed `GET /backup-archive/{id}`. Retire without `--keep-data` deletes that directory, so
      the copy must be on the laptop first.

### Phase 1 — `basecamp:backup` is Basecamp's

Goal: one command leaves Basecamp's current state on the laptop, checked.
Done when: run against yuma, the archive is under `~/.local/share/fli/basecamp/yuma/<stamp>/` and its
manifest's sha256 agree.

- [x] 1.1 `db:download` takes an App's archive alone (`FJS-D1848`): confirm it covers `--take`,
      add it if not, and remove the App body from `basecamp:backup`.
      It did not: `db:download --take` passes `take` to `pullAppArchive`, and refuses with no
      `BASECAMP_APP_ID`, since the ssh copy is already the live file. The App body and its
      `--app`/`--take` flags are gone from `basecamp:backup`.
- [x] 1.2 Take and fetch through the API — `hub-backups.take`, poll, `download` — and check sha256.
      `pullHubArchive` in `cli/core/basecamp.js`: the destination from `hubConfig.current` (a 404
      there is no settings saved, so the disk; a 404 from `hubBackups.find` first is the sysadmin
      refusal), `take`, poll `get` until settled, `download`, and the tar's sha256 when the bucket
      recorded one. A local archive is tarred as it streams and has none, so every unpacked file
      is checked against `manifest.json`. Proved on yuma 2026-11-03: archive under
      `~/.local/share/fli/basecamp/yuma/<stamp>/`, three files matching, and 0.2's script refuses
      it only for the key.
- [x] 1.3 The ssh fallback when the API does not answer: the db directory, the audit trail and
      `.env.production`, marked raw so restore knows `/setup` cannot take it.
      `pullRawBackup` in `cli/core/basecamp.js`, ruled `FJS-D1874`: automatic when the API is
      unreachable, answers 5xx or has no hub App, and `--raw` when asked. `sqlite3 .backup` on the
      box, then a tar over ssh into `<stamp>-raw/` with `db/`, `.env.production` and `raw.json`. The
      key, which yuma keeps in `secrets/ENCRYPTION_KEY`, goes to
      `~/.config/fli/basecamp/<server>/encryption.key` (1.4's file). Proved on yuma 2026-11-04:
      three databases `integrity_check` ok, the key's fingerprint the same as 1.2's manifest, `/data`
      still the App user's, and an unreachable `--url` falls back where a 401 refuses.
- [x] 1.4 The key, asked at each backup (`FJS-D1852`): a mode-600 file under
      `~/.config/fli/basecamp/<host>/`, printed once, or both; `attestEscrow` once a copy is off the box.
      `readBoxKey`, `keepKey` and `attestKeyCopy` in `cli/core/basecamp.js`, ruled `FJS-D1876`: the key
      is read off the box on both paths, one keypress picks, Enter or no terminal files it, and only an
      API backup whose manifest names that key attests. Proved on yuma 2026-11-04: a terminal-less
      `--raw` found it already filed and attested nothing; an API backup answered *both* printed it,
      found it filed, and `hubConfig.current` then read `6b6520fafe6f`, the manifest's.
- [x] 1.5 `--list`: every local backup per host with size, age and manifest version; never pruned
      (`FJS-D1851`).
      `localBackups` and `filedKeys` in `cli/core/basecamp.js`, beside `backupsOf`, which moved there
      for restore. Each row is read from `manifest.json` or `raw.json` and not hashed, and also says
      whether a filed key opens it, since that is what a restore would stop on. A directory with
      neither marker is listed as unreadable. Proved 2026-11-04: yuma's three backups, two archives
      and one raw, with the key filed; in a scratch tree, an unreadable and a not-filed row.

### Phase 2 — `basecamp:restore`

Goal: a freshly installed Basecamp becomes the archived one, refused before the box is touched when
it cannot.
Done when: `verify:hub-restore` stays green and an archive from 1.2 restores onto yuma.

- [x] 2.1 Local preflight with 0.2's script: sha256, key fingerprint, migrations against HEAD.
      `pickArchive` and `checkArchive` in `cli/core/basecamp.js`; `fli basecamp:restore --dry` stops
      after it. The key is `--key`, else the filed one whose fingerprint the manifest names (`filedKeys`
      now answers fingerprint → file). A raw copy is refused, and so is a development-key archive.
      Proved 2026-11-04: every yuma archive is refused for `initial_schema.sql` as it read before the
      squash; an archive built from the dev databases under a minted key passes; a missing filed key,
      a wrong `--key` and a raw `--from` are each refused before the box is asked anything.
- [ ] 2.2 On the box: the archive's key into `secrets/ENCRYPTION_KEY`, which the container reads as
      `ENCRYPTION_KEY_FILE` (not `.env.production`, whose lines a restart does not re-read), the
      archive to `POST /setup/restore` over ssh (the way `--admin` posts `/setup`), restart, poll
      `/setup/probe` until `done`.
      Built: `probeBox`, `putBoxKey`, `restartApi`, `probeUntil`, `stageOnBox`; `apiContainer` moved
      to `cli/core/ports.js` so restore names the container the deploy does. A Basecamp that is set
      up is refused before the confirmation. Proved against a scratch API on 7120 over the local
      transport: staged 202, restart, `done` with the archive's `takenAt`, a second stage 409. Open:
      `putBoxKey` and `docker restart` on a real box with a fresh, unclaimed Basecamp.
- [x] 2.3 Report: found replicas and archives, and which fleet machines still heartbeat — the same
      key derives the same hub signing key (`FJS-D1646`), so one at the same URL needs nothing.
      `restoreFindings` in `cli/core/basecamp.js`, read with `BASECAMP_API_KEY` at `--url` (the
      archive's key rows come back with it): a machine is heard when its `lastHeartbeatAt` is newer
      than the archive, which only the restored hub could record; waits up to 90s for every enrolled
      machine. The reconcile marks no end, so later findings are left to `/hub/backups/` and the App
      screen. `hubConfig` is not a scopable service, so a scoped key reports the hub's own replica as
      unknown; `appBackups.find` refuses `kind` as a filter, so found rows are picked client-side.
      Proved 2026-11-04 on a scratch API restored from a built archive, a whole key minted through
      `app:repl`: a machine heard after the archive read heard, one silent read not, one never
      enrolled left out.

### Phase 3 — `basecamp:reinstall`

Goal: one command, every question first, both modes.
Done when: yuma is reinstalled in fresh mode and a throwaway box built at HEAD in restore mode
(`FJS-D1883`), and the first screen after login is the setup checklist (fresh) or the old fleet
(restore).

- [x] 3.1 Preflight reads: HEAD against the dirty tree under `packages/basecamp/`, the deployed sha,
      and from the old Basecamp its fleet machines, the apps on this box, its hostname and the
      Outpost version against `OUTPOST_VERSION`.
      `readOld` in `commands/basecamp/reinstall.md`. The sha is the repo tag `02-ship` put on the
      container's image, and the hostname is the env file's `FRONTIER_APP_URL`. The fleet is one
      `deploy:repl -e` expression, which needs no API key, and Basecamp's box is picked as
      `hostServer` picks it. `-e` answers undefined for a block-bodied arrow (`FJS-3999`). Every
      other container on the box is listed, matched to an App by its `fjs.app` label. Proved on
      yuma 2026-11-04: running `abef3c26d` against HEAD `274e6e2a4`, Outpost `0.1.9` matching, and
      the `kapp` container named as App `7f691013`, released by an earlier Basecamp, since this one's
      `kapp` is `be3a35a4`.
- [x] 3.2 The questions, the printed plan and one confirmation; `--plan` stops there, `--yes` takes
      the defaults and still refuses what 3.3 refuses.
      Install's questions and run moved into `askInstall` / `installRows` / `runInstall` in the
      `basecamp` module, which `install.md` now calls too. Restore mode skips the admin. The mode
      is a keypress, and under `--yes` the default is **restore**, since it is the mode that
      refuses before the box is touched. The confirmation is the box's name, typed. Proved on
      yuma 2026-11-04 with `--plan --yes` in both modes: the steps are numbered per mode, and the
      install rows sit under step *install*.
- [ ] 3.3 Phase 1's backup, then in restore mode 2.1's preflight — a refusal ends the run with the
      box untouched. Fresh mode with no key copy off the box refuses unless told the data goes.
      Built: `takeBackup`, `keyFor` and `checkHere` moved into the module from `backup.md` and
      `restore.md`, and `backUpFirst` calls them. A raw fallback refuses restore mode. Fresh mode
      with no key copy refuses unless `--new-key`, which is also Q2's "a new one only when asked". It is
      refused with restore mode, since an archive opens only under the key it was taken with.
      `takeBackup` also answers the key's value, so fresh mode carries a key that was only printed.
      Open: a run on yuma, which takes a real backup.
- [ ] 3.4 Retire with the bare Outpost uninstall. Purge only on its own flag, with the apps it
      removes named and typed.
      Built: `retire` runs `deploy:retire --production --approved` as a child, licensed by the typed
      box name. `--purge` lists every other container before the run and takes `purge` typed, then
      runs `outpost-uninstall --purge --yes` after the retire; a box with no uninstaller warns and
      the install goes on. Open: a run on a box.
- [ ] 3.5 Install, with the key per Q2, and the Cloudflare token asked once for both jobs —
      Basecamp's own record, then the provider key and ingress zone per Q4, so the checklist's DNS
      step is done before login.
      Built: `seedBoxKey` writes the carried key to `secrets/ENCRYPTION_KEY` between the retire and
      `deploy:setup`, whose 03-directories leaves a key it finds: the old box's, the archive's in
      restore mode, or a `--new-key` one filed off the box before the retire. Q4 is `askIngress` in
      the module, asked before the run in fresh mode: `host-record.ts`'s check now answers the
      token's zones, the hostname's is the default, and more than nine are typed by name. The writes
      are `keepEdge` after the API key is minted — `POST /secrets` and `PATCH /workspaces/<id>` from
      the box over ssh stdin, so the token sits in no argv. `runInstall` answers `{ code, installed }`,
      so a failed record does not read as a failed install. Proved: the zone check against
      Cloudflare answered 20 zones and `kobami.cloud` for the hostname. Open: `keepEdge` against a
      real new Basecamp.
- [ ] 3.6 Restore mode: Phase 2 on the new box.
      Built: restore's `emptyOnBox`, `boxRunsKey`, `swapIn` and `reportFindings` moved into the
      module, and `restoreOnto` runs them, then `deploy:outpost`. Found here: a restored host row
      has heartbeated, so `enroll-host.ts` answered *in the fleet already* and installed nothing on
      a box with no Outpost — `FJS-4010`, fixed by `fli deploy` reporting a missing `outpost.service`
      and `useHost` re-issuing for it. Open: the throwaway box run (`FJS-D1883`).
- [ ] 3.7 After: `basecamp:key` re-mints `BASECAMP_API_KEY`, the old App ids and names are printed
      for the owner to find (`FJS-D1854`), and `infra.launch`'s steps are printed.
      Built: fresh mode mints with `adminKey` (which now answers the token), keeps the Cloudflare key,
      and prints the old Apps; restore mode mints nothing, since the old key opens the restored hub
      again, and reports what it hears. Both print `infra.launch` read through `deploy:repl`. Open:
      both runs.

### Phase 4 — Runbook

Goal: the backup runbook names the commands.
Done when: `docs/backups.md` § 7 and `packages/cli/README.md` cite the three commands, `fli done`
clean.

- [ ] 4.1 Rewrite § 7 around `basecamp:backup` / `basecamp:restore`; keep the terminal recipe for a
      box whose `/setup` cannot be reached.

## Open questions

1. ~~**Q1 — Where does the key copy go?**~~ **Answered 2026-11-04 (`FJS-D1852`): C — both, asked at each backup.**
   - **A** — a mode-600 file in a separate tree, `~/.config/fli/basecamp/<host>/encryption.key`.
   - **B** — printed once for a password manager, never written.
   - **C** — both, asked at each backup.
   - **Recommend A** — restore reads it without a paste, and it is not beside the archive, so one
     copied folder is not both halves.
2. ~~**Q2 — Does fresh mode keep the old key?**~~ **Answered 2026-11-04 (`FJS-D1853`): A — carry it by default, a new one only when asked.**
   - **A** — carry it by default, a new one only when asked.
   - **B** — always a new key.
   - **Recommend A** — every older archive stays restorable onto the new box, and the fleet's
     Outposts keep trusting the hub's derived signing key.
3. ~~**Q3 — Which repos are scanned for a stale `BASECAMP_APP_ID`?**~~ **Answered 2026-11-04 (`FJS-D1854`): B — none; print the old App ids and names.**
   - **A** — this workspace and `../fjs-prototypes/*`, read only.
   - **B** — none; print the old App ids and names.
   - **Recommend A** — those are where the ids live today, and the scan only reads.
4. ~~**Q4 — Is the install's Cloudflare token stored as the in-app provider key?**~~ **Answered 2026-11-04 (`FJS-D1855`): A — asked, yes by default, with the zone picked from the token's zones.**
   - **A** — asked, yes by default, with the zone picked from the token's zones.
   - **B** — always.
   - **C** — never.
   - **Recommend A** — one keypress closes the step that was walked past, and a token scoped to one
     zone may not be the one apps should use.
5. ~~**Q5 — How does yuma get past its pre-squash history?**~~ **Answered 2026-11-04 (`FJS-D1883`): A — reinstall yuma fresh only, keeping its archive as insurance; restore mode is proved on a throwaway box built at HEAD.** Every yuma archive is refused by HEAD:
   its `main.db` applied `initial_schema.sql` as it read before the 11-04 squash rewrote it (2.1's
   proof), so Phase 3's restore-mode reinstall of yuma cannot pass.
   - **A** — reinstall yuma fresh only, keeping its archive as insurance; restore mode is proved on
     a throwaway box built at HEAD.
   - **B** — rewrite yuma's tracking row for the initial migration to the squashed file's, then
     back up again, so restore mode runs on yuma itself.
   - **C** — `archiveRefusals` accepts a squashed initial whose schema matches.
   - **Recommend A** — migrations are not frozen before alpha, so a pre-squash database will keep
     turning up, and B is a hand edit to a live database.

## See also

`IDEAS/backups.md` (the hub archive and `/setup` restore), `IDEAS/box-layout.md` (what lives on a
fleet box), `FJS-D1836` (the setup checklist).
