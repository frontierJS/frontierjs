---
id: orion-decision-step
status: proposed
dated: 2026-09-29
---

# Idea — A decision step for orion: lookup tables and a stated reason

**Status: PROPOSED.** Two ideas taken from `zeguru/baas`, a NestJS wrapper over
`json-rules-engine` read on 2026-09-29. Nothing else in that repo is worth
taking. Orion has no node that does either of these today; `src/engine/nodes/`
was checked.

## 1. A lookup table is an action, not an expression

Most business rules are a table and not a formula: tax bands, premium tiers,
commission rates. baas treats them as three modes of one action, each with a
`default`:

| Mode | Input | Table shape | Example |
| --- | --- | --- | --- |
| value | one fact | `{ key: result }` | `{ GOLD: 0.1, SILVER: 0.05 }` |
| range | one number | `{ "lo-hi": result }` | `{ "0-40": 0.1, "41-65": 0.2 }` |
| value-range | a key fact, then a number | `{ key: { "lo-hi": result } }` | premium by cover class, then age |

A table is data that an owner can read, edit and audit on a screen. The same
rule written in the expression language cannot be. The step's output is a
named fact, and later steps read it.

**Settle before building:** what closes a band (baas splits `"0-40"` on the
dash, which breaks on negative numbers and leaves the edges ambiguous); what
happens when there is no match and no `default` (refuse, never fall back to
0; baas silently turns an unknown symbol into 0); and whether a table is
stored in the flow or is a model a flow points at.

## 2. Every step that fires states why, and the run records it

baas makes every rule carry a required `message`, so a run's output is a trace
the person affected can read: *"Loans above 10M not accepted"*,
*"10% discount for PREMIUM"*. The trace is part of the output, not a log line.

For orion, that means a `reason` on the decision step, written to its
`RunStep` next to the output value. That makes the run inspector show a
sentence per step instead of JSON. Apply the `FJS-D295` read rule: the
reason is readable by whoever can read the run.

## Not taken

baas also has `break: true` to stop at the first failed check. Orion's routing
already covers that. Its free-form mathjs expressions, rulesets held in memory,
and rules stored as one versioned JSON blob are anti-patterns, not ideas.
