# Verifying

*How you know something in this repo is true.*

The short version: **run it and probe its failure paths.** Reading the source,
the docs, or a package's own status file is how you form a hypothesis — not
how you confirm one.

---

## Why this is a rule and not a preference

The 2026-08-01 audit read all twelve packages carefully first. Every serious
defect it found was invisible to that reading and obvious the moment something
was executed:

| Defect | Looked like, in source | What running it showed |
|---|---|---|
| Gates fail open | `@@gate("0.4.4.5")` on the model, enforcement code present | Anonymous `create` succeeded — the enforcing plugin was never installed |
| Migration data loss | A tidy generated `INSERT … SELECT` rebuild | Two seeded rows destroyed; reported `✓ 1 migration applied` |
| Custom actions 404 | Header dispatch implemented, documented, exampled | Every camelCase action name was lowercased into a guaranteed miss |
| Empty notification emails | A `MailMessage` built and passed to `app.mail.send()` | Two packages owned different message shapes; bodies dropped silently |

And the inverse — self-descriptions were wrong often enough to be untrustworthy
as evidence:

- A package marked **"✅ Production ready"** in a sibling's status doc had
  **zero tests**.
- A README documented `@@gate("9")` where the code shipped `"8"` — following
  the README would have bricked auth.
- Three packages' docs advertised CLI commands that do not exist.
- A doc comment described a `cancel()` behavior the code contradicted, and the
  test passed because it asserted at the wrong moment.

The pattern: **anything hand-maintained drifts** — which is the framework's own
first axiom pointed back at its documentation.

---

## The practice

**Treat every claim as a hypothesis with an owner.** Source code claims what
it does; comments claim why; docs claim how to use it; status files claim
maturity. All four are restatements, and restatements drift. Execution is the
origin.

**Probe the failure paths, not the happy path.** The happy path is what the
author already ran. Value lives in: the empty input, the typo'd field, the
unauthenticated caller, the migration against *seeded* data, the second run,
the concurrent write, the malformed payload. A throwaway probe script that
tries fifteen wrong things in thirty lines is the highest-yield tool available
here — see `elegance-fixes` / `migrations-fixes` in
`packages/litestone/test/` for probes that graduated into tests.

**Capture the baseline before you touch anything.** Several packages carry
pre-existing test failures. Record the failing set first, so "regressions I
caused" and "breakage I inherited" are separable — otherwise a green-to-red
diff gets misread in both directions.

**Re-run the original failing scenario.** Not a scenario *like* it. The exact
reproduction that established the bug, end to end, through the real entry point
(the CLI, the HTTP route, the example app) — not through the internal function
you happened to fix.

**Prefer the real entry point.** A unit test around a fixed function proves the
function. Booting the app and curling the endpoint proves the wiring — and the
wiring is where this monorepo's bugs live, because so many of its bridges are
conventions rather than imports.

**When a fix lands, leave a test where the probe was.** A probe that found a
real defect and then evaporates guarantees the defect can return silently. Both
data-loss classes found in migrations are now permanent tests.

---

## What counts as evidence

| Claim | Insufficient | Sufficient |
|---|---|---|
| "This is implemented" | The export exists | It was called and returned what it promises |
| "This is enforced" | The check is in the source | An unauthorized attempt was actually refused |
| "This package works" | README, status doc, version number | Its suite runs green *and* an example boots |
| "X depends on Y" | `package.json` | A grep for real import sites (deps here are often undeclared, dynamic, or duck-typed) |
| "This is fixed" | The code changed | The original reproduction now passes and the suite shows no new failures |
| "Nothing else broke" | It compiles | Before/after failure sets compared, not just the after |

---

## Reporting

Say what you ran and what it printed. A finding with a reproduction is
actionable; a finding without one is a suspicion wearing a finding's clothes —
and if the reproduction can't be produced, say *that*, plainly, rather than
softening the claim until it's safe.

The same standard applies to success: "tests pass" means the command was run
and its output read. If a step was skipped, it gets said out loud.
