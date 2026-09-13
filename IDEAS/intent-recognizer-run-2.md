---
id: intent-recognizer-run-2
status: assessment
dated: 2026-09-12
---

# Assessment — the intent recognizer, run 2: a hundred messages through the built resolver

**Status: ASSESSMENT.** Dated 2026-09-12. It reads the tree and proposes nothing of
its own; what it changes is folded into `intent-recognizer.md`. Never cite this as
behavior.

**The resolver did not work as designed, and the run says why.** A deterministic
lookup from a person's words to the seed answered 18% of what a hundred messages
asked once it stopped guessing. Letting the translator pick off a menu the index
enumerates raised that to 43%. And a verdict — even a right one — made a sendable
reply three times in fifteen. **The part that worked was an agent reading the app**,
which answered all fifteen and found three defects on the way.

## The corpus and the key

`intent-recognizer-examples.md`: a hundred support messages from seven people — 61
email, 31 chat, 8 phone notes — written as a knife-sharpening shop, a lawn-care crew,
a candle shop, a bookkeeper, a payroll clerk, a teenager who does the website and an
annoyed owner, all mapped onto `example`. Message 26 is three other messages pasted
together.

**Two agents, blind to each other.** One wrote the ANSWER KEY from the seed and the
snapshots without seeing `intent.js`: 131 asks, each with a verdict, a depth, a
target and a citation. One wrote the CANDIDATES from the messages alone, without the
schema: 126 asks. A grader paired them within each message and ran every candidate
through `recognize`.

**The key is the weak half.** 58 of its 131 asks are low confidence — mostly where
the answer is on a screen or on `site/`, `widgets/` or `extension/`, none of which is
indexed. Every number below is against one agent's single pass, and tuning the
resolver toward it is tuning toward noise.

| Key verdict | Asks |
| --- | --- |
| needs us | 55 |
| exists | 26 |
| incident | 23 |
| declined by design | 13 |
| you can do this | 8 |
| unhomed | 6 |

## Three runs, one key

| | Words | A miss is unhomed | Pick off the menu |
| --- | --- | --- | --- |
| Answered | 72% | 18% | 43% |
| Right — the exact target | 12 | 10 | 19 |
| Right verdict, the right model | 12 | 6 | 13 |
| Right verdict, another target | 29 | 4 | 10 |
| **Wrong** | **41** | **4** | **14** |
| Unhomed where the key answered | 31 | 101 | 69 |

The grader undercounts the exact column in the last two: the key spells a move
`Order.transitions.refund` and the resolver `Order.status:refund`.

**Words.** Twenty-one of the 41 wrong answers were built on a MISS: words that found
nothing were read as the thing being absent — *needs us*, or an incident — and
eleven more found the model and missed the field, then answered about the model.
*Private note* missed `Customer.notes` and answered *you can do this* off the
`@@extensible` pool; *due date* missed `dueAt` and answered *needs us*. That breaks
the record's own first rule, that a wrong answer is worse than none.

**A miss is unhomed.** `needs us` is answered now only from a positive fact — no
state machine, two known states with no edge, a declaration the model lacks — and a
miss is `unhomed` with the pool said as a note rather than promised. Wrong fell to 4,
and answered fell to 18%. **None of the 101 unanswered was ambiguous**: every one was
a plain miss. By where the key lands them: a model, a view or a rule 35, a field 33,
a screen 11, another surface 10, a method 9, a move 3. **A synonym list would reach a
fraction of the field row and none of the rest** — a person describes a situation
(*does switching keep the payments already made*), not a column.

**A pick off the menu.** `menu(index)` lists every entry with its label and its own
schema comment — 571 on `example` — and a fact may carry `pick`, one id off it. The
translator matches meaning; the verdict is still decided in code from the entry it
picked, and a pick not on the menu is refused, which is what keeps a chosen id from
being an invented one. This amends the rule *a candidate names nothing*. The run is
only half valid: the translator picked from the first translator's one-line summaries
without reading the messages. Of its 14 wrong answers, six were a wrong pick — all
nine revenue questions went to the only view there is — four were a *broken* claim
taken at its word where the key says the person's belief is wrong, and four were a
claim mislabeled question for change.

## Is a verdict a reply

Fifteen asks across every verdict. For each, a reply written from ONLY what the
recognizer carries — verdict, target, citation, the schema comment at the target —
beside the reply a support person would send, written by an agent free to read
`example/`.

| Reply from the verdict | Asks |
| --- | --- |
| sends as-is | 3 — a narrow question answered *no* |
| needs an edit | 10 |
| useless | 2 — what the revenue number counts; an unhomed ask |

**The verdict was right on all fifteen and was the reply on three.** What the other
twelve lacked, counted per ask: how-to steps 11, why 10, what happens next 8, where
on the screen 7, a correction of the person's belief 6, the person's own rows 2.

**What they lacked is in the rule, not the comment.** What the revenue report counts
is the view's `@@sql` — order totals by status, every status, tax and shipping in, no
invoices. That a shipped order cannot come back is the transitions list. That a custom
field cannot enforce a tag's spelling is its type. A developer's `///` comment carries
none of these, and a screen question needs the route. And every second question in a
message (8.1, 14.1, 26.2) was lost when the message was split into asks.

**The free agent found defects nothing else had**, each one a question somebody
asked that the app answers wrong:

- `FJS-1103` — a monthly → yearly plan change prorates the yearly price as a month's
  and keeps the monthly period, then renews at the full year. Measured: 4500 for half
  a month.
- `FJS-1104` — `Customer.notes` is documented staff-only and readable by admins only.
- `FJS-1105` — `/settings/fields/` is linked from nowhere.

Two more read as findings and are the example's stated scope: `send-payslip` marks a
payslip sent and emails nobody, and dunning moves a subscription's status and tells
nobody. Both say so in their own headers.

## What it changes

**Stop building the resolver as the recognizer.** Recognition is a model's job — the
menu run shows it — and a verdict is triage, not an answer. What the deterministic
half is still for is a CHECK on whatever a model says: a draft that declines must be
backed by an `@immutable`, a `@system` or a missing edge, and a draft that offers must
name something the app has.

**Two directions the evidence supports, and they are one run:**

1. **A support agent grounded in the app**, whose draft is checked against the seed
   before it is sent — the check is the part of `intent.js` worth keeping.
2. **Support messages as probes of the app.** Fifteen messages found three defects a
   suite had not, because each is a question put to the codebase by somebody who
   expected a different answer.

**The next measurement is the agent, not the resolver**: fifteen fresh messages, each
reply graded on whether every claim in it is true against the code and whether a
person would send it.

## What was built and stays

`packages/cli/core/intent.js`: a miss answers `unhomed`; `menu(index)`; `pick` on a
fact, refused off the menu. `tests/intent.test.js`, 25 rows — each fix paired with
the words that must still hit (*private note* against *note*, *due date* against
*due*), and a picked `@immutable` field still declined.

The corpus run's working files — the key, both candidate sets, the grader and the
fifteen replies — were scratch and are not committed.
