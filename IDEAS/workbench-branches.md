---
id: workbench-branches
status: proposed
dated: 2026-10-09
---

# Idea — a branch per chat in the Workbench

**Status: IDEA.** Item 6 of [`workbench.md`](workbench.md). The owner took every
recommendation below on 2026-10-09; the port scheme is ruled in `FJS-D841`. Nothing
is built.

A pin is one checkout today, and two chats in one repo share one working tree. This
gives a chat its own tree: **Fork** on a pin makes a git branch in a linked worktree,
pinned beside its parent, with its own chat, port block and diff; **Land** puts its
work back into the parent's tree; **Archive** takes the tree away and keeps the branch.

## Probed, 2026-10-09

- **Installing is free.** `bun install` in a fresh worktree of this repo (4,158
  files) took 0.36 s from bun's cache, hardlinked (a file in `.bun` showed 122
  links), and toolbelt's suite ran green inside it. What a worktree lacks is the
  GITIGNORED state: basecamp has `.env`, `basecamp.db`, `basecamp-jobs.db` and
  `audit/` in the main checkout and only `.env.example` in a new tree.
- **A chat forks across directories.** `claude -p --resume <id> --fork-session`
  run from another directory answered from the original session, under a NEW id
  filed under the new directory's project. A plain `--resume` from there also
  answers, but keeps the old id filed under the old directory — so the fork is
  what lets `claude --resume` from the branch's own folder find it.
- **A fixed project's service digit is taken.** basecamp is 8120 API, 8121 mail
  sink, 8122 DigitalOcean stand-in (`docs/PORTS.md`), so the scaffold's answer —
  move the service digit — would put a branch's API on its parent's mail sink.

## The design

**1. A branch is a pin.** `Pin` gains `from` (the parent pin's id), `base` (the
commit the branch diffs against) and `branch` (`wb/<slug>`); everything else keys
on `p.path` already, so logs, cost, checks, review and diff work in a branch with
no change. `pin()` already accepts a linked worktree — its `.git` is a file and
`existsSync` passes. The grid groups pins by `from`. The UI word is **branch**,
which is what it is; no new noun.

**2. The base is a snapshot of the parent's tree, untracked files included.** This
repo is never clean — work sits uncommitted for days and other sessions share the
tree — so a branch cut from HEAD would not have what the operator sees. Build the
snapshot through a TEMPORARY index: copy `.git/index`, `git add -A` into it with
`GIT_INDEX_FILE`, `git write-tree`, `git commit-tree -p HEAD`. The working tree and
the real index are only read, which is what makes it safe beside a concurrent
session. `git worktree add -b wb/<slug> <path> <snapshot>` then materializes it. A
snapshot can catch another session mid-edit; the card names the files it carried
beyond HEAD.

**3. Land applies the branch's work to the parent's tree, uncommitted.** The work
is the branch's tree (snapshotted the same way) diffed against `base` — committed
or not, untracked included. `git apply --check` first; a patch that does not apply
is REFUSED, naming the files, rather than written as conflict markers into a tree
other sessions are in — the operator tells the branch's agent the parent moved. A
landed branch's `base` moves to the tree that landed, so a second Land carries only
what came after. A merge is wrong here (the parent is dirty, and this repo commits
narrowly by path); a pushed branch or PR can come later.

**4. Trees live outside the repo**, at `<WORKBENCH_DIR>/trees/<pin id>/<slug>`. A
tree inside it (`.claude/worktrees/`) is a second copy of every package for
`fli check`, the typecheck globs and the `packages/*` glob to find.

**5. Setup is `bun install` plus a copy list.** A per-pin `copy` setting names the
gitignored paths a new branch takes from its parent, default `**/.env`. A database
is the app's call: copy a small dev db, seed a large one (ELA's is 4.5 GB). It runs
after the worktree is made and before the first message; its output goes to the
branch's log as a plain line, which the fold already shows as an error when it
fails.

**6. Ports: branch N takes N×10000 on every port** (`FJS-D841`). Branch 1's basecamp
API is 18120 and its drive's stand-in 17122; drop the leading digit and it is the
parent's. `claimSession` (`packages/cli/core/ports.js`) owns it: a root that is a
LINKED worktree (`git rev-parse --git-common-dir` differs from `--git-dir`) is given
the lowest free N among its repo's linked worktrees, kept in the lock like a slot.
The ceiling is five (branch 6 would put 8120 at 68120); 3–5 sit in Linux's ephemeral
range (32768–60999), where a port is sometimes held by an outgoing socket and
`strictPort` refuses loudly. Lowest-free means those are reached only when 1 and 2
are in use. **A port written as a literal does not move**, and tests write them —
drives default to one, and basecamp's `compute.test.ts` binds 7123 and 7125 itself
— so until `FJS-2277` closes, a branch runs dev servers and the suites that bind no
port, and not drives.

**7. Fork carries the chat.** Where the parent has a session, the branch's first run
is `--resume <parent session> --fork-session`; `askArgv` (`ask-claude.js`, the one
owner of the argv) gains `fork`. **New chat** in the branch starts fresh as it does
anywhere.

**8. Lifecycle.** After Land the branch stays for follow-ups. **Archive** stops its
run, review and checks (each a process group, as `stop` does), releases its port
block (`releaseSession(root)`), runs `git worktree remove`, and keeps `wb/<slug>`.
Archiving a branch with work not yet landed asks first, naming the count. Unpinning
a parent with branches is refused.

**9. The card.** Branches indent under their parent. **Fork** is on a parent's
card, **Land** and **Archive** on a branch's; a branch's diff panel reads against
`base` (`readDiff` takes a base instead of HEAD). A parent's total includes its
branches; the header's today already sums every pin.

**Out:** best-of-N (`workbench.md` #12, which builds on this), push/PR, a Run button
that starts a branch's dev server, automatic cleanup.

## Slices

- **A — branches.** 1–4, 7, 8, 9: snapshot, worktree, fork with the chat, Land,
  Archive, grouping. Useful alone: parallel chats on one repo stop sharing a tree.
- **B — runnable branches.** 5 and 6: the copy list, then the port offset in
  `ports.js` with its tests and `docs/PORTS.md`.
- Then `FJS-2277`, a drive reading its port, which is the larger job and what lets
  a branch run `fli prove`.

**Proved by** basecamp's workbench tests against a real temp repo (fork, a dirty
parent, Land with and without a conflict, Archive), the `verify:provision` drive
for the card, and cli's ports tests for the offset.

## The nine, for 1–3 and 7–9

Answered before the first edit. **Origin** — the branch's state is the git
worktree and the pin, as a pin's is; nothing restated. **Concept** — none added:
*branch*, *worktree*, *pin*, *base* all existed. **Complexity** — the problem's;
every orchestrator in `workbench.md`'s survey names it a worktree per task.
**Predictability** — a branch is a pin, so everything a pin does it does.
**Derived** — `base` is stored, because the snapshot is not recomputable after
the parent moves. **Owner** — workbench owns the pin, git owns the tree, `askArgv`
the argv, `claimSession` the ports; nothing beside any of them. **Boundary** —
`fork`, `land`, `archive` on the workbench service at ADMINISTRATOR, like its
siblings; a slug passes `git check-ref-format --branch` and reaches git as argv,
never a shell string. **Failure** — Land refuses on a conflict; Archive asks
before discarding work. **Silence** — a snapshot that caught a half-written file
is not refused, and the card naming what it carried is the only artefact. No
§ IV adjudication is in tension. Tier: Assessment, until built.
