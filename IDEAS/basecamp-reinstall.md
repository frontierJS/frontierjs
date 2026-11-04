---
id: basecamp-reinstall
status: proposed
dated: 2026-11-03
---

# Idea — back up, restore and reinstall Basecamp from one terminal

**Status: PROPOSED. Ruled: `FJS-D1848`–`FJS-D1851`, Q1–Q4 as `FJS-D1852`–`FJS-D1855`; nothing is built.** Probed against
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

- [ ] 0.1 Name what `deploy:retire` and `basecamp:install` expose for reuse — steps called with
      answers, or the commands run as children — and which prompts each would ask that reinstall
      has already answered.
- [ ] 0.2 A script fli runs by path (the `enroll-host.ts` precedent) over `archiveRefusals`:
      archive dir, key, migrations root in; reasons out. Confirm what `/setup`'s
      `stageHubArchive` passes for the key and the install id, since its opts carry only
      `migrationsRoot`.
- [ ] 0.3 What `hub-backups.take` needs: the API key's scope, whether `basecamp:key --scopes admin`
      covers it, and where the archive lands on a hub with no backup destination.

### Phase 1 — `basecamp:backup` is Basecamp's

Goal: one command leaves Basecamp's current state on the laptop, checked.
Done when: run against yuma, the archive is under `~/.local/share/fli/basecamp/yuma/<stamp>/` and its
manifest's sha256 agree.

- [ ] 1.1 `db:download` takes an App's archive alone (`FJS-D1848`): confirm it covers `--take`,
      add it if not, and remove the App body from `basecamp:backup`.
- [ ] 1.2 Take and fetch through the API — `hub-backups.take`, poll, `download` — and check sha256.
- [ ] 1.3 The ssh fallback when the API does not answer: the db directory, the audit trail and
      `.env.production`, marked raw so restore knows `/setup` cannot take it.
- [ ] 1.4 The key, asked at each backup (`FJS-D1852`): a mode-600 file under
      `~/.config/fli/basecamp/<host>/`, printed once, or both; `attestEscrow` once a copy is off the box.
- [ ] 1.5 `--list`: every local backup per host with size, age and manifest version; never pruned
      (`FJS-D1851`).

### Phase 2 — `basecamp:restore`

Goal: a freshly installed Basecamp becomes the archived one, refused before the box is touched when
it cannot.
Done when: `verify:hub-restore` stays green and an archive from 1.2 restores onto yuma.

- [ ] 2.1 Local preflight with 0.2's script: sha256, key fingerprint, migrations against HEAD.
- [ ] 2.2 On the box: `ENCRYPTION_KEY` into `.env.production`, the archive to `POST /setup/restore`
      over ssh (the way `--admin` posts `/setup`), restart, poll `/setup/probe` until `done`.
- [ ] 2.3 Report: found replicas and archives, and which fleet machines still heartbeat — the same
      key derives the same hub signing key (`FJS-D1646`), so one at the same URL needs nothing.

### Phase 3 — `basecamp:reinstall`

Goal: one command, every question first, both modes.
Done when: yuma is reinstalled once in each mode and the first screen after login is the setup
checklist (fresh) or the old fleet (restore).

- [ ] 3.1 Preflight reads: HEAD against the dirty tree under `packages/basecamp/`, the deployed sha,
      and from the old Basecamp its fleet machines, the apps on this box, its hostname and the
      Outpost version against `OUTPOST_VERSION`.
- [ ] 3.2 The questions, the printed plan and one confirmation; `--plan` stops there, `--yes` takes
      the defaults and still refuses what 3.3 refuses.
- [ ] 3.3 Phase 1's backup, then in restore mode 2.1's preflight — a refusal ends the run with the
      box untouched. Fresh mode with no key copy off the box refuses unless told the data goes.
- [ ] 3.4 Retire with the bare Outpost uninstall. Purge only on its own flag, with the apps it
      removes named and typed.
- [ ] 3.5 Install, with the key per Q2, and the Cloudflare token asked once for both jobs —
      Basecamp's own record, then the provider key and ingress zone per Q4, so the checklist's DNS
      step is done before login.
- [ ] 3.6 Restore mode: Phase 2 on the new box.
- [ ] 3.7 After: `basecamp:key` re-mints `BASECAMP_API_KEY`, the old App ids and names are printed
      for the owner to find (`FJS-D1854`), and `infra.launch`'s steps are printed.

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

## See also

`IDEAS/backups.md` (the hub archive and `/setup` restore), `IDEAS/box-layout.md` (what lives on a
fleet box), `FJS-D1836` (the setup checklist).
