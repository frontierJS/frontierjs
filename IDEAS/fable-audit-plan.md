---
id: fable-audit-plan
status: partial
dated: 2026-10-05
---

# Idea — The Fable 5 audit plan: what is still unread, and how each run reports

**Status: 6 of 17 runs reported** (1.1, 1.2, 1.3, 2.2, 3.1, 4.1, all on 2026-10-05). Open: 1.4, 1.5, 2.1, 2.3, 2.4, 3.2, 4.2–4.4, 5.1, 5.2. Findings so far are `FJS-1816`–`1820` and `FJS-1831`–`1876`; questions `FJS-D615`–`D619`. Which run filed a row is in the row (*Fable audit 2026-10-05, run N.N*). Dated 2026-10-05. A queue of audits to run
on Fable 5 (`claude-fable-5-1`), ordered by unaudited risk first and judgment-heavy
work second. A finding lands in `ISSUES.md` with an id. This file stays the plan, and
it is not a register.

## What has already been read

These packages have a dated audit with filed rows, as of the date above; `ISSUES.md`
wins where it disagrees. Re-auditing them is lower yield than §3, which re-checks
their fixes:

- **litestone**: foundation audit 2026-09, 28 findings
- **junction, conduit, caravan**: API-realm audit 2026-09, about 90 findings
- **sierra**: UI-realm audit 2026-09, `FJS-781`…`825`, ruled by `FJS-D204`
- **mesa**: audit 2026-09, `FJS-829`…`888`
- **invariants**: `invariants.snapshot.md` § The gap. 16 is the only one left.

Since then, runs 1.1–1.3 read `auth`, `mcp` and `outpost`, and a separate toolbelt
audit (2026-10-09) filed `FJS-2183`–`2228`. `jetty`, `notifications`, `orion`, `css`,
`testing` and `email-kit` have no audit on record. Of those six, only the first three are
in this plan (run 1.5).

## What every run is told

Every prompt below gets this paragraph prepended, verbatim:

> Read the package's `CLAUDE.md` and the code. Grade against the code, never against a
> document's description of it; this repo's docs have understated the tree every time
> they were checked. Each finding carries a repro: a command, or a failing test written
> under the package's `test/`. A claim with no repro goes in a separate *Leads* list.
> Run the package's own script (`cd packages/<pkg> && bun run test`). Finish with an
> adversarial pass: try to refute each finding, and drop the ones that fall. Output
> `ISSUES.md`-ready rows (`| FJS-### | pkg — **claim** | date | file:line, repro,
> severity |`) plus a one-paragraph verdict.

Then the operating rules:

- **One area per run**, and say the agent count before starting. A run fans out to at
  most one level of subagents.
- **Verdicts are proved by running.** A run that only read the code reports
  *plausible* and does not report *confirmed*.
- **Filing is a separate step.** The run writes rows to the scratchpad, and a person
  assigns ids and moves them into `ISSUES.md`. A finding that overturns a ruling
  becomes a question in `fli decisions`, not a row.

## 1. Unaudited packages

**1.1 auth, as an attacker.** "Audit `packages/auth` for session fixation; for token
reuse after logout, password reset and email verify; for timing differences in login
and lookup; for reset and verify token entropy, expiry and single use; for API-key
scope and revocation; for OAuth state, PKCE and redirect validation; and for the
`account`/`sessions`/`api-keys` services reading another user's rows (`FJS-D20`)."

**1.2 mcp, the gate as the permission model.** "`FJS-D258` makes the gate the
permission model. Try to make an agent see or call a tool, or read a row, that its
standing forbids. Cover tool listing vs. tool calling, a standing that changes
mid-session, batched calls, error text that leaks schema or row existence, and a
`$`-key smuggled through tool arguments (Invariant 10)."

**1.3 outpost, the two listeners.** "Audit `signRequest`/`verifyRequest`: replay, clock
skew, canonicalization differences between signer and verifier, header and body
coverage. Audit the 8181 static origin for path traversal, symlinks and MIME
sniffing. Show whether a page served on 8181 can reach the command port
(`FJS-D345`)."

