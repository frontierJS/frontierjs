---
id: claude-chat
status: proposed
dated: 2026-11-17
---

# One Claude chat — a shared transcript and composer for every surface that talks to Claude Code

**Status: PROPOSED.** Dated 2026-11-17. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

Six screens draw a conversation with Claude Code, and each draws it its own way.
A fix to how a tool call folds, how a reply renders, or how a permission card
reads lands in one of them and none of the others. The owner wants one Claude
UI: the same bubbles, the same tool lines, the same cards, wherever Claude is.

The event half is already shared. `readAskEvent` in
`packages/cli/core/ask-claude.js` turns Claude Code's stream-json into one
vocabulary (`session`, `status`, `delta`, `text`, `tool`, `read`, `edit`,
`write`, `landed`, `refused`, `result`), and five of the six read it. What is
not shared is everything after: how events fold into rows, and how rows draw.

## The six

Measured 2026-11-17 in this repo and `fjs-prototypes/lathe`. The forks in
`fjs-chartered-deploy/` and `frontierjs-world/` carry older copies of 1–5 and are
not counted.

| # | Screen | File | Draws with | Process | Folds events in |
| --- | --- | --- | --- | --- | --- |
| 1 | Dev server's Ask panel (shift+alt-click) | `cli/core/vite-ask-client.js` (1,120 lines) | Plain DOM, inline styles — injected into any app's page | `runAsk`, one `claude -p` per message | its own `grouped()`, `SHOW_TOOLS = 4` |
| 2 | Site editor's Ask | `site-kit/src/editor/Ask.mesa` (330) | Mesa, styled after #1 by hand (its own comment says so) | basecamp `site-ask.ts` → `runAsk` | its own |
| 3 | Console `:ask` pane | `cli/console/Ask.mesa` (212) | Mesa + `@frontierjs/ui` | `cli/core/server.js` → `runAsk` | its own |
| 4 | Workbench chats | `workbench/web/src/routes/workbench/index.mesa` (2,868, chat inline) + `lib/claude-format.js` | Mesa + `@frontierjs/ui` (`Badge`, `Markdown`, `Spinner`) | `workbench.ts` → `askArgv` / `readAskEvent`, `claude -p` per message | its own `grouped()`, `SHOW_TOOLS = 4` |
| 5 | Haven study | `haven/web/src/components/Study.mesa` | Terminal (haven is a TUI) | `lib/study/session.js` — **long-lived** stream-json, its own protocol code | `lib/study/rows.js`, `SHOW_TOOLS = 4` |
| 6 | Lathe's Claude panel | `fjs-prototypes/lathe/desktop/src/components/ClaudePanel.mesa` (1,056) | Mesa, restyled 2026-11-17 to read like #1 and #4 | `api/src/domain/claude.ts` — **long-lived** stream-json + `claude-protocol.ts` (permission cards, hooks, modes, models, effort) | `desktop/src/lib/claude.js` `apply()` |

Two things fall out of the table:

- **The look has converged by copying, not by sharing.** #1 and #4 draw the same
  thing — *You* bubble on the right, *Claude* bubble on the left, muted
  `› tool` lines folded past four, one quiet result line — and #2 and #6 were
  styled to match them by hand. `SHOW_TOOLS = 4` is written three times.
- **The control protocol is written twice.** #5 and #6 both hold one `claude`
  open over stdin with `--permission-prompt-tool stdio` and answer its
  `control_request`s. #6's is the fuller (`AskUserQuestion`, `ExitPlanMode`,
  edit diffs, `set_permission_mode`, `set_model`, context usage); neither is in
  `cli/core`.

## The shape

Three layers, each with one owner. Layers 1 and 2 land in the local `claude`
package of `IDEAS/claude-calls.md` (`FJS-D2321`), not `cli/core`, once its Phase 2
moves `ask-claude.js`; Q4 below is its Phase 3.

1. **Events** — `readAskEvent` (exists). Extended with what only #6 emits today:
   `prompt`, `joined`, `permission`, `answered`, `hook`, `error`, `end`.
