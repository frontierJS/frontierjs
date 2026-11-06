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
- **An inferred package regroups only while its chat is idle.** A majority
  that flips mid-run would move the tab under the cursor, so inference reads
  the writes as they stood when the run started. An override is the owner's
  own click on that tab, so it applies at once.
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
- [x] 0.2 Run `workspaceMembers` against each pinned checkout and the
  `fjs-prototypes` repos. List which have no workspaces, which throw, and which
  use `pnpm-workspace.yaml`.
  - **Sample.** 38 checkouts: the 12 in `pins.json` (11 prototypes and this
    repo) and every git repo under `fjs-prototypes/`.

    | Checkouts (38) | Count | Which |
    | --- | --- | --- |
    | No `workspaces` key | 35 | every prototype but two |
    | `workspaces` names no existing member | 1 | `transit` (`packages/*`, no `packages/` folder) |
    | One member | 1 | `ksite` (`packages/ksite`) |
    | Several members | 1 | `frontierjs` (58) |
    | The reader throws | 0 | |
    | `pnpm-workspace.yaml` | 0 | |

  - **Only this repo groups.** A Frontier app's surfaces (`api/`, `web/`,
    `db/`) are folders, not members, so every app checkout reads as having no
    workspaces and looks the same as today. `darkroom`, `eventmark` and
    `page-performer` carry a `mockup/package.json` that no `workspaces` list
    names, so it is not a member either.
  - **No pnpm reader and no refusal path to drive.** Nothing in the sample
    throws, so the pin-log line for a refused pattern is exercised only by a
    fixture in Phase 1.
  - **`ksite` shows the one-member case.** Every chat that writes to the
    member gets the same label, so the label carries no information there.

### Phase 1 — A chat knows its package

Goal: `ChatStatus` carries `package`, inferred or overridden.
Done when: `packages/workbench/api/test/workbench.test.ts` covers inferred,
override, repo-wide and a checkout that has no workspaces, plus 0.1's rule:
root-only writes, an exact tie, and many root writes with one member write.
`fli done` is clean.

- [x] 1.1 Members per pin, read through `loadCli`'s pattern from
  `workspace-members.js`, re-read when the root `package.json` mtime moves. A
  refusal is one log line and `[]`.
  - **Built.** `membersOf(p)` in `workbench.ts`, keyed on the root
    `package.json`'s mtime and size as a plan's questions are, and exposed as
    `members(id)`. A member is `{ name, path }` with `path` relative to the pin.
    The refusal line goes to the API's log (`console.warn`, once per change to
    the file), not a chat log: a plain line there draws as an error in the
    transcript. A member added under an existing `X/*` is not seen until
    `package.json` moves. Pinned by `api/test/workbench.test.ts` § pins.
- [x] 1.2 `foldLine` counts `edit`/`write` paths per member onto `Folded`. Paths
  are relative to the pin, so a branch's worktree folds the same.
  - **Built.** The fold keeps each path whole with its count (`Folded.writes`),
    and `memberWritesOf(p, f)` sorts them into members when read, through
    `memberOfFile`. A fold is cached per log file and knows neither its pin nor
    the member list, so counting by member inside it would keep counts made
    under an old list. A call is counted before it lands, as 0.1 measured.
    A path outside the checkout or in no member counts toward none. Exposed as
    `memberWrites(id, chat)`, pinned by `api/test/workbench.test.ts` § pins.
    `memberOfFile`'s JSDoc is now generic over `{ path }`, since the workbench
    keeps only `{ name, path }`.
