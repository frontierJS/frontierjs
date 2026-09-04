---
id: payroll
status: partial
dated: 2026-08-30
---

# Idea — payroll, in phases

**Status: BUILT — phases 0 to 8 are done.** What remains is the fallout below. Dated 2026-08-30. This is the sequencing
for `IDEAS/proving-grounds.md` § Candidate A, which ranked payroll second of three
proving grounds, argued *why*, and already took the decision that it lives in
`example/` rather than in a fourth app. That file answers *what it breaks*; this
one answers *in what order*, and every phase ends with something runnable — a
phase whose output is only a schema is a phase that cannot be shown to be wrong.

Each phase will grow an *It landed* section as it is built, so the plan and the
record stay one document.

---

## What billing left standing, measured rather than predicted

`proving-grounds.md` predicted that if billing settled the cross-row invariant and
the immutable document, "payroll starts with two of its five walls already
standing". Billing shipped phases 0–6 on 2026-08-30. The real count is **one and a
half**, and the difference is the whole reason this file exists.

| Wall | State after billing |
| --- | --- |
| **Immutable document** | **Standing.** `@immutable` is a column at the constraint tier, so `asSystem()` cannot drop it (`FJS-D162`). A payslip is an invoice's shape with a different noun on it. |
| **Cross-row invariant** | **Argued, no grammar.** `FJS-D162` ruled *where* it is checked — at the transition, and the freeze is what makes once enough — and its own *not ruled* list still holds what **spells** it. `example` enforces `subtotal = Σ lines` in `api/src/billing.ts`. Application code. |
| **Effective dating** | **Half.** The pattern is built and ruled (`FJS-D164` — a row with a window, and the consumer names the version rather than the parent). There is no `@@effective`, and `FJS-603` means *one open window per parent* cannot be declared at all. |
| **Bitemporality** | **Untouched.** Billing never asked *as we knew it then*. |
| **Retroactive correction** | **Untouched.** A mid-cycle plan change is forward. Nothing declares *this row was derived from those rows*. |

Payroll meets walls 2 and 3 harder than billing did. A journal balancing to zero is
the same shape as an invoice's sum, and effective dating goes per employee per term
rather than per plan — which is one window against thousands. (*The parenthetical
that stood here — **with no draft state to check it at** — was retired by
`FJS-D167`: `@seals` gives a document its moment, and `PayRun` already had one in
`calculate: draft -> calculated`. What is still missing is the spelling for the
CHECK itself, not the moment to run it at.*)

---

## The size budget — the 80/20 rule, stated as a number

**This is a constraint on the design, not a note about effort.** `example`'s single
largest asset is that a newcomer can hold it in their head, and payroll is the
domain most likely to take that away by accident.

The negative reference is measured. `packages/litestone/test/fixtures/corpus/erpnext.lite`
is **534 models**, ported mechanically from `frappe/erpnext` — and it contains no
payroll at all, because HR was split out into `frappe/hrms` again. A faithful port
is the wrong target twice over: it is enormous, and most of its size is fidelity to
jurisdictions and workflows that carry none of the five walls.

> **Budget: eight models and three enums.** `example` is 23 models and 11 enums
> today. Payroll takes it to 31 and 14 — not to 60.

**A model earns its place by carrying a wall.** Anything that only adds domain
fidelity is out, and § *Out of scope* names it so it is not rediscovered as an
omission.

| Model | The wall it carries |
| --- | --- |
| `Employee` | none directly — the person, and the tenant boundary is already free |
| `EmploymentTerms` | **effective dating** — pay that was true over an interval |
| `PayRate` | **reference data with validity windows** — bands per tax year |
| `PayRun` | the batch, and an approval ladder where approving moves real money |
| `Payslip` | **the immutable document** |
| `PayslipLine` | **the cross-row invariant** — the lines *that count* sum to net (phase 0 found the exclusion) |
| `JournalEntry` | none directly — the header a run and a sale both post |
| `JournalLine` | **the cross-row invariant, in its sharpest form** — sums to zero |

**Two deliberate flattenings, each a fixed set expressed as an enum rather than a
table**, and both are stated here so nobody reads them as a claim about how payroll
should be modeled:

- **The chart of accounts** is `LedgerAccount` — sales, cash, receivables, tax
  control, wages expense, PAYE control, pension control, net pay control. A real
  bureau makes this a table because a client adds accounts; an example app's chart
  is genuinely fixed, litestone emits a table `CHECK` for an enum so a migration
  and `asSystem()` are both held to it, and a picker renders it for free.
- **The pay component** is `PayComponentKind` — basic, overtime, bonus, income tax,
  employee pension, employer pension, employer NI. Frappe spends three doctypes
  here (`Salary Component`, `Salary Structure`, `Salary Structure Assignment`) and
  the third evaluates a Python expression per component, which is schema-as-data —
  the question `proving-grounds.md` § Considered already declined to build.

**What the flattening costs is that a component's RATE still has to move**, which
is why `PayRate` survives as a table: a pension percentage and an income tax band
are the same shape — a number true for an interval — and that shape is a wall.

---

## Phase 0 — the port, before a model is written

`litestone import --from frappe` shipped 2026-08-29 and `fetch.mjs` is a table, so
adding `frappe/hrms` is one entry beside the seven already there. The payroll half
is exactly what ERPNext no longer carries: `Salary Slip`, `Salary Structure`,
`Salary Component`, `Income Tax Slab`, and the `Payroll Entry` that drives a run.

**Read `gaps.json`'s new rows before writing anything.** The refusal list is the
roadmap, and it is the one artefact here that finds unknown unknowns
automatically — 2,155 recorded constructs across seven applications so far, and two
defects nothing else could have found. A gap met at a terminal is a specification;
a gap argued from this page is a guess.

**Ends with:** a committed `hrms.lite` fixture with `openmrp.lite`'s header
discipline, a row in `test/corpus.test.ts` so it would go red if the parser
regressed on that shape, and a list of the constructs payroll actually uses that
`.lite` cannot express.

### It landed, and what it found

**Shipped 2026-08-30.** One entry in `fetch.mjs`, one name in `corpus.test.ts`.
`hrms.lite` is **160 models**, parses, builds and re-boots with zero drift, and
records **526 unexpressed constructs of which `0` are `changed`** — nothing was
silently mis-stated, the whole list is `lost` (335) or `noted` (191). The corpus
is now 1,537 models across eight applications.

**The headline is not in the refusal list, and that is the point.** Four of the
five walls this file is organized around are absent from a mature payroll
application's schema *as well*, because Frappe declares them in Python. A port
cannot report a gap the source does not attempt. What it can do — and did — is
show what each wall looks like when nobody declares it:

- **Money is `Float`.** 59 float columns across the six payroll-core models,
  `grossPay`, `netPay`, `totalDeduction`, `base` and `amount` among them. No
  scale on anything. `@money` (`FJS-D142`) is vindicated in the one domain least
  able to afford the alternative, and this is the first time the corpus has put
  net pay in front of it.
