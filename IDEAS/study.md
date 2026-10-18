---
id: study
status: proposed
dated: 2026-10-17
---

# Idea — the study: Claude sessions in tabs, split beside Haven

**Status: PROPOSED.** Dated 2026-10-17. Every phase is built. Do not
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
  same stdio stream (0.2 found the CLI asks its host there). A tab runs
  `--permission-mode manual`, since under `auto` the CLI asks the host
  nothing (2.3).
- **Narrow terminals zoom.** The scene is about 120 columns, so a split wants
  about 172 (the side takes 30%); under that, an open side shows one pane full width and Ctrl+O
  swaps them (3.1).
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
    a row above the footer, with the side 30% wide. Tab stays inside the pane
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
- [x] 2.2 `study.json` and `--resume`
  - `web/src/lib/study/kept.js`: `readStudy(cwd)`, `writeStudy(cwd, kept)`,
    `keptOf(tabs, at)`. A tab is kept as `{ sessionId, model }`, and the shown
    tab as `at`. **One entry per checkout**, keyed by the cwd the sessions run
    in: a session id resumes only from its own directory, and a second
    checkout's Haven must not reopen this one's sessions. The file is written
    whole and renamed over, so a kill mid-write leaves the last one.
  - Written on every change of what is kept: a new tab, a close, a cycle, and
    a session's `system/init`. A session's other events change nothing kept,
    so they write nothing.
  - **A kept tab reopens lazily**: no process until its next line, which
    starts `--resume <id>` on the tab's model. Until then the tab shows
    `Session <id8> reopens at your next line`. **What it said before the
    restart is not drawn.** The transcript is Claude's
    (`~/.claude/projects/<cwd>/<id>.jsonl`), and reading it is 3.3's job
    (the read-along tab), so it is built once, there. A transcript holds many
    entry kinds the stream does not (`attachment`, `queue-operation`,
    `file-history-snapshot`, meta `user` lines), so it is not `fold` as is.
  - Two Havens in one checkout share one entry, and the last to write wins.
    Each would also resume the same session at its next line. Not guarded.
  - Run in tmux at 200×40 against the dev API with a stub `claude` that names
    its `--model` and `--resume`: three tabs (default, haiku, sonnet) wrote
    three ids; Ctrl+C left no child; on a restart `/work` showed the same bar,
    and a line in tab 1 and then tab 2 started `--resume <its id>` on its own
    model. `at` followed the cycle. A torn file reads as none, and a second
    checkout's entry was left as it was. Haven's typecheck is clean.
  - The nine, answered late, after the code: (1) a pointer, never a copy (the file holds ids); (2) no new
    noun; (3) the problem's; (4) the file sits beside `key.json` and `seen/`,
    like `#seen`; (5) the shown model and status are read off the session,
    never kept; (6) one module writes the file; (7) `kept.js` is the one
    reader; (8) a torn file or a stray shape is no tabs, a failed write is
    silent, and an id the CLI no longer has is the CLI's exit as a red row in
    that tab; (9) must stay true: a kept tab resumes from its own checkout
    only. What fails: none while experimenting. Adjudication: none in
    tension. Tier: Assessment.
