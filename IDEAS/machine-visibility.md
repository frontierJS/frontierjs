---
id: machine-visibility
status: proposed
dated: 2026-11-06
---

# Idea — what a machine holds, readable in Basecamp

**Status: PROPOSED. Q1–Q2 ruled (`FJS-D1987`, `FJS-D1989`); Phase 0 built and driven 2026-11-06; Outpost 0.1.14 released and pinned; 0.3's Basecamp redeploy and re-enroll are the owner's; 1.1 next.**
Probed against the tree 2026-11-06. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-06): what does a machine hold that Basecamp cannot show, short of
an ssh session? Built one phase at a time, each its own small change.

## What exists (probed 2026-11-06)

- **Routes card** (`servers/[id]/index.mesa` `#server-routes`): Caddy's ingress routes reduced
  to hostname → upstream → writer, read live through `servers.ingress` → Outpost `POST /ingress`.
- **`Server.runtime`** carries every container and supervised unit each heartbeat
  (`domain/host/runtime.ts`). The App screen shows its own placements' containers
  (`observedOf`); the posture grader and the timeline read the rest. No screen lists the whole.
- **A Caddy-issued certificate is read by the managed Monitor** (`FJS-D1859`): `Monitor.certExpiresAt`,
  warned at 14/7/3 days (`domain/monitor/probe.ts` `certWarning`). The Domain row's `cert_status`
  is derived from an UPLOADED certificate only (`domains.service.ts:49`), so a hostname Caddy
  serves over ACME reads `none` on `/dns/` and on the App's Domains tab.
- **The live log stream** (`plugins/machine-stream.ts`) has one source, `logs`: an App's container.
  Caddy, Outpost and Litestream log to the journal, which only ssh reaches.
- **`/etc/outpost/litestream.yml`** is written by `replicate.js` from what Basecamp sends, and
  carries every app's bucket key. Replication STATUS is shown; the file is not.
- **Basecamp's own Caddyfile** is generated at image build (`deploy/caddyfile.mjs`) with
  `admin off`, so it cannot be read live.

## Open questions

1. ~~**Q1 — Who may follow a machine unit's journal (Phase 3)?**~~ **Answered 2026-11-06 (`FJS-D1987`): A — whoever may read the Server row: the `logs` source's rule, `$readAs` under the caller's claim.**
   - **A** — whoever may read the Server row: the `logs` source's rule, `$readAs` under the
     caller's claim.
   - **B** — admin and above only, a check in the source.
   - **Recommend A** — the `logs` source already decided this shape, and a check beside the gate
     is a second answer (Invariant 6). Reopen as B if a journal is found carrying what a Server
     reader should not see; the access log is a file per route (`FJS-1928`), not the journal.
2. ~~**Q2 — Where does a machine's install fetch the Outpost from (0.3)?**~~ **Answered 2026-11-06 (`FJS-D1989`): A — the release host: `bun add` of `packageHostUrl` (`packages.frontierjs.com`, the GitHub Release asset), the pin held where `ws:pub`'s default `--to tarballs` ships. Amends `FJS-D1773` and `FJS-D1941`: the pin names a version the RELEASE holds, `outpostUnpublished()` and `fli done` ask the release, and 04's *move the pin* follows a tarballs run.** The owner asked
   2026-11-06, for while the fleet is the team's own.
   - **A** — the release host: `bun add` of `packageHostUrl` (`packages.frontierjs.com`, the
     GitHub Release asset), the pin held where `ws:pub`'s default `--to tarballs` ships. Amends
     `FJS-D1773` and `FJS-D1941`: the pin names a version the RELEASE holds, `outpostUnpublished()`
     and `fli done` ask the release, and 04's *move the pin* follows a tarballs run.
   - **B** — npm stays: every Outpost release also runs `--to npm`.
   - **Recommend A** — `FJS-D1568` already makes the URL the install path and npm the upgrade
     path, and the public repo needs no token. Amended by the owner: npm first and the release
     the fallback, for the Outpost and each `@frontierjs` package its manifest pins
     (`enrollment.ts` `OUTPOST_MANIFEST`), so no Outpost release needs `--to npm`. Reopen if the
     repo goes private: a box would then need a token to fetch.

## Plan

### Phase 0 — Caddy's config on the Routes card

Goal: the Routes card shows the http servers as Caddy holds them, behind a disclosure.
Done when: `verify:docker` passes and the card renders the JSON from a real Outpost.

