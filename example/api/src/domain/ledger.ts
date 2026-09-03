// api/src/domain/ledger.ts — the one owner of a journal.
//
// This shop keeps two ledgers and they are the same shape. `inventory.ts` owns
// the first: an append-only tape of signed movements, where summing is the only
// thing anybody wants to do with one. This owns the second, which is that tape
// with an account on it and one extra rule:
//
//   THE LINES OF ONE ENTRY SUM TO ZERO
//
// Every journal in this application is posted here. That is Invariant 4's shape
// again — one owner per translation — and the translation is "money moved and
// here is both sides of it". The moment two places post journals, one of them
// is the one that forgets the rule.
//
// ─── Why the rule is in this file and not in the schema ───────────────────
//
// It reads a CHILD table. `@@check` sees one row, a row policy cannot
// aggregate, and a `@from` answers a number rather than refusing a write — so
// there is no way to declare it, and `db/schema.lite`'s `JournalEntry` says so
// at the point somebody will look for it.
//
// This is the SECOND time this application has written that sentence.
// `billing.ts` enforces `Invoice.subtotal = Σ lines` for exactly the same
// reason. `FJS-D162` ruled where such an invariant is checked — at the moment
// the document is issued, and the freeze is what makes once enough — and left
// what SPELLS it open. Two callers waiting on one spelling is the evidence that
// ruling wants; a third would be a pattern nobody is going to fix.
//
// ─── Why an entry is posted whole ─────────────────────────────────────────
//
// `postJournal` takes the lines and writes them with the header. There is no
// `addLine`, and there must not be: a journal that can be added to is a journal
// that is unbalanced between two calls, and the one moment the rule can be
// checked is the moment there is nothing left to add. Every column is
// `@immutable`, so what is checked once stays checked.
//
// ─── Why it takes a client ────────────────────────────────────────────────
//
// `inventory.ts`'s reason, unchanged: under `transactional:` Junction reassigns
// `ctx.locals.db` for the length of the method, so a write through anything
// else is a write outside the transaction that was supposed to contain it. A
// sale posts its journal inside the checkout transaction or the books and the
// order disagree.

/** A Litestone client of some flavour — deliberately loose, like `inventory.ts`.
 *  Which one to pass is *whose act is this*, and for a journal the answer is
 *  always the shop's: `asSystem()`, because `@@gate("5.9.9.9")` means no caller
 *  posts one. */
type Client = Record<string, any>

/** The chart of accounts, as `db/schema.lite`'s `LedgerAccount` declares it.
 *  Two groups because two things post: a sale, and a pay run. */
export type LedgerAccount =
  // the sale
  | 'receivables'
  | 'discountsAllowed'
  | 'sales'
  | 'shippingIncome'
  | 'taxPayable'
  // the payroll
  | 'wagesExpense'
  | 'payeControl'
  | 'pensionControl'
  | 'niControl'
  | 'netPayControl'

/** One side of one entry. Positive is a debit, negative is a credit. */
export type JournalLineInput = { account: LedgerAccount, amount: number }

/** Exactly one of `orderId` / `payRunId`, which is what `@@arc` declares in the
 *  schema and what `postJournal` refuses here. Two sources rather than a
 *  `(type, id)` pair keeps a real foreign key and a real cascade on both. */
export type JournalPosting = {
  reference: string
  narrative: string
  source:    'sale' | 'payroll'
  orderId?:  number | null
  payRunId?: number | null
  lines:     JournalLineInput[]
}

export type JournalEntryRow = Record<string, unknown> & { id: number, reference: string }

// ─── posting ──────────────────────────────────────────────────────────────

/**
 * Write one balanced journal, or refuse.
 *
 * Four refusals and they are not the same mistake:
 *
 *   a line for nothing      dropped, not refused — see below
 *   fewer than two lines    one line cannot balance against anything
 *   a non-zero sum          the rule
 *   not exactly one source  the arc, which the table also holds
 *
 * **A zero line is dropped rather than refused**, because zero is a legitimate
 * answer from the arithmetic upstream: a sale with no discount produces a
 * discount line of nothing, and refusing that would make every undiscounted
 * order fail. The column carries `@@check("amount != 0")` so a zero cannot
 * arrive by any other road; dropping here is what keeps the caller from having
 * to know which of its lines might be empty.
 */
