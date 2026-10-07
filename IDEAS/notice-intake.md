---
id: notice-intake
status: proposed
dated: 2026-10-06
---

# Idea — NoticeIntake: one screen of what needs attention, handed to an AI as one packet

**Status: IDEA.** Probed against the tree 2026-10-06. Prompted by comparing the
workspace's own agent loop against BuilderIO's *Factory* skill suite
(`github.com/BuilderIO/skills`, `docs/factory/README.md`). Factory's strongest
piece is the front: every signal (Slack, Sentry, telemetry, issues) comes in
through one collect step and lands on one queue a person or an agent works.

**V1 is two things:** one Basecamp screen listing everything that needs
attention across the fleet, and one button that turns the selection into a
packet an AI can audit formally. The AI's verdict stays outside Basecamp in V1.

---

## What exists (probed)

**The owner already exists.** `web/src/notices.js` describes itself as *the one
statement of WHAT deserves attention*: `computeNotices(rows, now)` is a pure
function from rows to `{id, priority, category, title, detail, href, action}`,
sorted critical → warning → info. It has two presentations: `NoticeBar.mesa`,
the shell's condensed strip, and `ActionQueue.mesa`, the home screen's full
list. NoticeIntake is a **third presentation of the same notices**, not a second list.

What it covers today, against the failure states the schema has:

| Signal | Model · state | In `computeNotices`? |
| --- | --- | --- |
| Machine lost, CPU/mem high, draining | `Server` · `unreachable`, `draining` | yes · `fleet` |
| Deploy failed or stuck | `Deployment` · `failed`, `building` > 15 min | yes · `deploy` |
| Job failed | `Job` · `failed`, `lastRunStatus` `failed` | yes · `job` |
| Threshold breached | `AlertEvent` · `firing` | **no** |
| Recipe failed | `RecipeRun` · `failed`, `timeout` | **no** |
| App down | `App` · `error` | **no** |
| Deploy rolled back | `Deployment` · `rolled_back` | **no** |
| Backup failed | `Backup` | **no** |

**What is absent:** four of the eight sources, a screen that shows only the
queue, a way for an item to stay acknowledged (ActionQueue's `dismissed` is
component state and clears on reload), and any export shaped for an AI to read.

---

## V1

1. **Grow the owner, not beside it.** Add the four missing sources as inputs to
   `computeNotices`, in the same pure style, with the same tests. Every screen
   that already shows notices gains them for free.
2. **`/notice-intake/`** (`NoticeIntake.mesa`) — the queue on its own page: every notice, grouped by
   subject (app/server/env), so three failed deploys and a firing alert on one
   app read as one problem. Rows come from the same resources the home screen
   reads, so each one passes through its model's `@@gate` (Invariant 6).
3. **Select → "Copy for review"** — a pure `noticePacket(notices, evidence)`
   beside `computeNotices` that builds a markdown packet. Each item carries its
   evidence: the failing step's log tail, the alert series around the breach,
   the last N `ServerEvent`s, the app's last successful deploy. A fixed preamble
   asks for a formal audit: cause, severity, the fix, and what is uncertain. It
   goes to the clipboard, and pasting it into any AI session is the V1 send.
4. **Protected values never enter the packet.** It is built only from reads the
   screen already makes, and `Secret` and `Variable` are not among its inputs.
   A leak here is destructive, so a test asserts the refusal rather than
   trusting the input list.

5. **`/hub/notice-intake/` — every workspace, for the system admin.** The Hub
   is the tier above every tenant: one service behind `requireSystemAdmin`,
   taking no workspace, read through `asSystem()`, and answering 404 to anyone
   else (`docs/SCREENS.md` § Phase 10). The cross-workspace queue is one more
   read on **that** service, fed through the same `computeNotices`. It is not a
   `?scope=hub` on the nineteen workspace-scoped services, which is the shape
   Phase 10 already rejected. Each notice is tagged with its workspace, and the
   packet keeps the tag, so one audit can see that the same failure hit three
   tenants. `asSystem()` reads bypass the row gates, so on this path the
   packet's secret-refusal test (item 4) is the only guard, not a second one.

## Later, not V1

- **Send, not copy** — `mcp` already exposes the app with the gate as the
  permission model (`FJS-D258`), so the likelier shape is the AI *pulling* the
  queue as an MCP tool, rather than Basecamp pushing it.
- **The review comes back** — store the verdict against the notice's subject,
  so a repeat failure shows what the last audit said. This is Factory's
  *prior fix attempts* field, and it is the first new model.
- **Acknowledge / snooze that survives a reload** — today's dismiss is local.
- **Outside signals** — uptime monitors (`uptime-monitoring.md`), posture
  (`server-posture.md`), client support chats. Each joins as one more input to
  `computeNotices`.
- **Lookback** — recurring symptoms over a time window (Factory's
  `/factory-lookback`), once notices have history.
- **Per-action autonomy** — Factory's rule that permission to fix grants no
  permission to reply, merge or deploy. That rule matters once anything acts on
  a notice. V1 acts on nothing.

## Decision rules (answered late, after the first draft)

The first draft proposed a new service unioning the source models. Question 6
failed it, since `notices.js` is that owner, and the proposal changed to the one
above.

1. **Origin** — one: `computeNotices`. The packet is derived from it.
2. **Concept** — *NoticeIntake*, owner's pick 2026-10-06: the queue of notices, built on the existing noun rather than beside it. A bare *Intake* would have been a third word for one thing.
3. **Complexity** — the problem's own: incident triage, a named practice.
4. **Predictability** — a third presentation of one rule set, like the two before it.
5. **Derived** — notices from rows, the packet from notices. Nothing is restated.
6. **Owner** — `web/src/notices.js`, which exists.
7. **Boundary** — two pure functions with JSDoc shapes, testable in plain node.
8. **Failure** — a leaked secret in the packet is destructive, so it is refused
   by a test, not left to the choice of inputs.
9. **Silence** — what must stay true: every failure state in the schema
   produces a notice. What fails today if not: **none**. A new failure enum
   value can land and never surface. Proposed artifact: a test enumerating
   `DeployStatus`, `RunStatus`, `AlertStatus`, `AppStatus` and the rest
   against the categories `computeNotices` emits.

No § IV adjudication is in tension. Tier: Assessment.