- **The cross-row invariant has an EXCLUSION, which changes the ruling it
  forces.** `SalarySlip` stores `grossPay`, `netPay`, `totalDeduction` and
  `roundedTotal` as ordinary columns with no stated relation to `SalaryDetail` —
  and the line carries `doNotIncludeInTotal` and `statisticalComponent`. So the
  real-world invariant is not *lines sum to net*, it is ***lines that count* sum
  to net**. Anything this project spells has to admit a predicate over the child
  and not merely an aggregate over it, which `Invoice.subtotal = Σ lines` never
  had to.
- **Effective dating has a third shape.** `SalaryStructureAssignment` carries
  `fromDate` and **no `toDate`** — the window is closed by the next row's start
  rather than written down. `example`'s `PlanVersion` uses a nullable
  `effectiveTo` pair (`FJS-D164`); a closed interval is a third. The
  `@@effective` question therefore has to choose among three real spellings
  rather than bless the only one in front of it, and successor-implied is the one
  that makes `FJS-603`'s *one open window per parent* meaningless — there is no
  open column to be unique over.
- **Amend-not-edit is a plain self-relation, used 54 times.** `amendedFrom` points
  a new document at the cancelled one it replaces. It is the nearest thing in the
  whole corpus to declaring **derived from**, and it is a link rather than a
  computation — evidence for ruling 4 below, and a cheaper answer than the one
  that file was expecting.
- **The formula is in the schema as a string.** `SalaryDetail` carries
  `condition`, `formula` and `amountBasedOnFormula`; `TaxableSalarySlab` carries
  `condition`. Evaluated as Python. § Out of scope declined this from memory and
  now declines it with the source in front of it.

**It also priced the budget rather than leaving it asserted.** Of 160 models
roughly **38 are payroll proper**; the rest are recruitment, appraisal, leave,
travel, expenses, shifts and onboarding — every one a domain § Out of scope
already names. Eight models is measured against that 38.

**Two stale claims fell out of doing it**, both in files somebody reads before
running anything: `fixtures/corpus/README.md` said only `triggerdev` was
committed when six fixtures were, and closed by describing `litestone import` as
something "which does not exist" three sentences after crediting it with
producing every file in the directory; and `corpus.test.ts`'s `COMMITTED` /
`FETCHED` lists had the same drift. Both corrected. The licensing question the
first one was answering — whether a schema converted from a copyleft source
belongs in an MIT package — is **unresolved rather than applied**, and is now
recorded as such instead of being contradicted by `git ls-files`.

---

## Phase 1 — the ledger, narrow

**This is the path taken 2026-08-30: the ledger comes early and stays small.**

`proving-grounds.md` makes the shared general ledger the whole argument for folding
payroll into `example/` — "an order posts journals, a pay run posts journals, and
the ledger is where the cross-row invariant finally has to be declared". Two ways
to sequence that, and the argument for this one is that the cross-row invariant is
the sharpest gap on the list and **the cheapest place to meet it is the smallest
one**: a sale's journal has three lines, a pay run's has nine.

The counter-case, recorded because it is real: this phase touches the money drives
that already pass, and a regression here is a regression in code that had nothing
to do with payroll.

**Narrow means the sale that already exists posts a journal, and nothing else is
retrofitted.** `carts.service.ts`'s `checkout()` is already `transactional:`, so the
journal commits with the order or not at all — no second write path, no reconciler,
no backfill of historic orders. Refunds, credit notes and inventory valuation are
each a later journal and each stays out.

**The precedent is already in the app**, which is what makes this cheap to read:
`InventoryMovement` is a signed, append-only ledger with `stockBefore`/`stockAfter`
on every row and a comment explaining why a ledger of totals cannot be summed. A
general ledger is that table's shape with an account on it and a balance rule.

**The gap it walks into on day one:** *the lines of one entry sum to zero* reads a
child table, which no `@@check` can do and no policy can aggregate — the identical
shape to `Invoice.subtotal = Σ lines`, which `billing.ts` enforces in application
code because `FJS-D162` ruled *where* it is checked and deliberately left *what
spells it* open. Two instances of one gap is the evidence a ruling wants.

**Ends with:** a sale posting a balanced journal inside the checkout transaction,
and `verify:money` extended by a delta assertion — the journal for a basket equals
the receipt identity that drive already proves.

### It landed, and what it cost

**Shipped 2026-08-30.** Three models' worth of vocabulary — `LedgerAccount`,
`JournalSource`, `JournalEntry`, `JournalLine` — `api/src/ledger.ts` as the one
owner of a posting, two read-only services, and one line inside
`carts.checkout`. `example` is 25 models. `fli check` clean, typecheck
unchanged at its pre-existing 16, every snapshot regenerated.

**The journal is the receipt identity written the other way round**, and that is
what makes the phase worth its size rather than a table nobody reads:

```
DEBIT   receivables        total        CREDIT  sales           subtotal
DEBIT   discountsAllowed   discount     CREDIT  shippingIncome  shipping
                                        CREDIT  taxPayable      tax
```

`Order`'s own `@@check` says `total = subtotal − discount + shipping + tax`;
rearranged that is `total + discount = subtotal + shipping + tax`, which is
debits equal credits. Every one of the five receipt columns appears **exactly
once**, so the entry reads back AS the receipt rather than merely agreeing with
it. Proved end to end: a real HTTP checkout of 5,600 minor units posts
`receivables 6720 · sales −5600 · taxPayable −1120`, summing to zero.

**The discount is its own debit rather than netted off `sales`.** Netting is
fewer lines and it destroys the figure — a period's revenue and a period's
discounting are two numbers a shop wants apart, and added together nothing can
separate them again.

**Running it corrected the gate, which reading could not have.** `@@gate("5.9.9.9")`
looked right and made the table unwritable by *everything*: `asSystem()` grades
at **8**, and `9` is LOCKED — not reachable through the ORM by any client. The
answer is better than the mistake. `@@gate("5.8.9.9")` is *read by staff · posted
by the application · amended by nothing*, so the ledger is append-only *at the
Data boundary* rather than by agreement, and a period close would not have to be
built on trust. `@immutable` refuses a restatement column by column; `9` refuses
the call.

**Five refusals, five different mechanisms**, which is `FJS-351`'s discipline
applied to a new rule — a refusal that cannot be shown to come from the rule it
names proves nothing:

| Refused | By |
| --- | --- |
| an unbalanced posting | `ledger.ts`, naming the imbalance — *debits 99, credits 100, out by 1* |
| fewer than two lines | `ledger.ts` |
| restating a posted entry | `@@gate` 9 on update — LOCKED, `asSystem()` included |
| deleting a line | `@@gate` 9 on delete |
| a line for nothing | `@@check("amount != 0")`, in the table |

