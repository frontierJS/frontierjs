# Project state — @frontierjs/outpost

**v0.1.1 · 40 tests, 0 fail · published.**

Written 2026-08-19 to close the half of `FJS-257` that had no code: basecamp
spoke a complete Outpost protocol to a process that did not exist, so a release
resolved no executor and every step passed having issued nothing.

## What is real

- The protocol both engines and two services already send: pull, deploy, stop,
  health-check, exec, system/prune, volumes/prune, DELETE volumes/<name>.
- The signature on every one of them, from `@frontierjs/toolbelt/signature` —
  the module Conduit signs with, so there is one definition and two ends.
- Build-on-target for a `git` source, answering the digest of what it built.
- Heartbeat, volume report and disk report, on two clocks.

## What is not

- **Nothing has run it against a real Docker daemon.** The tests inject the
  runner, which is what makes them exist at all; what they cannot prove is that
  `docker system df --format json` answers the keys parsed here on the version
  installed on somebody's machine.
- **Ring 1 — installing it.** Built now: basecamp's `Server` model carries the
  `pending → provisioning → installing → ready` walk and an enrollment token,
  and a minted `outpostSecretId` is a per-server credential. What remains is
  phase 3 — deleting the fleet-wide `OUTPOST_SECRET` fallback a `null`
  `outpostSecretId` still signs with, which can only happen once every machine
  in a fleet has enrolled with its own.
- **Build-once-promote-a-digest.** V1 builds on the target. The digest plumbing
  is done, so what remains is a builder and somewhere to put the artefact —
  `IDEAS/deploy-plane.md` §b.
- No TLS of its own (it expects to sit behind one), no metric endpoint.
  Log streaming is built (`POST /logs`), which is what `FJS-123`'s alert
  evaluator needed and now has.