2. **Rows** — one pure fold, events → rows, beside `readAskEvent` in `cli/core`:
   `you`, `text` (with `opens` for the first of a reply), `tools` (folded past
   `SHOW_TOOLS`), `file` (edit or write, pending → landed / refused), `ask`
   (a card: permission, question, plan, edit with diff), `hook` (drawn only
   when it did not succeed), `result`, `error`, `note`. #6's `apply()` is the
   starting point: it already handles queued prompts, cards and file states.
   Pure and DOM-free, so #5's terminal draws from it too.
3. **Drawing** — a `ClaudeChat` component in `@frontierjs/ui` (the log) and a
   `ClaudeComposer` (message box, pasted images, `@` file and `/` command
   pickers, Send/Stop/Queue). Rows in, events out (`onanswer`, `onopen`,
   `onfold`); no fetch, no process. A host adds its own controls around it —
   workbench's Check / Review / Fork, Lathe's mode / model / effort — through
   slots, not forks of the component.

What each host keeps: its process and transport (per-message `claude -p`, or a
long-lived one), its own controls, and where its rows are stored.

## What is not in scope

- Workbench's diff tab, plan tab, checks strip and rail — they sit beside the
  chat, not in it.
- The forks in `fjs-chartered-deploy/` and `frontierjs-world/`.
- Moving #5 and #6 onto one control-protocol module. Worth doing, and the fold
  in layer 2 makes it easier, but it is its own change — Q4.

## Open questions

- **Q1 — Where does the drawing layer live?** **A** — `@frontierjs/ui`
  components, beside `Markdown` and `Composer`. **B** — a small
  `@frontierjs/claude-kit` package holding the fold and the components, so the
  kit does not grow Claude-specific parts. Leaning A: every host already
  imports `@frontierjs/ui`, and the fold lives in `cli/core` either way.
- **Q2 — What does the dev server's Ask panel (#1) do?** It is injected into an
  arbitrary app's page with no build of its own, which is why it is plain DOM.
  **A** — compile `ClaudeChat` into a self-contained module `vite-ask.js`
  serves. **B** — keep its DOM code, but draw from the shared fold (layer 2)
  and the same CSS tokens, so it matches without sharing components.
- **Q3 — Markdown in every reply?** #4 renders replies with `Markdown`; #1
  draws plain text. One answer for all six.
- **Q4 — One control protocol?** Lift #6's `claude-protocol.ts` into
  `cli/core` and move #5 onto it, now or after this lands.

## Phase 1 — The fold

- [ ] 1.1 Extend `readAskEvent`'s vocabulary with the events #6 emits (`prompt`,
  `joined`, `permission`, `answered`, `hook`, `error`, `end`), each with a test
  in `cli/test/ask-claude.test.js`.
- [ ] 1.2 `cli/core/chat-rows.js` — the pure fold, ported from Lathe's
  `apply()` and reconciled with #1 and #4's `grouped()`; `SHOW_TOOLS` defined
  once. Unit tests from all three hosts' current cases.

## Phase 2 — The components (blocked on Q1)

- [ ] 2.1 `ClaudeChat` — rows in, the log out: bubbles, tool lines, file rows,
  cards (permission, question, plan, edit with `LineDiff`), result, error,
  working line. Light and dark.
- [ ] 2.2 `ClaudeComposer` — the message box with images, `@` and `/` pickers,
  Send / Stop / Queue, and a slot for host controls.

## Phase 3 — Move the hosts, one at a time

Each step deletes the host's own fold and drawing, and passes that host's
existing drive.

- [ ] 3.1 Lathe (#6) — the closest fit: it already has every event and the
  newest look. `bun run drive:workspace` passes.
- [ ] 3.2 Workbench (#4) — the chat lifted out of the 2,868-line route.
- [ ] 3.3 Console (#3) and site editor (#2).
- [ ] 3.4 Dev server's Ask panel (#1), per Q2.
- [ ] 3.5 Haven study (#5) — the fold only (layer 2); its terminal draws the rows.
