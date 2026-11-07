---
id: workbench
status: proposed
dated: 2026-10-09
---

# Idea — the Workbench after V1: what comes next, ranked against prior art

**Status: IDEA.** The V1 is built (uncommitted on 2026-10-09). This paper ranks what
comes after it. The V1 is Workbench's `/workbench/` (its own private app, `packages/workbench`, since
`IDEAS/workbench-package.md` 2026-11-03; it was Basecamp's until then): one card per pinned checkout, and
each message is a `claude -p` run against that checkout (`packages/workbench/api/src/domain/workbench/workbench.ts`;
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
| 5 | **A "needs you" notice** — the run ended on a question rather than finishing. A notice beside `unread`, never a fifth `RunState` (`FJS-D1176`) | Antigravity's inbox, octomux | A green *done* misleads when the run is actually waiting on you. | S–M |
| 6 | **A worktree per chat** — fork into a worktree with its own port slot (`ports.js`, the way Conductor hands out `CONDUCTOR_PORT`) and a setup step (install, copy `.env`), then merge back or archive | Conductor, claude-squad, parallel-code | The category's main feature. It also stops concurrent sessions colliding in one tree. A card becomes a branch rather than a checkout, so this is a data-model change. | L |
| 7 | **Start from `fli next` / `ISSUES.md`** — a card opens pre-filled with the issue; its place moves by the person's hand — intake, review, done — and the run's state and notices overlay it (`FJS-D1176`) | cyrus, Contrabass, kanban tools | Ties each run to the register. | M |
| 8 | **Import terminal sessions** — adopt a `~/.claude/projects/<repo>/*.jsonl` session as a card | agent-console | The reverse of the handoff V1 already has. | S |
| 9 | **Phone alerts** — ntfy or web push on *done* or *needs you*, plus a card layout that works at phone width | Happy, Omnara, repomon | The browser notification only reaches someone at the desk. | S–M |
| 10 | **Scheduled prompts per repo**, on Caravan cron | background-agents, Frink | Reuses `app.jobs`. | M |
| 11 | **An approval inbox in place of bypass** — `--permission-prompt-tool` routes each permission ask to the UI | Calyx, Remote Control | Makes a safe per-repo mode possible. Worth building only once bypass hurts. | M–L |
| 12 | **Best-of-N** — one prompt fans out to N worktrees and a person picks the winner | Pragma, Claudexor | Expensive. Needs #6. | M |
| 13 | **Snooze** — hide a card until a time; a notice raised meanwhile lifts it. With Unpin and Archive, one hidden set: no notification, no sort (`FJS-D1176`) | Agent of Empires' dismissed set | Vocabulary for the board once cards outnumber the stage; nothing to build before that. | S |
| 14 | **A Servers screen** — one read-only window onto the machines and IPs this developer can reach, the way Laravel Forge lists them. Ruled `FJS-D2006`–`FJS-D2008` (own encrypted tokens plus ssh hosts; Hetzner and DigitalOcean first; fetched live, nothing stored but the token); see § Open questions | Laravel Forge, Ploi | The developer's desk should answer "what can I reach?" before any Basecamp exists — it is the pre-install tool. | S–M |
| 15 | **Uncommitted-work board** — every pinned checkout's changed files grouped by package, each group matched to the `IDEAS/` plan whose § Lives in or recent steps name those paths, with the age of the oldest edit | git-town, GitButler's lanes | Dozens of changed files and a dozen memory notes say *built, uncommitted*; nothing answers "waiting to be committed, for which plan?" Read-only: the board names, a terminal commits. | S–M |
| 16 | **Stale-server column on Laptop's Running tab** — compare each dev server's start time with the newest source file under its package; older gets a *serving old code* badge (`FJS-740`) and a Restart button | Vite's own reload banner | A column on an existing tab, not a screen: `running.ts` already lists the servers and their ports. | S |
| 17 | **Lane and branch-worktree janitor** — one list of `~/.fli/lanes/*` and workbench branches with branch, merged or not, ahead/behind, dirty (`FJS-D2000`'s sync marker) and last touch; Remove is Disk's `removeLane` and `workbench-branches.md`'s Archive, nothing new | git worktree prune, GitButler | Scoped to the two worktree kinds fli made; strays stay out (`FJS-D1994`: fix the leakers, no list). Sits beside the Disk tab, since worktrees are disk too. | S |
| 18 | **Memory browser with a staleness check** — list `~/.claude/projects/<repo>/memory/*.md` (the sibling read #8 makes) and flag a claim the tree no longer supports: *uncommitted* when git holds the commit, a named file or flag that is gone | — | ~150 notes go stale quietly. Read-only; needs a design pass first for what counts as a stale claim. | M |
| 19 | **Morning brief** — one push a day over `workbench-package.md` Phase 3's morning-report transport: last CI (`.cache/ci-last.txt`), decisions waiting, overnight Autopilot, Disk folders that grew, stale servers (#16) | repomon, Happy's digest | Every piece exists; only the composition is new. | S |
| 20 | **Cost by plan, and a long-chat warning** — #2's totals summed per `IDEAS/` plan the chat was started from (#7), and a notice past N turns, since cost is turns × context | termany, Helicon | Extends #2, not a new origin. Waits for #7 to tie a chat to a plan. | S |
| 21 | **Disk history** — keep each scan's totals and draw a trend per folder on the Disk tab; a push when Cache or State grows past a set amount in a week | ncdu's export, Grafana | Adds history to the existing tab. A table of samples is a new origin, so the row must say who samples (the Disk scan, on each visit) and the retention (90 days). | S–M |

**Recommended order: 1 → 2 → 3 → 4**, because each reuses code that already exists.
Together they turn *a run ended* into *a run ended, here is the diff, the checks are
green, and it cost $0.80*. Then build #6 as a project of its own —
[`workbench-branches.md`](workbench-branches.md) is its design, and its slice A
(Fork, Land, Archive) is built.

**1–4 built on 2026-10-09.** The checks are the checkout's own `fli done`, which
already carries what `fli proves` names. The review is opt-in per pin, because
each review is paid, and it has a button as well. A line comment waits above the
message box and goes with the next message. Verified against a stand-in claude
only; no real `claude -p` has run through any of it yet.

**Not on the list:** agent-to-agent messaging, other agents (Codex, Gemini), cloud
VMs, and a live channel in place of the 1.5-second poll. The poll holds until there
are many cards.

## Open questions (owner)

**A Servers screen (owner's note 2026-11-03).** Wanted: from Workbench, see which IPs and servers I have access to — a simple screen, Forge-shaped. It overlaps Basecamp, whose `Server` model (provider, account, role, status) and `ServerEvent` trail already are the fleet's list, and whose `domain/local/local-ssh.ts` already reads `~/.ssh/config` hosts as enrollment candidates (`workbench-package.md` § Derived, not asked). Owner 2026-11-03 (chat): Workbench works and operates independently of any Basecamp — it is the tool you use BEFORE you have a Basecamp installed. So this screen is where a developer with a cloud token and no fleet yet sees what machines exist and which one a Basecamp could go on; Basecamp's `Server` list is what the same view becomes after install, not a thing Workbench reads. That removes the peer-call option: Workbench is its own source, and "access" means the cloud accounts the developer holds tokens for — the machines a provider lists for those tokens. A Basecamp may know the same machines; Workbench never asks it. Read-only throughout: list, never create or destroy. The questions:

- ~~**Q1 — Where the list comes from.**~~ **Answered 2026-11-07 (`FJS-D2006`): C — A, plus `~/.ssh/config` hosts shown beside the cloud machines, for hosts no account lists.**
  - **A** — Workbench keeps its own provider tokens as `@encrypted` rows in its own database (it already has `Member` + `Session` and encrypted fields for `ClaudeWrite.before`) and lists machines through a Conduit provider connector. Add and remove an account on the screen.
  - **B** — Workbench keeps no token: it reads each provider's token from the developer's environment or the provider's own CLI config (`hcloud`, `doctl`) and lists through the same connector.
  - **C** — A, plus `~/.ssh/config` hosts shown beside the cloud machines, for hosts no account lists.
  - **Recommend C** — the owner's pick in chat on 2026-11-03. A screen that says "no accounts yet, add one" works on a clean laptop, where B depends on what happens to be installed; the cost is a second token store beside Basecamp's `Secret`s, which is the price of independence. The ssh hosts are the machines no account lists, and reading them is the same `ssh -G` read Basecamp's `local-ssh.ts` already makes.
- ~~**Q2 — Which providers first.**~~ **Answered 2026-11-07 (`FJS-D2007`): A — Hetzner and DigitalOcean: the two `ComputeProvider` names (`FJS-D1607`), each with a `list` in its conduit (`packages/conduits/conduit-hetzner`, `conduit-digitalocean`).**
  - **A** — Hetzner and DigitalOcean: the two `ComputeProvider` names (`FJS-D1607`), each with a `list` in its conduit (`packages/conduits/conduit-hetzner`, `conduit-digitalocean`).
  - **B** — Hetzner alone, the smaller slice.
  - **Recommend A** — both conduits exist and expose the same `list(send)` shape, so the second provider is a row in a table, not a second client. Forge and Ploi both lead with the same two.
- ~~**Q3 — Stored rows or a live list.**~~ **Answered 2026-11-07 (`FJS-D2008`): A — Fetched live on each visit and cached for the tab's lifetime, with a fetched-at time and a Refresh control; the token is the only stored thing.**
  - **A** — Fetched live on each visit and cached for the tab's lifetime, with a fetched-at time and a Refresh control; the token is the only stored thing.
  - **B** — A `Server`-like table Workbench keeps, refreshed on demand, so the list survives offline and can carry notes.
  - **Recommend A** — the provider's account is the one origin, and a stored list is a second copy of it that can disagree; the Running and Disk tabs already read live and cache nothing. The silence to guard: a cached list can be stale without saying so, which the fetched-at time answers. What must stay true: the screen writes no machine row and calls only list endpoints.

## Before any of it

V1 runs with every permission. `/mcp` offers no agent the workbench, and
`agentGuard` refuses a key that calls it anyway (`domain/api-key/scopes.ts`), so an
admin key cannot start such a run. Real `claude -p` has run through the ask
panel's argv (`verify:ask --real`, the plan probes of
[`shipped/workbench-plans.md`](shipped/workbench-plans.md) 5.4); a full Build
plan against `example/` has not.

## Sources

- [Conductor — parallel Claude Code](https://www.conductor.build/workflows/run-parallel-claude-codes)
- [Addy Osmani — The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)
- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- [Nimbalyst — Antigravity review (Manager view, inbox)](https://nimbalyst.com/blog/antigravity-ide-review/)
- [Vibe Kanban shutdown (Bloop, 2026-04-10; continues as Apache-2.0)](https://vibekanban.com/blog/shutdown)
- [Omnara vs Happy vs SeaWork](https://seawork.ai/en/blogs/omnara-vs-happy-vs-seawork/)
- [Agent of Empires (Mozilla.ai) — Stage vs Signal, the dismissed set](https://github.com/mozilla-ai/agent-of-empires)
