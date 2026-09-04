// api/src/domain/billing/index.ts — the door into billing.
//
// One file, and a folder anyway: billing is closed — it imports nothing else in
// `domain/` — and it is the module most likely to grow, since dunning, credit
// notes and proration each already have enough surface to become neighbors.
// The alternative was leaving `billing.ts` beside `ledger.ts` until it had a
// second file, which trades this folder for a later move of every import.
//
// The one thing it reaches outside the app for is the payment provider
// (`../../providers/psp/`), which is the shape a module SHOULD have: it talks to
// a third party through the boundary conduit owns, not to a vendor SDK.

export {
  // the cycle
  dueForRenewal, advancePeriod, changePlan, prorate, periodLines,
  // the documents
  issueInvoice, nextInvoiceNumber, unpaidInvoices, settleInvoice,
  // taking the money, and what the provider's answer means
  chargeInvoice, declineKind,
  // the deadlines a subscription is graded against
  TERMS_DAYS, GRACE_DAYS, DUNNING_DAYS,
} from './billing.ts'
