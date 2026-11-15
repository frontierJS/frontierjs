---
id: workbench-setup
status: proposed
dated: 2026-11-14
---

# Idea — a Setup checklist for a new laptop in Workbench

**Status: Phases 1–3 built 2026-11-14, uncommitted. 3.2's error row is built but never seen in a browser; the owner's 5501 instance shows the tab after a restart.**
Probed against the tree 2026-11-14. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-14): a setup screen in Workbench that helps a new user make sure
the laptop has everything it might need.

## What exists (probed 2026-11-14)

- **`fli doctor` already grades the machine, and Workbench never shows it.** `diagnose()`
  (`packages/cli/core/doctor.js`) answers `system` (the `BINARIES` table: bun ≥ 1.4.0 and git
  required, then sqlite3, zip, ssh, rsync, docker and cf), `config`, `namespaces` (each
  `requires:` key), `profiles`, `basecamps`, `secrets` and `services`, grouped by kind.
  `requiringModules()` takes the registry, which Workbench already builds once in
  `api/src/domain/laptop/services.ts`.
- **The rest of the answer is spread over four screens.** `/laptop/` has Disk, Keys (secret
  modes, with the Fix button `fixMode`), Running and Services (accounts, with the Check button
  `probeService`). `/settings/` has the global env, profiles and the phone ping. The Claude Code
  tab runs `claude doctor`. `/recommended-services/` is a static list.
- **Nothing checks:**
  - the `claude` binary Workbench spawns (`CLAUDE_BIN`), or whether it is signed in
    (`claudeAuthStatus()` exists in `domain/local/local-claude.ts`)
  - `WORKBENCH_KEY` and `ENCRYPTION_KEY` still holding their dev defaults (`core/env.ts`
    `DEV_WORKBENCH_KEY`, `DEV_ENCRYPTION_KEY`), which a new user would never notice
  - git's `user.name` / `user.email`
  - a public SSH key for `server:create` / `basecamp:create` (`publicKey()`, `core/cloud.js:251`)
  - `gh` as a binary (it is only an account), `cargo` for the desktop shells, and Chromium and
    Firefox for the drives (`csp-needs-firefox`)

## Open questions

- ~~**Q1 — Where does the checklist live?**~~ **Answered 2026-11-14 (`FJS-D2160`): A — A Setup tab, first on `/laptop/`, and a row in Home's "Needs you" when a required item fails. No new nav entry.**
  - **A** — A Setup tab, first on `/laptop/`, and a row in Home's "Needs you" when a required
    item fails. No new nav entry.
  - **B** — A new `/setup/` screen with its own nav entry.
  - **Recommend A** — `/laptop/` is already the screen about this machine, and B's screen
    would overlap its Keys and Services tabs. Home's row covers finding it.

- ~~**Q2 — How is the checklist grouped?**~~ **Answered 2026-11-14 (`FJS-D2161`): A — By goal, as `flutter doctor` groups by toolchain: Run fli, Use Claude in Workbench, Build & test apps, Desktop builds, Deploy & Basecamps. Each group says whether that goal works, and a goal with nothing set up reads "not set up", not failed.**
  - **A** — By goal, as `flutter doctor` groups by toolchain: Run fli, Use Claude in
    Workbench, Build & test apps, Desktop builds, Deploy & Basecamps. Each group says whether
    that goal works, and a goal with nothing set up reads "not set up", not failed.
  - **B** — By kind: Tools, Accounts, Keys & files, Basecamps, as `fli doctor` prints.
  - **Recommend A** — A new user needs to know what a missing item stops, and what they can
    skip. B lists the same rows without saying either.