export async function postJournal(client: Client, posting: JournalPosting): Promise<JournalEntryRow> {
  const lines = posting.lines.filter(l => l.amount !== 0)

  if (lines.length < 2) throw ledgerError(
    `${posting.reference} has ${lines.length} line(s) — a journal needs at least two`,
  )

  // Integers, and this is where that is worth checking rather than at the
  // column. `@money` stores whole minor units and SQLite would take a float
  // silently — 1.5 cents is not a refusal SQLite knows how to make, and the
  // balance below would then be comparing sums that do not round.
  for (const l of lines) {
    if (!Number.isInteger(l.amount)) throw ledgerError(
      `${posting.reference} posts ${l.amount} to ${l.account} — a journal line is a whole number of minor units`,
    )
  }

  // The rule. Stated as a sum rather than as debits-equal-credits because the
  // column is signed, and stated with the two halves in the message because
  // *it does not balance* is unactionable and *debits 4500, credits 4300, out
  // by 200* names the line somebody forgot.
  const sum = lines.reduce((n, l) => n + l.amount, 0)
  if (sum !== 0) {
    const debits  = lines.filter(l => l.amount > 0).reduce((n, l) => n + l.amount, 0)
    const credits = lines.filter(l => l.amount < 0).reduce((n, l) => n - l.amount, 0)
    throw ledgerError(
      `${posting.reference} does not balance — debits ${debits}, credits ${credits}, out by ${Math.abs(sum)}`,
    )
  }

  // The arc, refused here as well as in the table. SQLite's own CHECK names a
  // constraint; this names the two columns and which of them are set, which is
  // what a caller that built the posting can act on.
  const sources = [posting.orderId, posting.payRunId].filter(v => v != null)
  if (sources.length !== 1) throw ledgerError(
    `${posting.reference} names ${sources.length} sources — a journal belongs to exactly one order or pay run`,
  )

  const entry = await client.journalEntry.create({ data: {
    reference: posting.reference,
    narrative: posting.narrative,
    source:    posting.source,
    orderId:   posting.orderId ?? null,
    payRunId:  posting.payRunId ?? null,
  } }) as JournalEntryRow

  // One `createMany`, inside the caller's transaction. A loop would leave an
  // entry with some of its lines if anything threw half way, which is the one
  // state this table must never hold — the balance was checked against all of
  // them.
  await client.journalLine.createMany({ data: lines.map(l => ({
    entryId: entry.id,
    account: l.account,
    amount:  l.amount,
  })) })

  return entry
}

// ─── what a sale posts ────────────────────────────────────────────────────

/** The five figures `pricing.ts` decided, as they reach the books. */
export type SaleAmounts = {
  subtotal: number
  discount: number
  shipping: number
  tax:      number
  total:    number
}

/**
 * A sale, in double entry.
 *
 *   DEBIT   receivables        total        what the customer owes
 *   DEBIT   discountsAllowed   discount     revenue given away, not hidden
 *   CREDIT  sales              subtotal     what the goods were listed at
 *   CREDIT  shippingIncome     shipping
 *   CREDIT  taxPayable         tax          owed onward, never the shop's
 *
 * **It balances because the receipt does.** `Order`'s own `@@check` states
 * `total = subtotal − discount + shipping + tax`; rearranged that is
 * `total + discount = subtotal + shipping + tax`, which is debits equal
 * credits. The journal is the receipt identity written the other way round,
 * and every one of the five columns appears exactly once — which is what makes
 * the entry readable back as the receipt.
 *
 * The discount is a DEBIT to its own account rather than netted off `sales`.
 * Netting is fewer lines and it loses the figure: a period's revenue and a
 * period's discounting are two numbers a shop wants separately, and once they
 * are added together nothing can take them apart again.
 */
export function saleJournal(order: { id: number, reference: string } & SaleAmounts): JournalPosting {
  return {
    reference: `JNL-${order.reference}`,
    narrative: `Sale — ${order.reference}`,
    source:    'sale',
    orderId:   order.id,
    lines: [
      { account: 'receivables',      amount:  order.total    },
      { account: 'discountsAllowed', amount:  order.discount },
      { account: 'sales',            amount: -order.subtotal },
      { account: 'shippingIncome',   amount: -order.shipping },
      { account: 'taxPayable',       amount: -order.tax      },
    ],
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/** 500, deliberately. Every refusal above is the application posting a journal
 *  it built itself, so a caller can do nothing about any of them — a 400 would
 *  tell a shopper their checkout was their fault. */
function ledgerError(message: string) {
  return Object.assign(new Error(message), { status: 500 })
}
