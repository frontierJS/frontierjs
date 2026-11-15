---
id: group-kit
status: proposed
dated: 2026-11-15
---

# Idea — Group kit: sign-ups, shifts, events, tickets and dues at cost

**Status: PROPOSED.** Dated 2026-11-15. Nothing here is built. Do not cite this
file as behavior; see `VERIFYING.md`. "Group kit" is a working name (Q1).

**The product.** One tool for the adult who runs a club, PTA committee, church
team, running group or neighborhood association. It covers sign-up sheets,
volunteer shifts, event pages with RSVP, paid tickets and yearly dues. Money
lands in the group's own Stripe account at Stripe's rate, with no platform
cut, no tip prompt and no ads. Members use a link in a browser and give a name
and an email, never an app or an account.

**Why this, from the research** (`reports/Group kit competitive landscape.md`,
with notes beside it in `research_notes/`):

- No tool found bundles all five jobs into the group's own Stripe account.
- Each piece has a narrow incumbent:
  - Luma Plus charges no platform fee on tickets but costs $59/mo and has no shifts.
  - Heylo charges 5% + $0.59 per payment on its free tier.
  - Zeffy is free but nonprofit-only and funded by a pre-selected tip.
  - SignUpGenius shows ads on paid tiers and adds 5% + $0.50 on payments.
  - **LongTable** ([longtable.app](https://longtable.app/), found 2026-11-15
    during the name search, after the report) is the closest bundle. It covers
    roster, events with waitlist and check-in, sign-up slots, dues, a website
    and texting, at $20–75/mo. It charges 3.8% + $0.30 per payment on paid
    plans and 6.3% + $0.30 on its 25-member free plan, has no ticketing, and
    does not name its processor. Its page says nothing about volunteer shifts.
  - **My Clubs Manager** ([myclubsmanager.com](https://myclubsmanager.com/)) is
    $60/yr for a club, built by one Lions Club member. It has no-account
    sign-up sheets and tracks dues in a ledger. Online payment is "coming soon".
- The open ground is groups that are not 501(c)(3)s. On $50 dues × 100
  members, raw Stripe is $175 a year by card or $40 by ACH. Heylo comes to
  about $309, SignUpGenius $475 and Wild Apricot about $888.
- **The evidence is thin in places.** Most prices come from search summaries
  or competitor blogs, and Heylo's payout model is unverified. Step 0.2
  re-checks the claims the plan rests on.

**Scope calls, settled before the run.**

- **Adult organizers only.** No member account exists to be under 13, and the
  terms say participants are adults. A parent signing up for a PTA slot is the
  adult. Youth-league registration is out of v1.
- **Each group owns its Stripe account.** The kit never holds funds and
  charges no application fee, so no marketplace-facilitator or 1099-K duty
  lands on the operator. A tax adviser confirms that before Phase 3 ships (3.8).
- **Email is the only channel in v1.** SMS and chat wait on Q4 and Q6.
- **Every seam the framework lacks is filed as an `FJS-###` row**, not worked
  around in the app. Known going in: `conduit-stripe` has payment intents,
  refunds and webhooks but no Connect. Guest access is not a gap. It rides the
  shipped `bearerClaim` (`.mint()`, `.mintOnCreate()`, `.redeem()`;
  `FJS-D339`–`D344`), which the jazzhr and maidtech portals already use with no
  framework change.
- **App home:** `fjs-prototypes/<name>/` as its own git repo. Its own
  `PLAN.md` takes over from this file once Phase 0 scaffolds it. Ports are
  7500–7509 (API 7500, web 7501), which no prototype used on 2026-11-15.

---

### Phase 0 — Groundwork

Goal: the rulings, the re-checked facts, the pilot groups and a running
scaffold, before any feature.
Done when: Q1–Q7 are ruled, `docs/prior-art.md` cites every claim the
Why section rests on, three pilot groups have said yes, and
`fli new --here --auth` boots on 7500/7501.

- [ ] 0.1 Rule Q1–Q7 one at a time with the owner.
- [ ] 0.2 Re-check the load-bearing facts from first-party pages, and write
  links and dates into `docs/prior-art.md`:
  - Heylo's payout model.
  - Stripe Connect's current account types (controller properties, Accounts
    v2). Record the exact property values chosen (who carries losses, through
    `losses.payments`, and who pays Stripe's fees) and what the platform pays
    per account under them.
  - Stripe's onboarding for an unincorporated association (EIN vs. SSN).
  - Luma Plus's terms.
  - SignUpGenius pricing.
- [ ] 0.3 Recruit three pilot groups of different shapes, for example a PTA
  committee, a club with dues and a church volunteer team. Write down what each
  uses today and what it pays.
- [ ] 0.4 Scaffold the app and its dev login, and state the ports in `.env`.
- [ ] 0.5 Draft `db/schema.lite`:
  - Models: `Group`, `Organizer`, `Sheet`, `Slot`, `Signup`, `Event`, `Rsvp`,
    `Ticket`, `Member`, `DuesPlan`, `Payment`.
  - Gates and tenancy by group, with the gaps they hit filed.
- [ ] 0.6 Write a gap map (`docs/gap-map.md`) of the framework seams each phase
  needs: Connect on `conduit-stripe`, recurring dates, `.ics` feeds, scheduled
  reminders and CSV export. Each gap is a filed row or an existing one cited.

### Phase 1 — Shift sheets, no money

Goal: an organizer replaces a SignUpGenius sheet end to end without anyone
making an account.
Done when: a browser drive at phone width goes through the whole loop:
- An organizer builds a sheet of slots with caps.
- Three guests sign up by name and email.
- One guest cancels from the emailed link, and the waitlist promotes.
- The reminder email is captured.
- The CSV export matches the rows.
After the drive passes, one pilot group runs one real sheet.

- [ ] 1.1 Group and organizer roles, with several organizers per group and
  ownership handed to the next organizer.
- [ ] 1.2 Sheet and slot editor: date, time, label, cap and notes, built
  mobile-first.
- [ ] 1.3 Guest signup by name and email, with an emailed link to edit or
  cancel (a bearer grant).
- [ ] 1.4 Waitlist that promotes on cancel and emails the promoted guest.
- [ ] 1.5 Scheduled reminder emails, plus a nudge to the organizer for unfilled
  slots.
- [ ] 1.6 Duplicate a sheet, and repeat it weekly or monthly.
- [ ] 1.7 CSV export and a print view.
- [ ] 1.8 Public group page listing open sheets.

### Phase 2 — Event pages and RSVP, free events

Goal: a recurring group's events live in the kit and on members' calendars.
Done when: a drive covers the loop:
- An organizer creates a weekly series.
- A guest RSVPs and is checked in by QR.
- The series' `.ics` feed opens in a calendar client with every occurrence.
- Cancelling one occurrence emails the RSVPs.

- [ ] 2.1 Event page: title, place, time, capacity, description and cover
  image.
- [ ] 2.2 RSVP with a guest grant, with capacity and waitlist reusing 1.4.
- [ ] 2.3 Recurring series, with single occurrences that can be edited or
  cancelled.
- [ ] 2.4 Calendar feed per group and per series, and add-to-calendar per event.
- [ ] 2.5 QR check-in on the organizer's phone.
- [ ] 2.6 Message the RSVPs of one event by email.

### Phase 3 — The group's own Stripe, paid tickets

Goal: a ticket sale lands in the group's Stripe account and the kit takes
nothing.
Done when, in Stripe test mode:
- A group connects a Stripe account.
- A guest buys two $10 tickets.
- The connected account shows the charge with no application fee.
- A refund from the kit's dashboard reverses it.
- Replaying the webhook changes nothing.
- The no-fee test in 3.7 passes.

- [ ] 3.1 Minimal abuse path, before any group can take money (Q3 opens
  payments to every group):
  - Rate limits on group creation and signups.
  - A report link on every public page.
  - An operator switch that suspends a group.
- [ ] 3.2 Connect support in `conduit-stripe` per Q2, filed and built as
  framework work:
  - Onboarding link and account status.
  - Direct charges.
  - Per-account webhooks that extend the connector's existing signature
    verifier, rather than adding a second one.
- [ ] 3.3 Onboarding inside the kit: the treasurer connects or creates the
  group's account, and the kit shows what Stripe will ask for (EIN or SSN).
- [ ] 3.4 Ticket types on an event: price, quantity and sales window.
- [ ] 3.5 Checkout that shows the fee up front: who pays it, and what the
  group receives.
- [ ] 3.6 Refunds and cancellations from the organizer dashboard, with payment
  rows reconciled from webhooks and replays idempotent.
- [ ] 3.7 A test that asserts every charge the kit creates has no
  `application_fee_amount` and goes to the group's account. This test is what
  keeps the no-cut promise true.
- [ ] 3.8 Tax adviser review of the direct-charge, no-fee setup (facilitator
  and 1099-K duties), citing 3.7. The result is written into `docs/`.

### Phase 4 — Dues

Goal: a club collects a year of dues and knows who has paid.
Done when, in test mode, a drive covers the loop:
- Twenty members get a dues link.
- Some pay by card and some by ACH.
- The roster shows paid and unpaid.
- A renewal reminder goes only to the unpaid.
- The treasurer exports the year.

- [ ] 4.1 Member roster: name, email and status, imported from CSV.
- [ ] 4.2 Dues plan: amount, period, and card or ACH, charged to the group's
  account.
- [ ] 4.3 Renewal reminders and a paid/unpaid view.
- [ ] 4.4 Treasurer handoff. What moves when the person who owns the Stripe
  account steps down is checked against Stripe's docs in 0.2.
- [ ] 4.5 Year-end export for the group's books.

### Phase 5 — Pilots live

Goal: the three pilot groups run their real season on the kit.
Done when: each pilot group has run the kit for 30 days with no fallback to its
old tool, and each one's complaints are rows in the app's issue list.

- [ ] 5.1 Import from a SignUpGenius export or a spreadsheet.
- [ ] 5.2 Deploy through Basecamp with backups and alerting. The restore is
  rehearsed once.
- [ ] 5.3 Help pages for organizers and a plain-language page for members.
- [ ] 5.4 Terms and privacy, adults only, with a data-export and deletion path.
- [ ] 5.5 Onboard the pilots, then review with each at week 1 and week 4.

### Phase 6 — Running at cost

Goal: the kit pays its own way at a price that is public and explained.
Done when: a public costs page shows the real monthly running cost, the price
follows from it (Q8), and the first groups outside the pilots pay.

- [ ] 6.1 Cost ledger: hosting, email sending, backups, insurance and support
  hours, in the open.
- [ ] 6.2 Price per Q8, and a sliding scale.
- [ ] 6.3 Abuse and fraud handling for connected accounts and spam signups.
- [ ] 6.4 Support channel and its response promise.
- [ ] 6.5 Entity and liability choice (LLC, nonprofit or co-op), with an
  adviser.

---

## Open questions

- **Q1 — The name.** "Group kit" is a placeholder.
- **Q2 — Stripe account model.**
  - **A** — legacy Standard.
  - **B** — Express: Stripe-hosted onboarding, platform carries liability,
    extra cost per account.
  - **C** — controller properties / Accounts v2, set to behave like Standard.
  - **Recommend C.** The group owns the account and uses the full Dashboard,
    and Stripe steers new platforms this way. Who carries losses and who pays
    per-account fees are properties the platform sets, so 0.2 records the
    values and their cost before this is ruled.
  - **Reopen path:** A, if Accounts v2 needs a migration the platform pays for.
- **Q3 — Require nonprofit status to take payments?**
  - **A** — yes, an EIN, as Zeffy does.
  - **B** — no; Stripe's own identity checks are the gate.
  - **Recommend B.** Clubs that are not 501(c)(3)s are the open ground, and a
    gate hands them back to Venmo.
- **Q4 — SMS reminders.**
  - **A** — at cost, passed through.
  - **B** — defer and use email only.
  - **Recommend B for v1.** It carries carrier-registration and per-message
    cost; reopen it after pilot feedback.
- **Q5 — Scheduling polls.**
  - **A** — link out to Rallly or When2meet.
  - **B** — a bare date vote on a sheet.
  - **C** — full polls.
  - **Recommend A now and B later**, since a sheet's slots are most of a date
    vote already.
- **Q6 — Chat.**
  - **A** — defer; members stay in WhatsApp, GroupMe or Discord.
  - **B** — basic group chat to match Heylo.
  - **Recommend A.** Replacing chat is the biggest install ask, and
    email-to-RSVPs (2.6) covers announcements.
- **Q7 — Product or stressor?**
  - **A** — a Kobami product, with framework gaps filed on the way.
  - **B** — a stressor: an instrument whose output is FJS rows.
  - **Recommend A, run with stressor discipline.** The pilots and Phase 6 only
    make sense for a product, and the Connect gap gets filed either way. It
    lives in its own `fjs-prototypes` repo, so it costs the framework's CI
    nothing.
  - **When the two goals conflict, a filed seam is never deferred to meet a
    pilot date.**
- **Q8 — Price (rule before Phase 6).**
  - **A** — free, donation-funded.
  - **B** — free for sheets and events, a flat yearly fee once a group takes
    payments.
  - **C** — a flat yearly fee for every group, on a sliding scale.
  - Lean B, ruled with the real cost ledger in hand. The earlier report's
    arithmetic: $60 a year needs about 1,700 paying groups per $100k of budget.
  - A flat yearly fee is a subscription billed to the group by the kit, not a
    cut of the group's payments. It keeps the no-platform-cut promise and 3.7
    still holds.