- [x] 1.3 `Chat.package?: string`, the override: a member path, or `'.'` for
  repo-wide. `ChatStatus.package` is the resolved `{ name, path, inferred } |
  null`.
  - **Built.** `packageOf` in `workbench.ts`, run once per chat in `status`
    over one read of the members. The idle-only regroup is done here, not in
    the tab rows: the fold keeps `before`, the writes as they stood when the
    latest run started, and a working chat is graded on those. So 2.1 reads
    `package` as it is and does no remembering of its own. A Bash write still
    counts toward nothing. The cases from Phase 1's Done-when are pinned in
    `api/test/workbench.test.ts` § pins, where 1.1 and 1.2 are, not
    `services.test.ts`: the service has no package surface until 1.4.
- [x] 1.4 A service method to set or clear the override, beside close and open.
  It clears on an explicit `null` and tests key presence, not `??`
  (Invariant 9).
  - **Built.** `setPackage { chat, package }` on the workbench service, over
    `setPackage(id, input)` beside `close` in `workbench.ts`. `package` is a
    member path, `'.'`, or `null`, which deletes the key from the chat. A body
    without the key, or a path that is not a current member, is refused
    (400), so a stale menu cannot save a member that `packageOf` would ignore.
    Allowed while a run is going: the owner's choice regroups at once, and only
    inference waits for idle. Pinned by `api/test/workbench.test.ts` § pins;
    `app.snapshot.md` regenerated.

### Phase 2 — Tabs group by package

Goal: both tab rows draw groups, and a group folds.
Done when: a `drive-browser` run over a pin with three chats on two packages
shows the order, the labels, a fold and an override that moves a tab.

- [x] 2.1 Both rows sort into groups (repo-wide first, then by member order)
  and draw the label. The open order still decides order within a group.
  `package` arrives already held steady through a run (1.3), so the rows
  group on it as given.
  - **Built.** The sort is `status`'s, in `workbench.ts`: the API holds the
    member list and the client does not, so `PinStatus.chats` arrives in
    drawing order (a stable sort, so open order holds within a group) and
    `p.chats` keeps open order for close's neighbor. `groupsOf` in
    `index.mesa` cuts the runs; each is a `.workbench-chat-group`
    (`display: contents`, so tabs still shrink and scroll as one row) with
    `data-package`, and a member's carries `role="group"` and the label, the
    last path segment (`auth ·`) titled with the package name. Pinned by
    `api/test/workbench.test.ts` § pins; driven in Chrome over a scratch pin
    with four chats on two members, both rows.
- [x] 2.2 The label folds its group to a chip with a count. The fold is per pin,
  kept where the slim and fold choices are kept today.
  - **Built.** `groupFolds` in `index.mesa`, per pin and package path, in
    memory as `slimmed` and `folds` are, so a reload opens every group. The
    label is a button (`aria-expanded`) in both rows, which share the fold.
    Folded, it reads `auth · 2` as a pill. It also wears the dot of the chat
    inside that most wants the owner (asks, then unread, then working), is bold
    when one is unread, and is `aria-current` when it holds the shown chat, so
    a fold never hides a question or a reply. Driven in Chrome by a scratch
    script over 2.1's pin: fold, chip, count, dot, both rows, unfold, the pane
    staying slim, no console errors.
- [x] 2.3 The tab menu sets the override from 1.4 and shows *inferred* beside a
  package that was not chosen.
  - **Built.** A tab had no menu, so each tab in the full row gained a `⌄`
    (`.workbench-chat-pkg-open`, only where the checkout has members). The
    menu has *From its writes* (suffixed with the inferred package, `auth ·
    inferred`, or `repo-wide`), *Repo-wide*, and a submenu *A package* of every
    member, with *inferred* beside the one inference picked. The member list
    rides on `pins` (`members`), not the status poll. `ChatStatus.chosen` is
    the stored choice (`'.'` or a member path, null while inferred) because a
    null `package` cannot tell a chosen repo-wide from an inferred one. With
    this repo's 58 members the submenu ran past the window, so
    `@frontierjs/ui`'s `DropdownMenu` and `DropdownSubmenu` panels now cap at
    the viewport and scroll, pinned by a 60-row submenu in the kit's
    `dropdown.spec.mjs`. A tall top-level menu low on the page still opens
    past the edge (`FJS-4063`). Example's `verify:ui` was not run, since it
    needs the shared 8110 dev servers.
  - **Phase 2's drive.** A scratch CDP script over a pin with four chats on
    two of 32 members ran all 32 checks green: order, labels, the fold in both
    rows, the menu's three choices each moving the tab and stored on the chat,
    the submenu inside the viewport, no console errors. It is not committed.

