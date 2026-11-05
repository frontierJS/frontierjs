---
id: workbench-package-chats
status: proposed
dated: 2026-11-05
---

# Workbench package chats — a chat knows which package it is about

**Status: PROPOSED.** Dated 2026-11-05. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want: in a checkout with workspaces, each chat tab carries the package it is
about, and chats about the same package sit together under one label, the way
Chrome groups tabs. Once a chat has a package, the package can also narrow what
runs after a chat (its checks) and what goes into it (its context).

---

## What exists

- **A Pin is a checkout and its chats are tabs over one tree**
  (`packages/workbench/api/src/domain/workbench/workbench.ts`, header). One chat
  runs at a time; Fork is how two run at once. A `Chat` is `{ id, session,
  forkOf }` and says nothing about what it is about. State is `pins.json` and
  `logs/<id>.<chat>.ndjson` under `WORKBENCH_DIR`, not the database.
- **The tabs draw in two places** in `packages/workbench/web/src/routes/workbench/index.mesa`:
  the slim header row (`workbench-head-chats`) and the full row
  (`workbench-chats`), each `{#each chatsOf(p.id)}` in the order the chats were opened.
- **A run's file writes are already read.** `readAskEvent`
  (`packages/cli/core/ask-claude.js`) yields `edit` and `write` events carrying
  `file_path`; `foldLine` in `workbench.ts` keeps only the `tool` line today.
