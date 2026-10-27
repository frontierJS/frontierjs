# Plans — finished-phase record

What a finished phase found, and the questions it answered, moved here verbatim so
each plan stays under 32 KB (`plan-size`, `FJS-1562`). Step and `Q` numbers resolve
against the plan named in each heading.

## IDEAS/server-posture.md

### Phase 2 — Basecamp's own host

2.2 detail:

  - The paths are written into `/etc/basecamp/outpost.env` after the install AND
    on a box enrolled before, since an enrolled box never reruns `install.sh`.
  - The real-box half of *Done when* waits on `@frontierjs/outpost` 0.1.3 being
    published and `OUTPOST_VERSION` in `enrollment.ts` moving to it: until then a
    host runs 0.1.2, which reads no `host_files`, and the two file controls stay
    `unknown`.

Answered questions:

- ~~**Q7 — How does the host's readings leave the box?**~~ **Answered 2026-10-12 (`FJS-D925`): A — The Outpost, installed by `fli deploy` with its command listener off, reporting over loopback.**
  - **A** — The Outpost, installed by `fli deploy` with its command listener off,
    reporting over loopback.
  - **B** — A full Outpost, enrolled as an ordinary server row with a hub flag.
  - **C** — Bind-mount `/etc`, `/proc` and `docker.sock` into the API container and
    read in process.
  - **Recommend A** — one implementation of the readings and nothing listening. B puts
    a signed command port on the box that holds the fleet's command key, and a server
    row invites the deploy and drain this record refuses on the host. C gives the
    control plane's own container root on its host to read a config file.
- ~~**FJS-D944 — What does the report-only host Outpost sign its posture report with?**~~ **Answered 2026-10-15 (`FJS-D944`): B — Derived from `ENCRYPTION_KEY` as an HMAC over a fixed label: `fli deploy` writes only the derived value into the host Outpost's config, and the API derives the same value at boot. There is no new variable to generate, lose or rotate.**
  `report.js` signs every POST with `config.secret`, and `outpostCredential`
  (`api/src/core/hooks.ts`) finds the key through `outpostSecretFor(serverId)` —
  `Server.outpostSecretId`, with *no second key that also works*. The host has no
  `Server` row (`FJS-D925`), so a host report today is refused 401 whatever it signs
  with. Whichever is picked, `keyFor` admits the host key for `posture.report` with
  no `server_id` alone, as a principal carrying no workspace, and a test refuses
  the same signature on `servers.heartbeat`.
  - **A** — A host key of its own, `HOST_REPORT_SECRET`, generated once beside
    `ENCRYPTION_KEY` in the stack's `.env` by `deploy/build.mjs` and `fli deploy`,
    and written into the host Outpost's config.
  - **B** — Derived from `ENCRYPTION_KEY` as an HMAC over a fixed label: `fli deploy`
    writes only the derived value into the host Outpost's config, and the API derives
    the same value at boot. There is no new variable to generate, lose or rotate.
  - **C** — The fleet's own enrollment: a hub method mints a `Secret` and the host
    Outpost exchanges a one-time token for it, with the row named on the hub's
    config. This is the same door every machine uses. It needs a system admin's
    session at install time, though, and a fresh box has no admin yet.
  - **Recommend B** — the key is derived, not restated, so it has one origin and
    nothing new to back up. `ENCRYPTION_KEY` already cannot rotate without
    orphaning every `@encrypted` column, and the HMAC is one-way, so the Outpost's
    config never holds anything that decrypts a `Secret`.