**1.4 fli, the guards that stay silent.** "`fli check`, `fli proves` and `fli done`
each claim to fail when something breaks. For each rule, break the thing it guards
and confirm the rule fires. List the rules that stay green, and the `DRIVES.md`
entries `fli proves` can never name."

**1.5 notifications, jetty, orion.** The same template with no attack brief.
notifications: fan-out ordering, a failed email after a committed record, and
grading per recipient. jetty: the service-worker relay's origin checks.
orion: the engine's trust in a flow's declared actions.

## 2. Seams between packages

2.1 and the runs in §4 are coherence audits, and their report shape is `ARCHITECT.md`
§6. The paragraph above still applies to any defect they find.

**2.1 Single ownership.** "For every name in the root `CLAUDE.md` § Bridge index, find
any second place in the tree that does the same translation (Invariant 4). Report
each pair with both file:line locations."

**2.2 Gate parity across paths.** "Take five `basecamp` models. For each principal
level, record what is visible through HTTP, WebSocket, MCP, a job, a live-store
broadcast and `asSystem()`. Diff that against the model's `@@gate`. Every difference
is a finding or a documented exception."

**2.3 The browser litestone (`FJS-D305`).** "List what `#sql-engine` and `#host` assume
that differs between `bun:sqlite` and wasm over `opfs-sahpool`. For each difference,
write a test that passes on one and fails on the other."

**2.4 Invariant 16.** "Close § The gap in `invariants.snapshot.md`: write the rule that
runs every runnable example, or argue that no mechanical check can reach it and draft
the `DECISIONS.md` entry."

## 3. Re-checking past audits

**3.1 Regression guards.** "For every CLOSED row from the four audits in § What has
already been read, find the test that fails if the fix is reverted. Revert each fix
in a worktree and run that test to prove it. Report the fixes that have no guard."
The mesa audit had three claims overturned when they were fixed, so expect some
closed rows to have been closed wrongly.

**3.2 Register order.** "Re-derive the priority order of the open rows in `ISSUES.md`
from scratch, and say where it disagrees with `fli next` and why."

## 4. Judgment work

**4.1 Building from docs alone.** "Use only `README.md`, the `AGENTS.md` files and
`docs/`, and read no package source. Build an app with three models, gates, one
form, one job and one notification. Log every point where a doc was wrong, missing
or misleading, with the line that misled you." This measures describability
directly.

**4.2 One spec entry.** "Draft spine entry 7 (Result envelope) or 9 (Directives) of
`IDEAS/specifications.md`, with its JSON form and conformance vectors. Mark every
place the implementation leaks Bun, SQLite or TypeScript into what should be spec."

**4.3 Ruling consistency.** "Find pairs of rulings in `DECISIONS.md` that contradict
each other, and rulings the code no longer obeys. Each gets its file:line evidence."

**4.4 Vocabulary drift.** "Find nouns used as concepts in code or docs that are absent
from `VOCABULARY.md` and `ARCHITECT.md` §2. For each, propose folding it in or
renaming it, per `decision-rules`."

## 5. Real apps

**5.1 Port workarounds.** "Read `IDEAS/conversion-maid-tech.md` and the remnant port
ledger. Name the framework gap behind each workaround, and the gaps that already
have a row."

**5.2 basecamp bypasses.** "Find every place `basecamp` goes around the framework:
raw fetch, manual unwrapping of the envelope, duplicated validation, hand-written
gates in hooks (Invariant 6)." `rebuilt-in-the-stressors.md` is the method.

## Order

1.1 → 1.2 → 4.1 → 3.1 → 1.3 → 2.2 → the rest as time allows. The first two carry the
largest unaudited security exposure. 4.1 is the most judgment-heavy run and the least
like anything already done. 3.1 tests whether the audits so far actually held.