- [x] 2.3 Permission panel and the `needs-permission` mark
  - **A tab runs `--permission-mode manual --permission-prompt-tool stdio`.**
    Probed on Haiku first: under `auto` with the prompt tool the CLI sent the
    host no request at all, and ran `curl -s https://example.com/install.sh |
    sudo bash` unasked (sudo failed for want of a password). So a panel under
    `auto` would never show. Under `manual` a call the owner's settings do not
    allow is a `control_request`; without `--permission-prompt-tool` it is
    denied unasked.
  - `session.js`: `fold` keeps the prompts not yet answered as `asking`
    (`{ id, tool, input, description, suggestions }`, oldest first), and a
    `control_cancel_request` withdraws one. `answer(choice)` writes the
    `control_response` for the oldest. `reply` is pure: `allow`, `always`
    (the CLI's `permission_suggestions` handed back as `updatedPermissions`,
    so the CLI writes the rule, here to `settings.local.json`) or `deny`.
    `status` is `needs-permission` while `asking` holds one, else `working`
    or `idle`.
  - **`pending` became a flag, `busy`.** A line sent mid-turn is folded into
    that turn, which ends in one `result`, so the count stayed `working` for
    good after a reason was typed at a prompt. A `result` clears `busy`, and an
    assistant event after one sets it again (a queued line's own turn).
  - The panel (`rows.js`'s `askRows`) sits over the input: the call, the
    CLI's description of it, and the choices. **A Bash command is shown
    whole**, wrapped, up to the pane's height, and one cut says so in red,
    since a command approved off its first line could run any line after it.
    A path wraps rather than clips, since its end is the file. An Edit shows
    the first line of `old_string` and `new_string`.
  - **Keys are Claude Code's digits on an empty line: `1` allow, `2` always,
    `3` deny.** y/a/n came first and failed the drive: a reason typed as
    "not t2, …" lost its `n` to the answer and went as a fresh line. **A line
    typed at a prompt denies it and goes to Claude as the owner's next line**,
    as Claude Code's "No, and tell Claude what to do differently" does. The
    reason was carried in the deny's `message` first, and Haiku declined to
    act on it: "that message came back in the tool result, not from you". A
    deny now says only to stop and wait for the next line.
  - The bar marks a tab waiting `?` (over `…`), and the status line reads
    `needs permission`. Closing a tab that is not idle kills it.
  - **A prompt in a HIDDEN study stalls unseen.** The bar is drawn only while
    the study shows, so Ctrl+\ with a tab waiting leaves nothing on the scene
    saying so. Not built: it wants a mark in the shell's own chrome, which is
    Sierra's (3.x, or a line in `Mode.mesa`).
  - Run in tmux at 200×40 against the dev API through `fli haven`, with the
    real CLI on Haiku in a `/new haiku` tab: a `touch` outside the checkout
    showed the panel, `1` ran it; a second waited while Ctrl+K showed tab 1
    with `2 haiku?` in the bar; "no, touch t3.txt in the same folder
    instead" denied it and Claude asked for t3, which `3` denied; the status
    went back to `idle`; Ctrl+C left no child, and `study.json` was removed
    after. `2` was not pressed in the checkout, since it writes the
    checkout's `settings.local.json`; a probe in a scratch directory showed
    the CLI writing `Bash(touch made-by-bash.txt)` there. Haven's typecheck
    and `fli check` are clean.
  - The nine, answered late, after the code: (1) a prompt is the CLI's, held
    in the session's state and never stored, and an `always` rule is written
    by the CLI, not by Haven; (2) no new noun, and the keys are Claude Code's;
    (3) the problem's; (4) the digits and the typed reason behave as Claude
    Code's do; (5) `status` is read off `asking` and `busy`; (6) `session.js`
    is the one writer of a `control_response`; (7) `reply` and `askRows` are
    pure; (8) a process that ends clears its prompts, a tab closed waiting is
    killed, a cut command says so, and a hidden study is the gap above; (9)
    must stay true: no call runs on a key the owner did not press, and a
    command is shown whole or marked cut. What fails: none while
    experimenting. Adjudication: familiarity vs precision, and the familiar
    digits won, since y/n ate a letter. Tier: Assessment.
- [x] 2.4 An image in a line. **Ruled 2026-10-17 (owner): a path the line names
  and the clipboard, both.** Probed 2026-10-17:
  **the stream takes an image.** A user line whose `content` is a block
  array, `[{ type: 'image', source: { type: 'base64', media_type:
  'image/png', data } }, { type: 'text', text }]`, was answered correctly
  by Haiku ("Red" for a red square, $0.008). So `session.send` taking blocks
  is the whole engine change. The question is how an image reaches the line,
  since a terminal pastes text, never a picture:
  - **Today, with no code:** type the image's path in the line. Claude's
    `Read` tool opens a PNG or JPG as an image, and dragging a file onto
    most terminals pastes its path. Costs one tool call.
  - **A path the line names** (`/image <path> [words]`, or any token that
    is an existing image file): the study reads and base64s it into a block.
    No tool call, and works on any terminal.
  - **The clipboard**, as Claude Code's own Ctrl+V does: `xclip -selection
    clipboard -t image/png -o` on X11 (installed here), `wl-paste --type
    image/png` on Wayland, `pngpaste` or `osascript` on macOS. The key must
    be one opentui's textarea and the shell leave free, and a terminal's own
    Ctrl+Shift+V pastes text only.
  - **Built.** `lib/study/images.js`: `imagesOf(text, { cwd, pasted })` is
    the blocks a line carries — each `[Image #n]` still in it whose picture
    was pasted, then each token naming an existing image file (bare,
    quoted, its spaces escaped, or a `file://` URL, as terminals paste a
    dragged file; a trailing period dropped). A path stays in the text as
    typed, so a line about `a.png` still names it. The type is read off the
    first bytes, never the extension, and an image over 5 MB encoded or not
    a PNG, JPEG, GIF or WebP refuses the send naming the file, the line
    kept. `clipboardImage()` reads `wl-paste`, `xclip` or `pngpaste`, the
    first whose session runs, in two seconds at most. `session.send(text,
    images)` writes `[...images, { type: 'text', text }]`, and a `you` row
    says `+ N images`.
  - **Ctrl+V** puts `[Image #n]` in the line, Claude Code's own spelling,
    and deleting it drops the picture. opentui's input and the shell bind
    nothing to it. What cannot be sent is a red row over the input, cleared
    by the next key. A read-along pastes nothing.
  - Run (scratch probe, not committed): the shell's `--side` in a 200×40
    pty on a private Xvfb display, its clipboard holding a PNG, a HOME of
    its own and a stub `claude` logging stdin. Ctrl+V drew `[Image #1]`;
    sent, the stub got an image block (`image/png`) then the text with the
    tag, and the row read `+ 1 image`; a path sent an image with the path
    kept; a fake `.jpg` was refused in red, nothing sent, the line kept; a
    tag deleted sent a plain string; a text clipboard said so, and the next
    key cleared it. 12/12. Through `startSession`, Haiku named a blue PNG
    the line named "Blue" with no tool call ($0.008). Haven's suite 681
    pass, 4 fail (the editor's four, failing before); typecheck clean.
  - **Not probed:** Wayland and macOS (no `wl-paste` or `pngpaste` here),
    and a real X owner refusing `image/png` — `xclip` as owner answers every
    target with its text, so that probe read "not a PNG" where a browser's
    clipboard reads "holds no image".
  - The nine, answered before the code: (1) the line sent is the one
    source — a pasted picture goes while its tag is in it, a path image
    because the line names it; (2) no new noun, *image* is the stream's
    block and `[Image #n]` Claude Code's; (3) the problem's: a terminal
    pastes text, and every desktop has its own clipboard reader; (4) two
    rules, a token naming an image file is that image and Ctrl+V tags one;
    (5) the type is derived from the bytes, which images go from the line;
    (6) `session.js` stays the one writer of a line, and `images.js` owns
    line to blocks and the clipboard, no owner in the tree before it;
    (7) `imagesOf` and `clipboardImage` throw naming what failed;
    (8) a file that cannot go refuses the send rather than dropping the
    picture, a clipboard with none is a red row; (9) must stay true: no
    image goes that the line sent does not name, and a read-along sends
    none. What fails: none while experimenting. Adjudication: familiarity
    vs precision, Claude Code's shape and words kept since they fit.
    Tier: Assessment.

### Phase 3 — Fit

Goal: usable on a laptop screen and tied to the world.
Done when: an 120-column terminal zooms rather than clips, and a tab's figure
is pointed out in the workshop.

- [x] 3.1 Zoom under the split width
  - Sierra's `paneKeys`: where the page would keep fewer than `PAGE_COLUMNS`
    (120) beside the side's `SIDE_SHARE` (0.3, handed to `sideOf` rather
    than left to its default, so the threshold, 172, is derived from it) an
    open side is ZOOMED, as tmux's prefix z.
    The pane holding focus is drawn full width (`pageOf(r).visible`, and the
    side's `flexGrow` so its share takes the row alone), and Ctrl+O swaps.
    The renderer's `resize` re-decides, so widening past 200 gives the split
    back and narrowing zooms to whichever pane holds focus. Mesa is unchanged.
  - **The drawn pane follows focus**: a route's mount or anything else that
    focuses into the hidden pane brings it forward, since keys going to a
    pane nobody can see is the failure. The pane is drawn before focus moves,
    because `focusables()` skips a hidden one.
  - **Ctrl+\ and `/work` test what is DRAWN, not what is open.** Zoomed
    behind the page, the study is open and out of sight, so the toggle brings
    it forward rather than closing it.
  - The mode line reads `· Ctrl+O the side` while the page is zoomed over an
    open side (`Mode.mesa`'s `zoom`), which is the one mark a hidden study
    has. It does not say a tab is waiting (2.3's gap stands).
  - Run in tmux through this tree's `fli haven` against the dev API, no line
    sent: at 160×40 Ctrl+\ drew the study full width, Ctrl+O the scene full
    width with the hint, and three Rights walked the figure; text typed in the
    study survived a resize to 200, which drew the split; Ctrl+O to the page
    and a resize to 120 zoomed to the scene, 117 columns wide; Ctrl+O, Ctrl+\
    hid the study and the hint went. Restarted at 120: from the zoomed page
    Ctrl+\ brought the study forward, a second hid it, and `/work` opened it.
    After the share was derived: 199 columns zoomed, 200 drew the split.
    Sierra's suite (2332), Haven's typecheck, `verify:view` and `fli check`
    in Haven are clean. `example`'s `verify:tui` fails one check, the field's
    INSERT, the same at HEAD with this change set aside: that is `FJS-2931`.
    Haven's `verify:explore` fails 35 of 60, the same 35 at HEAD: the fog
    and hedge checks of `FJS-2875` and `FJS-2877`.
  - The nine, answered late, after the code: (1) and (5) failed first: a
    `SPLIT_WIDTH = 200` restated Mesa's default 40% and would go stale unseen
    when it moved, so the shell states the share once and derives the
    threshold. The width is the renderer's, read on each resize; (2) no
    new noun, *zoom* is tmux's; (3) the problem's; (4) Ctrl+O and Ctrl+\ keep their meanings,
    Ctrl+\ now judged by what is drawn; (5) `zoom` is derived from `open`,
    the width and focus; (6) `paneKeys` is the one writer of both panes'
    visibility; (7) two constants, no option, since no second side exists to
    want another width; (8) a terminal resized under a zoom re-lays out, and
    focus never rests in a hidden pane; (9) must stay true: a key goes to the
    pane on screen. What fails: none while experimenting. Adjudication:
    familiarity vs precision, and tmux's shape and word both fit. Tier:
    Assessment.
  - **The share is 0.3, so the split draws from 172 columns.** At 0.4 it
    wanted 200, wider than a laptop; 120 / 0.7 is 171.4. Run in tmux through
    this tree's `fli haven`, Ctrl+\ to open the study: started at 172 the
    split drew, at 171 the study took the row alone; resized live to 220 and
    172 the split held, and to 140 it zoomed. Sierra's suite (2332) clean.
    The nine, answered late, after the edit: (1) the share is stated once and
    the threshold still derived from it; (2) no noun; (3) the problem's;
    (4) Ctrl+O and Ctrl+\ unchanged; (5) 172 is nowhere written in code;
    (6) `paneKeys` still the one writer; (7) a value, no option; (8) under
    172 it zooms, as before; (9) must stay true: the scene keeps 120 columns
    beside the side; what fails: none. No adjudication in tension. Tier:
    Assessment.
- [x] 3.2 A tab names its figure; the figure names its tab
  - **The figure names its tab.** Standing beside a
    workshop figure whose session is a study tab reads it out with the tab's
    number from the bar first, `[2] 3d06 working · 4s ago`. `#study`'s
    `studyTabs()` maps each session a tab runs (`sessionId`) or reads along
    (`reads`) to its number, read off `study.json` under the cwd `Study.mesa`
    keeps, polled with the workers every second; the browser twin is empty.
    The file and not the mounted study, since kept tabs exist before the
    study first shows. A fresh tab has no number on its figure until its
    `system/init` writes the id.
  - **The tab names its figure's bench** on the status line,
    `haiku · idle · at junction · $0.04`: `Study.mesa` reads `#workers`
    each second in the tick it already ran, the session's `bench` keyed by
    the tab's `reads`, else its session id, else the id it resumes. Not the
    bar: a bench per tab would not fit 30% of a terminal. A tab with no
    session yet, or one quiet past `QUIET_MS`, names none. `#study`'s
    `studyCwd()` is now the one place the cwd is worked out, and
    `Study.mesa` and `studyTabs()` both read it.
  - Tab half run through a scratch probe (deleted after) in a 200×40 pty
    with `--side`, a HOME holding three kept tabs and two workers written
    through the real hook: tab 2 read `at junction`; an edit in sierra
    moved it to `at sierra`; Ctrl+J to the read-along read `at mesa`; the
    tab with no session named none. 7/7. `verify:workshop` 18/18, Haven's
    typecheck clean, `fli check` no errors.
  - Run through a one-off copy of `verify:workshop` (deleted after) with a
    `study.json` in Sam's HOME naming `aaaa-one` as tab 2: beside it Sam's
    screen read `[2] aaaa packages/…`. Probed `studyTabs()` over a scratch
    HOME: a tab with no id yet keeps the numbers after it, another
    checkout's entry is ignored, no file is no tabs. `verify:workshop`,
    Haven's typecheck and `fli check` are clean; `verify:browser` fails its
    one fog line, which is `FJS-2877`.
  - The nine, answered late, after the code: (1) failed first: the cwd
    was read off `#taskmaster`'s `checkout()` where `Study.mesa` keys on
    `#ledger`'s, two roots that part under `HAVEN_LEDGER_ROOT`. It now
    reads `#ledger`'s, and the tab half moved the cwd into `#study`'s
    `studyCwd()` so one place states it. The tabs are a pointer, read off the file 2.2 already writes; (2) no new noun, the number is the bar's own;
    (3) the problem's; (4) `[n]` is the bar's spelling; (5) derived from
    `study.json` and `#workers` each poll, never stored; (6) `#study` is the
    one reader for the scene, `kept.js` the one parser; (7) one function, no
    option; (8) a torn or absent file is no numbers, and the reading is as
    before; (9) must stay true: a number on a figure is the bar's number for
    that session in this checkout, and a bench on a tab is where its
    figure stands. The tab half's nine, also late: the bench is read off
    the `#workers` row the figure stands on, one origin; no new noun;
    derived each second, never stored; `#workers` owns the bench and
    `#study` the cwd; no worker row is no bench and the line as before. What fails: none while experimenting.
    Adjudication: none in tension. Tier: Assessment.
- [x] 3.3 A CHEF! ticket opens in the study. **Ruled 2026-10-17 (owner):
  read-along plus own tabs.** A ticket whose session the study started opens
  that tab, answered in 2.3's panel. Any other ticket opens a read-only tab
  tailing that session's transcript (the hook's `transcript_path`, which
  `#workers` does not keep yet), showing the ask; its own host still answers
  it. Never `--resume` a session another host holds: two processes would
  drive one session in one tree.
  - **The gesture is `/work <id>`**, the id a ticket or a plate shows, from
    any scene. Bare `/work` still shows and hides the study. Not a kitchen
    verb with a reach: the study is reached from every scene, and an id is
    already on the rail. A prefix naming none or two answers with the ids up.
    **Ruled 2026-10-18 (owner): `/work <id>`.**
  - `#workers` keeps the hook's `transcript_path` (a `.jsonl` path, kept
    from the first event naming it) and `readWorkers` hands it as
    `transcript`. `#study` gains `openSession(worker)` and `onOpen(fn)`: the
    study mounts the first time it shows, so a session handed in before then
    waits there for it.
  - **Sierra's side toggle takes `force`**, as DOM's `classList.toggle`:
    `toggle(true)` only shows (and focuses the side), so `/work <id>` with the
    study already open never hides it.
  - `lib/study/transcript.js`: `foldEntry`, pure — a main-line `user` or
    `assistant` entry handed to `session.js`'s `fold` (a sidechain, a meta line
    and every other entry kind skipped; a prompt's `<system-reminder>` and IDE
    tags stripped) — and `readAlong({ session, path, worker })`, shaped as
    `startSession`'s answer with `send` and `answer` refusing. It reads the
    file from the top, then the bytes added each second, a torn last line held
    until its newline; it keeps the newest `KEEP` (500) messages. A transcript
    has no `result`, so the status and the ask are read off the `#workers`
    row: asking is `needs-permission` (`?` in the bar), a stop `idle`.
  - **A read-along is keyed `reads`, never `sessionId`.** The first cut keyed
    it on its transcript, and the probe caught a session with none: it became
    an ordinary tab, and a line typed there would have `--resume`d another
    host's session. Now `send` returns on `reads`, and `study.json` keeps a
    read-along as `{ reads, transcript }`, so no reader of the file can
    resume it. The bar names it `read <id4>`; its ask is a panel over the
    input (`waitRows`, "answer it in its own terminal"), since the 80-column
    status line clipped it; a typed line stays in the field.
  - Run (scratch probe, not committed) in a 200×40 pty through the shell's
    `--side` against a test API, a HOME of its own holding three workers, a
    kept tab and a stub `claude` that marks any spawn: `/work zz` named the
    ids up; `/work aaaa` opened `read aaaa?` with the prompt, words and call
    drawn, the reminder and a sidechain line not, and the ask over the input;
    a line and a `1` there started nothing; lines appended were tailed, the
    stop read idle and the call `✓`; `/work bbbb` showed the kept `haiku` tab
    and opened no second; `/work cccc`, with no transcript, said so and a line
    there started nothing; `study.json` kept both as `reads`; after a restart
    the read-along came back drawing its transcript, still spawning nothing.
    23/23. The real hook wrote `transcript` for this session. Haven's suite:
    681 pass, 4 fail (the editor's four, failing before); Sierra's 2332;
    both typechecks clean; `verify:workshop` failed 15 once and passed 18/18
    on the rerun, not looked into.
  - **Not built:** a session the study started that asks is probably no
    CHEF! at all. Its prompts go over stdio (2.3), and whether the CLI also
    fires the `Notification` hook then is not probed. A read-along opened
    before its session's first event named a transcript stays without one
    until reopened.
  - The nine, answered late, after the code: (1) the transcript stays Claude's
    and the worker file holds its path, a pointer; (2) no new noun, a
    read-along is a tab, and `force` is the DOM's; (3) the problem's; (4)
    `/work` keeps its bare meaning, and an id behaves as `/bump`'s and
    `/heard`'s do; (5) the status and the ask are read off `#workers`, never
    stored; (6) `fold` is still the one reader of a stream event, and the
    transcript is handed to it; (7) `foldEntry` is pure, the tail is one
    module; (8) a missing or torn transcript is a red row in that tab alone,
    and a read-along can never start a process; (9) must stay true: the
    study never drives a session it did not start. What fails: none while
    experimenting, though that rule is the one worth a test first.
    Adjudication: none in tension. Tier: Assessment.
