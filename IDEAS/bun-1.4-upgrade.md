---
id: bun-1.4-upgrade
status: proposed
dated: 2026-09-09
---

# Idea — moving the workspace to Bun 1.4

**Status: PROPOSED.** Dated 2026-09-09. The whole of this was measured against
`bun-1.4.2` on a laptop, never read off release notes; every number below is a run.
What the natives in 1.4 are worth is a separate question and is
`IDEAS/bun-natives.md`. This file is only *what breaks and in what order to fix it*.

The pin is `bun-version: 1.3.11` in `.github/workflows/ci.yml` and `bun-types:
^1.3.14` in the root `package.json`.

---

## What a full run says

`bun run ci:fast` under 1.4.2 is green apart from a stale
`repo-atlas.snapshot.html`, which **reproduces under 1.3.11 on a clean tree** and is
therefore not part of this. Structure, registers, advisories, scaffold and typecheck
all pass unchanged; the scaffold phase packs, installs and builds an app against the
tarballs without a word.

The suites are 17 green and 3 red, and no red is a Bun defect:

| Package | 1.3.11 | 1.4.2 | Cause |
| --- | --- | --- | --- |
| litestone | 0 fail / 4715 | 14 fail / 4718 | `rl.prompt()` after the readline closed |
| sierra | 0 fail | 1 fail | a negative control Bun 1.4 invalidated |
| cli | 0 fail | 1 fail | a half-closed socket that node has never closed |

**Two of the three are Bun becoming more node-correct, and each exposes something
of ours.** That is the argument for going: 1.4 stops hiding two things, and one of
them is live on `main` today under the runtime `fli` actually uses.

---

## 1. `fli proxy` leaves an unclaimed name hanging — live today, not a 1.4 defect

`refuse()` in `packages/cli/core/proxy.js` writes a 404 carrying `connection: close`
and then calls `socket.end()`, which is a half-close: the client is told nothing is
coming and the connection stays open. The same handful of lines as a `node:net`
probe, three runtimes:

| runtime | result |
| --- | --- |
| bun 1.3.11 | `close` after 13 ms |
| bun 1.4.2 | timed out at 2006 ms |
| node | timed out at 2007 ms |

**`fli` is `#!/usr/bin/env node`.** So the shipped behavior has always been the
timeout, and `tests/proxy.test.js`'s *an upgrade to a name nothing claims is dropped
rather than proxied somewhere* has been green for the wrong reason — the suite runs
under Bun, the command runs under node, and only Bun 1.3 closed both directions on
`end()`.

**Fix:** flush then close — `socket.end(...)` followed by `destroySoon()` — in
`writeText()`, which is the one owner of a hand-written answer on that side.
**Proves it:** `packages/cli`: `bun run test`, and it is worth running the file
under node once by hand, because that is the runtime the defect lives in.
**This one deserves an `FJS-###` whether or not the upgrade happens.**

## 2. litestone's REPL prompts a closed readline

All 14 failures are one cause in `packages/litestone/src/tools/repl.js` — `handleLine`
ends in `rl.prompt()`, and `.help`, `.standing` and every dot command return through
it. Once the interface is closed, node answers `ERR_USE_AFTER_CLOSE`, and Bun 1.4 now
does too. The failures spread across *evaluating*, *printing a row*, *dot commands*
and the statement queue because every one of them goes through that line.

**Fix:** guard the prompt on `rl.closed` at its single site rather than at each
caller. **Proves it:** `packages/litestone`: `bun run test`, plus
`verify:studio:explore`, since `POST /api/repl` is the served half of the same
evaluator.

## 3. sierra's TDZ workaround has lost its reason

`tests/build-imports.test.js`'s negative control asserts that re-importing a module
whose top-level await threw gives a TDZ error rather than the real one. Probed on
one file:

| runtime | first import | second import |
| --- | --- | --- |
| bun 1.3.11 | `the real one` | `Cannot access 'other' before initialization.` |
| bun 1.4.2 | `the real one` | `the real one` |
| node | `the real one` | `the real one` |

So the masking was Bun 1.3's alone, and `importAppModule` / `firstRealFailure()`
exists to see through it.

**Fix, in two parts and only the first is part of this upgrade:** correct the control
to state what the runtime now does. **Retiring the workaround is a separate change
and must not ride along** — it is only safe once 1.4 is the floor for everyone
building a sierra app, and an app pinned to 1.3 would get the masked error back with
nothing saying so. Note it, do not do it.
**Proves it:** `packages/sierra`: `bun run test`.

---

## The order, and what it costs

1. File the three (item 1 at minimum) so the fixes have ids to cite.
2. Fix 1, 2 and 3 **under the current pin** — every one of them is either a live
   defect or a test correction, and all three should be green on 1.3.11 and 1.4.2
   alike. That is what makes the bump itself a one-line commit.
3. Bump `.github/workflows/ci.yml` to 1.4.2 and `bun-types` to `^1.4.x`.
4. Run the full `bun run ci` (not `ci:fast`) — the `deploy` phase's
   `deployJournalCycle` and the `tutor` phase are the two nothing here has yet asked
   under 1.4, and both stand up real containers.
5. Run the browser drives, which no CI tier covers: `example`'s `verify`,
   `verify:site` and `verify:live` at least, since the runtime rewrite touched
   streams and HTTP, and `verify:extension`, which drives Chrome through CDP.

**Not part of this.** The `[install] linker = "isolated"` opt-in and the natives in
`IDEAS/bun-natives.md` are separate decisions; a runtime bump that also changed how
`node_modules` is laid out would make a failure impossible to attribute.

**Rollback is the pin.** Nothing in steps 1–3 is Bun-version-specific, so reverting
step 3 alone returns the workspace to 1.3.11 with the three fixes still in place.