And the acceptance beside them: a sale with no code applied posts **three** lines
rather than a `discountsAllowed` line of zero — dropped by `postJournal`, because
zero is a legitimate answer from the arithmetic upstream and refusing it would
fail every undiscounted order.

**The wall is now written twice, which is the point.** `billing.ts` enforces
`Invoice.subtotal = Σ lines` and `ledger.ts` enforces *the lines sum to zero*,
for the identical reason: the rule reads a CHILD table, `@@check` sees one row, a
policy cannot aggregate. Two callers waiting on one spelling is the evidence
ruling 1 wants; a third would be a pattern nobody is going to fix.

**`verify:money` grew a *the books* section — 14 assertions, 107 in the drive.**
Every count in it is scoped to the run's own order, because the table is
append-only by declaration and a global count would pass once and drift upward
for ever.

---

## Phase 2 — the seed: who is employed, and on what terms

`Employee` and `EmploymentTerms`. The employee is per shop, which costs nothing —
`example` is `tenancy { strategy database  resolve subdomain }`, one SQLite file per
shop, so every shop is already a separate legal employer and the bureau shape
`proving-grounds.md` asks for arrives free rather than as a feature.

`EmploymentTerms` is effective-dated: an annual salary or an hourly rate, hours per
week, and a window. **The as-at read is written by hand**, which is the instruction
rather than an oversight — proving-grounds says "the ugliness of that read is the
specification for `@@effective`", and a grammar designed before the ugliness is a
guess about which part was ugly.

Two things are known before it starts, from billing:

- **`FJS-D164` already ruled the pattern.** A payslip names the `EmploymentTerms`
  it was calculated under, exactly as a subscription names its `PlanVersion` — the
  consumer names the version, never the parent, or a raise in July reprices April.
- **`FJS-603` bites immediately and for the second time.** *One open window per
  employee* is not expressible: `effectiveTo` is null on exactly the row that
  matters, two NULLs never compare equal, and `@@unique` takes no predicate. It
  goes in a service transaction, as `PlanVersion` does.

What is genuinely this phase's is the question `FJS-D164` explicitly left to
candidate A: **should the language know about validity windows at all**, or is an
app arranging two nullable columns the right answer forever.

**Ends with:** an as-at read, and a drive asserting that a raise effective 1 July
does not change a payslip issued in April.

### It landed, and what it cost

**Shipped 2026-08-30.** Two models (`Employee`, `PayWindow`), one enum, two
input types, `api/src/employment.ts` as the one owner of the as-at read, two
services, three seeded people with pay HISTORIES, and a new bun drive —
**`verify:employment`, 31 assertions, green twice with no reseed.** `example` is
27 models. `fli check` clean, typecheck unchanged at 16, 9 snapshots current.

**The interval is the thing that had to be decided once.** A window is half-open
— `effectiveFrom <= at < effectiveTo` — so the instant a window opens belongs to
the new one and to nothing else. Two readers disagreeing about that boundary is
a wrong salary once per raise, and never reproducible, because it depends on
which row came back first. It is exported as `coveringAt(at)` so a caller
building its own query cannot spell it a second way, and the drive asks it from
both sides.

**The ugliness the phase was written to expose is the BATCH.** One employee is a
`findFirst`. A pay run is five thousand at one instant, and there is no way to
ask for that: either N queries, or one query for every covering row and pick in
JS — which is only correct because at most one window per employee can cover an
instant, **and that "at most one" is not declarable**. So `payAsAtMany` defends
against the thing it is told cannot happen and names the employee when it finds
it. *A function that has to re-check an invariant its own database was supposed
to hold* is what a missing feature looks like from the inside, and it is now a
paragraph with a test under it rather than an argument.

**`FJS-603` is pinned rather than described.** `gap.twoOpenWindowsAreAcceptedByTheSchema`
creates a second open window and asserts it SUCCEEDS. Closing the gap turns that
assertion red, which is the only way a drive can hold a language gap without
going stale.

**The second copy exists and was left uncombined on purpose.** `employees.setPay`
is `plans.reprice`'s four steps over an unrelated noun — find the open window,
refuse two, close it at `now`, open the next in one transaction. Factoring them
into a helper would make two hand-written workarounds look like one designed
mechanism, and two domains arranging validity windows identically by hand is the
argument for ruling 2.

**`fli check` caught the model name, and it was not a false positive.** `model
EmploymentTerms` reads as a plural, so the service `employment-terms`
singularises to `EmploymentTerm` and Invariant 2's three resolvers stop
agreeing — a resource file over it would resolve to no model at all. Renamed to
`PayWindow`, which is what every comment in `employment.ts` already called it.

**Two findings the phase produced that the plan did not predict:**

- **`@money` is refused inside a `type`**, by name. A `type` is a wire shape and
  `@money` is a storage decision, so the unit lives on the COLUMN — which is
  what a generated form reads anyway. Consistent, and worth knowing before
  writing a third input type.
- ***Employed* and *paid* are different questions, and only one of them has a
  window.** Leaving does not close a pay window: the seeded leaver still has an
  open one, and a payroll reading the terms table alone would keep paying them.
  `employedAt` is the only thing that separates the two, and it is asked of
  `Employee` rather than of the windows. This is the shape phase 5's
  retroactive correction will meet again from the other end.

---

## Phase 3 — the rates

`PayRate` — banded, effective-dated reference data. One table serves the income tax
band, the pension percentage and the employer NI threshold, because all three are
the same sentence: *this number was true between these dates, for amounts in this
range*.

**Not a `valueset`** (`FJS-D120`), which is a closed set of values a picker offers,
and **not an enum**, which is a fixed set with no time on it. This is a table whose
rows are each true for an interval, and it is the second instance of phase 2's wall
in a shape where nobody is tempted to call it a status column.

**Ends with:** tax computed for one employee at one date, from rows rather than from
a constant in a `.ts` file.

### It landed, and what it cost

**Shipped 2026-08-30.** One model (`PayRate`), one enum (`RateKind`),
`api/src/payrates.ts` as the one owner of the band walk, one service, seven
seeded bands, and `annualGross` beside `weeklyGross`. `example` is 28 models /
31 services. **`verify:employment` is 58 assertions**, green three times without
a reseed and green again after seeding twice. `fli check` clean, typecheck
unchanged at 16, 9 snapshots current.

**One table where Frappe spends four.** `Salary Component`, `Income Tax Slab`,
`Income Tax Slab Other Charges` and `TaxableSalarySlab` are one sentence — *this
rate applied to this slice, over this interval* — and splitting it costs a join
per question and a second place to forget the window. Four `RateKind` values
cover the 80/20: what the state takes, what the employee puts in, what the
employer puts in beside it, and the employer's own contribution. Everything a
real bureau adds is another ROW.

**The band walk is the only interesting arithmetic in payroll, and its negative
control is the classic wrong answer.** A rate applies to the slice between two
thresholds, never to the whole: on 48,000 the tax is 20% of the 35,430 above the
allowance — 7,086 — and `walk.theTopBandIsNotAppliedToTheWholeSalary` asserts it
against the naive figure the same bands would give, which is out by more than
1,000. Half-open at the threshold for `coveringAt`'s reason, asked from both
sides.

