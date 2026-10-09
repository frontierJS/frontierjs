---
id: ledger
status: proposed
dated: 2026-09-23
---

# Idea — the balance: a number that is the sum of what happened to it

**Status: IDEA, nothing built.** Dated 2026-09-23. Every model and line cited
below is read off `example/db/schema.lite` and `example/api/src/` on that date,
and every number under § *Measured* came from a scratch script against
`bun:sqlite`, not from litestone. Do not cite this file as describing behavior
— see `VERIFYING.md`.

It is the lens `ontology.md` left on the table. That paper took one noun from
REA — **Commitment**, a thing the system owes later — and REA's other half is
older and more used: **a Resource is changed only by an Event, and its level is
the sum of the events.** Stock on a shelf, money in an account, redemptions of a
code, hours in a leave balance. Litestone can say *this number is a sum of those
rows* (`@from`) and can say *this number may not go below zero* (`@gte`), and it
cannot say both about one column. That is the gap, and `example` has already
paid for it twice.

---

## 1. The name is old

| Tradition | The word | Worth reading for |
| --- | --- | --- |
| Pacioli, 1494 | the **journal** and the **ledger** | Two books for one fact: the journal is the order things happened in, the ledger is the balance per account. Every design below is one of those two |
| REA (McCarthy 1982) | **Resource** changed by an **Event**; the *duality* | A balance is never primary. It is a query over events that somebody decided to keep warm |
| Fowler, *Analysis Patterns* ch. 6 | **Account** · **Entry** · **Transaction** (balanced) | The same split this paper makes: an account's balance, and a transaction whose entries must net to zero, are two different rules |
| Event sourcing | **projection** | The balance as a fold over the log. Right about origin, and silent about the part this paper cares about — refusing the event that would make the fold go negative |
| TigerBeetle | `debits_posted` / `credits_posted` and the flag **`debits_must_not_exceed_credits`** | **The one to actually read.** A balance kept at write, and the floor as a flag on the ACCOUNT, checked in the same step as the transfer. It is `@gte(0)` on a balance, shipped as a database |
| Modern Treasury, Stripe balance transactions | **ledger entry**, **balance transaction**, a lock version on the account | The same shape as an API. The version on the account is the concurrency half |

`reference-library.md` § *Double-entry money* already says the corpus holds no
double-entry model to learn from. This paper is about the rule, not the chart
of accounts, and the chart of accounts is § 6's refusal.

---

## 2. What `example` already does by hand

**Two ledgers, one shape, both enforced in application code.** The schema says
so itself, twice.

**The stock tape.** `ProductVariant.stock` is the running total and
`InventoryMovement` is the tape behind it: signed `quantity`, `stockBefore`,
`stockAfter`, `@@gate("5.5.9.9")` so nothing edits a movement, `Restrict` so
nothing deletes one by deleting the shelf. The promise that holds the two
together is a comment on the model — *nothing writes that column without writing
a row here in the same breath* — and the thing that keeps it is
`api/src/domain/shop/inventory.ts` `move()`, five steps long:

1. read the variant,
2. compute `after = stock + delta` and refuse below zero in the shop's words,
3. insert the movement with both ends stamped,
4. update `stock` carrying `version`, so a race is a refusal and not a lost
   movement,
5. hand the movement to `$.dispatch`, because the parent's change is otherwise
   announced to nobody.

Every one of those steps is correct and none of them is the Data boundary's.
`asSystem().productVariant.update({ data: { stock: 99 } })`, a seed, a
migration and `fli tinker` each move the shelf with no row saying why, and the
tape and the total stop being reconcilable without anything failing.

**The journal.** `JournalEntry` and `JournalLine`: signed `amount`, every column
`@immutable`, `@@gate("5.8.9.9")`, and the rule *the lines of one entry sum to
zero* enforced in `api/src/domain/ledger.ts` `postJournal`. The schema's comment
on `JournalEntry` calls it **the wall** and names the ruling it is waiting on.

**Two counters with no tape.** Both are balances whose entries were never
declared, and each shows a different half of the gap:

- **`Discount.redemptions`** — `@system`, incremented by read-modify-write inside
  `carts.checkout`'s transaction, and **not** by `{ increment: 1 }`, because an
  atomic operator computes the value inside SQLite where the validator cannot
  see it and `maxRedemptions` would be passed (`FJS-D27`, `FJS-D54`). The limit
  is therefore held by the checkout's `BEGIN IMMEDIATE` and nothing else. The
  entry exists — it is the order — but `Order` carries `discountCode` as a copy
  with no foreign key, so there is no tape to sum.
- **`Payment.refundedAmount`** — the provider's running total, copied from the
  webhook. **This one is correctly NOT a balance here**: the provider owns the
  number and `PaymentEvent` is the provider's tape, not the shop's. It is in the
  list so the proposal has a case it must refuse to claim.

**And the neighbor that cannot refuse.** `Product.onHand` is
`@from(ProductVariant, sum: stock)`: a live sum, derived on every read, stored
nowhere. It is exactly right for a number nobody writes against. It cannot be
`stock`, because `stock` has to refuse an oversell and a read-time aggregate
refuses nothing.

---

## 3. Two rules, and why one escapes `FJS-D168` and the other does not

The two ledgers look like one feature and they are two rules with different
moments.

**A balance is INCREMENTAL.** `stock' = stock + quantity` is true after every
single insert, so there is no statement at which the invariant is legitimately
false. It can be checked on each row as it lands, which is what a trigger is.

**A balanced entry is a LAST-WRITE rule.** *The lines sum to zero* is false
after line one of four and true after line four, and nothing in SQL knows which
insert is the last. That is `FJS-D168`'s whole argument, and it stands: the
three document invariants (`Invoice`, `JournalEntry`, `Payslip`) stay in the
three functions that are each their document's only writer, and a declaration
that passed or failed depending on whether the caller batched *is not a
constraint*.

**So the proposal is the balance, and the balanced entry is § 7's open
question.** D168's reopen condition — *a fourth demand whose document has a
declarable moment, or a second writer* — is not met by anything here, and this
paper does not pretend otherwise.

---

## 4. What it would look like in `.lite`

The spelling mirrors `@from` on purpose. `@from(Model, sum: field)` is derived
at READ and refuses nothing; `@balance(Model, sum: field)` is kept at WRITE, so
it can carry a constraint. Knowing one tells you the other's arguments.

```lite
model ProductVariant {
  id        Int     @id
  sku       String  @length(1, 40)
  price     Int     @money(USD) @gte(0)

  /// ON HAND. The sum of every movement, kept by the engine in the statement
  /// that posts one. `@gte(0)` is what refuses an oversell — the movement that
  /// would take it negative rolls back with it.
  stock     Int     @balance(InventoryMovement, sum: quantity) @gte(0)

  movements InventoryMovement[]
}

model InventoryMovement {
  id          Int                @id
  variantId   Int
  variant     ProductVariant     @relation(fields: [variantId], references: [id], onDelete: Restrict)
  kind        StockMovementKind

  /// Signed: +12 received, −2 sold.
  quantity    Int

  // stockBefore / stockAfter are gone — the engine guarantees the sum, so
  // they would be a second origin (Q3 weighs stamping them anyway).

  reference   String?            @length(1, 40)
  createdAt   DateTime           @default(now())

  @@sync(append)
}
```

**What the second model no longer says** is the point. `@@gate("5.5.9.9")`'s
two 9s — *never edited, never deleted* — are **derived**: a model that is the
source of a `@balance` is append-only, because an edited entry is a balance that
silently stops being the sum. The gate keeps its read and create digits, which
are still a decision about WHO; the 9s were a statement about WHAT the table is,
and that now has one origin.

**What `move()` becomes:**

```ts
await client.inventoryMovement.create({ data: {
  variantId, kind, quantity: delta, reference: meta.reference ?? null,
} })
// An oversell is refused by the Data boundary, naming the variant and the
// balance, and nothing was written.
```

Steps 1, 2 and 4 go, and step 3 is the whole of the write. Step 5 — announcing the parent —
is § 7's Q4.

**The redemption limit, which `FJS-D27` said could not be declared:**

```lite
model Discount {
  id             Int           @id
  maxRedemptions Int?          @gte(1)
  redemptions    Int           @balance(Redemption, count: true)
  redeemed       Redemption[]

  @@check("maxRedemptions IS NULL OR redemptions <= maxRedemptions",
          "this code has been used up")
}

/// One use of a code by one order. The tape `redemptions` never had.
model Redemption {
  discountId Int
  discount   Discount @relation(fields: [discountId], references: [id], onDelete: Restrict)
  orderId    Int
  order      Order    @relation(fields: [orderId], references: [id], onDelete: Restrict)

  @@relator([discountId, orderId], once)
}
```