- [x] 0.1 Outpost `routes()` answers `config` (`apps.http.servers`, no `apps.tls`); `servers.ingress`
  passes it; `#routes-config` shows it, or says the Outpost is too old
  - `bun run test` (outpost) 456 pass, `verify:docker` 95 pass, the web build compiles the card.
- [x] 0.2 Drive the card against `bun run dev:outpost`: open `#routes-config`, read the JSON
  - A `caddy:2` with admin only on the host network, an `ingress` server loaded by `POST /load`,
    a seeded scratch API on 7620/7520: the card read `fli-demo` whole. Unbounded JSON ran the page
    long, so the `pre` caps at 32rem and scrolls.
- [ ] 0.3 Release the Outpost so a fleet machine answers `config`
  - Per Q2 the install takes the Outpost and each `@frontierjs` dep it pins from npm, or its
    release asset where npm lacks the version (`enrollment.ts` `OUTPOST_MANIFEST`); `fli done`,
    `outpostUnpublished()` and 04 accept either host. The rendered install lines in a scratch
    directory took 0.1.13, litestone 1.1.16 and toolbelt 0.1.11 from npm, and with the registry
    pointed at a dead port took all three from the release. `verify:provision` 109 pass.
  - Released 0.1.14 with litestone 1.1.17 to the release host only; `OUTPOST_VERSION` = 0.1.14.
    The real install lines took both from the release and toolbelt 0.1.11 from npm, and the
    installed `ingress.js` is the tree's. Owed: redeploy Basecamp, re-enroll the machines.

### Phase 1 — Every container and unit on the server page

Goal: `/servers/:id/` lists `Server.runtime` whole — containers (app or not) and units.
Done when: a `verify:screens` check reads a seeded runtime's rows, a unit's `active` among them.

- [ ] 1.1 A Runtime card: containers (name, app link, state, restarts, OOM, exit code, started)
  and units (unit, active/sub, since); `replaced` marked as a swap's set-aside; `checked_at` shown
- [ ] 1.2 The seed and a `verify:screens` check

### Phase 2 — The Domain row reads the Monitor's certificate

Goal: the primary hostname Caddy serves over ACME shows its expiry, not `none`.
Done when: `bun run test` proves a primary Domain with no upload reads `active`/`served` off its
managed Monitor, a non-primary one reads `none`, and an upload wins over the Monitor.

The managed Monitor probes the primary Domain's hostname only (`domain/monitor/managed.ts`), so
its reading speaks for that one row. A Monitor that has not probed yet (`certExpiresAt` null)
reads `none`, never `active` with no days.

- [ ] 2.1 `decorate` resolves `{ certExpiresAt, source }` — the upload, else the managed Monitor's
  reading for the Domain `managed.ts` names, read `asSystem` within the Domain's workspace — and
  hands it to `certStatusOf`, which stays pure (`ingress-cert.job.ts` calls it too)
- [ ] 2.2 `/dns/` and the Domains tab show the source; *Upload certificate* stays for `none` only

### Phase 3 — A machine unit's journal, followed live

Goal: Caddy's, Outpost's and Litestream's logs on the server page, as an App's are on its own.
Done when: the drive follows `caddy-api` on `dev:outpost` and reads a line.

- [ ] 3.1 Outpost `POST /units/follow`: `journalctl -u <unit> -f -n <tail>`, the unit an
  allow-list (`caddy-api`, `outpost`, `basecamp-litestream`), argv only
- [ ] 3.2 A `units` row in `machine-stream.ts` SOURCES, accessor `server`, per Q1; a test that a
  caller who cannot read the Server is refused the stream
- [ ] 3.3 A Logs card on the server page with a unit picker; the drive

### Phase 4 — Litestream's config, keys redacted

Goal: what the machine replicates, and where, as the file says it.
Done when: `bun run test` (outpost) proves no key value leaves the machine, and the card renders.

- [ ] 4.1 Outpost reads `litestream.yml` back with `access-key-id`/`secret-access-key` replaced
  by `[redacted]` (Invariant 7's word), through `POST /replicate/config`
- [ ] 4.2 A disclosure on the server page's replication section

### Phase 5 — Basecamp's own Caddyfile in Hub settings

Goal: the operator sees the proxy config the running image was built with.
Done when: `/hub/settings/` shows text equal to `caddyfileFor()` over `api-paths.js`.

- [ ] 5.1 A `hub` read returning `caddyfileFor(API_PATHS…)`; a disclosure on `/hub/settings/`

## See also

- `IDEAS/box-health.md` — the runtime reading Phase 1 renders.
- `IDEAS/backups.md` — the replication Phase 4 shows.
