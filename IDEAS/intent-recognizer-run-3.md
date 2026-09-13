---
id: intent-recognizer-run-3
status: assessment
dated: 2026-09-13
---

# Assessment — the intent recognizer, run 3: three models as the support agent

**Status: ASSESSMENT.** Dated 2026-09-13. It reads the tree and proposes nothing of
its own; what it changes is folded into `intent-recognizer.md`. Never cite this as
behavior.

**Only Opus 5 answered without supervision.** Run 2 found that an agent reading the
app was the part that worked. This run asked which model that agent can be. On the
same fifteen asks, Opus 5 wrote fifteen sendable replies with no false claim and
reported a real defect on all eight asks that exposed one. Sonnet 5 wrote six
sendable replies and five misleading ones. Haiku 4.5 wrote no sendable reply, twelve
that needed an edit, and three misleading ones. **A cheaper model's failure is not
a thinner answer; it is a confident wrong one**, and none of the wrong claims was
about something the seed declares.

## The run

**The fifteen asks are run 2's usefulness set**: 1.1, 3.1, 8.1, 16.1, 1.2, 14.1,
22.1, 26.2, 2.1, 41.1, 94.1, 6.1, 27.1, 51.1, 88.1, from
`intent-recognizer-examples.md`. The tree had moved since run 2 (`FJS-1103` was
fixed), so run 2's replies were not reused as the ceiling; Opus answered again.

**One prompt, three models.** Each model answered the asks in three batches of five,
as a support person reading `example/` and nothing else — the registers, `IDEAS/`
and every `CHANGES.md` were out of bounds. For each ask it wrote the reply, every
factual claim with a `file:line`, and a defect note.

**Three Opus graders, blind.** Each batch's three replies were put under labels
shuffled per ask. A grader established the correct answer from the code, verified
every claim itself rather than trusting the cited line, and scored each reply
`sendable`, `edit` (nothing false, needs work), `misleading` (a false claim a
customer would act on) or `useless`.

## What came back

| | Haiku 4.5 | Sonnet 5 | Opus 5 |
| --- | --- | --- | --- |
| Sendable | 0 | 6 | 15 |
| Edit | 12 | 3 | 0 |
| Misleading | 3 | 5 | 0 |
| Useless | 0 | 1 | 0 |
| False claims / claims | 6 / 66 | 7 / 79 | 0 / 124 |
| Defect reported, of 8 asks exposing one | 0 | 1 | 8 |
| Defect reported that is not one | 1 | 1 | 0 |

Sonnet's useless reply is ask 1.2, which it skipped: its batch file has four
sections.

**Haiku is cautious and thin.** Its replies were mostly true and lacked the steps,
the why and the correction a customer needed. Its three misleading replies were
the old proration behavior on a plan change (8.1), a notification on a failed
payment that nothing sends (22.1), and custom fields described as tags that can be
assigned, searched and filtered from the console (51.1).

**Sonnet is fuller and more often wrong.** A yearly member told they can move to
monthly at renewal, which the code refuses at any date (8.1); the app reaching out
when a renewal charge fails (22.1); a note left on an existing order, which no
screen can edit (94.1); a stock message explained as working as intended on the
strength of wording only one of the two storefront islands uses (27.1); and the
custom-fields screen offered as a working path (51.1).

**None of the false claims in the eight misleading replies is one the resolver's
check can grade.** Each is about billing code, a notification that does not exist, a
screen's wiring or a string on the storefront. `intent.js` checks a decline against
`@immutable`, `@system` or a missing edge, and an offer against something the app
declares; a draft saying *you can switch at renewal* or *we'll email you* passes
both. This is by reading the eight replies, not by running the check.

## What it cost

Measured from each agent's own transcript: the last usage record per message id,
priced at list API rates — Haiku 4.5 $1/$5, Sonnet 5 $2/$10, Opus 5 $5/$25 per
million input/output tokens, cache writes at 1.25×, cache reads at 0.1×.

| Fifteen asks | Haiku 4.5 | Sonnet 5 | Opus 5 |
| --- | --- | --- | --- |
| Cache writes | 314K | 459K | 612K |
| Cache reads | 10.1M | 16.7M | 23.4M |
| Output | 24K | 76K | 66K |
| As run | $1.53 | $5.25 | $17.17 |
| Per ask, as run | $0.10 | $0.35 | $1.14 |
| Per ask, lean | ~$0.03 | ~$0.14 | ~$0.59 |
| Wall time per ask | ~25 s | ~83 s | ~81 s |

The three graders cost $8.27 as run; the whole run about $32.

**Reading dominates.** Cache reads outnumber output about three hundred to one,
because every turn re-reads the context. Each agent also started with 73–98K tokens
of harness it would not carry in a product — the root `CLAUDE.md`, tool definitions,
a system prompt. *Lean* subtracts one write of that baseline and one read of it per
later turn; it is an estimate, not a measurement.

## What it does not show

- **The grader is the same model as the ceiling.** Labels were blind and every false
  claim carries the line that contradicts it, so that column holds; `sendable`
  against `edit` is a judgment and may favor the longer, more complete style.
- **One run per model**, so no variance.
- **Five asks per context.** A later ask reused an earlier one's reading, so a per-ask
  figure is an average of a batch.
- **One prompt.** Haiku took fewer turns and fewer tool calls than the others; a
  prompt asking it to dig further may close part of the gap at a higher cost.

## Defects it found

Every one was reported by Opus's answering agent and confirmed by its grader against
the code; seven were also checked by hand before filing.

| Ask | Defect |
| --- | --- |
| 51.1 | `FJS-1116` — the custom-fields page cannot create a field, and a declared field never reaches the customer form |
| 27.1 | `FJS-1117` — the storefront's availability table says *Sold out* for stock held in baskets |
| 94.1 | `FJS-1118` — shipping an order asks for no confirmation and cannot be undone |
| 6.1 | `FJS-1119` — two payments can be started on one order (read, not run) |
| 8.1 | `FJS-1120` — the yearly → monthly refusal says the move takes effect at renewal, and nothing applies it |
| 3.1 | `FJS-1121` — the Reports *Taken* tile counts unpaid, canceled and refunded orders |
| 1.2 | `FJS-1126` — the *Note template* setting is read by nothing |
| 14.1 | `FJS-1127` — paying a run says payslips go out, and nothing sends one |

One more was noted and not filed: on ask 88.1, the order page's Payments tab offers
*Refund…* on a shipped order's payment, which the refund path refuses
(`payments.service.ts:247-252`) — a button that can only fail.

**Run 2 found three defects in these fifteen messages; this run found eight more in
the same fifteen.**

## What it changes

**The support agent is a frontier-model job.** The cheaper models fail where a
customer's belief is wrong or where the seed and a screen disagree, which is most of
what support is; the check in `intent.js` does not reach either.

**The next measurement is cost, not quality.** A lean harness — the schema, the route
map and the service surface handed over once and cached, instead of discovered per
turn — prices Opus outside Claude Code. The same fifteen asks through it answer
whether ~$0.59 per ask is the real number.

The run's working files — the asks, the nine answer files, the blinded grading
files, the grades, the label mapping and the cost meter — were scratch and are not
committed.