**Rounding is per BAND and never on the total**, and the total is the sum of the
parts. A payslip shows the bands, so each line has to be whole on its own — a
breakdown whose lines are exact and whose total is rounded separately does not
add up, which is the one thing a payslip may not do.

**The third instance of the same four columns.** `PlanVersion`, `PayWindow`,
`PayRate` — three tables in one application, two of them reference data and one
a person, each arranging `effectiveFrom` / `effectiveTo` / a `nullsDistinct`
near-miss / close-then-open by hand. `coveringAt` has a second consumer now,
which is the whole argument for having exported it: a tax band that changed on a
different midnight from a salary would be a real defect and an invisible one.

**Two things it decided that the plan did not name:**

- **A percentage at two places, not a fraction.** `example` already had both
  spellings — `Discount.value Int @scale(2)` and `TaxRate.rate Float`. Payroll
  takes the integer, and the reason is the domain rather than taste: a float
  fraction is exact enough for a shop's VAT line, and phase 0 found a real
  payroll storing its *wages* that way. `PERCENT_SCALE` is written once so
  nobody divides by 100 and is out by a hundred.
- **The employer's cost is answered separately and must never be netted.**
  Employer NI and the employer's pension are a cost to the business, not a
  deduction from the person. A `contributionsOn` that returned one number would
  have made that mistake for every caller; phase 4's journal debits them to a
  different account.

**A defect this phase created and fixed, worth keeping because the shape is
general:** the payroll seed keyed its idempotency on `effectiveFrom: ago(900)`,
which is recomputed on every run — so nothing ever matched and each `db:seed`
appended another whole history. Three seeds gave one person six windows, several
open at once, and the very next as-at read refused by name. **A seed whose
idempotency key is a computed timestamp is not idempotent**, and the fix is to
rebuild against a count rather than match on a value. The drive caught it
immediately, which is the argument for the overlap refusal existing at all.

---

## Phase 4 — the pay run

`PayRun` is a `@@transitions` state machine — `draft → calculated → approved →
paid` — and it is the first thing in `example` where **approving moves real money**,
so it takes a `@gate` and a capability (`FJS-D146`): a bookkeeper may calculate, a
director approves. The grid and the ladder are ANDed, so the gate stays the floor.

`Payslip` is immutable with `@immutable` doing the work `billing` proved it can do,
and `PayslipLine` is signed — earnings positive, deductions negative — summing to
net. Signed rather than a `kind` column deciding the arithmetic, for
`InventoryMovement`'s stated reason: a ledger you cannot sum is a ledger nobody can
check.

**The run posts one journal**, and that journal is phase 1's rule met at nine lines
instead of three: wages expense debited, PAYE control, pension control and net pay
control credited. If phase 1's invariant has a spelling by now, this is where it
pays for itself; if it does not, this is the second application-code copy of it and
the ruling is overdue.

**`allocate` gets its second caller.** `FJS-D154` shipped
`allocate(amount, ratios)` for proration; splitting employer cost across cost
centers is the same function with a different reason, and the parts must sum to
what was actually paid.

**Ends with:** one run over three employees producing three payslips and one
balanced journal, with the approval refused at the wrong standing.

### It landed, and what it cost

**Shipped 2026-08-30.** Three models (`PayRun`, `Payslip`, `PayslipLine`), two
enums, five new ledger accounts, `api/src/payroll.ts`, three services, and the
journal becoming an **`@@arc`** — this application's second, after `Payment`.
`example` is 31 models / 34 services. **`verify:payrun`, 41 assertions**, green
three times without a reseed; `verify:employment` 58, billing 23, proration 21
unmoved. `fli check` clean, typecheck back at 16, 9 snapshots current.

**`allocate` gets its second caller, and it is the opposite end of the same
function.** Billing splits a period across seats; this splits a YEAR across
periods. A band table is annual and a payroll is monthly, so something divides,
and twelve roundings of `annual / 12` do not sum to `annual` — the drive asserts
the property on a salary that does not divide evenly, with the naive division
written out beside it as the control. `PayRun.periodIndex` is a stored column
precisely so which month carries the leftover unit is decided by the ratios
rather than by whichever calculation ran first.

**Contributions are computed ANNUALLY and then split**, never on the period's
gross. A band is an annual threshold: charging it against a twelfth of a salary
puts almost everybody in the zero band and collects no tax — the wrong answer
that looks like a working payroll.

**The cross-row invariant now has the shape phase 0 predicted.** *The lines that
COUNT sum to net* — `PayslipLine.counts` is false for the employer's
contributions, which belong on the payslip and are not deductions from the
person. So the rule needs a **predicate over the child**, and `ruling 1` has its
requirement confirmed by executed code rather than by a corpus reading. This is
the third application-code copy of a cross-row rule (`Invoice.subtotal`, the
journal balance, this).

**And `net = gross − deductions` is the contrast worth having beside it**: three
columns of one row, so it IS declarable, and the drive shows SQLite refusing a
system write that breaks it. Two invariants on one model, one held by the
database and one by a function, is the clearest statement of the gap this
project has produced.

**The journal balances by identity, not by luck.** `net = gross − tax − employee
pension` and `employerCost = employer pension + employer NI`, so
`wagesExpense = gross + employerCost` is exactly the sum of the four credits.
Phase 1's rule at five lines instead of three, on a completely different noun.

**The drive found a real design hole and the fix is a finding.** `revert:
calculated -> draft` exists because a run computed against the wrong period is
the ordinary mistake — but `Payslip` was `@@gate("5.5.9.9")`, delete LOCKED, so
reverting stranded its payslips and the recalculation collided on
`@@unique([payRunId, employeeId])`. The gate is now `5.5.9.8`, and what that
gives up is stated: **a freeze that depends on STATE is not expressible.** A
payslip under a draft run was never issued and removing it is ordinary; one
under a paid run is a document. `@@gate` is per model, so the rule lives in
`revertPayRun` — a **fourth** cross-row rule in application code, and a
different SHAPE from the other three: they aggregate a child, this one reads a
parent's state before touching one. `FJS-D162`'s open sub-question about DELETE,
met from a direction the ruling did not anticipate.

**The ladder is real and asked at the boundary.** `approve` is `@gate(5)` —
this shop's second, after a refund — and the drive moves it with a level-4
client and a level-5 client rather than comparing a number. `calculate` and
`pay` are `@system`, so a caller cannot state them at all.

**Effective dating pays off here and nowhere else could.** The drive reverts a
run, doubles somebody's salary, recalculates the SAME period, and asserts every
figure comes back identical — and that the payslip still names the now-CLOSED
pay window. That is `FJS-D164` in a foreign key, and it is the one assertion
that fails the moment `calculatePayRun` reads `now` instead of the period end.

---

## Phase 5 — the batch at size

