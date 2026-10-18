---
id: study
status: proposed
dated: 2026-10-17
---

# Idea — the study: Claude sessions in tabs, split beside Haven

**Status: PROPOSED.** Dated 2026-10-17. Phase 0, Phase 1 and 2.1 are built. Do not
cite this file as describing behavior — see `VERIFYING.md`. Work the plan from
the first open box.

**The ask.** A command in `fli haven` opens a chat with Claude beside the
scene, split screen. The chat has tabs, one session each, and a key cycles
them (Ctrl+J / Ctrl+K asked for).

**The claim.** Two owners already exist. The split is a terminal-shell
affordance like Ctrl+P, so it is Sierra's: `runTerminalShell` takes an
optional side pane, and any app's `fli dev:tui` may hand one in. The pane that
runs Claude is Haven's and the owner's machine only — the lane `#workers` and
`#taskmaster` already hold — because it runs a session with tools in a
checkout. A hosted Haven with strangers on it never mounts it.

**Ruled in chat, 2026-10-17** (owner):

- **Engine: `claude -p --input-format stream-json --output-format stream-json`**,
  one child process per tab, the binary `agents/agents.js` already spawns. No
  SDK dependency. A tab reopens with `--resume <session-id>`.
- **Split: a Sierra slot, a Haven pane.**
- **Keys: probe Ctrl+J/K first** — Ctrl+J is byte `0x0A`, the line feed, and a
  terminal without the kitty keyboard protocol may deliver it as Enter.

## Shape

- **Focus belongs to one pane at a time.** Arrows, Esc and typing go to the
  focused pane; one key moves focus. Esc stays Haven's walk-back.
- **A tab is `{ sessionId, cwd, title, status }`**, `status` one of `idle`,
  `working`, `needs-permission`. The tab bar marks a tab waiting on a prompt,
  so a session cannot stall unseen. Tabs persist to `~/.fli/haven/study.json`.
- **A permission prompt is a confirm panel in the pane**, answered over the
  same stdio stream (0.2 found the CLI asks its host there). Until 2.3 builds
  the panel, a tab starts with `--permission-mode auto`.
- **Narrow terminals zoom.** The scene is about 120 columns, so a split wants
  about 200; under that, the focus key shows one pane full width.
- **Each tab is already a figure.** `.claude/hooks/haven-worker.mjs` records
  every Claude session on this machine, so a tab's session stands at its
  package's bench in the workshop with no new code.

## The nine

Answered late — after the file was first written, before any code.

1. **Origin** — the transcript stays Claude's own (`~/.claude/projects/`);
   `study.json` holds a session id and a title, a pointer rather than a copy.
2. **Concept** — one noun, *study* (Q1), for the pane, and Sierra's `side` slot. A tab is
   a Claude session, which is not a new noun. No new dependency.
3. **Complexity** — the problem's. *Pane* is tmux's and vim's word for a split
   region with focus, so the word comes from prior art rather than being coined.
4. **Predictability** — the split follows Ctrl+P: shell chrome lives in Sierra
   and works in every app's `fli dev:tui`. Esc keeps one meaning.
5. **Derived** — `status` is read off the stream's events and never stored;
   the workshop figure comes from the existing hook.
6. **Owner** — terminal chrome is `runTerminalShell`'s, so the split lives
   there. Running `claude` is already `agents/agents.js`'s, so the pane
   resolves the binary the same way (`HAVEN_AGENTS_CLAUDE`), sharing that
   rather than spelling a second one.
7. **Boundary** — `side` is a named prop (a component plus a focus contract);
   the stream's events are parsed in one module.
8. **Failure** — no `claude` on PATH: the pane says so and Haven keeps
   running. No checkout (`checkout()` is null, a hosted install): the pane
   never mounts.
9. **Silence** — must stay true: the pane mounts only on the owner's machine,
   and the parser matches the CLI's event shape. What fails: **none** while
   experimenting; a stub-`claude` test of `agents.test.js`'s shape when the
   owner calls it settled.

