---
id: workbench
status: proposed
dated: 2026-10-09
---

# Idea — the Workbench after V1: what comes next, ranked against prior art

**Status: IDEA.** The V1 is built (uncommitted on 2026-10-09). This paper ranks what
comes after it. The V1 is Basecamp's `/workbench/`: one card per pinned checkout, and
each message is a `claude -p` run against that checkout (`api/src/core/workbench.ts`;
the argv lives in `packages/cli/core/ask-claude.js`). The surveys behind the ranking:
Conductor, Vibe Kanban, claude-squad, agent-manager, Calyx, Antigravity's Manager
view, Happy, Omnara, Anthropic's Remote Control, Addy Osmani's *Code Agent
Orchestra*, and the ~150 tools in `awesome-agent-orchestrators`.

## What V1 already has (probed)

- Per-checkout cards with live state: idle, working with the current tool, done
  and unread, error.
- A tab-title rollup and a browser notification.
- A queue, Stop, New chat, and handoff to a terminal (`claude --resume`).
- Per-repo settings for the spending limit and whether the repo's hooks run.
- Run logs that survive a `bun --watch` restart.
- **Cost and turns for each run** — read from `total_cost_usd` in the result event
  (`ask-claude.js`) and shown on the card.

It does not have review, verification or parallelism, and those are the three things
every tool in the field leads with.

## What the field converged on

1. **One worktree per task**, so that parallel runs on one repo never share a tree.
   Every tool in the category does this.
2. **Diff-first review**, where a line comment goes back to the agent as its next
   message.
3. **An inbox for "needs you"** that is separate from "done": a question asked, or
   a permission waiting.
4. **A check before "done"**: a hook runs the tests before a task may close.
5. **Phone alerts and approvals.**
6. **Running cost and budgets**, **intake from an issue tracker**, **scheduled runs**.

## Ranked

| # | Feature | Prior art | Why | Cost |
|---|---|---|---|---|
| 1 | **Checks strip** — after a run ends, run `fli proves`/`fli done` in that checkout and put the result on the card | the TaskCompleted gate, Fletch, kodo | No other tool can offer this one: the repo already states what *finished* means. | S |
| 2 | **Running cost** — totals per card and per day, next to the per-run figure V1 shows | termany, Helicon | The data already exists. | S |
| 3 | **Diff panel per card**, where a line comment becomes the next message | Conductor, agent-manager, Vibe Kanban | Review is the bottleneck. Today a card shows only a count of changed files. | M |
| 4 | **Reviewer pass** — when a run ends, a read-only run reviews the diff | Osmani's one reviewer per 3–4 builders, Orbi | `ask-claude.js`'s read-only mode already exists. | S |
| 5 | **A "needs you" state** — the run ended on a question rather than finishing | Antigravity's inbox, octomux | A green *done* misleads when the run is actually waiting on you. | S–M |
| 6 | **A worktree per chat** — fork into a worktree with its own port slot (`ports.js`, the way Conductor hands out `CONDUCTOR_PORT`) and a setup step (install, copy `.env`), then merge back or archive | Conductor, claude-squad, parallel-code | The category's main feature. It also stops concurrent sessions colliding in one tree. A card becomes a branch rather than a checkout, so this is a data-model change. | L |
| 7 | **Start from `fli next` / `ISSUES.md`** — a card opens pre-filled with the issue, and its states run queued → working → review → done | cyrus, Contrabass, kanban tools | Ties each run to the register. | M |
| 8 | **Import terminal sessions** — adopt a `~/.claude/projects/<repo>/*.jsonl` session as a card | agent-console | The reverse of the handoff V1 already has. | S |
| 9 | **Phone alerts** — ntfy or web push on *done* or *needs you*, plus a card layout that works at phone width | Happy, Omnara, repomon | The browser notification only reaches someone at the desk. | S–M |
| 10 | **Scheduled prompts per repo**, on Caravan cron | background-agents, Frink | Reuses `app.jobs`. | M |
| 11 | **An approval inbox in place of bypass** — `--permission-prompt-tool` routes each permission ask to the UI | Calyx, Remote Control | Makes a safe per-repo mode possible. Worth building only once bypass hurts. | M–L |
| 12 | **Best-of-N** — one prompt fans out to N worktrees and a person picks the winner | Pragma, Claudexor | Expensive. Needs #6. | M |

**Recommended order: 1 → 2 → 3 → 4**, because each reuses code that already exists.
Together they turn *a run ended* into *a run ended, here is the diff, the checks are
green, and it cost $0.80*. Then build #6 as a project of its own —
[`workbench-branches.md`](workbench-branches.md) is its design.

**1–4 built on 2026-10-09.** The checks are the checkout's own `fli done`, which
already carries what `fli proves` names. The review is opt-in per pin, because
each review is paid, and it has a button as well. A line comment waits above the
message box and goes with the next message. Verified against a stand-in claude
only; no real `claude -p` has run through any of it yet.

**Not on the list:** agent-to-agent messaging, other agents (Codex, Gemini), cloud
VMs, and a live channel in place of the 1.5-second poll. The poll holds until there
are many cards.

## Before any of it

V1 runs with every permission, and `/mcp` may expose `workbench.send` as an agent
tool. If it does, an admin key can start such a run on the owner's machine. That
hole was being closed when this paper was written; check it before the Workbench
leaves the owner's machine. Separately, no real `claude -p` had run through V1 yet,
only a stand-in.

## Sources

- [Conductor — parallel Claude Code](https://www.conductor.build/workflows/run-parallel-claude-codes)
- [Addy Osmani — The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)
- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- [Nimbalyst — Antigravity review (Manager view, inbox)](https://nimbalyst.com/blog/antigravity-ide-review/)
- [Vibe Kanban shutdown (Bloop, 2026-04-10; continues as Apache-2.0)](https://vibekanban.com/blog/shutdown)
- [Omnara vs Happy vs SeaWork](https://seawork.ai/en/blogs/omnara-vs-happy-vs-seawork/)