- ~~**Q3 — What may a fix button do?**~~ **Answered 2026-11-14 (`FJS-D2162`): A — An install command is shown with Copy and never run from the page. The fixes Workbench already owns stay one click: Fix a mode, set a key in Settings, Check a login, open the vendor's key page.**
  - **A** — An install command is shown with Copy and never run from the page. The fixes
    Workbench already owns stay one click: Fix a mode, set a key in Settings, Check a login,
    open the vendor's key page.
  - **B** — A as well as "Run in Terminal", which opens the Workbench terminal with the command
    typed in for the person to press Enter.
  - **C** — Show only; every fix is by hand outside Workbench.
  - **Recommend A** — The page starts no new kind of shell command, and every fix that is
    already safe stays one click.

## Plan

### Phase 1 — The checks, in one owner

Goal: `fli doctor` and Workbench answer from the same rows.
Done when: `fli doctor` prints the new rows, and `doctor.test.js` covers each.

- [x] 1.1 `BINARIES` gains `claude`, `gh`, `cargo`, and a browser row each for Chromium (any of
  `chromium`, `chromium-browser`, `google-chrome`) and Firefox, all `required: false`. Each
  binary row gains `for:`, the goal ids it serves, which the terminal ignores. `hint` splits
  into `install` (a bare command a Copy button can paste, or a URL) and `why` (the prose now in
  its parentheses), and the doctor's printer reads both in the same change.
- [x] 1.2 A `identity` section in `diagnose()`: git `user.name` and `user.email` set, and a
  public SSH key found where `publicKey()` looks. Warn only, never counted in `blocked`.
- [x] 1.3 The goal table (`GOALS`: id, label, one line on what it lets you do, `required`,
  and the `namespaces` whose `requires:` keys and services it claims) is exported from
  `doctor.js` beside `BINARIES`, so a goal is named once. A namespace no goal claims lands in
  Run fli, so nothing drops off the checklist. Only Run fli and Use Claude in Workbench are
  `required`.

### Phase 2 — Workbench's own rows and the service

Goal: one call answers the whole checklist, grouped by goal.
Done when: `api/test/` covers the grouping and the dev-default rows.

- [x] 2.1 `api/src/domain/laptop/setup.ts`: runs `diagnose()` with `requiringModules()` off
  the registry `services.ts` already builds, and adds the rows only Workbench knows: `claude`
  signed in (`claudeAuthStatus()`), `WORKBENCH_KEY` and `ENCRYPTION_KEY` not the dev default
  (a boolean leaves, never the value), and the phone ping set. Answers
  `{ goals: [{ id, label, why, required, state: 'ok'|'warn'|'error'|'unset', rows }] }`.
  A goal's state is derived, never stored: `unset` when the goal is optional and none of its
  rows is present, `error` only for a required goal with a failing row, `warn` otherwise when
  any row fails.
- [x] 2.2 Each row carries one fix: `{ copy: <command> }`, `{ url, note }` (a vendor page),
  or `{ go: <href>, label }` (the Workbench screen that already fixes it). Never a verb that
  runs a shell (Q3 = A).
- [x] 2.3 A test asserts every row's fix is `copy`, `url` or `go`, so Q3 = A is enforced, not
  remembered.
- [x] 2.4 `laptop.setup` as a read method on `laptop.service.ts`, gated at ADMINISTRATOR like
  its siblings.

### Phase 3 — The tab and Home's row

Goal: a new user opens `/laptop/` and sees what the laptop can and cannot do.
Done when: the tab is driven in a browser on a scratch API port, signed in, with Recheck pressed.

- [x] 3.1 `/laptop/` opens on a Setup tab: one card per goal, collapsed when `ok`, each failing
  row with its why and its fix. Recheck all reloads.
- [ ] 3.2 Home's "Needs you" gains one row while a required goal is `error`, linking to the tab.
  - Built. Driven only in its empty state ("Nothing is waiting on you") on 2026-11-14: this
    laptop has no required goal in `error`, so the row itself has not been seen.

## See also

- `IDEAS/workspace-onboarding.md` — the same checklist for a Basecamp workspace, not a laptop.
- `IDEAS/fli-profiles.md` — the profiles rows the checklist reuses.