A pay run is 5,000 employees. **One transaction is the wrong answer, partial failure
is the normal case, and the run must be resumable and re-runnable without paying
anybody twice.** This is caravan's hardest test — harder than `verify:jobs` has ever
given it — and it is the outbox's designed case, because a payslip that has been
*sent* cannot be un-sent.

Two things are already learned and must not be relearned:

- **The idempotency key is `unique`, never `id`.** `occurrenceKey('payslip', runId,
  employeeId)` from `@frontierjs/toolbelt/history`. `FJS-609` was exactly this
  mistake in billing: `dispatch({ id })` is the jobs table's primary key and
  therefore a no-op *forever*, and SQLite reuses rowids, so a cleanup made the
  second run silently skip work.
- **The effect that must survive a crash is `ctx.enqueue`, not `ctx.afterCommit`.**
  A payslip email is the durable half by definition.

**Ends with:** a run interrupted half way and resumed, paying nobody twice, asserted
against the ledger rather than against a job count.

### It landed, and what it cost

**Shipped 2026-08-30.** `payroll.ts` restructured around a **per-person unit of
work**, two job files, `PayRun.headcount`, `Payslip.sentAt`, and a new drive —
**`verify:batch`, 33 assertions**, green twice with no reseed. Every other bun
drive unmoved. `fli check` clean, typecheck back at 16, 9 snapshots current, 11
durable jobs.

**The unit is one PERSON, and that is what makes the key natural.**
`occurrenceKey('payslip', runId, employeeId)` names a fact. A chunk index does
not — a roster that changes between two dispatches puts different people in
chunk 7 and the key stops meaning anything. The cost is N dispatches, which is
what a queue is for. `@@unique([payRunId, employeeId])` is the floor under all
of it, asserted directly.

**One implementation, two drivers.** `calculatePayRun` is now a loop over the
same `calculatePayslipFor` the queue calls, so a three-person shop and a
five-thousand-person one produce identical documents. Phase 4's 41 assertions
passed through the restructure unchanged, which is the evidence that it is one
implementation and not two.

**The two jobs choose their idempotency key OPPOSITELY, and that is the phase's
sharpest finding.**

| Job | Key | Because |
| --- | --- | --- |
| `calculate-payslip` | `unique` | the work is RESUMABLE — a second dispatch after a crash has to REACH the handler, and under `id` it would be swallowed and the payslip never written |
| `send-payslip` | the dispatch `id` | a payslip that has gone out cannot be un-sent, so the only safe answer to a redelivery is *nothing happens, forever* |

`FJS-609` was `id` used where `unique` was meant. This is the case `id` is right
for, and having both in one domain is what makes the distinction teachable. The
handler is idempotent underneath either, and `sentAt` is a second guard at a
different layer — the dispatch id stops it being QUEUED twice, the stamp stops
it being SENT twice.

**A measured defect fell out: `FJS-611`.** `transition()` is read-then-write, so
`@@transitions` does not hold under concurrency — four concurrent
`transition(id, 'calculate')` calls on one `draft` row all succeeded, the last
against a row already `calculated`. Nothing is corrupt, because the row lands in
the target state either way; the damage is entirely in the ANSWER, and a batch
is exactly where that matters — five thousand workers each asking *was it me who
wrote the last payslip* all get yes. `completeIfDone` is now a `$transaction`,
where litestone's `BEGIN IMMEDIATE` makes the second caller wait and re-read.
(**Corrected on closing the row** — see the phase 6 list below. The transaction
is not what held it and the diagnosis in this paragraph is wrong.)
The mitigation is real and **not discoverable from the schema**, which is what
makes it worth a defect rather than a note: a declared state machine reads as if
the boundary enforces it, the way a `@@check` does.

**Two corrections to phase 4, both mine:**

- **`Payslip` gate `5.5.9.8` → `5.5.8.8`.** `9` on update froze the ROW, which
  took the legitimate `sentAt` stamp with it. `FJS-D162` had already ruled this:
  *a document is the COLUMN tier rather than the row tier, because a document
  still has to MOVE.* Every figure is `@immutable`, so nothing restates one at
  any level; what the two 8s buy is one removal and one stamp. `PayslipLine`
  keeps `9` on update deliberately — a line has nothing anybody stamps.
- **`planPayRun` excludes somebody with no pay window from the headcount**,
  rather than counting them and skipping them later. A run whose finish line can
  never be reached never finishes, and at five thousand nobody would notice
  which one it was.

**The ledger is what the resume is asserted against**, as the plan asked, and the
reason is worth keeping: a job count agrees with a double-payment bug. The books
are the only record that cannot be right while the money is wrong.

---

## Phase 6 — the retroactive correction

Backdate a raise to 1 March. Three closed periods recompute. **They emit adjustment
lines on the next payslip and never edit the closed ones** — which `@immutable`
already enforces, so the phase cannot cheat even if somebody wants to.

**The finding this phase exists for: nothing declares *this row was derived from
those rows*.** A recompute cascade has no owner, idempotency per employee per period
is hand-built, and the question of which inputs a document was computed from is
answerable only by rerunning the computation and hoping.

**Bitemporality shows up here and only here**, which is why it is not its own phase:
*what did March's payslip say when March said it* against *what does March owe now*
are two different questions about one row, and the second is the adjustment. If the
answer is a column pair rather than a dimension, that is a finding worth having
cheaply.

**Ends with:** a backdated raise producing three adjustment lines on one later
payslip, with every closed payslip byte-identical afterwards.

### It landed

`api/src/arrears.ts` (the correction), `api/src/payslip.ts` (split out of
`payroll.ts` — a RUN is made of payslips and ARREARS are about one, so the file
both of them import can be neither), one nullable column
(`PayslipLine.correctsPayRunId`) and one optional input field
(`EmploymentPay.effectiveFrom`). **No new model: the budget was already spent,
and a correction that needed a ninth would have been the finding instead.**
`verify:retro`, 55 assertions, green twice.

**The closed documents do not move, and nothing had to be written to make that
true.** Every figure on a `Payslip` is `@immutable`, so the phase could not
cheat even if somebody wanted it to. The drive compares all three closed
payslips and their lines byte for byte before and after.

**The finding the phase was written for, measured three ways.**

Nothing declares *this row was derived from those rows*, and what follows is not
inconvenience:

1. **The cascade has no owner.** A pay window is written and three payslips
   become wrong. No column, no attribute and no event says so — the drive
   asserts the stale document is byte-identical to the current one — so the
   only correct answer is to RECOMPUTE EVERYTHING and compare. `arrearsFor` is therefore O(every run this person has
   been paid for) rather than O(what changed), and that is forced rather than
   lazy.
2. **Idempotency is hand-built.** The comparison has three terms — what we now
   believe the period owed, less what the payslip said, less what has already
   been put right — and the third is a query somebody remembered to write.
   Forget it and the next run pays the arrears again. Two drive sections exist
   only to pin it: reverting and recalculating gives the same arrears once, and
   a later run carries none at all.
