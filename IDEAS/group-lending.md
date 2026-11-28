---
id: group-lending
status: partial
dated: 2026-11-27
---

# Idea — Group lending: a shared shelf, holds, due dates and bookings in grouppi

**Status: PARTIAL.** Dated 2026-11-27. Built in grouppi on 2026-11-28 and
uncommitted: Phases 0, 1, 3 and 6 but its pilot, Phase 2 but handoff photos,
and Phase 4 but a run on real test-mode keys. Phase 3 and step 4.7 were
built under the recommendations of Q5 and Q7, which are not ruled. Nothing has
run against real Stripe, only the `conduit-stripe` sink. What was measured, and
every call a page makes, is in grouppi `docs/gap-map.md` § Lending; `fli plan`
on this file says what is next. An unticked step is not behavior; see
`VERIFYING.md`. It extends grouppi, the group kit in `IDEAS/group-kit.md`, and
lives in the same tree, `fjs-prototypes/grouppi/`, on the same ports
(7500–7509).

**The product.** A group lends things to its own members. A tool library, a
church's folding tables, a scout troop's tents, a neighborhood's board games, a
club's meeting room. Some things belong to the group and some to a member who
offers them to the rest. A member borrows, joins a queue when an item is out,
gets reminded before it is due, and is told when it is late. Things that are
booked by date, such as a tent for a weekend or the hall for an evening, are
booked on a calendar that refuses two overlapping bookings.

**Why this, from the research** (`§ Research` at the end of this file):

- Every library-of-things tool assumes one operator owns everything (Circulate,
  myTurn, Lend Engine). Only ToolPool.Garden and the peer-to-peer apps let a
  member lend their own things, and those have no queue, due dates or reminders.
  A tool that does both is open ground.
- The cheap tools are thin where it matters. Lend Engine's free tier has a
  waiting list that emails everyone at once, with no order and no pickup window.
  ToolTrust and ToolPool have no holds queue at all.
- A group already on grouppi has its members, its links and its Stripe account.
  Lending reuses all three, so it costs a group nothing new to start.

**What stays true from the group kit.** Money lands in the group's own Stripe
account and the kit takes nothing (`FJS-D2200`). Members use a link and never
need an account (`IDEAS/group-kit.md` § The product). `conduit-stripe` refuses
every key that would let a platform take a cut or move money elsewhere. Q3 was
ruled to keep that whole (`FJS-D2421`): a member who rents things out is paid
into their own Stripe account, never through the group's.

## The shape

The nouns are app nouns in grouppi, not framework nouns. Each one is the
precedent's word unless noted.

- **Item.** One physical thing, with its own history. A set of eight identical
  chairs is eight Items or one Item with a count; Circulate's
  `uniquely_numbered` switch is the precedent for allowing both. An Item belongs
  to the group or to a member (`ownerMemberId`, Q2), and is lent by queue or by
  date (`lendBy`, Q5). In, out and on hold are read off its open Loan and ready
  Hold, never stored. Only what no row implies is a column: lost, broken,
  paused, withdrawn.
- **LoanPolicy.** Loan length, renewals allowed, how many items a member may
  hold at once, how long a ready hold waits for pickup, and whether a member
  needs approval before borrowing. Circulate's `BorrowPolicy` and myTurn's
  per-item-type defaults are the shape. A group starts with one.
- **Loan.** One borrowing: who, which Item, `dueAt`, `returnedAt`, renewal
  count, and condition notes at checkout and return. "Overdue" is derived
  (`returnedAt` null and `dueAt` past), as Circulate does, so no job has to set it.
- **Hold.** A place in an Item's queue, Circulate's word. It waits, becomes
  ready when the Item comes back, and lapses to the next person if it is not
  picked up within the policy's window. Its position is read from order, as
  Signup's and Rsvp's are. "Hold" means this queue place and nothing else in
  this plan: the ticket stock hold keeps its own name in `payments.ts`, and a
  booking's short claim is `pending`.
- **Booking.** A dated claim on an Item: `startsAt`, `endsAt`, and a status that
  runs requested → pending → confirmed, or declined, cancelled or expired. A Booking
  becomes a Loan at pickup, and it is finished when that Loan is returned,
  read off `Loan.returnedAt` rather than set twice.