**Adjudication: batteries vs. smallness** — the slot is one seam in Sierra's
shell and the pane is severable in Haven; Sierra never learns Claude.
**Tier:** Assessment, until built.

## Open questions

- **Q1 — the noun. Ruled 2026-10-17 (owner): the study.** A room noun: the
  place beside the town where work happens. "Mode" already meant NORMAL/typing
  (`Mode.mesa`), and "desk" and "bench" were taken. Haven's files are
  `Study.mesa` and `lib/study/`, and the tabs persist to
  `~/.fli/haven/study.json`. Sierra's slot stays the generic `side`, because
  Sierra never learns what Haven puts in it.
- **Q2 — the command. Ruled 2026-10-17 (owner): `/work` and a key.** `/work`
  in Haven's command line, and a key that toggles the study from anywhere,
  chosen in 1.1 beside the focus key.

---

### Phase 0 — Probe the three unknowns

Goal: know what the terminal, the CLI and the layout actually do before
writing the pane.
Done when: each step below records its finding under its box.

- [x] 0.1 Ctrl+J and Ctrl+K as opentui delivers them, beside Enter
  - opentui's `parseKeypress` (0.5.17) gives Enter `\r` as `return`, Ctrl+J
    `\n` as `linefeed`, which is distinct from Enter, and Ctrl+K as `k` with
    `ctrl`. Under the kitty protocol Ctrl+J is `j` with `ctrl`. **Ctrl+J/K
    are usable**, so the asked-for keys stand.
  - Two things to handle in 2.1. Mesa's `keyFields` maps `linefeed` to
    `key: '\n'` with no `ctrlKey`, which a handler reads as a typed newline,
    so it should map to `{ key: 'j', ctrlKey: true }`. opentui's textarea
    binds `linefeed` to newline and Ctrl+K to delete-to-line-end, so the
    shell must take both keys before a focused input does.
  - Alt+[ is not usable: `\x1b[` is the CSI prefix and parses as no key.
- [x] 0.2 `claude -p` stream-json: one turn in, the events out, and whether a
  permission prompt reaches the host on stdout
  - Spelling: `-p --input-format stream-json --output-format stream-json
    --verbose --permission-prompt-tool stdio`. Without `--verbose` the
    stream-json output is refused.
  - A line in is `{ type: 'user', message: { role: 'user', content } }`. Out
    come `system/init` (session id, tools, model), `assistant` messages
    (blocks `text`, `thinking`, `tool_use`), `user` for tool results, and a
    `result` per turn (`session_id`, `total_cost_usd`).
  - **A permission prompt reaches the host**: `control_request` with
    `request.subtype: 'can_use_tool'`, `tool_name`, `input`, `description`
    and `permission_suggestions`. The host answers with `control_response`,
    `{ subtype: 'success', request_id, response: { behavior: 'allow',
    updatedInput } }` or `{ behavior: 'deny', message }`. Both were run, and
    a deny left no file behind.
  - **One process holds the session across turns**: a second user line on
    the same stdin answers with the same `session_id`. Closing stdin exits 0.
    So a tab is one long-lived child.
  - The owner's hooks run in a `-p` session (`hook_started` events), so
    `haven-worker` records a tab with no new code (3.2).
- [x] 0.3 opentui row split: a lowered Haven scene in a left box and a text
  box at its right
  - The Square mounted into a 100-column `overflow: hidden` box inside a
    160×30 row lays out correctly: the scene clips at its box, and a bordered
    box beside it draws.
  - **The scene fits the renderer, not its box.** `paint.js` calls
    `stage.fit(viewFor(ctx.width, ctx.height))`, so the stage's view was 157
    wide inside a 100-wide box. The figure would walk past the visible edge
    before the view pans. Fixed by 1.1a.

**Done 2026-10-17.** All three unknowns came out favorable. Ctrl+J/K are
distinguishable keys, the CLI's stream protocol carries permission prompts to
the host, and opentui splits cleanly. One fix is owed before a split is
usable: the scene must size itself to its box (1.1a).

### Phase 1 — One tab

Goal: a single Claude session beside the scene.
Done when: in a real terminal, `/work` opens the pane, a line sent gets a
streamed answer, and focus moves between the panes and back.

- [x] 1.1 Sierra: `runTerminalShell({ side })` — a row split, a focus key,
  and nothing about Claude
  - **Keys: Ctrl+\\ shows and hides the side, Ctrl+O moves focus between
    panes.** Ctrl+\\ is VS Code's split and `o` is tmux's next pane. Neither
    is in opentui's textarea bindings (a e f b w k u d - .), and both parse
    as the letter with `ctrl`. The shell takes them before any mount sees
    the key, as it does h/j/k/l, and Mesa's `onKey` now skips a key a host
    listener already prevented.
  - `side` is a `.mesa` file: `--side` on `tui.js` and `fli dev:tui`,
    resolved from `web/`. That puts the owner-only rule with whoever starts
    the shell, so `fli haven` passes it only from a checkout (1.4). The pane
    mounts on the first Ctrl+\\ and stays mounted while hidden, so a tab's
    process outlives a hide.
  - Mesa owns the layout (`sideOf`, `paneOf`, `focusPane`): page and side are
    a row above the footer, with the side 40% wide. Tab stays inside the pane
    that holds focus, and Ctrl+O returns to the node last focused there. A
    key at a node in the side never reaches the window, so the scene's
    window listener cannot walk on it. Focus events still cross, so the mode
    line reads `-- SIDE --` there, and Esc and h/j/k/l belong to the side.
  - Run in tmux at 200×40 against Haven's dev API: the split draws at
    120/80; arrows typed in the side left the figure where it was, and after
    Ctrl+O three Rights walked it three cells. Esc in the side left the room
    open. Hiding the side gave the page its full width back.
- [x] 1.1a Haven: `paint.js` fits the stage to its box's size and listens to
  the box's resize, not the renderer's (0.3)
  - The box is the PAGE, not the scene's own box, which is sized by its
    frame buffers. Mesa exports it as `pageOf` beside `sideOf` and
    `footerOf`. `paint.js` takes the page's columns and the renderer's rows,
    since the side splits columns only and `viewFor` counts the mode line
    under both. It listens to the page's `resize`, which fires on a side
    toggle and on a terminal resize alike. Before the first layout a page
    reads 0 wide, so the fit falls back to the renderer's width.
  - The HUD under the scene (the pack, the map) is sized by the stage, but
    `Profile.mesa` read `stage.size.w` in its template, where a side toggle
    changes no tracked value. It keeps the width in a `let` beside `spare`.
  - Run in tmux at 200×40 against Haven's dev API: with the side open the
    art and the HUD are 117 wide, no wrap and no scrollbar. Sixty Rights
    held the figure at column 106 while the view panned, 11 cells short of
    the side. Hiding gave back 197. Resized to 160×36 with the side open,
    the view and HUD re-fit to 93 and the figure re-followed to column 84.
    `verify:view` and Mesa's terminal drive (428) are green.
- [x] 1.2 Haven: the session process — spawn, send a line, parse the events
  into messages, end it on exit
  - `web/src/lib/study/session.js`: `startSession({ cwd, resume, model })` →
    `{ state, subscribe, send, end, kill }`, and the pure `fold(state, event)`
    the pane can be tested by later. A message is `you`, `said`, `thought`,
    `tool` (one line from its input, marked `done`/`failed` by its result),
    `turn` (ms, cost, error) or `error` (the process, not the model). A
    subagent's events (`parent_tool_use_id`) are left out. `status` is
    `working` while a sent line has no `result`, else `idle`.
  - **`total_cost_usd` is the process's running total, not the turn's**: a
    one-word second turn read higher than the first. A turn's cost is the
    difference, and a `--resume`d process counts from 0 again.
  - `system/init` arrives only after the first line is sent, so `sessionId`
    is null until then. A missing binary is an `error` message and `send`
    answers false. The child is killed on Haven's `exit`, and one whose
    parent dies outright gets EOF on stdin and ends on its own.
  - `HAVEN_AGENTS_CLAUDE` is spelled once, here, and `agents/agents.js`
    imports it: the other way round would load the agents' runner into the
    study.
  - Run against the real CLI on Haiku: a Read call marked done, two turns on
    one session id, exit 0 on `end()`; `--resume` of that id remembered the
    file; a child alive while the probe ran was gone after its
    `process.exit`. No partial messages: a block arrives whole, which is
    `--include-partial-messages` if 1.3 finds that too slow.
- [x] 1.3 Haven: the pane — messages scrolled, an input line, `status`
  - `web/src/components/Study.mesa`, handed to `--side` as
    `src/components/Study.mesa`: a status line (model, `working Ns` or
    `idle`, the process's cost, `N newer ↓` while reading back), the newest
    rows that fit, and an `<input>` on the bottom row; Enter sends.
    `lib/study/rows.js` is the layout, pure: a message's rows at a width, a
    thought and a tool call one row each, and `windowOf`.
  - **Nothing on a terminal scrolls but the page**, and the side is a plain
    box, so the pane windows its own rows to the size of the box it was
    mounted in, again on its `resize` (not Mesa's `sideOf`, which would make
    a side where there is none). PageUp and PageDown in the input page
    back and forward; a reader scrolled back holds a row, so what arrives
    meanwhile does not move it. Blank rows pad under the newest to keep the
    input at the bottom. A `<pre>` holding only a literal space lays out at
    no height, so a pad row is `{' '}`.
  - The wrap is `Bun.wrapAnsi` per line with the line's indent carried, since
    an answer's code is indented and `answer.js`'s `wrap` folds spaces.
  - The session starts at the first line, in `#ledger`'s `checkout()` (the
    shell's own cwd is `web/`). One that ended is resumed by the next line
    with its messages kept above. A missing binary is a red row and the
    status reads `ended`.
  - The nine answered late, after the code. Q7 failed and was fixed (the
    `sideOf` above). Q9: none fails while experimenting.
  - Run headless against a stub `claude` (two turns, a tool marked done,
    PageUp, a missing binary at 80 columns), then in tmux at 200×40 against
    the dev API with the real CLI: the split draws, a Read call came back
    marked done with the answer and `— 32s · $0.783`, letters type into the
    side unrenamed, Ctrl+O crosses both ways, a hide and show keeps the
    session, and Ctrl+C took the child with it. **No model is named, so a
    tab runs the CLI's default** — Opus here, $0.78 for that one-line turn
    over this repo's context.
- [x] 1.4 The command that opens and closes it (Q2)
  - **`/work` and Ctrl+\\ are one toggle.** The shell hands its show-and-hide
    to Mesa's `setSideToggle(renderer, fn)`, beside `sideOf`, and a page reads
    it with `sideToggle()`, null where the shell has no side. Ruled in chat
    (owner): Mesa owns it, over a renderer event whose name two packages would
    spell. Haven reaches it through `#study` (`lib/study/study.js`; the
    browser twin answers null), since `Scene.mesa` is built for both targets
    and the terminal runtime must not reach the browser build.
  - `Work.mesa`, placed by `Scene.mesa`, adds `/work` only where
    `sideToggle()` answers, so an installed Haven, a browser and a `bun run
    tui` with no `--side` have no `/work` and no hint of it.
  - `fli haven` passes `--side src/components/Study.mesa` only when it runs
    the checkout's Haven, the same `checkout` test that picks the build.
  - Run in tmux at 200×40 against the dev API with a stub `claude`:
    `/wo` hints `/work`; `/work` opens the study with focus in it; a line got
    its answer; Ctrl+O back and `/work` hid it, the page full width; `/work`
    again showed the same session with its messages; Ctrl+\\ hid it. `bun run
    tui` with no side answers `no command /work`. Haven's typecheck and
    `mesa-compiles` are clean.
  - The nine answered late, after the code (the seam itself was asked
    first). All pass; Q9: none fails while experimenting.

### Phase 2 — Tabs

Goal: several sessions, cycled, surviving a restart.
Done when: three tabs open, cycled by the ruled key, quit, and come back
resumed from `study.json`.

- [x] 2.1 Tab bar, new and close, the cycle key 0.1 chose
  - **A tab names its model. Ruled 2026-10-17 (owner): per tab, here.**
    `/new [model]` opens a tab on that model (`--model`, an alias or an id
    the CLI takes); bare, the CLI's default. The model is held once, on the
    tab; the bar reads the CLI's `system/init` name for a tab that asked for
    none.
  - **New and close are typed words, the cycle is a key.** `/new` and
    `/close` are the study's two words (`lib/study/tabs.js`, `studyLine`);
    every other line goes to Claude whole, its own slash commands included.
    Close is a word and never a key, since it ends a process and Ctrl+W
    deletes a word in the field. A tab closed mid-turn is killed rather than
    left working where no tab shows it, and closing the last opens a fresh
    one. Ctrl+J and Ctrl+K are the next and last tab, around the end, read
    off `code` and taken before the input, which submits on a line feed and
    deletes to its end on Ctrl+K.
  - The bar is a row over the status line: `[n model]` the shown tab, `…`
    working and `✗` ended, read off each session's state. A value derived
    from a derived tab stops updating, since the tab is the same object
    after a change, so each `$:` reads `tabs[at]` itself.
  - **Mesa's `keyFields` owed two fixes** (0.1): a Ctrl letter's `key` is its
    letter rather than the control byte a legacy terminal sends, and
    `linefeed` is `j` with Ctrl. `keys.spec` pins both. HomeRow's operator
    ignores a modified key, or `d` then Ctrl+K would fire upward.
  - Run in tmux at 200×40 against the dev API with a stub `claude` that
    names its `--model`: two tabs answered on their own models and session
    ids, the bar marked a working tab, Ctrl+J and Ctrl+K wrapped both ways
    with a draft in the field neither submitted nor cut, `/close` took each
    tab's child (a working one killed), the last close left a fresh tab, and
    Ctrl+C with a working tab left no child. Mesa's terminal drive is green.
  - The nine, answered before the code: (1) the model is held once, on the
    tab, and `system/init`'s is display only; (2) no new noun, the words are
    tmux's and a browser's; (3) the problem's; (4) `/` lines are the scene's
    shape, and the two words the study takes are the only ones not Claude's;
    (5) the marks are read off each session, never stored; (6) tabs are
    `Study.mesa`'s, Sierra learns nothing, keys become DOM fields in Mesa's
    one `keyFields`; (7) one pure parser, `studyLine`; (8) a bad model is
    the CLI's exit as a red row in that tab alone, and the destructive act is
    a typed word; (9) must stay true: Ctrl+J and Ctrl+K never reach the field
    — what fails: `keys.spec` for the key fields, none for the study while
    experimenting. Adjudication: familiarity vs precision (the words are
    stolen); tier Assessment.
- [ ] 2.2 `study.json` and `--resume`
- [ ] 2.3 Permission panel and the `needs-permission` mark

### Phase 3 — Fit

Goal: usable on a laptop screen and tied to the world.
Done when: an 120-column terminal zooms rather than clips, and a tab's figure
is pointed out in the workshop.

- [ ] 3.1 Zoom under the split width
- [ ] 3.2 A tab names its figure; the figure names its tab
- [ ] 3.3 A CHEF! ticket opens in the study. **Ruled 2026-10-17 (owner):
  read-along plus own tabs.** A ticket whose session the study started opens
  that tab, answered in 2.3's panel. Any other ticket opens a read-only tab
  tailing that session's transcript (the hook's `transcript_path`, which
  `#workers` does not keep yet), showing the ask; its own host still answers
  it. Never `--resume` a session another host holds: two processes would
  drive one session in one tree.