3. **A derived row is not live.** Once issued, an adjustment is frozen like any
   other line. A second backdate does not move it; it produces a second
   adjustment for the remainder, which composes only because of term three
   above.

`PayslipLine.correctsPayRunId` is the whole of what can be said, and it is a
plain foreign key. **Phase 0's prior art holds up exactly:** Frappe writes
`amendedFrom` on 54 doctypes, a link and not a computation, which is evidence
that a link is the state of the art rather than that a link is enough.

**Bitemporality, and it is not absent — it is a FILE.** The schema holds VALID
time (`effectiveFrom`/`effectiveTo`) and says nothing about when we LEARNT
something, so a backdate overwrites `effectiveTo` in place and the row keeps no
trace. What holds the previous belief is `@@log(audit)`: the drive reads
`db.auditLogs`, finds the closing write, and gets `before.effectiveTo === null`
beside `after.effectiveTo === <the backdate>`. So *what did we believe about
March* is answerable, and answering it means scanning an append-only log and
decoding two JSON strings against a stringified array of ids. **A record, not a
dimension** — no read of `PayWindow` can be asked to stand at a past moment of
KNOWLEDGE the way `coveringAt` stands at a past moment of validity.

That also answers the open question phase 2 raised. **An `asAt(date)` client
flavor would be a real convenience and would not have helped here**: it moves
the valid-time instant, which `coveringAt` already does, and the correction case
needs the OTHER axis — which is not in the table for any read to stand at.

**Three limits, each honest and each pinned by an assertion rather than a
paragraph:**

- **A correction bigger than the period it lands on has nowhere to go.**
  `Payslip.gross` is `@gte(0)`, so an adjustment can only be as large as the
  period carrying it. `arrearsFor` computes the number fine and the WRITE is
  refused by the boundary naming the column. A real payroll spreads a large
  recovery over several periods and nothing here can say *this much of it, this
  month*.
- **A change part way through a period moves the whole period**, because the
  as-at read stands at one instant — the period end. Not prorated, and nothing
  says so.
- **Only a PAID run is corrected.** A run that is merely `calculated` holds
  stale figures and the answer is to revert and recalculate it. That rule is in
  prose in `arrears.ts` and in nothing else.

**An append-only ledger means a drive cannot tidy up after itself**, which
nothing had run into before because `verify:money`'s fixtures are orders it can
soft-delete. `JournalEntry` and `JournalLine` are `@@gate("5.8.9.9")` and `9` is
LOCKED, so `asSystem()` — which grades 8 — is refused by name, and with the
journals in place the pay runs, the pay windows and the employees underneath
them are all held by foreign keys. Leaving them is not an option either: an
employee this drive backdated goes on producing arrears for ever, and
`verify:payrun` sweeps every employee there is. The way out is the documented
one and it is deliberately blunt — `asSystem().sql`, which enforces no gate and
no policy — and this is the only place in the repository where a drive has to
reach for it. Two costs worth stating: raw SQL binds to TABLE names rather than
model names, which is what `db/ddl.snapshot.sql` is committed for, and a
cleanup that goes under the boundary is a cleanup nothing grades.

**One thing I got wrong and the drive caught.** `payPayRun` aggregated each
component with `Math.abs`, and I wrote a comment claiming a backdated pay cut
would break it. It does not, and the reason is worth more than the fix was: for
a run's total income tax to come out positive the refund must exceed the
period's own tax, which needs a gross reduction larger than the period's own
gross, which `@gte(0)` refuses one step earlier. **The magnitude was correct by
a constraint three tables away rather than by anything the function said.** The
signed sum ships because it is correct by construction; the comment now says
which of the two it is.

---

## Phase 7 — the surfaces

The staff console in `web/`, and **nothing public** — which is worth stating rather
than assuming, because payroll is the first thing in `example` with exactly one
audience. Every other feature here has at least two: a shop and a shopper, staff and
a customer, the console and the storefront. That asymmetry is itself a test of
whether the framework's affordances assume a second audience anywhere.

The employee's own payslip is the arguable second audience and it is **out of scope
for this phase**, because it is a whole authentication story — an employee is not a
`Customer` and not staff — and it would double the phase for one screen.

Budgeted here rather than discovered: the login limiter is 10 sign-ins per 15
minutes across every browser drive, so the payroll drives follow `verify:site`'s
example and stay off it where they can.

### It landed

Four routes (`/people/`, `/people/:id/`, `/payroll/`, `/payroll/:id/`), six
resource files, one nav link, and `verify:payroll` — 60 assertions in a real
browser, green twice. Nothing public, as scoped.

**The one-audience question got an answer, and it is not the one the phase
predicted.** The expectation was that `approve: … @gate(5)` would be the single
place a level-4 caller is told apart from a level-5 one, and that everywhere
else the affordance layer would degrade to a constant. Measured, it is sharper
than that: **`PayRun` READS at 5, so a level below sees no run, no nav link and
no screen at all** — the ladder gates the whole SURFACE one step earlier, and
the transition's gate is the same number as the model's update gate and narrows
nothing. **A per-transition gate is only visible ABOVE the model's own update
gate**, and this application's ladder tops out at 5 for a person, so there is
nowhere above to put one. That is the honest shape of a domain with one
audience, and it is asserted as three separate facts because from a screen they
are indistinguishable.

**A framework defect fell out and it is not about payroll: `FJS-612`.**
`{...$attributes}` on a Mesa component is applied once at mount and never
updated, so every dynamic attribute a caller forwards to a kit component is
frozen at its first value. Measured minimally: one `<Pill data-rate={…}>` asked
three times about three dates answers the FIRST rate all three times while its
own children render the right figure each time. It cost half a day of the phase
because it makes a browser drive lie — an assertion on `[data-status="x"]` reads
stale markup and passes or fails for reasons unrelated to what changed — and the
first sighting was worse than the minimal one: a fresh `draft` run rendered into
the node a `paid` one had used carried `data-status="paid"` beside the text
`calculated`. What it costs beyond a drive is `aria-expanded`, `aria-selected`
and `aria-current`, which announce the first state for ever. Pinned by
`verify:payroll` rather than described — **and that is what closed it**: the
pinned assertion was the only failure on the first run after the fix. See the
fallout list below.

**A second, smaller one was the drive's own fixture failing to exist**: a first
pay window could not start in the past, because `assertEffectiveFrom` refused a
backdate with nothing open. With no window there is nothing to close and no
history to cross, and the refusal meant a person's pay could only ever begin at
the instant somebody typed it — so the first run for anybody hired last month
was wrong. Now allowed, with the case it was guarding against stated separately:
opening INSIDE a closed history, which would put two windows over one instant.
`verify:retro` grades both.

