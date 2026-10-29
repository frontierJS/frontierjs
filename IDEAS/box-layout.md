---
id: box-layout
status: proposed
dated: 2026-10-28
---

# Idea — a fleet box's files under Outpost's name, with one folder to look in

**Status: PROPOSED. Ruled as `FJS-D1544` (E); nothing is built.** Probed against the tree 2026-10-28. Do not
cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-10-27): one place on a server to find everything, and an
app's SQLite files reachable as plain files from the server, the way a CapRover or
Forge box mounts `/db` from a host folder. `FJS-D1544` ruled the shape: the real
directories follow FHS under Outpost's name and are made by systemd, and
`/frontier-outpost/` holds only links to them.

```
/etc/outpost/                 ConfigurationDirectory=outpost
  outpost.env · outpost.crt · outpost.key · litestream.yml · firewall.nft
/var/lib/outpost/             StateDirectory=outpost
  apps/<app>/data/            bind-mounted at the App's volumePath (.db files)
  builds/                     checkouts and build caches (today's apps/, FJS-D1614)
  static/ · backups/ · restore/ · replica-restore/ · deploy-keys/ · uids.json
/frontier-outpost/            links only, read by people, never by code
  config -> /etc/outpost
  data   -> /var/lib/outpost
  logs   -> /var/log/caddy     per-app access logs (FJS-D1617)
```

**Not in this plan.** `fli deploy` over SSH keeps `/apps/<app>/db` (`FJS-D1120`);
Basecamp's own database on its host stays where that deploy put it, named to
Outpost by `OUTPOST_HOST_DB_PATH`. Boxes are reinstalled, not migrated: nothing
has shipped.

---

## Phase 0 — What a box holds today

Goal: every path a box gets, with its writer and readers, and the four questions ruled.
Done when: Q1–Q4 are ruled and 0.2's probe output is recorded under it.

- [x] 0.1 Inventory the paths
  - Outpost defaults, `packages/outpost/src/config.js`: `workDir` `/var/lib/outpost/apps` (build checkouts, `docker.js` § build), `restoreDir`, `backupDir`, `replicaStageDir`, `uidFile`, `deployKeyDir`, `staticDir`, all under `/var/lib/outpost`; `litestreamConfig` `/etc/basecamp/litestream.yml`; `litestreamMetaDir` `/var/lib/litestream`.
  - The install, `installScript()` in `packages/basecamp/api/src/providers/compute/enrollment.ts`: `/etc/basecamp/{firewall.nft,litestream.yml,outpost.key,outpost.crt,outpost.env}`; the outpost unit's `ReadWritePaths=/var/lib/outpost /etc/basecamp …` with `StateDirectory=outpost`; the Litestream unit's `ReadWritePaths=-/var/lib/docker/volumes`; `outpost-uninstall` removes `/etc/basecamp` and, with `--purge`, `/var/lib/outpost`.
  - App data: a named volume `fjs-<app>-data` in `docker.js` § deploy (with `volume-nocopy` and a throwaway root `chown` container for a non-root image), § backup, § `refuseHeld`, § volumes report and prune; `replicate.js` finds databases by `docker volume inspect` and the `VOLUME_DB` pattern.
  - The cli writes into the same tree: `commands/deploy/_module.md` § enrollOutpost edits `/etc/basecamp/outpost.env`, and `_steps-docker/01-preflight.md` greps `/etc/basecamp/litestream.yml`.
  - Basecamp reads Docker volumes as a model: `services/volumes/volumes.service.ts` (observed rows, `remove`, `prune` through Outpost), and `apps.service.ts` names `fjs-<app>-data` for import and restore.
  - Tests that name these paths: `outpost/test/outpost.test.js`, `outpost/test/posture.test.js` and its fixtures, `basecamp/api/test/{compute.test.ts,services.test.ts,verify-outpost.mjs}`, `cli/test/{checks.test.js,site-surface.test.js}`.