### Phase 3 — The package does work

Goal: a chat's package narrows its context and its checks.
Done when: a run in a package chat names that package in its appended prompt,
and its `checks` line names and counts only that chat's files.

- [x] 3.1 `workbenchContext` names the chat's package and points at its
  `CLAUDE.md` and `PROJECT_STATE.md`, which exist only where the checkout is
  FrontierJS. The cwd stays the checkout root, so `fli` and hooks behave as
  they do now.
  - **Built.** `start` resolves the package through `packageOf` on the chat's
    writes so far (the chat is idle when a run starts) and passes it to
    `workbenchContext(p, pkg)`. The last bullet names the package and its
    path, says whether it was inferred or chosen, and names only the notes
    that exist there. A repo-wide chat gets no bullet. Resume drops an
    appended prompt, so every run recomputes it and a moved tab is told on
    its next run. `packageOf` now takes the writes to read, and `status`
    picks `before` for a working chat. The same edit fixed the context's
    "started by Basecamp's API" to Workbench's. Pinned by
    `api/test/workbench.test.ts` § pins: inferred with one note file, chosen
    with none, and repo-wide, over the fake `claude`.
- [x] 3.2 Q3: `collectChanges(root, { only })` in `packages/cli/core/done.js`
  cuts `changed`, `added`, `untracked` and `diff` together, and
  `workbench-check.ts` passes the chat's written files as `only`. The
  `checks` line names its scope. A chat with no recorded writes passes no
  `only`. A `services.test.ts` case pins a Bash-only chat to the whole-tree
  grade.
  - **Built.** `runDone(root, { only })` passes it through; the engines
    (snapshots, registers, npm) still grade the whole tree. The diff is cut on
    its own `diff --git` headers, since a pathspec reads `routes/[id]/` as a
    glob. `check(id, chat?)` is now async and grades the named chat, else the
    shown one; a run's follow-up names the chat that ran. The child rewrites
    the whole checks file, so it gets `{ chat, only }` and writes
    `scope: { chat, files }`, which `PinStatus.checks` carries. The strip reads
    *1 unfinished · this chat's 2 files, 1 changed* (*another chat's* when
    another tab is shown), else *… changed in the tree*, and the Checks tab
    says which. The case is in `api/test/workbench.test.ts` § checks, where
    the stand-in `done.js` lives, not `services.test.ts`: a Bash-only run is
    graded on the whole tree, then a Write narrows the next check to that file.
    `cli/test/done.test.js` pins the cut, a `[id]` path included. The strip and
    the tab were driven by a scratch CDP script (6 checks), not committed.
- [x] 3.3 A *Test <package>* button on the Run tab runs the member's own
  `bun run test` as a script row.
  - **Built.** `inventory(root, name, members)` in `workbench-run.ts` adds a
    `test:<path>` row (`kind: 'test'`) for each member whose package.json has
    a `test` script, read fresh, not off the member cache. A member that is an
    app already has that script as a `task:` row, so it gets no second one.
    `run` finds the row in the same inventory, so a request still names a row
    id and never a command. The page leads the Run tab with *This chat's
    package* and a *Test auth* button for the shown chat's member. Another
    member's test is listed under *Tests* only once it has run, so its output
    stays reachable. Pinned by `api/test/workbench.test.ts` § the Run tab: one
    row per member with a test, none for an app member, a member without one
    refused, the run in the member's directory. A scratch CDP drive covered the
    page (11 checks) and is not committed.

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