- **The member list has one owner.** `workspaceMembers(root)` and
  `memberOfFile(members, file)` in `packages/cli/core/workspace-members.js` read
  the root `package.json` `workspaces` (array or yarn's `{ packages }`), longest
  path wins. It THROWS on a pattern it does not read (`**`, a negation;
  `FJS-D1911`), and it does not read `pnpm-workspace.yaml`. The workbench
  already reaches the cli lazily (`loadCli` in `workbench-run.ts`), and the cli
  has no `exports` field, so a deep import works.
- **Checks grade the whole tree.** `workbench-check.ts` runs the checkout's
  `runDone(root)`, which takes an optional `changes` (`packages/cli/core/done.js`).
  With several chats on one tree, a chat's `checks` line also grades every other chat's edits.
- **`@frontierjs/css` has no categorical color.** Tones carry meaning, and the
  chat dots already spend `success`, `warning`, `danger` and `info` on state.
  Invariant 13 rules out a raw color.

## Prior art

- **Chrome tab groups** ([help](https://support.google.com/chrome/answer/2391819)):
  a group is a name plus one of nine fixed colors, members are contiguous, and
  the label collapses the group. The user forms the group; Chrome does not
  infer one.
- **GitHub `actions/labeler`** ([repo](https://github.com/actions/labeler)): a
  pull request gets labels from the paths it changed. The label is derived from
  what the change touched, not declared up front.
- **Nx affected / Turborepo `--affected`**
  ([Nx](https://nx.dev/ci/features/affected),
  [Turborepo](https://turborepo.com/docs/reference/run#--affected)): changed
  files map to workspace packages, and only those packages' tasks run. That is
  3.2 below.

Chrome gives the shape (contiguous, labeled, collapsible) and labeler gives the
source (paths touched). Neither colors by default without a fixed palette.

## Recommended setup

- **The package is inferred, with an override.** The member holding more than
  half of a chat's `edit`/`write` paths that fall inside a member is its
  package. Root files such as `ISSUES.md` don't count toward any member (0.1).
  A chat with no member writes, or with no member above half, is *repo-wide*. The tab's
  menu sets an override — a member, or repo-wide — kept on the `Chat` as
  `package`. Absent means inferred, and an override naming a member that has
  since gone falls back to inferred. This is Q1.
- **A tab regroups only while its chat is idle.** A majority that flips
  mid-run would move the tab under the cursor, so `package` is re-read when a
  run ends, never during one.
- **Grouping is order plus a label, with no color.** Chats with the same package
  are drawn together under a short label (`auth ·`). Clicking the label folds
  the group to a chip with a count. Repo-wide chats come first and get no
  label. Color is Phase 4, after Q2.
- **A checkout without workspaces looks the same as today.** The same goes for
  a checkout whose `workspaces` the reader refuses: it gets one line in the
  pin's log and no grouping, never an error on the pane.

## Open questions

- ~~**Q1 — Where a chat's package comes from.**~~ **Answered 2026-11-05 (`FJS-D1958`): A — inferred from writes, with an override on the tab.**
  - **A** — inferred from writes, with an override on the tab.
  - **B** — declared only: picked when the chat opens, blank means repo-wide.
  - **C** — inferred only, no override.
  - **Recommend A** — chats drift (one that starts on auth ends up editing
    junction), so a choice made up front goes stale. Writes are already in the
    stream, and the override covers a chat that is about a package it only reads.
- ~~**Q2 — Do groups get a color.**~~ **Answered 2026-11-05 (`FJS-D1960`): A, then B if groups do not stand out.**
  - **A** — no color: order and label only.
  - **B** — a categorical palette in `@frontierjs/css` (a new term, through
    `decision-rules`), with each package's color chosen from a hash of its name.
  - **C** — reuse tones.
  - **Recommend A, then B if groups do not stand out** — C collides with the
    state dots, and B is a vocabulary decision that should rest on use.
- ~~**Q3 — What a chat's checks grade.**~~ **Answered 2026-11-05 (`FJS-D1959`): B — `fli done` graded on the files this chat wrote, cut in `collectChanges`, with the scope named in the line.**
  - **A** — the whole tree, as now.
  - **B** — `fli done` graded on the files this chat wrote, cut in `collectChanges`, with the scope named in the line.
  - **C** — B, plus the package's own `bun run test`.
  - **Recommend B** — the pane's `checks ✓` reads as being about this chat, and
    today it is not once two chats share a tree. C adds a slow test run to every
    run; offer it as a button instead. The cut belongs to `collectChanges` in
    `done.js`, the owner of what changed, because cutting `changed` alone leaves
    `added` and `diff` whole for `layoutNamed` and `provesFor`. The written-file
    list is incomplete: a Bash edit, a `git mv` or a generator records no
    `edit`/`write` event. So the line states its scope (*checks · this chat's 4
    files*), and a chat with no recorded writes is graded on the whole tree. The
    checkout's own Stop hook still grades the whole tree, so a narrowed `✓` can
    sit beside a failing hook. The stated scope is what makes that readable.

## Phases

### Phase 0 — Measure the chats that exist

Goal: know how chats actually spread over packages before fixing the threshold.
Done when: a table of the chats under `~/.config/workbench/logs`, split into
single-package, mixed and no-writes, is pasted under 0.1, with how often a
chat's majority package changed between runs.

- [x] 0.1 Fold every chat log with the `edit`/`write` events counted per member
  (`memberOfFile`) and print the split, plus how many chats changed majority
  from one run to the next. It decides Q1's majority line and whether the
  idle-only regroup is enough.
  - **Sample.** `~/.config/workbench/logs` holds 4 chats with one prompt each
    and no `edit`/`write` at all, so the fold ran over this repo's 2,728 Claude
    Code transcripts instead (a Workbench chat is the same `claude` session).
    These are main-thread `Edit`/`Write`/`MultiEdit` paths only. Subagent and
    Bash writes are not counted, the same blind spot the stream has.

    | Chats (2,728) | Count | Share |
    | --- | --- | --- |
    | No writes inside the repo | 990 | 36% |
    | Writes to root files only (`ISSUES.md`, `DECISIONS.md`, `IDEAS/`) | 290 | 11% |
    | One member | 1,173 | 43% |
    | Several members, one above 50% | 215 | 8% |
    | Several members, none above 50% (46 are exact ties) | 60 | 2% |

    | Of the 1,448 chats that write to a member | ≥ 50% | > 50% | ≥ 60% | ≥ 67% | ≥ 90% |
    | --- | --- | --- | --- | --- | --- |
    | Top member's share of member writes | 99% | 96% | 94% | 88% | 82% |

  - **Root files must not count.** With root writes counted as a group, root
    is the top group in 338 chats, more than any package. Filing an issue would
    make a litestone chat repo-wide. The share is taken over member writes only.
  - **The line is a strict majority, above 50%.** It places 96% of chats that
    write to a member, and a tie stays repo-wide. 67% would push another 8% to
    repo-wide and is a number no one could predict from the label. The
    change-between-runs rate below was measured only at the 50% line. If
    regrouping churns in real use, 67% is how to reopen this.
  - **Regrouping only when idle is enough.** 144 chats wrote in two or more
    runs. The majority changed in 14 of them (10%), 15 changes in total. Median
    writes per chat are 4 (p90 13), and most chats are one run long.
- [ ] 0.2 Run `workspaceMembers` against each pinned checkout and the
  `fjs-prototypes` repos. List which have no workspaces, which throw, and which
  use `pnpm-workspace.yaml`.

### Phase 1 — A chat knows its package

Goal: `ChatStatus` carries `package`, inferred or overridden.
Done when: `packages/workbench/api/test/services.test.ts` covers inferred,
override, repo-wide and a checkout that has no workspaces, plus 0.1's rule:
root-only writes, an exact tie, and many root writes with one member write.
`fli done` is clean.

- [ ] 1.1 Members per pin, read through `loadCli`'s pattern from
  `workspace-members.js`, re-read when the root `package.json` mtime moves. A
  refusal is one log line and `[]`.
- [ ] 1.2 `foldLine` counts `edit`/`write` paths per member onto `Folded`. Paths
  are relative to the pin, so a branch's worktree folds the same.
- [ ] 1.3 `Chat.package?: string`, the override: a member path, or `'.'` for
  repo-wide. `ChatStatus.package` is the resolved `{ name, path, inferred } |
  null`.
- [ ] 1.4 A service method to set or clear the override, beside close and open.
  It clears on an explicit `null` and tests key presence, not `??`
  (Invariant 9).

### Phase 2 — Tabs group by package

Goal: both tab rows draw groups, and a group folds.
Done when: a `drive-browser` run over a pin with three chats on two packages
shows the order, the labels, a fold and an override that moves a tab.

- [ ] 2.1 Both rows sort into groups (repo-wide first, then by member order)
  and draw the label. The open order still decides order within a group, and
  a working chat keeps its place until its run ends.
- [ ] 2.2 The label folds its group to a chip with a count. The fold is per pin,
  kept where the slim and fold choices are kept today.
- [ ] 2.3 The tab menu sets the override from 1.4 and shows *inferred* beside a
  package that was not chosen.

### Phase 3 — The package does work

Goal: a chat's package narrows its context and its checks.
Done when: a run in a package chat names that package in its appended prompt,
and its `checks` line names and counts only that chat's files.

- [ ] 3.1 `workbenchContext` names the chat's package and points at its
  `CLAUDE.md` and `PROJECT_STATE.md`, which exist only where the checkout is
  FrontierJS. The cwd stays the checkout root, so `fli` and hooks behave as
  they do now.
- [ ] 3.2 Q3: `collectChanges(root, { only })` in `packages/cli/core/done.js`
  cuts `changed`, `added`, `untracked` and `diff` together, and
  `workbench-check.ts` passes the chat's written files as `only`. The
  `checks` line names its scope. A chat with no recorded writes passes no
  `only`. A `services.test.ts` case pins a Bash-only chat to the whole-tree
  grade.
- [ ] 3.3 A *Test <package>* button on the Run tab runs the member's own
  `bun run test` as a script row.

### Phase 4 — Color, if Q2 rules B

Goal: a group has a stable color that is never a tone.
Done when: the palette passes `@frontierjs/css`'s contrast specs in every theme.

- [ ] 4.1 A categorical palette term in `@frontierjs/css`, through
  `decision-rules`, then a ruling in `DECISIONS.md`.
- [ ] 4.2 A package's slot is a hash of its name. The label and the tab edge
  wear it.

## Later, not planned

- **Fork suggests a different package.** Two chats on one package in one tree
  are the ones that collide.
- **Spend by package** in the Claude Code view. `ClaudeMessage` stores `cwd`
  and no paths, so this needs the indexer to keep writes first.