- **CancelRule.** One row of a cancellation schedule: from this many hours before
  the start, refund this percent. A named preset (flexible, moderate, firm) is a
  set of rows, which is how Airbnb's tiers decompose.

**What the framework already gives this** (read 2026-11-27 from
`packages/litestone/docs/reference.snapshot.md`; each still has to be probed
in Phase 0):

| Need | Framework word | Use here |
| ---- | -------------- | -------- |
| One open loan per Item | `@@unique([itemId], where: returnedAt == null)` | grouppi already uses `where:` uniques on Signup and Rsvp |
| One live hold per member per Item | the same partial unique | |
| At most N items out per member | `@@rate([memberId], max: policy.maxOut, where: ...)` (`FJS-4380`, closed) | measured 0.2: the cap reads one hop, so Loan carries `policyId`; a system write and a promotion count against it |
| No two bookings overlap | `@@exclude(<scope>, range: [startsAt, endsAt], where: ...)` | `scope item(itemId)`; the guard Cal.com lacked (its PR 29966 says a real fix needs a schema-level constraint) |
| A pending booking dies on time | `@@commitment(expire, on: expiresAt)` and an `expired` state | measured 0.3: a row `@@expires` has expired still blocks its dates (`FJS-4686`), so expiry is a state change, and a stale claim lasts until the next sweep |
| A ready hold lapses and the next one is promoted | `@@commitment(lapse, on: readyAt + pickupDays)` | measured 0.4: the window is copied from the policy onto the Hold (`@immutable`); the promotion is a hook on the transition, in the same transaction |
| States move only along declared edges | `@@transitions` | Booking and Hold |

`api/src/domain/places.ts` already promotes the first in line when a place is
given up, for sign-ups and RSVPs. Holds are the same shape, so 1.4 extends that
file instead of writing a second queue.

Two of the rules are gates on Loan and Hold creation, never hooks (Invariant 6):
no new loan or hold while the member has something overdue past the grace, and
no member checking themselves out.

**What the framework lacks** (from reading `packages/conduits/conduit-stripe/src/`):

- No card authorization. `capture_method` appears nowhere, so a deposit
  authorized on a card (Q4 B, `FJS-D2422`) needs a connector change first (4.5).
- No dispute webhook. `charge.dispute.*` is handled nowhere, and that is
  already a gap for grouppi's tickets and dues today (6.1).

## Phases

### Phase 0 — Groundwork

Goal: every framework word in § The shape is measured against a probe schema
before any model is written.
Done when: each probe below has a recorded result in `docs/gap-map.md`, and a
gap that blocks a phase has an `FJS-###`.

- [x] 0.1 Read Circulate's `Hold`, `Loan`, `BorrowPolicy` and `RenewalRequest`
  models and its `StartWaitingHoldsJob` again at the commit used, and list the
  rules grouppi takes and the ones it drops.
- [x] 0.2 Probe `@@rate max:` as a per-member loan cap: can the cap be read off
  the group's policy through one hop, and does a promotion that moves a hold to
  a loan count against it?
- [x] 0.3 Probe `@@exclude` with `@@expires` on Booking: a pending booking past its
  expiry must not block a new one, and a confirmed one must.
- [x] 0.4 Probe `@@commitment` for a ready hold's lapse: does the transition fire
  at `readyAt + 7d` under `advance()`, and can its hook promote the next hold in
  the same transaction?
- [x] 0.5 Race drive: two guests take the last copy and two guests book the same
  night, concurrently, through the API. Exactly one wins each time.

### Phase 1 — The group's shelf, no money

Goal: a group lends its own things by queue, with due dates, reminders and
overdue notices.
Done when: a browser drive lends an Item, queues a second member, returns it,
promotes the hold, lapses it after the window and promotes a third member. The
same drive asserts that a renewal is refused while a hold waits, and that an
overdue member's new loan and new hold are both refused. `bun run test` is green.

- [x] 1.1 Models: Item, LoanPolicy, Loan, Hold, with gates. Organizers manage
  Items and policies; a member reads the shelf and their own loans and holds.
- [x] 1.2 Shelf page: a public list of Items for a member link, with photos,
  status (in, out until a date, on hold) and a search box.
