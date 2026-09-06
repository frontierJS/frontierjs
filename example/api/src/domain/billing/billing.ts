// api/src/domain/billing/billing.ts — the one owner of what a SUBSCRIPTION charges.
//
// `pricing.ts` owns what a basket costs and this owns what a cycle costs. They
// are separate because the questions are: a basket is priced once, at the till,
// from rows somebody is looking at; a cycle is priced again next month, without
// anybody there, from a price that may have moved since.
//
// ─── The two rules the whole file turns on ────────────────────────────────
//
// **A subscriber keeps the price they were sold at.** That is why a
// `Subscription` names a `PlanVersion` and not a `Plan`: the version is a row
// with a window, so a price rise is a new row and the existing subscriber is
// untouched until something explicitly moves them.
//
// **An invoice is written WHOLE.** Every money column on it is `@immutable`
// (`FJS-D162`), so there is no draft row to add lines to — the header and its
// lines go in one transaction, and this file is the only place that transaction
// is written. The invariant that the lines sum to the subtotal is checked HERE,
// because no `@@check` can see a child table.
//
// Everything is minor units, as `pricing.ts` is. Nothing divides by a hundred.

import { roundMinor, allocate } from '@frontierjs/toolbelt/units'
import { createIntent, confirmOffSession } from '../../providers/psp/index.ts'

/** A Litestone client of some flavor — see `pricing.ts` for why this is loose. */
type Client = Record<string, any>

/** A line as this file builds it, before it has an invoice to belong to. */
export type BillingLine = {
  description: string
  quantity:    number
  unitAmount:  number
  amount:      number
  periodStart?: string | null
  periodEnd?:   string | null
}

/** How long after issue an invoice is due. Days, because that is how terms are
 *  written; the deadline below is measured from the same column. */
export const TERMS_DAYS = 7

/** How long a subscription may sit unpaid before it is cancelled, measured from
 *  the DUE date of its oldest unpaid invoice rather than from a counter on the
 *  row. A counter is a second answer to a question the invoices already
 *  answer, and the two disagree the first time a job runs twice. */
export const DUNNING_DAYS = 21

/** The grace between an invoice falling due and the subscription lapsing. A
 *  card that fails on a Friday should not read `pastDue` on the shop floor
 *  before anybody has had a chance to fix it. */
export const GRACE_DAYS = 3

const DAY = 24 * 60 * 60 * 1000

/** Move an instant on by one billing interval.
 *
 *  Calendar months rather than 30 days: a monthly subscription bought on the
 *  3rd is charged on the 3rd, which is what a subscriber expects and what every
 *  billing system they have used does. The 31st of January plus a month clamps
 *  to the 28th or 29th of February rather than rolling into March.
 *
 *  **Every operation here is UTC**, and that is not tidiness. The local-clock
 *  spelling (`setMonth`, `getDate`) reads the SERVER's zone, so the same
 *  subscription advances to a different instant depending on where the process
 *  is running — and moving a deployment across a zone would move every
 *  subscriber's billing date by a day, silently, once. Measured on a machine at
 *  UTC-7 while writing this: `2026-01-31T00:00:00Z` advanced to 1 March. */