The `@@check` on the PARENT is an ordinary table CHECK, so it fires when the
engine's own update moves `redemptions` — the validator never had to see an
atomic operator, because the constraint is in SQLite. Checkout creates a
`Redemption` inside its transaction and reads nothing first.

---

## 5. What the engine emits, and what it cost

**Emitted as triggers, beside the CHECK the column already gets.** Litestone
already writes triggers for `@@fts` (`src/core/ddl.js`), dropped and recreated on
every apply for the reason that file states. A trigger is the one mechanism that
holds against every writer — a migration, a seed, `asSystem()`, raw SQL — which
is the reason `FJS-D168` gave for preferring a table constraint over an `if`.

```sql
CREATE TRIGGER "inventory_movement_balance_stock" AFTER INSERT ON "inventory_movement" BEGIN
  UPDATE "product_variant" SET "stock" = "stock" + NEW."quantity" WHERE "id" = NEW."variantId";
  UPDATE "inventory_movement" SET "_posted" = 1 WHERE "id" = NEW."id";
END;
CREATE TRIGGER "inventory_movement_no_update" BEFORE UPDATE OF "variantId", "quantity" ON "inventory_movement"
  BEGIN SELECT RAISE(ABORT, 'a movement is never edited'); END;
CREATE TRIGGER "inventory_movement_no_delete" BEFORE DELETE ON "inventory_movement"
  BEGIN SELECT RAISE(ABORT, 'a movement is never deleted'); END;
CREATE TRIGGER "product_variant_stock_is_a_balance" BEFORE UPDATE OF "stock" ON "product_variant"
  WHEN NOT EXISTS (SELECT 1 FROM "inventory_movement"
                   WHERE "variantId" = NEW."id" AND "_posted" = 0 AND NEW."stock" = OLD."stock" + "quantity")
  BEGIN SELECT RAISE(ABORT, 'stock is a balance: post a movement'); END;
```

### Measured

Scratch scripts against `bun:sqlite`, in-memory, one transaction per batch.

| Case | Result |
| --- | --- |
| +12 then −2 | `stock` 10, `stockBefore`/`stockAfter` 0→12, 12→10, and `stock = Σ quantity` holds |
| −11 against 10 on hand | refused by `CHECK (stock >= 0)`, **and the movement rolled back with it** — two rows, not three |
| editing or deleting a movement | refused by the triggers |
| `UPDATE stock = 99` directly | refused |
| `UPDATE stock = 24`, a replay of the last +12 | refused — the `_posted` mark is what tells the engine's own update from a caller's |
| guard by re-summing the tape | **774 µs per post at 20k rows, and linear** — the wrong design |
| guard by the unposted row | **19 µs per post at 20k, 22 µs at 100k** — flat. 7 µs with no guard at all |

**The first guard is in the table because it is the obvious one and it is
wrong.** *Does the new balance equal the sum?* is the literal invariant and
costs a scan of the shelf's whole history on every sale. The second asks
something narrower and sufficient: *is there an entry in flight whose quantity
explains this change?* It costs a hidden `_posted` column and a partial index,
which is § 7's Q2.

---

## 6. What it does not do

**No chart of accounts, no periods, no currencies across entries.** Those are
an accounting product, and *Batteries vs. smallness* (`PHILOSOPHY.md` § IV)
decides it: the balance is a fact about two tables and belongs in the Data
boundary, while a general ledger is a battery that would grow tendrils into it.
`example`'s `LedgerAccount` enum stays the app's.

**No balance over an external number.** `Payment.refundedAmount` is the
provider's total and stays a copied column. A `@balance` whose entries are not
the only thing that moves it is a lie with a trigger attached.

**No balance per account ON the entry table.** `JournalLine` has no parent row
per account, so *the balance of `receivables`* is a `groupBy` today and stays
one. Declaring an `Account` model to hang a `@balance` on is the chart of
accounts again.

---

## 7. The nine, answered before the first edit

1. **Origin** — the tape is the one origin and the column becomes a cache the
   engine owns. Today there are two: the tape, and `move()` plus a comment. Passes.