**Three things the screens made visible that no bun drive can.** A salary typed
in dollars into a `@money` column that holds cents, and nothing on the page
knows the difference — the control does, off `x-money`. A date box that turns
the same write from a raise into a correction, which is the phase 6 finding as a
form rather than a paragraph. And an adjustment line badged with the run it puts
right, which is the only provenance the schema can carry.

**And one about the servers.** The drive starts and stops its own pair, and the
reason is this domain's own: a payroll service registered after a dev server
booted is not an error that names itself, it is `Service 'employees' not found`
— a 404 indistinguishable from a screen asking for a row that does not exist. An
API left up from before these services landed answers every payroll screen that
way, and the drive reports *the roster does not render*, which is true and is
about the wrong thing entirely. `/health` is not a sufficient probe for that;
`/manifest` is.

---

## Phase 8 — the drives

Three minimum, as `proving-grounds.md` says: **an as-at read, a pay run, a retro
correction.** Prefer bun drives with no browser — phases 2, 3, 5 and 6 are all
answerable at the Data boundary, and a drive that does not sign in does not make the
existing suite flakier.

Every assertion is a **delta**, for `verify:shop`'s stock reason: `db:seed` restores
the rows it owns and a payroll drive that asserts an absolute figure passes once.
Every fixture is minted per run under a run prefix, for `FJS-530` and `FJS-546`'s
reason, and cleaned up in a `finally` — billing's three bun drives each had to grow
one of those after the fact.

### It landed

Five drives, and four of them existed before this phase started: `verify:employment`
(58), `verify:payrun` (41), `verify:batch` (33), `verify:retro` (56) and
`verify:payroll` (62). So the phase's work was not writing them — it was **grading
them against its own rules**, and they failed one.

**Only one of five cleaned up in a `finally`, and the cost was measurable.** The
shop held **38 leftover pay runs**, all but two of them paid, with the payslips and
journals under them. Two drives had read the ledger's refusal as *the journal stays,
as a real one would* and left the RUN behind with it — a reasonable reading that
`verify:retro` had already disproved, since `asSystem().sql` is the hatch. It is not
tidiness: a paid run keeps a payslip for a SEEDED employee, and the correction is a
function of every paid period rather than of what changed, so the next drive that
backdates one of them computes arrears against runs nobody remembers making. A stale
run at the top of the console's list is also how `FJS-612` was first seen.

**So the sweep got one owner** — `web/test/payroll-sweep.mjs`, five callers — and the
reason it needs one is the ORDER: four foreign keys point into a pay run, two of them
`Restrict`, and `PayslipLine.correctsPayRunId` holds a run even after the payslip
carrying that line is gone from a different one. **The proof is a measurement**: the
whole suite run twice leaves the database byte-identical — 0 runs, 0 payslips, 0
lines, 3 employees, 5 windows, 4 sale journals, before and after.

**Two things the restructure found, both about scope rather than payroll.** A
`finally` is a scope of its own and cannot see a `const` declared inside its `try`,
so `typeof open` there answers `'undefined'` and a restore is skipped in silence —
which is how one seeded employee ended up permanently on four times her salary across
three runs. And **restoring what a drive CHANGED is the drive's own job**; the shared
sweep removes what it MADE. `verify:payrun` is the only payroll drive that touches a
row it did not create, and it says so.

**The two drives the fallout list had blocked since phase 1 both ran, and one was
wrong.** `verify:collect` is 28/28. `verify:money` is 107/107 — after a correction:
its two ledger assertions expected **403** from the gate and got **405** from the
service surface, because `journalEntries` declares `methods: ['find', 'get']` and a
method that is never mounted is refused before the gate is consulted. Both refusals
are real and they are at different layers; asserting the wrong one named a rule that
had never run, which is `FJS-351`'s shape inside a drive that had itself never run.
The surface half stays in `verify:money`; the Data-boundary half — `asSystem()`
refused BY NAME on a `9` — moved to `verify:payroll`, which has a client to ask with.

---

## Fallout — carried, to be cleared after the phases

Kept here rather than in scrollback because every one of these was found while
doing something else, and a finding nobody wrote down is a finding somebody pays
for twice. Ordered by how much it would cost to leave.

**~~Blocked, not broken~~ — CLEARED in phase 8.** Both ran. `verify:collect` is
28/28 first time. `verify:money` is 107/107 **after a correction it could only
have found by running**: its two ledger assertions expected a 403 from the gate
and got a 405 from the service surface, because `journalEntries` declares
`methods: ['find', 'get']` and a method that is never mounted is refused before
the gate is consulted. A claim written and not executed was, as this register
suspected, worth executing.

**Open defects the phases have touched**

- ~~**`FJS-603`**~~ — **closed 2026-08-31.** `@@unique([cols], where: <expr>)`.
  All three instances — `PlanVersion`, `PayWindow`, `PayRate` — now declare the
  constraint they wanted, and it is held by the table rather than by a service:
  `asSystem()` is refused and so is a raw INSERT. The pinned assertion did its
  job — `gap.twoOpenWindowsAreAcceptedByTheSchema` went red on the first run and
  is now eight `constraint.*` assertions of the opposite. `payAsAtMany`'s own
  overlap defense is unreachable through any client now, which is the correct
  outcome and is why it is no longer asserted.
- **`FJS-610`** — a soft-declined invoice is never re-presented, so the
  distinction `declineKind` draws buys nothing. Billing's one substantive
  functional gap.
- **`FJS-607`** — a `slot=` child wrapped in `{#if}` turns `<Form>` generation
  off. Phase 7 wrote six resource files and avoided it by writing both buttons
  unconditionally, with the reason in each file. **No longer silent as of
  2026-08-30**: the form warns when it generated nothing and holds no control
  over a resource that had fields to offer. The behavior is open — whether a
  block whose every branch is slotted counts as default content is a Mesa
  question about `$slots` — and the workaround is unchanged.
- ~~**`FJS-612`**~~ — **closed 2026-08-30.** `$attributes` was a copy taken
  once at component init, so a forwarded dynamic attribute was frozen at its
  first value; it is a live view over a signal now, and the undeclared half of
  a prop push — which had nowhere to arrive and was silently dropped — reaches
  a sink the child registers. The negative control was the pinned assertion:
  `gap.aForwardedAttributeIsFrozenAtItsFirstValue` was the ONLY failure on the
  first run after the fix, which is what writing it as an executed assertion
  bought. It is now three `forward.*` assertions of the opposite, and mesa has
  a `forward-attributes` spec of its own.
- **`FJS-611`** — filed in phase 5 by measurement, **closed 2026-08-31, and the
  diagnosis above is wrong.** `transition()` is not read-then-write: the UPDATE
  has always carried `AND status = <from>`, so four concurrent movers give one
  winner. What was missing is that `transition(id, name)` and an update carrying
  the column arrived as one question — carrying the value a row already holds is
  a legitimate no-op on an update and means the opposite under a named move — and
  the early return that answered the first to both skipped the gate, the
  capability and `@system` as well. **The mitigation named here made it worse**:
  `$transaction` serialises the callers, so each re-reads after the winner
  committed, which is precisely the state that return called a no-op — four
  transactions, four successes. What actually held `completeIfDone` is its own
  `status !== 'draft'` READ, and it had to, because these run on `asSystem()`,
  which bypasses `@@transitions` entirely. Payroll was safe; not for the reason
  written here.