export function advancePeriod(from: Date | string, interval: 'monthly' | 'yearly'): Date {
  const d = new Date(from)
  const next = new Date(d)
  if (interval === 'yearly') next.setUTCFullYear(d.getUTCFullYear() + 1)
  else {
    const day = d.getUTCDate()
    next.setUTCDate(1)                    // set the month on a day every month has
    next.setUTCMonth(d.getUTCMonth() + 1)
    next.setUTCDate(Math.min(day, daysInMonth(next.getUTCFullYear(), next.getUTCMonth())))
  }
  return next
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/** The lines a full, ordinary period is made of. One today; a plan with add-ons
 *  is where the array stops being a formality. */
export function periodLines(
  args: { name: string, quantity: number, unitAmount: number, periodStart: string, periodEnd: string },
): BillingLine[] {
  return [{
    description: `${args.name} — ${args.quantity} × the ${describeSpan(args.periodStart, args.periodEnd)}`,
    quantity:    args.quantity,
    unitAmount:  args.unitAmount,
    amount:      args.unitAmount * args.quantity,
    periodStart: args.periodStart,
    periodEnd:   args.periodEnd,
  }]
}

/** `1 Mar – 1 Apr`, for a line a person reads. Kept here rather than on a screen
 *  because the line text is part of the DOCUMENT — it is frozen with the row,
 *  so it cannot be re-rendered later in a different locale or a different
 *  wording and still be the same statement. */
export function describeSpan(from: string, to: string): string {
  // UTC for `advancePeriod`'s reason, one step further along: this string is
  // FROZEN into the line, so a server in another zone would write a different
  // document for the same period — and the difference would only ever be
  // visible on the rows written either side of a move.
  const fmt = (s: string) => new Date(s).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `${fmt(from)} – ${fmt(to)}`
}

// ─── Proration ────────────────────────────────────────────────────────────
//
// A change mid-cycle is a TIME SLICE, and the whole difficulty is that the
// slice does not divide evenly. Three separate roundings happen — the credit
// for time not used, the charge for time not yet used, and the split of that
// charge across however many units are being paid for — and each one is where
// a receipt stops adding up.
//
// The first two are `roundMinor`; the third is `allocate`, and it is the one a
// hand-rolled implementation gets wrong: dividing a charge by three and writing
// the same number on three lines is three plausible numbers that do not sum to
// what was taken.

/** What a change costs, and what its lines are. */
export type Proration = {
  /** How much of the period is left, 0–1. Milliseconds, not days: a period is
   *  an interval between two instants and a change happens at one. */
  fraction: number
  /** Owed back for time paid for and not used. Always positive. */
  credit:   number
  /** Owed for the rest of the period on the new arrangement. Always positive. */
  charge:   number
  /** `charge - credit`. Positive is an invoice, negative is a credit note —
   *  which is not a stylistic choice: `Invoice.subtotal` is `@gte(0)`, so the
   *  Data boundary refuses a negative document. */
  net:      number
  lines:    BillingLine[]
}

/**
 * Price a mid-cycle change.
 *
 * `at` is clamped into the period: a change dated before it starts prorates the
 * whole period and one dated after it ends prorates nothing, which are both
 * better answers than a negative fraction quietly inverting every figure below.
 *
 * The charge is split across the units with `allocate` rather than by
 * multiplying a per-unit price, and the difference is the point. Three seats
 * out of a 1000 charge is 333.33 each; three lines of 333 is a receipt one unit
 * short of what was taken, and three lines of 334 is one unit over. `allocate`
 * hands the remainder to the largest fractional parts, so the lines sum to the
 * charge exactly and the reader can still see what a seat cost.
 */
export function prorate(args: {
  periodStart: string
  periodEnd:   string
  at:          string
  name:        string
  from: { unitAmount: number, quantity: number }
  to:   { unitAmount: number, quantity: number }
}): Proration {
  const start = Date.parse(args.periodStart)
  const end   = Date.parse(args.periodEnd)
  const now   = Math.min(Math.max(Date.parse(args.at), start), end)
  const span  = Math.max(1, end - start)

  const fraction = (end - now) / span
  const credit   = roundMinor(args.from.unitAmount * args.from.quantity * fraction)
  const charge   = roundMinor(args.to.unitAmount   * args.to.quantity   * fraction)
  const net      = charge - credit

  const rest  = new Date(now).toISOString()
  const lines: BillingLine[] = []

  if (credit > 0) lines.push({
    description: `Unused ${describeSpan(rest, args.periodEnd)} — credit`,
    quantity:    args.from.quantity,
    unitAmount:  -args.from.unitAmount,
    amount:      -credit,
    periodStart: rest,
    periodEnd:   args.periodEnd,
  })

  if (charge > 0) {
    // One line per unit, and the split is `allocate`'s. Evenly-weighted, so
    // every seat costs the same to within the one unit the remainder moves.
    const parts = allocate(charge, Array.from({ length: args.to.quantity }, () => 1))
    for (const [i, amount] of parts.entries()) lines.push({
      description: `${args.name} — seat ${i + 1}, ${describeSpan(rest, args.periodEnd)}`,
      quantity:    1,
      unitAmount:  amount,
      amount,
      periodStart: rest,
      periodEnd:   args.periodEnd,
    })
  }

  return { fraction, credit, charge, net, lines }
}

/**
 * Write an invoice and its lines, as one document.
 *
 * The tax rate is READ rather than passed, for `priceOrder`'s reason: a caller
 * that stated a rate would be a second opinion about what a shop charges. The
 * subtotal is summed from the lines for the same reason, and then checked
 * against them — which is the cross-row invariant that has no declaration
 * (`FJS-D162` leaves what would spell it open), so this is where it lives and
 * this is the only writer, which is what makes that acceptable.
 *
 * `system:` is not enough here and `asSystem()` is what the caller must hand
 * in: `Invoice` is `@@gate("1.8.8.8")`, so the write is a system context by
 * declaration. What `asSystem()` does NOT drop is `@immutable` — which is the
 * whole point of the tier it sits in, and is why this function can be the only
 * one that ever writes these numbers.
 *
 * **Three steps now, not two** (`FJS-D167`). The header is written as a `draft`,
 * the lines are added to it, and `issue` is what makes it a document. The order
 * is not a style: `lines` is `@sealed`, so after the seal `createMany` is refused
 * — by the Data boundary, not by this function — and a version of this that
 * sealed first would fail rather than write a header with no lines.
 *
 * The draft is never observable, because all three run in one transaction. That
 * is the point rather than a limitation: what the seal buys is not a visible
 * draft state, it is that from the moment this function returns there is no
 * write anywhere in this app, `asSystem()` included, that can add a line to the
 * document or take one away.
 */
export async function issueInvoice(
  sys: Client,
  args: {
    number:         string
    customerId:     number
    subscriptionId?: number | null
    userId?:        string | null
    lines:          BillingLine[]
    periodStart:    string
    periodEnd:      string
    issuedAt?:      string
  },
): Promise<{ id: number, number: string, subtotal: number, tax: number, total: number }> {
  if (!args.lines.length)
    throw new Error(`issueInvoice(${args.number}): an invoice with no lines is not a document`)

  const subtotal = args.lines.reduce((n, l) => n + l.amount, 0)

  // The invariant, checked where it can be. A line array that does not add up
  // to the header is the one failure this domain is most about, and the reason
  // it is an assertion here rather than a `@@check` is that SQLite cannot see a
  // child table from a row constraint.
  if (!Number.isInteger(subtotal))
    throw new Error(`issueInvoice(${args.number}): lines must be whole minor units, got ${subtotal}`)

  const rate = await sys.taxRate.findFirst({ where: { isDefault: true, active: true } })
  const tax  = roundMinor(Math.max(0, subtotal) * (rate?.rate ?? 0))

  const issuedAt = args.issuedAt ?? new Date().toISOString()
  const dueAt    = new Date(new Date(issuedAt).getTime() + TERMS_DAYS * DAY).toISOString()

  // One transaction. A header without its lines is an invoice that says it
  // charged for nothing, and a frozen subtotal means it can never be corrected —
  // so the pair commits together or neither does.
  return await sys.$transaction(async (tx: Client) => {
    const invoice = await tx.invoice.create({ data: {
      number:         args.number,
      customerId:     args.customerId,
      subscriptionId: args.subscriptionId ?? null,
      userId:         args.userId ?? null,
      subtotal, tax, total: subtotal + tax,
      periodStart:    args.periodStart,
      periodEnd:      args.periodEnd,
      issuedAt, dueAt,
    } })

    await tx.invoiceLine.createMany({ data: args.lines.map(l => ({
      invoiceId:   invoice.id,
      description: l.description,
      quantity:    l.quantity,
      unitAmount:  l.unitAmount,
      amount:      l.amount,
      periodStart: l.periodStart ?? null,
      periodEnd:   l.periodEnd ?? null,
      userId:      args.userId ?? null,
    })) })

    // The seal. Everything above this line was a draft the caller could still
    // change; nothing below it can be changed by anybody.
    return await tx.invoice.transition(invoice.id, 'issue')
  })
}

/**
 * The money arrived for one invoice.
 *
 * Two writes, one owner. `@@transitions` moves the status and refuses the move
 * from anywhere but `issued`; `paidAt` is a second column and no transition can
 * stamp one, so a caller that only ran the transition left a paid invoice with
 * no payment date — true of the seed, the staff button and the webhook path
 * alike, each in its own copy of the same two lines.
 *
 * `system: ['paidAt']` rather than a bare write: the column is `@system`, and
 * naming it on the call keeps the gate, the row policies and the audit actor
 * where `asSystem()` would drop all three to write one value.
 */
export async function settleInvoice(client: Client, id: number, at?: string): Promise<unknown> {
  await client.invoice.transition(id, 'settle')
  return await client.invoice.update({
    where: { id },
    data:  { paidAt: at ?? new Date().toISOString() },
    system: ['paidAt'],
  })
}

/**
 * Move a subscription to a different price or a different quantity, mid-cycle.
 *
 * The arrangement changes at once and the money is settled for the part of the
 * period that is left — which is what a subscriber means by *upgrade now*.
 *
 * **Which document it writes is decided by the SCHEMA, not by a branch here.**
 * `Invoice.subtotal` is `@gte(0)`, so a negative document is refused at the
 * Data boundary; an upgrade owes money and is an invoice, a downgrade is owed
 * money and is a `CreditNote`. That is also why a credit note carries no lines:
 * it is one amount against one invoice, where an invoice is a statement made of
 * parts.
 *
 * A change worth nothing writes nothing. Issuing a zero invoice would put a
 * document in a customer's ledger recording that they were charged nothing,
 * which is a different claim from having made no charge.
 */
export async function changePlan(
  sys: Client,
  subscriptionId: number,
  change: { planVersionId?: number | null, quantity?: number | null, at?: string },
): Promise<{ kind: 'invoice' | 'credit-note' | 'none', number?: string, net: number }> {
  const sub = await sys.subscription.findFirst({ where: { id: subscriptionId } })
  if (!sub) throw new Error(`changePlan: no subscription ${subscriptionId}`)
  if (sub.status === 'cancelled')
    throw new Error(`changePlan: ${sub.reference} is cancelled — there is no period left to prorate`)

  const at   = change.at ?? new Date().toISOString()
  const from = await sys.planVersion.findFirst({ where: { id: sub.planVersionId } })
  const to   = change.planVersionId && change.planVersionId !== sub.planVersionId
    ? await sys.planVersion.findFirst({ where: { id: change.planVersionId } })
    : from
  if (!from || !to) throw new Error(`changePlan: no such plan version`)

  const plan     = await sys.plan.findFirst({ where: { id: to.planId } })
  const quantity = change.quantity ?? sub.quantity

  const p = prorate({
    periodStart: sub.currentPeriodStart,
    periodEnd:   sub.currentPeriodEnd,
    at,
    name:        plan?.name ?? 'Plan',
    from: { unitAmount: from.price, quantity: sub.quantity },
    to:   { unitAmount: to.price,   quantity },
  })

  // The arrangement moves whatever the money does. A change that is worth
  // nothing is still a change.
  await sys.subscription.update({
    where: { id: sub.id },
    data:  { planVersionId: to.id, quantity },
  })

  if (p.net === 0) return { kind: 'none', net: 0 }

  if (p.net > 0) {
    const invoice = await issueInvoice(sys, {
      number:         await nextInvoiceNumber(sys),
      customerId:     sub.customerId,
      subscriptionId: sub.id,
      userId:         sub.userId,
      issuedAt:       at,
      periodStart:    at,
      periodEnd:      sub.currentPeriodEnd,
      lines:          p.lines,
    })
    return { kind: 'invoice', number: invoice.number, net: p.net }
  }

  // Owed back. Against the most recent invoice for this subscription, because a
  // credit note is a correction OF a document and has to name one — and if
  // there is none, there is nothing to correct and the change is simply
  // cheaper from here on.
  const last = await sys.invoice.findFirst({
    where: { subscriptionId: sub.id }, orderBy: { id: 'desc' },
  })
  if (!last) return { kind: 'none', net: p.net }

  const note = await sys.creditNote.create({ data: {
    number:    `CN-${3000 + (await sys.creditNote.count()) + 1}`,
    invoiceId: last.id,
    amount:    -p.net,
    reason:    `Downgrade on ${describeSpan(at, sub.currentPeriodEnd)} — unused time credited`,
    issuedAt:  at,
    userId:    sub.userId,
  } })
  return { kind: 'credit-note', number: note.number, net: p.net }
}

// ─── Collection ───────────────────────────────────────────────────────────
//
// The shop owns the SCHEDULE and the vendor takes the money. That split is the
// whole design: a provider will run the whole cycle if asked, and then the
// state machine, the durable clock and the cross-row invariant all live in the
// provider's product rather than in the application — which is the opposite of
// what this app is for.
//
// So collection is one call out through `app.conduit` and one row written here.
// Everything about WHEN it happens is `renew-subscriptions` and
// `dun-subscriptions`, and everything about whether it worked comes back as a
// webhook the provider signs.

/** What a decline MEANS, which is not the same question as whether the request
 *  worked. A soft decline is a retry — the money may be there tomorrow. A hard
 *  one is an answer: this card will never work, and re-presenting it is how a
 *  shop gets its merchant account reviewed. */
export type DeclineKind = 'soft' | 'hard'

/** The codes a provider sends, mapped onto the only two things a shop can DO.
 *  Unknown codes are soft, deliberately: an unrecognized decline is not a
 *  reason to stop trying, and treating it as one turns every new code the
 *  provider invents into a cancelled subscription. */
const HARD_DECLINES = new Set([
  'stolen_card', 'lost_card', 'pickup_card', 'fraudulent',
  'card_not_supported', 'invalid_account', 'do_not_honor_final',
])

export function declineKind(code: string | null | undefined): DeclineKind {
  return code && HARD_DECLINES.has(code) ? 'hard' : 'soft'
}

/**
 * Present an invoice to the provider.
 *
 * Writes a `Payment` row against the INVOICE — `Payment` is
 * `@@arc([orderId, invoiceId])`, so exactly one of the two is set and the Data
 * boundary refuses a row that names both or neither.
 *
 * It does not settle anything. The provider answers an intent and then TELLS
 * the shop what happened, signed, over the webhook — which is the only account
 * of a payment a shop should act on, because it is the only one the provider
 * will stand behind. A charge that appears to succeed here and fails there is
 * the ordinary case, not an edge.
 *
 * Answers the payment row, or the error as a VALUE — the caller is writing
 * down what happened and a throw would make "the provider is down" and "the
 * card was declined" the same shape.
 */
export async function chargeInvoice(
  app: { conduit?: unknown },
  sys: Client,
  invoiceId: number,
): Promise<{ paymentRef?: string, error?: { kind: string, message: string, retryable: boolean } }> {
  const invoice = await sys.invoice.findFirst({ where: { id: invoiceId } })
  if (!invoice) throw new Error(`chargeInvoice: no invoice ${invoiceId}`)
  if (invoice.status !== 'issued')
    throw new Error(`chargeInvoice: ${invoice.number} is ${invoice.status} — only an issued invoice is owed`)

  // Already presented and still waiting. Charging twice is the failure this
  // domain is judged on, and both of these are the provider having been asked:
  // `pending` is an answer that has not arrived, and `requiresAction` is one
  // that HAS — the bank wants the cardholder, and presenting the same card
  // again produces the same challenge and a second row to reconcile.
  const inFlight = await sys.payment.findFirst({
    where: { invoiceId, status: { in: ['pending', 'requiresAction'] } },
  })
  if (inFlight) return { paymentRef: inFlight.providerRef }

  // ── What is being presented ─────────────────────────────────────────────
  //
  // Nobody is at the keyboard. An invoice is issued by a cron at three in the
  // morning, so the only thing that can pay it is a card the provider is
  // already holding — which is what `PaymentMethod` is for.
  //
  // **No instrument is its own answer and not a soft decline.** Before this
  // existed the charge minted an intent nobody would ever confirm, so the
  // invoice sat `issued`, which is indistinguishable from a card that keeps
  // saying no — and dunning then ran its full twenty-one days at somebody who
  // had never been asked for a card at all. `retryable: false`, because no
  // number of attempts produces an instrument.
  //
  // `providerRef` is `@guarded`, so this read only answers under `asSystem()`,
  // which is the client every caller of this function already holds.
  const method = await sys.paymentMethod.findFirst({
    where:   { customerId: invoice.customerId, isDefault: true },
    orderBy: { id: 'desc' },
  })
  if (!method) return { error: {
    kind:      'no_instrument',
    message:   `${invoice.number}: there is no card on file for this customer`,
    retryable: false,
  } }

  const { intent, error } = await createIntent(app as never, {
    amount:    invoice.total,
    currency:  'USD',
    reference: invoice.number,
  })

  // The provider could not be asked. Nothing is written: a `Payment` row says
  // the provider was asked and answered, and a row recording a request that
  // never arrived is a reconciliation somebody has to do by hand.
  if (error || !intent) return { error: error ?? { kind: 'unknown', message: 'no intent', retryable: true } }

  // ── The row exists before the money moves, and that ordering is the point ─
  //
  // The provider's event arrives on its OWN connection and routinely beats the
  // reply to the call that caused it. If the charge happened inside
  // `createIntent`, the webhook saying *paid* could reach `payments.record`
  // before this row existed — which is `unknown-payment`, a 200, and money
  // taken against nothing. Minting and presenting are therefore two calls, and
  // this write is what sits between them.
  await sys.payment.create({ data: {
    providerRef:     intent.id,
    invoiceId,
    paymentMethodId: method.id,
    amount:          invoice.total,
    currency:        intent.currency ?? 'USD',
    status:          'pending',
    // Copied from the invoice, so the row policy on `Payment` can answer
    // *yours*. When the bank asks for the cardholder, the only person who can
    // finish this is the one who owns it — and a row only staff may read
    // cannot tell them.
    userId:          invoice.userId ?? null,
  } })

  // Present it. Neither a decline nor a challenge is an error here: the
  // provider ANSWERED, and *the card said no* and *the bank wants the
  // cardholder* are both domain facts that arrive as signed events and move the
  // payment through `payments.record` like any other. What this returns is the
  // reference either way, so the caller has something to look the outcome up
  // by — and what an error means is narrower for it: the provider could not be
  // reached at all.
  const presented = await confirmOffSession(app as never, {
    intentId:   intent.id,
    instrument: method.providerRef,
  })
  if (presented.error) return { paymentRef: intent.id, error: presented.error }

  return { paymentRef: intent.id }
}

/** The next invoice number. A sequence over the table rather than a counter
 *  somewhere else, so a database restored from a backup cannot mint a number
 *  that is already in use — `number` is `@unique`, so a collision is a refusal
 *  rather than a duplicate. */
export async function nextInvoiceNumber(sys: Client, prefix = 'INV'): Promise<string> {
  const last = await sys.invoice.findFirst({ orderBy: { id: 'desc' } })
  return `${prefix}-${3000 + (last?.id ?? 0) + 1}`
}

/** Which subscriptions are due to be charged at `at`.
 *
 *  A trial that has ended counts: the whole of *the trial converts* is that the
 *  period ran out and the next one is charged for. */
export async function dueForRenewal(sys: Client, at: string): Promise<any[]> {
  return await sys.subscription.findMany({
    where:   { status: { in: ['trialing', 'active', 'pastDue'] }, currentPeriodEnd: { lte: at } },
    orderBy: { id: 'asc' },
  })
}

/** The unpaid invoices behind a subscription, oldest first. What dunning reads,
 *  and what makes a counter on the row unnecessary. */
export async function unpaidInvoices(sys: Client, subscriptionId: number): Promise<any[]> {
  return await sys.invoice.findMany({
    where:   { subscriptionId, status: 'issued' },
    orderBy: { dueAt: 'asc' },
  })
}