2. **Concept** — one attribute word, `@balance`, beside `@from` with the same
   argument shape. The entry needs no word: *append-only* is derived from being a
   source. `@before`/`@after` are two more words and are Q3 for that reason.
3. **Complexity** — `move()` loses four of five steps and `Discount` loses the
   ordering argument its comment makes. The engine gains triggers, a shape it
   already emits. The hidden column is complexity the design adds, and is named.
4. **Predictability** — `@from` derives on read and refuses nothing; `@balance`
   keeps on write and can refuse. Same arguments, and the difference is exactly
   the one a developer needs to choose between them.
5. **Derived** — the entry's append-only-ness, the column's `readOnly` in every
   JSON Schema mode, and its place in `access.snapshot.md` are all derived from
   the one declaration.
6. **Owner** — `ddl.js` and the migrator, beside the `@@fts` triggers. The
   refusal messages go through the client's existing CHECK translation, not a
   second one. `inventory.ts` shrinks; it does not keep a copy.
7. **Boundary** — a caller posts an entry and reads the balance back. It does
   not need to know a trigger exists, and a raw-SQL caller is held to the same
   rule.
8. **Failure** — an oversell, a direct write to the balance, and an edit to an
   entry are all refusals: each one otherwise destroys the reconciliation with
   nothing said. An ill-formed declaration is a parse error (a source with
   `@@softDelete`, a relation that is `SetNull`, a summed field that is not an
   `Int`, entries in another `database` block).
9. **Silence** — must stay true: *the balance equals the sum of its entries, for
   every parent, after every statement.* What fails when it stops: a litestone
   test that posts a random sequence through every writer — the client,
   `asSystem()`, `createMany`, raw SQL — and compares the column against
   `SUM()` after each. **Today: none**, because it is not built.

**Adjudication in tension:** *Batteries vs. smallness*, § 6 — the balance is in
and the ledger product is out. No other row is in tension.

**Tier:** Assessment. A ruling, when made, goes to `DECISIONS.md`; the
behavior, when built, to `packages/litestone/docs/schema.md`.

---

## Open questions