- [x] 1.3 Check out and check in by an organizer: pick member and Item, set due
  from the policy, record condition notes. A member cannot check themselves out
  in v1.
- [x] 1.4 Holds queue: join, leave, position shown; a returned Item makes the
  first hold ready and notifies that member by the channels grouppi already has
  (email, SMS, ntfy). Built in `domain/holds.ts`, not on `places.ts`: that
  `Line` counts places against a cap column, and a Hold's place is a Loan.
- [x] 1.5 Pickup window: a ready hold lapses after the policy's days (default 7,
  the public-library norm) and passes to the next person with no penalty.
- [x] 1.6 Renewals: a member renews from their link if renewals are left and
  nobody holds the Item (Circulate, Koha and every public library surveyed
  refuse a renewal when someone is waiting).
- [x] 1.7 Reminders: one before due (default 2 days), one on the day, then
  overdue notices on a schedule the policy sets (Lend Engine's "every X days
  until returned"). Reuses `jobs/reminders.job.ts`.
- [x] 1.8 Overdue consequence per Q1. Under the recommendation: no new loans or
  holds while something is overdue past the policy's grace (Toledo, Holbrook).
- [x] 1.9 Lost and broken: an organizer marks a Loan lost or an Item broken; the
  Item leaves the shelf, holds on it are told, and the loan is closed.
- [x] 1.10 Import a shelf from a spreadsheet, reusing `domain/sheetImport.ts`.

### Phase 2 — Members lend their own things

Goal: a member offers an Item they own; another member asks, the owner accepts,
and they hand it over themselves.
Done when: a browser drive runs request, accept, handoff, return and a decline
that times out, with the owner and borrower on two member links.

- [x] 2.1 `ownerMemberId` on Item (Q2); the owner edits their own Items and sees
  who has them.
- [x] 2.2 Request to borrow: the owner accepts or declines. An unanswered
  request lapses after 48 hours (Airbnb gives a host 24 hours, Sharetribe 6
  days); the owner can switch an Item to auto-accept.
- [ ] 2.3 Handoff and return are marked by the owner, with condition notes and
  up to three photos at each (Fat Llama asks for timestamped photos within 24
  hours of the start).
  The marking and the notes are built; the photos are not, because grouppi has
  no file store yet.
- [x] 2.4 An owner pauses or withdraws an Item; a withdrawn Item with an open
  loan stays until it is returned.
- [x] 2.5 Organizer view: every member-owned Item, and a way to hide one.

### Phase 3 — Booking by date

Goal: Items lent by date (a tent, a trailer, the hall) are booked on a
calendar, and two overlapping bookings are refused by the schema.
Done when: the 0.5 race drive passes against Booking, and a browser drive books,
holds, confirms and cancels a weekend.

- [x] 3.1 Booking model with `@@exclude(item, ...)` over pending and confirmed
  rows, `@@transitions`, and a turnaround buffer per Item (Cal.com's
  buffer-aware overlap check is the precedent). The step also settles how a
  Loan made from a Booking (3.5) stays inside the overlap rule. Either Loan cites
  the same `scope item(itemId)` with its own range, or `lendBy` keeps queue and
  date lending apart per Item and a late return tells the next booker.
- [x] 3.2 Calendar on the Item page: free and taken days, pick a range, see
  the policy's longest booking and how far ahead a booking may be made.
- [x] 3.3 Pending booking: picking dates claims them for 15 minutes while the member
  confirms (Sharetribe's `expire-payment` is 15 minutes; grouppi's ticket hold is
  35 because Stripe's page needs 30).
- [x] 3.4 Request-to-book for member-owned Items, with the 2.2 accept timeout;
  instant booking for the group's own Items unless the policy asks for approval.
- [x] 3.5 A confirmed Booking becomes a Loan at pickup, so Phase 1's reminders and
  overdue rules apply unchanged.
- [x] 3.6 `.ics` for a booking, reusing `domain/ics.ts`.

Built 2026-11-28 under Q5's recommendation A, before Q5 is ruled: an Item is
lent one way, `lendBy` queue or dates, and a late return tells the next booker.
In 3.4 a policy that asks for approval refuses an unapproved member's booking
outright, as it refuses their hold; it does not turn the booking into a request.

### Phase 4 — Money for the group's own Items

Goal: a group charges a rental fee or a replacement cost into its own Stripe
account, and a paid booking refunds itself by the group's cancellation rules.
Done when: against the `conduit-stripe` sink, a paid booking is charged, cancelled
inside and outside each preset's window and refunded the right amount; then
once with real test-mode keys.

- [x] 4.1 Rental fee per Item or per policy, per day or per loan, paid through
  the Checkout path tickets already use (`domain/payments.ts`).
- [x] 4.2 CancelRule rows and three presets taken from Airbnb's tiers: flexible
  (full refund to 24 hours before), moderate (full to 5 days), firm (full to 30
  days, half to 7). A group may edit the rows.
- [x] 4.3 Cancellation refunds by the rules through `refundPayment`; a
  cancellation by the group or the owner refunds in full. Built for the
  group's own Items: the rows are the group's, a booking keeps the rows it was
  made under, a member pays within a 35-minute claim before the booking is
  confirmed, and a booking never picked up refunds nothing.
- [x] 4.4 Replacement cost for a lost or broken Item, sent as a payment link
  the way dues are (`domain/dues.ts`), never charged to a stored card.
- [x] 4.5 `conduit-stripe` gains a card authorization: a PaymentIntent with
  `capture_method: manual` on a connected account, a partial or full capture,
  a cancel that releases it, and the sink's matching events. It still refuses
  every platform-fee key. Proved by the connector's own tests.
- [x] 4.6 Deposits (`FJS-D2422`): a policy or Item names a deposit; checkout
  authorizes it on the lender's account; a return in good order releases it; a
  loss or damage captures up to the amount, with the organizer's or owner's
  note. The authorization is never captured without a person pressing capture.
- [ ] 4.7 Loans longer than the authorization lasts, per Q7. The authorization
  lasts 7 days for an online card and is released by Stripe after that.
  Built under Q7's recommendation A and not ticked until Q7 is ruled: a
  deposit goes only with a loan of 6 days or less.

### Phase 5 — Paid lending between members

Goal: a member rents their own things to other members, paid into the
lender's own Stripe account by direct charge with no fee (`FJS-D2421`).
`FJS-D2200` holds unchanged: the kit takes nothing and moves no money.
Done when: against the sink, a member onboards, rents an Item with a fee and a
deposit, is cancelled on by the borrower under a preset, and refunds the right
amount from their own account; then once with real test-mode keys.

- [ ] 5.1 Lender onboarding: a member connects their own Stripe account with
  the same controller properties the group uses (`FJS-D2200`). The member is a
  connected account in their own right, never a sub-account of the group's.
  The member has no grouppi account, only a link, so the step settles how a
  link-only member returns to Stripe's onboarding and to their own payouts page.
- [ ] 5.2 A member's Item may carry a fee, a deposit and a cancellation preset
  only once that member's account can take charges. Until then it lends free.
- [ ] 5.3 Checkout, refund and deposit run on the lender's account, reusing 4.1,
  4.3 and 4.6 with the account id taken from the Item's owner, not the group.
- [ ] 5.4 Lender's ledger: what they earned, refunded and captured, and a year
  export like the group's.
- [ ] 5.5 Terms: the lender, not the group or the kit, is the seller, and bears
  refunds and disputes on their account. Added to the draft terms with group-kit
  5.4's lawyer review.
- 6.1's dispute webhook lands before any member takes a live payment, because
  under B a member bears their own disputes.

### Phase 6 — Trust and safety

Goal: a group can see and act on trouble before it costs a member money or an
Item.
Done when: a drive raises a dispute on the sink, files a report on an Item and
blocks a member, and each reaches the organizer.

- [x] 6.1 Dispute webhook in `conduit-stripe` and grouppi: `charge.dispute.created`
  marks the Payment and tells the organizers. This also covers tickets and dues,
  which have no dispute handling today.
- [x] 6.2 Member approval per policy (Circulate's `borrow_policy_approvals`): a
  power-tool policy may require an organizer's yes before a member borrows.
- [x] 6.3 `Report` gains `item` and `member` subjects; an organizer can suspend
  a member's borrowing.
- [x] 6.4 Waiver acceptance per policy, recorded on the Loan (ToolTrust ships
  waivers; Chicago Tool Library requires one).
- [ ] 6.5 Pilot with one real tool library or gear closet, run as group-kit
  Phase 5 runs its pilots.

## Open questions

Each option names who does it that way. The recommendation is first.

- ~~**Q1. What happens when an item is late?**~~ **Answered 2026-11-28 (`FJS-D2423`): A — **Recommend.** No fines. Borrowing is blocked while something is overdue past a grace, and a lost item is charged at replacement cost. This is the fine-free library practice (ALA 2019 resolution; Toledo, Holbrook, Oak Park) and Chicago Tool Library's rule. Evidence that fines bring things back is thin (13.9% vs 14.2% overdue in a 1983 study).**
  - **A** — **Recommend.** No fines. Borrowing is blocked while something is
    overdue past a grace, and a lost item is charged at replacement cost. This
    is the fine-free library practice (ALA 2019 resolution; Toledo, Holbrook,
    Oak Park) and Chicago Tool Library's rule. Evidence that fines bring things
    back is thin (13.9% vs 14.2% overdue in a 1983 study).
  - **B** — A per-day fee capped at the replacement cost, charged at return
    (myTurn's model, $1–$4 a day).
  - **C** — The group chooses A or B per policy.
- ~~**Q2. Who owns the things on the shelf?**~~ **Answered 2026-11-28 (`FJS-D2424`): A — **Recommend.** Both the group and members. That is the open ground: only ToolPool.Garden does both today, and it has no queue or due dates.**
  - **A** — **Recommend.** Both the group and members. That is the open ground:
    only ToolPool.Garden does both today, and it has no queue or due dates.
  - **B** — The group only, as every library-of-things tool does.
- ~~**Q3. Can members charge each other?**~~ **Answered 2026-11-28 (`FJS-D2421`): B — Yes, into the owner's own Stripe account by direct charge with no fee. `FJS-D2200` holds unchanged, but every lending member does Stripe's identity check and bears their own disputes.** This decides whether `FJS-D2200` is
  amended.
  - **A** — **Recommend for v1.** No. Member-owned things are lent free, and
    only the group charges for its own Items (Phase 4). Buy Nothing, Peerby's
    free tier and ToolPool all work this way.
  - **B** — Yes, into the owner's own Stripe account by direct charge with no
    fee. `FJS-D2200` holds unchanged, but every lending member does Stripe's
    identity check and bears their own disputes.
  - **C** — The group collects and pays the owner out (a destination charge, or
    separate charges and transfers). Sharetribe and Airbnb work this way. It
    puts Stripe's fees, refunds and chargebacks on the platform's balance
    (Stripe's Connect charges page), and it needs the `transfer_data` key
    `conduit-stripe` refuses today.
- ~~**Q4. Deposits?**~~ **Answered 2026-11-28 (`FJS-D2422`): B — A card authorization hold. It lasts 7 days at most for an online card, up to 30 with extended authorization where eligible, so it only fits short loans. It needs `capture_method` in `conduit-stripe`. myTurn has added this.**
  - **A** — **Recommend.** None. A lost or broken item gets a replacement-cost
    payment link (Chicago Tool Library, Circulate).
  - **B** — A card authorization hold. It lasts 7 days at most for an online
    card, up to 30 with extended authorization where eligible, so it only fits
    short loans. It needs `capture_method` in `conduit-stripe`. myTurn has added this.
  - **C** — Charge the deposit and refund it at return (Lend Engine). The group
    pays Stripe's fee on money it hands back.
- **Q5. Queue, dates or both?**
  - **A** — **Recommend.** Both, chosen per Item: a queue for books and games,
    dates for tents and rooms. Circulate queues; myTurn reserves by calendar.
  - **B** — Queue only; Phase 3 is dropped.
- **Q6. Reviews of borrowers and lenders?**
  - **A** — **Recommend.** None. No library-of-things tool has them, and in a
    group people know each other. 6.3's reports and blocks carry the weight.
  - **B** — Two-sided double-blind reviews after each loan (Sharetribe, Airbnb).
- **Q7. A deposit on a loan that outlasts the card authorization?** Under
  `FJS-D2422` a deposit is a card authorization, which Stripe releases after 7
  days for an online card ([place a hold](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)).
  Extended authorization reaches 30 days only for eligible cards, so it cannot be
  promised. A dated booking authorizes at pickup, not when it is booked.
  - **A** — **Recommend.** A deposit is offered only where the loan is due within
    6 days of checkout. A longer policy carries no deposit, and 4.4's
    replacement-cost link covers a loss. Chicago Tool Library's 7-day loan
    would need a 6-day loan to take one.
  - **B** — Re-authorize off-session before the 7 days run out, which needs a
    saved card and a merchant-initiated charge. A re-authorization can be
    declined mid-loan, and the lender is then unprotected without being told.
  - **C** — Ask for extended authorization, and fall back to A when the card is
    not eligible.

## Research (2026-11-27)

Two research passes, about 30 tool calls each. "Inferred" marks a conclusion
rather than a read. myTurn's help pages returned 403 to a direct fetch, so
their claims come from search summaries.

### Library-of-things tools

- **Circulate** (Ruby for Good, used by Chicago Tool Library), read from source:
  [hold.rb](https://github.com/rubyforgood/circulate/blob/main/app/models/hold.rb),
  [loan.rb](https://github.com/rubyforgood/circulate/blob/main/app/models/loan.rb),
  [borrow_policy.rb](https://github.com/rubyforgood/circulate/blob/main/app/models/borrow_policy.rb),
  [schema.rb](https://github.com/rubyforgood/circulate/blob/main/db/schema.rb).
  - Each physical thing is one `Item`; `uniquely_numbered` switches to a counted
    quantity for consumables.
  - `BorrowPolicy` carries a 7-day default duration, a renewal limit,
    `fine_cents` (at most $10), a per-member maximum, and `requires_approval`.
  - Holds are an ordered list per Item. A ready hold expires 7 days later,
    pushed to the next open day, and expiry carries no fee. A return or a lapse
    queues `StartWaitingHoldsJob`, which promotes the next hold and emails and
    texts.
  - A member's renewal request is refused while anyone holds the Item.
  - Overdue is derived from `due_at` and `ended_at`. Fines are `Adjustment` rows.
  - Pickup appointments link to holds and loans.
- **Chicago Tool Library** ([rules](https://app.chicagotoollibrary.org/signup/documents/rules)):
  7-day loans, up to 10 items, a 7-day pickup window (1 day for high-demand
  tools), up to 4 renewals, pay-what-you-can membership, no fines, replacement
  cost invoiced, and membership revoked for repeat offenses.
- **myTurn** ([inventory](https://support.myturn.com/hc/en-us/articles/205663298-Adding-Editing-and-Deleting-Inventory-Items),
  [late fees](https://support.myturn.com/hc/en-us/articles/215521567-Default-Rental-Loan-and-Late-Fees),
  [self-renewal](https://support.myturn.com/hc/en-us/articles/229562248-Self-Renewal-of-Loans)):
  - One record per copy, with defaults per item type.
  - Calendar reservations, not a holds queue.
  - Self-renewal only after half the loan has passed and when nothing is overdue.
  - Per-day late fees capped at the replacement cost and charged at return.
  - No public price.
- **Lend Engine** ([guide](https://www.lend-engine.com/downloads/LendEngineUserGuide2024.1.pdf),
  [pricing](https://www.lend-engine.com/pricing)):
  - The waiting list emails everyone on return, with no order and no window.
  - Reminders the day before due, then overdue reminders every X days.
  - Refundable per-item deposits from the Starter plan.
  - Free to 100 items, then $12.50–$50 a month.
- **ToolTrust** ([site](https://tooltrust.org/)) is free and has reservations
  and waivers but no queue or deposits. **ToolPool.Garden**
  ([tutorial](https://toolpool.garden/tutorials/start-a-tool-library)) has
  member-owned and pool-owned items, free to 20 members, with no due dates or
  queue documented.
- **Koha** ([circulation preferences](https://koha-community.org/manual/latest/en/html/circulationpreferences.html)):
  a 7-day hold pickup default, and auto-renewal skipped when a hold exists.

### Peer-to-peer lending

- **Fat Llama** ([Owner Guarantee](https://fatllama.crisp.help/en/article/about-the-owner-guarantee-129lu8x/)):
  - The owner accepts each request, and the card is charged only on acceptance.
  - No deposits. A platform guarantee covers damage, and owners must photograph
    the item within 24 hours before the start.
- **Peerby** ([terms](https://us.peerby.com/terms-and-conditions?locale=en_US)):
  free lending leaves damage to the two people; a paid tier adds insurance.
- **Buy Nothing** ([how-to](https://docs.buynothingproject.org/howto)): lending
  is a tagged post and comments, with no workflow.
- **Sharetribe** ([process](https://raw.githubusercontent.com/sharetribe/example-processes/master/default-booking/process.edn)):
  - The payment hold expires after 15 minutes.
  - The provider has 6 days to accept, or less if the start is sooner.
  - Payout goes 2 days after the end.
  - Two-sided reviews are open for 7 days.

### Library norms

- **Fines.** The ALA's 2019 resolution urges ending them
  ([draft](http://www.ala.org/aboutala/sites/ala.org.aboutala/files/content/governance/council/council_documents/2019_ms_council_docs/ALA%20CD%2038%20RESOLUTION%20ON%20MONETARY%20LIBRARY%20FINES%20AS%20A%20FORM%20OF%20SOCIAL%20JUSTICE.pdf)).
  A 1983 study found 13.91% overdue with fines and 14.21% without
  ([ALA OIF](https://www.oif.ala.org/why-have-libraries-gone-fine-free-the-past-few-years/)).
  Fine-free libraries block borrowing instead
  ([Toledo](https://www.toledolibrary.org/policies/nofines),
  [Holbrook](https://holbrookpubliclibrary.org/fine-free)).
- **Pickup windows.** A 7-day window is the norm
  ([San José](https://www.sjpl.org/faq/holds-faqs/),
  [Gwinnett](https://ask.gwinnettpl.org/about_gcpl/faq/348676)). Auto-renewal
  runs 2–3 days before due, and only when nobody is waiting
  ([Tigard](https://www.tigard-or.gov/your-government/departments/library/using-the-library/borrow-renew-return)).

### Booking and money

- **Stripe Connect** ([charges](https://docs.stripe.com/connect/charges),
  [risk](https://docs.stripe.com/connect/risk-management),
  [accounts](https://docs.stripe.com/connect/accounts)):
  - A direct charge lands on the connected account, which bears refunds and
    disputes.
  - Destination charges and separate charges and transfers put Stripe's fees,
    refunds and chargebacks on the platform's balance.
  - A direct charge with fee payer `account` costs the platform no Connect fees
    ([fee payer](https://docs.stripe.com/connect/direct-charges-fee-payer-behavior)).
  - Manual payouts can hold funds up to 90 days (2 years in the US), and Stripe
    says it is not escrow ([manual payouts](https://docs.stripe.com/connect/manual-payouts)).
  - An authorization hold lasts 7 days for an online card
    ([place a hold](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)).
- **Inferred:** a direct charge on the owner's own account is the only flow
  that keeps a zero-fee platform off the hook for disputes.
- **Double booking.** Cal.com guards with a unique idempotency key, and it
  leaked:
  - Its own PR says a real fix needs a schema-level constraint
    ([PR 29966](https://github.com/calcom/cal.diy/pull/29966)).
  - A slot reservation could be bypassed ([issue 23974](https://github.com/calcom/cal.diy/issues/23974)).
  - Postgres solves this with an exclusion constraint on a range
    ([docs](https://www.postgresql.org/docs/current/rangetypes.html)). SQLite
    has none, which is the job `@@exclude` does here.
- **Cancellation** ([Airbnb](https://www.airbnb.com/help/article/475)):
  - Flexible gives a full refund to 24 hours before.
  - Moderate gives a full refund to 5 days before.
  - Firm gives a full refund to 30 days before and half to 7 days.
  - A host cancellation refunds the guest in full and costs the host a fee
    ([Airbnb](https://www.airbnb.com/help/article/990)).
  - Peerspace lets a host pick one of four tiers
    ([Peerspace](https://support.peerspace.com/en/articles/10119471-what-is-the-cancellation-and-refund-policy)).

**Not read:** Cal.com and Sharetribe source files (PRs and process files only),
an ACM paper on tool libraries (403), and Stripe's separate-charges page.
Airbnb's request and review rules come from search summaries.