- ~~**FJS-D1023 — How does `fli deploy` know to install the report-only host Outpost, and what does it install from?**~~ **Answered 2026-10-16 (`FJS-D1023`): A — A deploy config key the app states, `deploy.hostOutpost: true` in basecamp's `frontier.config.js`. `deploy:setup` installs the Outpost from the pushed checkout's `packages/outpost` (it is in the build context already) as `outpost-host.service`, sandboxed like the fleet unit, and writes the key it derives from the server's `.env.production`, the loopback API URL and the two paths fli itself laid out (the deploy root's env file and the `/db` volume's host directory).**
  Step 2.2. Everything on the Basecamp side of it is built: the Outpost runs
  report-only when `OUTPOST_HOST_KEY` is set (with `BASECAMP_URL`,
  `OUTPOST_HOST_DB_PATH`, `OUTPOST_HOST_ENV_PATH`), the API verifies a
  `posture.report` naming no machine against `hostReportKey(ENCRYPTION_KEY)`
  (`api/src/core/hooks.ts`, label `basecamp.host-posture.v1`), and
  `/hub/security/` reads the rows. But `fli deploy` is the generic app deployer
  and nothing in an app's config says *this app is a control plane, put a host
  Outpost beside it*, and a deploy target has bun but no `node_modules`
  (`packages/cli/CLAUDE.md`). Whichever is picked, fli derives the key with the
  same label, so the label moves to one owner both import (toolbelt) in the same
  change.
  - **A** — A deploy config key the app states, `deploy.hostOutpost: true` in
    basecamp's `frontier.config.js`. `deploy:setup` installs the Outpost from the
    pushed checkout's `packages/outpost` (it is in the build context already) as
    `outpost-host.service`, sandboxed like the fleet unit, and writes the key it
    derives from the server's `.env.production`, the loopback API URL and the two
    paths fli itself laid out (the deploy root's env file and the `/db` volume's
    host directory).
  - **B** — No fli option: basecamp ships its own extra step file under `deploy/`,
    and `fli deploy` gains a generic *the app's own steps* hook that runs it. The
    knowledge stays in the app that needs it, at the cost of a second step
    mechanism in fli.
  - **C** — The fleet install script (`providers/compute/enrollment.ts`
    `installScript()`) grows a report-only mode, and `fli deploy` pipes it to the
    box. One installer for every Outpost, but fli would fetch an install script
    from the app it is installing, before that app is up.
  - **Recommend A** — fli already owns the layout both paths come from and holds
    the `.env.production` the key derives from, so it is the one place that can
    state all three without a copy; one boolean in the one app that wants it.

- ~~**FJS-D1241 — Now that `fli deploy` enrolls Basecamp's host as a fleet machine, does it still install the second, report-only host Outpost?**~~ **Answered 2026-10-18 (`FJS-D1241`): B — Fold the host readings into the fleet Outpost. `08b-outpost` passes `OUTPOST_HOST_DB_PATH`/`OUTPOST_HOST_ENV_PATH` into the `basecamp-host` install, and `/hub/security/` grades the `basecamp-host` row (`HOST_SLUG`) with the `hub.*` controls. Report-only mode, `hostReportKey`, the `outpost-host` principal and the nullable `serverId` are deleted. One reader per box, but the hub tier's reading depends on a workspace's Server row and goes dark under `--no-outpost`. `FJS-D924`/`FJS-D925`/`FJS-D944` are struck in part.**
  Step 2.2 again. `FJS-D1023` was ruled on the premise that no Outpost runs on
  the host. A day later `FJS-D1191`/`FJS-D1202` made `deploy.outpost: true`
  install the full fleet Outpost there by default (`outpost.service`, Server row
  `basecamp-host`, `08b-outpost`). Built as ruled, one box runs two Outposts that
  both read its sshd, ruleset and pending updates. That gives two
  `ServerPosture` rows for one machine, one on a workspace's `/security/` and one
  on `/hub/security/`, and nothing compares them (§ V questions 1, 5, 6 and 9).
  Nothing clashes in the plumbing: the units, state and listeners are separate,
  since report-only opens no port.
  - **A** — Build `FJS-D1023` as written, beside the fleet Outpost. A new
    `deploy.hostOutpost` key and a `_steps-setup` step install
    `outpost-host.service` with `hostReportKey` (its label moving to toolbelt so
    fli derives the same value). The hub tier keeps its own reading, which stays
    true under `--no-outpost` and in a workspace-free install, where
    `enroll-host.ts` answers `skip`. The cost is a duplicated reading.
  - **B** — Fold the host readings into the fleet Outpost. `08b-outpost` passes
    `OUTPOST_HOST_DB_PATH`/`OUTPOST_HOST_ENV_PATH` into the `basecamp-host`
    install, and `/hub/security/` grades the `basecamp-host` row (`HOST_SLUG`)
    with the `hub.*` controls. Report-only mode, `hostReportKey`, the
    `outpost-host` principal and the nullable `serverId` are deleted. One reader
    per box, but the hub tier's reading depends on a workspace's Server row and
    goes dark under `--no-outpost`. `FJS-D924`/`FJS-D925`/`FJS-D944` are struck
    in part.
  - **C** — Keep report-only mode only for `--no-outpost`. `08b-outpost`
    installs the report-only unit when it skips the fleet enrollment, and
    `/hub/security/` reads whichever exists. There is always exactly one reader,
    at the price of two paths to keep correct.
  - **Recommend B** — `FJS-D1191` already put an Outpost on the key's box with
    its listener on, which was `FJS-D925`'s whole reason for report-only. One
    reader per box is § V's ninth answer, and the hub screen grading
    `basecamp-host` derives rather than restates.