- **Q1 — Is a balance a column trait the engine keeps at write, or does `@from` stay the only aggregate?**
  `@from` is correct for every number nobody writes against. The two ledgers in
  `example` both need a refusal at the moment an entry lands, which a read-time
  aggregate cannot make.
  - **A** — `@balance(Model, sum: field | count: true)`: stored, kept by
    triggers, refused below any constraint the column declares, and the source
    derived append-only.
  - **B** — no new word. Document the `move()` shape as the pattern and add a
    `litestone advise` rule that finds a column written beside an append-only
    child and suggests the reconciliation.
  - **C** — `@from(…, stored: true)`: the same machinery as A behind an option on
    the existing word.
  - **Recommend A** — B leaves the promise in a comment, where `asSystem()`, a
    seed and `fli tinker` already break it without a sound. C puts two different
    answers to *can this refuse* behind one word, so reading `@from` would no
    longer tell a developer whether a write can fail.
  - **Evidence, 2026-10-09 — the Lago stressor, a second domain (prepaid credit).**
    `fjs-prototypes/lago` § Q2 graded a hand-kept `Account.balance` under
    `@@check("kind <> 'prepaid' OR balance <= 0")` against Σ `Posting.amount`
    read at the spend, two $7 spends of $10, in one process and in two
    (`api/test/journal.test.ts`). The kept column refused the second spend in
    every arrangement, `asSystem()` included. The sum refused it only when read
    inside the spending transaction (`$transaction`'s FIFO lock and `BEGIN
    IMMEDIATE` serialize it, across processes too); read before the transaction,
    both guards passed and only the column's CHECK stopped $14 leaving $10. The
    sum costs 230 µs at 1k postings, 3.3 ms at 10k and 37 ms at 100k on one
    account, inside the write lock, against 15–35 µs for the column. And a direct
    write moved the column with no posting, the drift A's triggers would close.
    Two things A's spelling must answer that inventory did not ask. **The floor
    is per row, not per column:** a receivable goes either way and a prepaid
    account may not, so `@balance(Posting, sum: amount) @gte(0)` on `Account`
    floors every kind; Lago's own wallet validates `balance_cents >= 0` only
    `if: :traceable?`. **The sign:** debit-positive postings put credit-normal
    accounts (prepaid, payable, revenue) below zero, so the floor is `<= 0` or a
    negation. TigerBeetle ships two flags, `debits_must_not_exceed_credits` and
    `credits_must_not_exceed_debits`, for this reason. Lago itself keeps
    `wallets.balance_cents` at write under a per-customer advisory lock and
    `lock_version` (`credits/applied_prepaid_credits_service.rb:23-42`), which is
    spelling (a) plus a lock.

- **Q2 — How is a direct write to the balance refused?**
  The literal guard (re-sum the tape) is linear and measured at 774 µs a post at
  20k rows. The narrow guard is flat at about 20 µs and needs a hidden column.
  - **A** — the narrow guard: an engine-owned `_posted` column on the source and
    a partial index over the unposted rows. It holds against every writer.
  - **B** — refuse at the client only (every flavor, `asSystem()` included) and
    let raw SQL through, with a `litestone verify`-style reconcile that reports
    drift.
  - **C** — no guard. `@system` on the column, as `redemptions` has today.
  - **Recommend A** — B is a guarantee with one door left open, which is
    `FJS-D168`'s own reason for preferring a table constraint to an `if`. C is
    today's state. A's cost is a column nobody declared, and that column must be
    invisible to every generated schema, which is testable.

- ~~**Q3 — Does the entry get its before and after stamped by the engine?**~~ **Answered 2026-09-29 (`FJS-D542`): B — no stamping. The balance is the parent's, and a row's before and after are a window function over the tape when somebody asks.**
  `InventoryMovement` carries `stockBefore`/`stockAfter` so a single row can be
  checked on its own and a gap between two rows is visible.
  - **A** — `@before(relation.field)` / `@after(relation.field)`, filled in the
    posting trigger.
  - **B** — no stamping. The balance is the parent's, and a row's before and
    after are a window function over the tape when somebody asks.
  - **Recommend B** — for now: once the engine guarantees the sum, the stamps are
    a second origin for a number the tape already answers. Revisit if an app
    needs to find a gap in a tape it did not write.

- **Q4 — A post changes the parent row. Is that announced, and does it move the parent's `@version`?**
  A trigger's update reaches no hook, so the live layer hears about the movement
  and not about the shelf, which is `FJS-1308`'s shape arriving through a new
  door.
  - **A** — announce the parent as updated in the same event, and leave
    `@version` alone: the balance is not a field a person edits, so a stale form
    must not be refused for it.
  - **B** — announce it and bump the version.
  - **Recommend A** — B makes every sale a conflict for the person editing that
    variant's price, which is the problem `@@sync(field)` on `ProductVariant`
    exists to avoid today. Under A that `@@sync(field)` may become unnecessary,
    since the only other writer of the row is gone.

- ~~**Q5 — Does a balanced ENTRY (the journal) get a spelling?**~~ **Answered 2026-09-29 (`FJS-D543`): A — no. `postJournal` stays the one writer, as ruled.**
  `FJS-D168` ruled that a sum over children is checked in application code,
  because its moment is the last child insert. Nothing in this paper meets its
  reopen condition.
  - **A** — no. `postJournal` stays the one writer, as ruled.
  - **B** — a balanced entry's lines may only be written by a nested create of
    the entry, and the check runs when that one call completes. It is a
    declarable moment with no status column.
  - **Recommend A** — B holds only against callers that use the client. A
    migration, a seed or raw SQL can still write a line on its own, which is the
    objection D168 already answered. Reopen if a second writer of a journal
    appears.

---

## See also

- `IDEAS/ontology.md` — the tree this is a leaf of. *A measurement, a quantity,
  money* covers the unit of a column; this covers the row that changes it
- `IDEAS/reference-library.md` § *Double-entry money* and § *Inventory as a
  ledger* — what the corpus lacks
- `DECISIONS.md` `FJS-D162`, `FJS-D167`, `FJS-D168` — what a document is, when
  it seals, and why its sum stays in code. `FJS-D27`, `FJS-D54` — why an atomic
  operator cannot hold a limit the validator must see
- `example/api/src/domain/shop/inventory.ts` `move()` and
  `example/api/src/domain/ledger.ts` `postJournal` — the two ledgers, written by hand