**Limits phase 6 left standing, deliberately**

Each is asserted in `verify:retro` rather than described, so it turns a drive
red the day somebody fixes it. None is a framework defect — all three are this
application's own schema being honest about what it cannot say.

- **A correction bigger than the period carrying it is refused**, because
  `Payslip.gross` is `@gte(0)`. Spreading a recovery over several periods is a
  feature nothing here has.
- **A change part way through a period moves the whole period.** The as-at read
  stands at one instant, the period end; there is no proration.
- **Only a PAID run is corrected.** A merely `calculated` one holds stale
  figures and is reverted and recalculated, which is a rule in prose and in
  nothing else.

**Rulings still owed**

- **`FJS-D162` left four sub-questions open** — what spells *check at this
  transition*, whether `@immutable` refuses a DELETE and how it reads against
  `@@softDelete`, which error class a refusal carries, and whether a child
  cascade is a parent read or a condition on the child's own write.
- ~~**The `example/` decision itself.**~~ **Recorded in phase 8 as `FJS-D166`.**
  Nine phases overdue, and writing it up was worth the delay: the estimates in
  the original argument could be graded. The schema landed where predicted
  (23 → 31 models); the DRIVES did not — *at least three of its own* became five
  and 250 assertions — and the shared database grew a hazard nobody anticipated,
  which is what `payroll-sweep.mjs` exists for.

**Carried lessons, already fixed but easy to repeat**

- **A seed whose idempotency key is a computed timestamp is not idempotent.**
  Phase 3's payroll seed matched on `effectiveFrom: ago(900)` and appended a
  fresh history every run. Rebuild against a count, or key on something the
  fixture states rather than something the clock does. This is the mirror of
  `FJS-530`'s fixed-key trap and it fails in the opposite direction — that one
  passes once, this one passes once and then poisons every later run.

**Housekeeping**

- **`gaps.json` holds `hrms` only.** Naming one target rewrites the file as if
  the other seven did not exist. `bun test/fixtures/corpus/fetch.mjs` with no
  argument restores the full set — worth doing before anybody reads a total off
  it.
- **The corpus licensing question is unresolved rather than applied.** Six
  copyleft-derived fixtures are committed under a paragraph that used to say
  only one was. The README now describes the directory instead of contradicting
  it, and somebody should either take that decision or move six files.
- **16 pre-existing typecheck errors in `example`**, none of them payroll's:
  `core/db.ts` tenancy typing, `gate.ts`'s `Gradable`, `announce-payment.job.ts`,
  `carts.service.ts`. Every phase has left the number where it found it.

---

## Out of scope, stated so it is not rediscovered

Each of these is a real part of payroll and none of them carries a wall.

- **Statutory filing** — RTI/FPS, P60, W-2, year-end. A file format and a deadline,
  which is a vendor integration billing already proved through conduit.
- **Multi-country payroll.** One jurisdiction's rules, and the rules live in
  `PayRate` rows rather than in code, which is the transferable part.
- **Timesheets and attendance.** `example` would need a clock-in domain to feed an
  hourly rate; the drives supply hours directly.
- **Leave and absence accrual**, **expenses and reimbursement**, **benefits
  administration.** Three domains, no new wall.
- **Salary structures with formula strings.** Frappe evaluates a Python expression
  per component. That is schema-as-data, which `proving-grounds.md` § Considered
  declined on the grounds that its likely conclusion is a refusal.
- **Double-entry beyond the two journals named.** No trial balance, no period close,
  no reconciliation. The invariant is the point; the accounting is not.
- **Payment execution** — a BACS or ACH file, or a payment API. `conduit` could, and
  `verify:pay` already proves that boundary in both directions.
- **The employee's own login.** Phase 7 says why.

---

## The rulings this will force, in the order it forces them

Each gets filed **once the code exists**, never ahead of it — `FJS-560` is what
happens when a question is answered in the abstract, and billing's own record shows
each ruling was stronger for naming the alternative the code had already rejected.

1. **What SPELLS a cross-row invariant.** `FJS-D162` ruled where it is checked and
   left this open; phase 1 and phase 4 each need it, and `billing.ts` is already one
   application-code copy. An argument on `@@check`, an argument on `@@transitions`,
   or a third attribute. **Phase 0 added a requirement**: real payslip lines carry
   `doNotIncludeInTotal`, so the spelling must admit a predicate over the child
   rather than only an aggregate over it.
2. **Whether the language should know about validity windows.** *(Partly answered
   by the row below: the constraint half is declarable now.)* `FJS-D164` left it
   explicitly as candidate A's question. Phase 2, after the hand-written as-at read
   is ugly enough to specify from. **Phase 0 found three spellings in the wild**,
   not one: a nullable `effectiveTo` pair (`example`), successor-implied with no
   end column at all (Frappe), and a closed interval. The third makes `FJS-603`
   moot rather than harder — there is no open column to be unique over.
3. ~~**`FJS-603` — a partial unique.**~~ **Ruled and built 2026-08-31:
   `@@unique([cols], where: <expr>)`**, argued in `IDEAS/partial-unique.md`. Not
   `@@index(unique: true)`, for four reasons that compound — the sharpest being
   that the fix has to be reachable from the refusal that sends people wrong, and
   nobody reads a `@@unique` refusal and then goes to read about `@@index`.
4. **What declares *derived from*.** **Phase 6 built it and it is a nullable
   foreign key** (`PayslipLine.correctsPayRunId`), which is the same answer
   Frappe reaches with `amendedFrom` on 54 doctypes. What a link does not carry
   was measured rather than argued: nothing recomputes when the source moves,
   nothing marks the derived row stale, and *has this already been put right* is
   a hand-written query whose absence pays somebody twice. A stale payslip is
   byte-identical to a current one, so the only sound cascade is to recompute
   everything and compare — which is what the correction does.
5. **Whether an as-at read is a client flavor or a directive** — `asAt(date)`
   beside `asSystem()`, or `$asAt` on the call. Phase 2 raised it and **phase 6
   answered it: still worth having, and it would not have helped here.** Both
   halves of a correction are ordinary reads at different VALID instants against
   one belief, which `coveringAt` already expresses; what the correction needs
   is the other axis — when we learnt something — and that is in no table for a
   flavor or a directive to stand at. It survives in this application only as
   `@@log(audit)`, a record rather than a dimension.

**Also owed at the first model:** `proving-grounds.md` § *Where A lives* took the
decision on 2026-08-29 that payroll folds into `example/` rather than a fourth app,
and says to record it in `DECISIONS.md` when the first model lands. It is a ruling
with an argument — the shared ledger — and phase 1 is the argument being made.