- [x] 0.2 Probe systemd and Docker on a real box
  - `ConfigurationDirectory=outpost` and `LogsDirectory=outpost` beside the existing `StateDirectory=outpost`; a bind source under `/var/lib/outpost` mounted by dockerd, which runs outside the unit's namespace; `docker ps --filter volume=<path>` on a bind mount, which `refuseHeld` relies on; whether the installed Outpost runs as root (the unit names no `User=`).
  - Read on yuma 2026-10-28: systemd 255, Docker 29.9.2, the outpost unit's `User=` is empty so Outpost runs as root, and `/var/lib/outpost` holds only `static/`.
  - The write half ran as a self-cleaning script the owner ran on yuma 2026-10-28 (a session's remote writes are refused):
  - Under `ProtectSystem=strict`, `ConfigurationDirectory=`, `StateDirectory=` and `LogsDirectory=` each make their directory, hand its path to the process in `$CONFIGURATION_DIRECTORY` and the rest, and allow writes there; a write elsewhere in `/etc` is refused. systemd makes them `0755 root`, so the key files keep their own `0600`.
  - A directory the install already made `0700` stays `0700` and stays writable under `ConfigurationDirectory=`, so the install may write `/etc/outpost` before the unit first starts.
  - dockerd bind-mounts a source under `/var/lib` and the container's write lands there as a plain file, owned by the container's user.
  - **`docker ps --filter volume=<destination>` matches every container mounting that path**, named volumes too: `/db` listed basecamp-api and NELA's app beside the probe. `--filter volume=<host source>` matched the probe alone. So 3.2's `refuseHeld` filters by the source directory, never the `volumePath`.
  - `--mount type=bind` with a missing source exits non-zero and creates nothing (the script kept only the help line, not Docker's message), so 3.1 makes the directory before the run.
  - `du` and `tar` do not follow the links in `/frontier-outpost` (`du -s` 4 KB against `du -sL` 20 KB; `tar` 2 entries against `tar -h` 7). Copying the link folder copies links only. Phase 4's docs say that and name the real paths for a backup.
- [x] 0.3 Read yuma's App rows for `volumePath`
  - A bind mount hides whatever the image has at that path, as `volume-nocopy` already does for a non-root image. List what each App mounts and whether its image ships files there.
  - Both Apps on yuma mount `/db`: `api` (kos, port 8101, volume empty) and `app` (NELA, port 8100). NELA's volume holds only `app.db`, `audit.db` and `jobs.db` with their `-wal`/`-shm` files, owned by root, and its container runs as root. No cli Dockerfile template writes into `/db`, so a bind mount there hides nothing.

**Done 2026-10-28.** systemd and dockerd do what the layout needs. The one change the probe forces is in 3.2: `refuseHeld` filters by the host source directory, since filtering by `/db` matches every app on the box.

## Phase 1 — One layout, owned by Outpost

Goal: every box path is derived from one exported module, so the install and the process cannot disagree.
Done when: `cd packages/outpost && bun run test` is green and `config.js` holds no literal `/var/lib` or `/etc` path.

- [x] 1.1 `src/layout.js` exports the three roots and the link folder, and each derived path
  - Roots come from `$CONFIGURATION_DIRECTORY`, `$STATE_DIRECTORY` and `$LOGS_DIRECTORY` when systemd sets them, then the FHS defaults. The `OUTPOST_*` overrides stay: `dev:outpost` and the tests run without systemd.
  - Built with two roots read from systemd: `logs` is `/var/log/caddy` by `FJS-D1617`, which sets no `LogsDirectory=`. `ROOTS` also names `/var/lib/litestream`, the Litestream unit's own state. `layout()` defaults to an empty env, so the install script, which runs in Basecamp's process, never takes Basecamp's own `STATE_DIRECTORY`.
- [x] 1.2 `config.js` reads its defaults from the layout; `workDir` becomes `builds/` (Q1)
  - `static.js`, `serve.js` and `replicate.js` take their defaults from the layout as well. `docker.js`'s defaults and its posture argv (`/etc/basecamp/*`) wait for 2.4 and Phase 3, which rewrite those lines anyway.
- [x] 1.3 Export it as `@frontierjs/outpost/layout`, beside `@frontierjs/outpost/cert`

**Done 2026-10-28.** `bun run test` 292 pass, typecheck clean, and `exports.snapshot.md` has the new entry.

## Phase 2 — The install writes that layout

Goal: a fresh box gets `/etc/outpost`, `/var/lib/outpost` and `/frontier-outpost`, and nothing under `/etc/basecamp`.
Done when: `compute.test.ts` and the cli suite are green, with 2.5's assertion among them.

- [x] 2.1 `enrollment.ts` imports the layout; `/etc/basecamp` becomes `/etc/outpost`; the unit gains `ConfigurationDirectory=outpost` and derives `ReadWritePaths`
  - Also `ConfigurationDirectoryMode=0700`: the default is `0755`, and posture grades the directory `700`. The firewall, the cert, the env file and the uninstall all follow.
- [x] 2.2 The Litestream unit writes `/var/lib/outpost/apps` instead of `/var/lib/docker/volumes`, and reads `/etc/outpost/litestream.yml`
  - Built as `ReadWritePaths=/var/lib/outpost/apps -/var/lib/docker/volumes`, so apps still on a named volume keep replicating. 3.3 drops the volumes entry. The install makes `apps/` before the Litestream unit starts, because the Outpost's StateDirectory does not exist yet at that point.
- [x] 2.3 The install makes `/frontier-outpost` with `ln -sfn`, so a second run is a no-op; `outpost-uninstall` removes it and `/etc/outpost`
- [x] 2.4 The cli follows: `enrollOutpost` writes `/etc/outpost/outpost.env`, the preflight greps `/etc/outpost/litestream.yml`, posture fixtures re-captured
  - The cli has no Outpost dependency, so its two steps name `/etc/outpost` literally. The posture argv in `docker.js` reads the layout. `dev-host.json` had its paths rewritten instead of being re-captured: it is from a box with no Outpost, so each read already answered `No such file`. The outpost `CLAUDE.md` and `README.md` paths moved now, ahead of 4.3, since an agent acts on them.
- [x] 2.5 A test renders `installScript()` and asserts every Outpost path in it starts with a layout root
  - The missing check `FJS-D1544` names: today `enrollment.ts` restates Outpost's paths and nothing fails when they drift.
  - Built in `compute.test.ts` as *every Outpost path the install names is under a layout root*. It also checks the three `ln -sfn` links.

**Done 2026-10-28.** `compute.test.ts` 115 pass, outpost 292 pass, and outpost and basecamp typecheck are within baseline. The cli suite has one failure, unrelated: `dead-path` flags `FJS-D138` citing a removed `ServiceHealthBody.mesa`. Not on a box yet: Phase 4 reinstalls.

## Phase 3 — App data is a bind mount

Goal: an app's SQLite files are plain files at `/var/lib/outpost/apps/<app>/data/`, and every reader finds them there.
Done when: `bun run test` and `bun run verify:docker` in outpost are green, and basecamp's `verify:outpost` reads a database back from that path.

- [x] 3.1 `docker.js` § deploy mounts `type=bind,src=<state>/apps/<app>/data,dst=<volumePath>`, making the source if absent; ownership per Q4 — `OUTPOST_APPS_DIR` overrides the directory (`dev:outpost` sets `.outpost/apps`); the source is made root's 0700 and the chown one-shot stays. Running the drive found FJS-3591, Bun resetting a request at 10s
- [x] 3.2 § backup, § restore, § `refuseHeld` and `/replica/drill` take the directory — answers carry `data_dir`, not `volume`; a held directory is found by its host path
- [x] 3.3 `replicate.js` finds databases under `apps/<app>/data/`; the `docker volume inspect` call and `VOLUME_DB` go
- [x] 3.4 The volume report and prune follow Q3, and so does Basecamp's `volumes.service.ts` — `Volume.kind` (`volume` | `bind`); remove and prune refuse a `bind` row whose App is placed on that server. The report takes ~35s on a box holding 101 Docker volumes
- [x] 3.5 Basecamp's `apps.service.ts` import and restore paths name the directory, not the volume — the comments and refusal; the method `restoreVolume` and route `/volume/restore` keep their names

## Phase 4 — On a real box

Goal: yuma runs the layout and still serves.
Done when: `ls -la /frontier-outpost` on yuma shows the three links, `sqlite3` opens an app database through `data`, and https://fjs.maverickmade.tech/ still answers.

- [ ] 4.1 Publish Outpost (owner: npm needs their login) and bump `OUTPOST_VERSION`
  - `0.1.6` (the leading-underscore fix) and `0.1.7` are on npm and `OUTPOST_VERSION` is `0.1.7`. The layout ships in the next patch.
  - **Basecamp and Outpost ship together.** Phase 2's install, pinned to the published `0.1.7`, would give a new box a sandbox without `/etc/basecamp` while that Outpost still writes `/etc/basecamp/litestream.yml`, so `/replicate` fails on it. Basecamp is not deployed from this tree until the bump to the published layout version is in the same deploy.
- [ ] 4.2 Reinstall Outpost on yuma (owner runs it on the production box)
- [ ] 4.3 Docs follow: outpost `README.md` and `CLAUDE.md` (the sandbox paragraph names `/etc/basecamp`), basecamp `docs/`, `cli/docs/deploy.md`

---

## Open questions

- ~~**Q1 — Outpost's build checkouts already live at `/var/lib/outpost/apps`, the path `FJS-D1544` gives app data. Which moves?**~~ **Answered 2026-10-29 (`FJS-D1614`): A — the checkouts move to `/var/lib/outpost/builds/` and app data takes `apps/<app>/data/` as ruled. Checkouts and caches are rebuilt on every build, so nothing is lost by the move.**
  - **A** — the checkouts move to `/var/lib/outpost/builds/` and app data takes `apps/<app>/data/` as ruled. Checkouts and caches are rebuilt on every build, so nothing is lost by the move.
  - **B** — app data goes to `/var/lib/outpost/data/<app>/`. Nothing moves, but the person's path becomes `/frontier-outpost/data/data/<app>`.
  - **Recommend A** — it keeps the ruled path and the link folder readable, and moves only throwaway files.
- ~~**Q2 — Outpost logs to journald, so nothing writes `/var/log/outpost`. What does the `logs` link point at?**~~ **Answered 2026-10-29 (`FJS-D1617`): A (confidence 2).**
  - **A** — `logs -> /var/log/caddy`, where Caddy already writes each app's access log (`FJS-1928`). No `LogsDirectory=`. Amends `FJS-D1544`'s link target; Outpost's own log stays `journalctl -u outpost`.
  - **B** — `LogsDirectory=outpost`, and `ingress.js` points each app's Caddy access log at `/var/log/outpost/access/`. One folder for logs, but Caddy writes as its own user into Outpost's directory, and `edge.js` (the cli's non-Outpost Caddy) keeps `/var/log/caddy`, so two places hold the same kind of file.
  - **C** — as ruled: `LogsDirectory=outpost` and a link to a directory that stays empty until something writes there.
  - **Recommend A (confidence 2)** — the link should open on files that exist, and the per-app access logs are the ones a person looks for.
- ~~**Q3 — Basecamp's Volumes screen is Docker's named volumes, observed. Once app data is a bind mount, what does it list?**~~ **Answered 2026-10-29 (`FJS-D1615`): A — Outpost reports each `apps/<app>/data/` directory as a Volume row with its size and a `kind` of `bind`, alongside any named volumes a third-party image still makes. Remove and prune refuse a directory an App still names.**
  - **A** — Outpost reports each `apps/<app>/data/` directory as a Volume row with its size and a `kind` of `bind`, alongside any named volumes a third-party image still makes. Remove and prune refuse a directory an App still names.
  - **B** — the screen stays Docker-only and an App's data size shows on the App instead. App data disappears from the screen people use to find what fills a disk.
  - **Recommend A** — the screen exists to answer what is using the disk, and app databases are most of that answer.
- ~~**Q4 — A non-root image needs its data directory owned by its uid. Who chowns it?**~~ **Answered 2026-10-29 (`FJS-D1616`): A — keep the throwaway root container, now mounting the directory. It works whether or not Outpost runs as root, which `dev:outpost` on a laptop does not.**
  - **A** — keep the throwaway root container, now mounting the directory. It works whether or not Outpost runs as root, which `dev:outpost` on a laptop does not.
  - **B** — Outpost chowns on the host. Simpler, but only when Outpost is root, so the laptop case needs the container anyway.
  - **Recommend A** — one way that works everywhere. `FJS-D1544`'s note that the container "becomes a host-side `chown`" assumed B.
