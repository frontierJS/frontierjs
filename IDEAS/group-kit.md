---
id: group-kit
status: proposed
dated: 2026-11-15
---

# Idea — Group kit: sign-ups, shifts, events, tickets and dues at cost

**Status: PROPOSED.** Dated 2026-11-15. Nothing here is built. Do not cite this
file as behavior; see `VERIFYING.md`. The codename is **grouppi** until Q1
picks the public name. Q2–Q9 were ruled on 2026-11-16 (`FJS-D2200`–`D2207`).

**The product.** One tool for the adult who runs a club, PTA committee, church
team, running group or neighborhood association. It covers sign-up sheets,
volunteer shifts, event pages with RSVP, paid tickets and yearly dues. Money
lands in the group's own Stripe account at Stripe's rate, with no platform
cut, no tip prompt and no ads. Members use a link in a browser and give a name
and an email, never an app or an account.

**Why this, from the research** (`§ Research` at the end of this file; the
at-cost ranking that picked Group kit is `IDEAS/at-cost-services.md`):

- No tool found bundles all five jobs into the group's own Stripe account.
- Each piece has a narrow incumbent:
  - Luma Plus charges no platform fee on tickets but costs $59/mo and has no shifts.
  - Heylo charges 5% + $0.59 per payment on its free tier.
  - Zeffy is free but nonprofit-only and funded by a pre-selected tip.
  - SignUpGenius shows ads on its free tier and adds 5% + $0.50 on payments.
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
- **Channels: email, SMS and ntfy push (Q4).** SMS is sent from the kit's own
  Telnyx number through `conduit-telnyx`, with the cost covered by donations,
  so no group is billed. A group can connect its own Telnyx key and number
  instead. ntfy is for members who want push without SMS, through the
  `@frontierjs/notifications` ntfy driver. STOP is always honored.
- **Chat and polls are in the kit (Q5, Q6).** A member chats as a link guest
  under the name they gave. Chat reuses serpgrid's `Room`/`Post` and
  `fjs-prototypes/chat` rather than starting fresh. A poll is a Sheet in vote
  mode.
- **Every seam the framework lacks is filed as an `FJS-###` row**, not worked
  around in the app. Known going in: `conduit-stripe` has payment intents,
  refunds and webhooks but no Connect. Guest access is not a gap. It rides the
  shipped `bearerClaim` (`.mint()`, `.mintOnCreate()`, `.redeem()`;
  `FJS-D339`–`D344`), which the jazzhr and maidtech portals already use with no
  framework change.
- **App home:** `fjs-prototypes/grouppi/` as its own git repo. Its own
  `PLAN.md` takes over from this file once Phase 0 scaffolds it. Ports are
  7500–7509 (API 7500, web 7501), which no prototype used on 2026-11-15.

---

### Phase 0 — Groundwork

Goal: the rulings, the re-checked facts, the pilot groups and a running
scaffold, before any feature.
Done when: Q1 is ruled, `docs/prior-art.md` cites every claim the
Why section rests on, three pilot groups have said yes, and
`fli new --here --auth` boots on 7500/7501.

- [ ] 0.1 Rule Q1, the public name. Q2–Q9 were ruled 2026-11-16.
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
  - Telnyx 10DLC or toll-free registration for the kit's number: cost, lead
    time and per-message price. Registration starts here because carrier
    review takes weeks.
  - Stripe's rules on accepting donations into the kit's own account (Q8).
- [ ] 0.3 Recruit three pilot groups of different shapes, for example a PTA
  committee, a club with dues and a church volunteer team. Write down what each
  uses today and what it pays.
- [x] 0.4 Scaffold the app and its dev login, and state the ports in `.env`.
- [x] 0.5 Draft `db/schema.lite`:
  - Models: `Group`, `Organizer`, `Sheet`, `Slot`, `Signup`, `Event`, `Rsvp`,
    `Ticket`, `Member`, `DuesPlan`, `Payment`, plus chat's `Room` and `Post`
    taken from serpgrid's schema.
  - Gates and tenancy by group, with the gaps they hit filed.
- [x] 0.6 Write a gap map (`docs/gap-map.md`) of the framework seams each phase
  needs: Connect on `conduit-stripe`, recurring dates, `.ics` feeds, scheduled
  reminders, CSV export, a real-carrier proof of `conduit-telnyx` with
  per-group credentials, ntfy topics per member, and chat for a guest with no
  account. Each gap is a filed row or an existing one cited.
- [ ] 0.7 Publish three template pages for intent searches ("volunteer sign up
  sheet", "team snack schedule", "PTA dues collection") on the kit's public
  site, so they have weeks to index before 4.6 reads them (Q9).

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

- [x] 1.1 Group and organizer roles, with several organizers per group and
  ownership handed to the next organizer.
- [x] 1.2 Sheet and slot editor: date, time, label, cap and notes, built
  mobile-first.
- [x] 1.3 Guest signup by name and email, with an emailed link to edit or
  cancel (a bearer grant).
- [x] 1.4 Waitlist that promotes on cancel and emails the promoted guest.
- [x] 1.5 Scheduled reminder emails, plus a nudge to the organizer for unfilled
  slots.
- [x] 1.6 Duplicate a sheet, and repeat it weekly or monthly.
- [x] 1.7 CSV export and a print view.
- [x] 1.8 Public group page listing open sheets.
- [ ] 1.9 SMS and ntfy reminders (Q4). They reuse 1.5's scheduler. Each
  member picks a channel, and STOP opts out. Sending uses the kit's number,
  or the group's own Telnyx when it has connected one.

### Phase 2 — Event pages and RSVP, free events

Goal: a recurring group's events live in the kit and on members' calendars.
Done when: a drive covers the loop:
- An organizer creates a weekly series.
- A guest RSVPs and is checked in by QR.
- The series' `.ics` feed opens in a calendar client with every occurrence.
- Cancelling one occurrence emails the RSVPs.

- [x] 2.1 Event page: title, place, time, capacity, description and cover
  image.
- [x] 2.2 RSVP with a guest grant, with capacity and waitlist reusing 1.4.
- [x] 2.3 Recurring series, with single occurrences that can be edited or
  cancelled.
- [x] 2.4 Calendar feed per group and per series, and add-to-calendar per event.
- [ ] 2.5 QR check-in on the organizer's phone.
- [x] 2.6 Message the RSVPs of one event by email.
- [x] 2.7 Polls (Q5): a Sheet in vote mode. A date vote picks a date and
  creates the Event, and a general question uses the same model.
- [x] 2.8 Group chat (Q6), one room per group and per event, reusing
  serpgrid's chat and `fjs-prototypes/chat`. Guests post through their link.
  An organizer removes a post or revokes a link. A test asserts that no chat
  path requires an account.

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

- [x] 3.1 Minimal abuse path, before any group can take money (Q3 opens
  payments to every group):
  - Rate limits on group creation and signups.
  - A report link on every public page and chat post.
  - An operator switch that suspends a group.
- [x] 3.2 Connect support in `conduit-stripe` per Q2, filed and built as
  framework work:
  - Onboarding link and account status.
  - Direct charges.
  - Per-account webhooks that extend the connector's existing signature
    verifier, rather than adding a second one.
- [x] 3.3 Onboarding inside the kit: the treasurer connects or creates the
  group's account, and the kit shows what Stripe will ask for (EIN or SSN).
- [x] 3.4 Ticket types on an event: price, quantity, sales window and promo codes.
- [x] 3.5 Checkout that shows the fee up front: who pays it, and what the
  group receives.
- [x] 3.6 Refunds and cancellations from the organizer dashboard, with payment
  rows reconciled from webhooks and replays idempotent.
- [x] 3.7 A test that asserts every charge the kit creates has no
  `application_fee_amount` and goes to the group's account. This test is what
  keeps the no-cut promise true.
- [ ] 3.8 Tax adviser review of the direct-charge, no-fee setup (facilitator
  and 1099-K duties, a treasurer's chargeback liability), citing 3.7. The result is written into `docs/`.

### Phase 4 — Dues

Goal: a club collects a year of dues and knows who has paid.
Done when, in test mode, a drive covers the loop:
- Twenty members get a dues link.
- Some pay by card and some by ACH.
- The roster shows paid and unpaid.
- A renewal reminder goes only to the unpaid.
- The treasurer exports the year.

- [x] 4.1 Member roster: name, email and status, imported from CSV.
- [x] 4.2 Dues plan: amount, period, and card or ACH, charged to the group's
  account.
- [x] 4.3 Renewal reminders and a paid/unpaid view.
- [x] 4.4 Treasurer handoff. What moves when the person who owns the Stripe
  account steps down is checked against Stripe's docs in 0.2.
- [x] 4.5 Year-end export for the group's books.
- [ ] 4.6 Read 0.7's pages: indexed or not, and their rank for each target
  query against SignUpGenius and SignUp.com. Q9 is ruled A (`FJS-D2203`),
  so this checks its reopen path to B.

### Phase 5 — Pilots live

Goal: the three pilot groups run their real season on the kit.
Done when: each pilot group has run the kit for 30 days with no fallback to its
old tool, and each one's complaints are rows in the app's issue list.

- [ ] 5.1 Import from a SignUpGenius export or a spreadsheet.
- [ ] 5.2 Deploy through Basecamp with backups and alerting. The restore is
  rehearsed once.
- [ ] 5.3 Help pages for organizers and a plain-language page for members.
- [ ] 5.4 Terms and privacy, adults only, with a data-export and deletion path,
  SMS consent and STOP wording, and chat conduct rules.
- [ ] 5.5 Onboard the pilots, then review with each at week 1 and week 4.

### Phase 6 — Running at cost

Goal: the kit runs free for every group, with donations covering a cost that
is public and explained (Q8).
Done when: a public costs page shows the real monthly running cost, SMS
included, beside the donations received, and the first donations from groups
outside the pilots arrive.

- [ ] 6.1 Cost ledger: hosting, email and SMS sending, backups, insurance and
  support hours, in the open.
- [ ] 6.2 Donation page into the kit's own Stripe account, never a tip on a
  group's checkout, so 3.7 holds. Per-group SMS volume caps if the ledger needs
  them. The reopen path to Q8 B is cost outrunning donations.
- [ ] 6.3 Abuse and fraud handling for connected accounts and spam signups.
- [ ] 6.4 Support channel and its response promise.
- [ ] 6.5 Entity and liability choice (LLC, nonprofit or co-op), with an
  adviser. Rule it before 6.2 takes donations, since the entity decides
  whether they are tax-deductible.

---

## Open questions

- **Q1 — The public name.** The codename is grouppi (owner, 2026-11-15), so
  the repo, package and ports can be scaffolded now. The public name is still
  open. The shortlist from the 2026-11-15 search: Corrally (corrally.app),
  Hivvi (hivvi.app), Covykit (covykit.com), Bunchkin (bunchkin.app). Each one
  still needs a USPTO search in classes 9 and 42 and an app-store check.
- ~~**Q2 — Stripe account model.**~~ **Answered 2026-11-16 (`FJS-D2200`): C — controller properties / Accounts v2, set to behave like Standard.**
  - **A** — legacy Standard.
  - **B** — Express: Stripe-hosted onboarding, platform carries liability,
    extra cost per account.
  - **C** — controller properties / Accounts v2, set to behave like Standard.
  - **Recommend C.** The group owns the account and uses the full Dashboard,
    and Stripe steers new platforms this way. Who carries losses and who pays
    per-account fees are properties the platform sets, so 0.2 records the
    values and their cost before this is ruled.
  - **Reopen path:** A, if Accounts v2 needs a migration the platform pays for.
- ~~**Q3 — Require nonprofit status to take payments?**~~ **Answered 2026-11-16 (`FJS-D2201`): B — no; Stripe's own identity checks are the gate.**
  - **A** — yes, an EIN, as Zeffy does.
  - **B** — no; Stripe's own identity checks are the gate.
  - **Recommend B.** Clubs that are not 501(c)(3)s are the open ground, and a
    gate hands them back to Venmo.
- ~~**Q4 — SMS reminders.**~~ **Answered 2026-11-16 (`FJS-D2206`): A — at cost, passed through.**
  - **A** — at cost, passed through.
  - **B** — defer and use email only.
  - **Recommend B for v1.** It carries carrier-registration and per-message
    cost; reopen it after pilot feedback.
- ~~**Q5 — Scheduling polls.**~~ **Answered 2026-11-16 (`FJS-D2204`): C — full polls.**
  - **A** — link out to Rallly or When2meet.
  - **B** — a bare date vote on a sheet.
  - **C** — full polls.
  - **Recommend A now and B later**, since a sheet's slots are most of a date
    vote already.
- ~~**Q6 — Chat.**~~ **Answered 2026-11-16 (`FJS-D2205`): B — basic group chat to match Heylo.**
  - **A** — defer; members stay in WhatsApp, GroupMe or Discord.
  - **B** — basic group chat to match Heylo.
  - **Recommend A.** Replacing chat is the biggest install ask, and
    email-to-RSVPs (2.6) covers announcements.
- ~~**Q7 — Product or stressor?**~~ **Answered 2026-11-16 (`FJS-D2202`): A, run with stressor discipline.**
  - **A** — a Kobami product, with framework gaps filed on the way.
  - **B** — a stressor: an instrument whose output is FJS rows.
  - **Recommend A, run with stressor discipline.** The pilots and Phase 6 only
    make sense for a product, and the Connect gap gets filed either way. It
    lives in its own `fjs-prototypes` repo, so it costs the framework's CI
    nothing.
  - **When the two goals conflict, a filed seam is never deferred to meet a
    pilot date.**
- ~~**Q8 — Price (rule before Phase 6).**~~ **Answered 2026-11-16 (`FJS-D2207`): A — free, donation-funded.**
  - **A** — free, donation-funded.
  - **B** — free for sheets and events, a flat yearly fee once a group takes
    payments.
  - **C** — a flat yearly fee for every group, on a sliding scale.
  - Lean B, ruled with the real cost ledger in hand. The earlier report's
    arithmetic: $60 a year needs about 1,700 paying groups per $100k of budget.
  - A flat yearly fee is a subscription billed to the group by the kit, not a
    cut of the group's payments. It keeps the no-platform-cut promise and 3.7
    still holds.
- ~~**Q9 — First marketing channel (rule at 4.6, before Phase 5).**~~ **Answered 2026-11-16 (`FJS-D2203`): A, low confidence.**
  - **A** — organizer-led loop first: guest-facing links that show the kit to
    non-members, organizer-to-organizer referral, and one activation metric
    in Heja's style. SEO comes second.
  - **B** — SEO template pages first, aimed at intent searches the way
    SignUpGenius does, with intent-based paid search later as Zeffy did.
  - The two can both happen eventually. The real decision is whether pilot
    season spends its effort on template pages.
  - **Recommend A, low confidence.** The guest links already ride
    `bearerClaim` in Phases 1–2, so A costs almost no extra build. Every group
    app in § Marketing grew this way. The open-web channels are tightening.
  - **Reopen path:** B, if 0.7's pages index and rank on page one for their
    queries.
  - Paylode (`IDEAS/paylode.md`) measures A: its Phase 3 loop events are
    this metric.

---

## Marketing

The research is from 2026-11-15. Every growth story below is company-reported
or secondary; the research found no primary channel mix, K-factor or CAC for
any group app. Reddit organizer threads (r/PTA, r/volunteer) and Facebook
groups could not be read. The landscape of marketing tools, and why a channel
bet is measured rather than bought, is `IDEAS/paylode.md` § Research.

**How group apps grew: an organizer exposes non-users.**
- **TeamSnap** reached its first million users reportedly with no marketing,
  spreading through coaches and parents within each team ([TeamSnap](https://www.teamsnap.com/company/press-releases/teamsnap-announces-10-million-customers-now-use-its-sports-team-management)).
- **Spond** launches new markets without advertising. It reached 10% of
  Norway by 2021 and 3.3M MAU by November 2024 ([Spond](https://www.spond.com/news-and-blog/10-years-of-spond-sports-team-app/)).
- **SignUpGenius** was bootstrapped for about nine years and reached 72M
  participants by 2018, with no participant account required. It also runs
  template pages for "sign up sheet" searches, with no traffic-share data
  found ([templates](https://www.signupgenius.com/resources/volunteer-sign-up-sheet-templates)).
- **Partiful's** invite link is its landing page, and guests RSVP without an
  account. It had 500k MAU in Q1 2025 ([NoGood](https://nogood.io/blog/partiful-marketing-strategy/)).
- **Givebutter** shows the platform to donors with every campaign.
- **Meetup** grew as attendees became organizers, and only promoted itself
  from about 2017.
- **Heja** (13 staff, 130k+ teams) tracks one activation metric: the share of
  teams with six members within seven days. It runs weekly hypothesis
  experiments ([scilla.studio](https://scilla.studio/insights/dd-heja-130k-members-13-people/)).

**The counterexample is Zeffy.** Cold-calling about 1,000 nonprofits yielded
about 10 signups. Google Ads on "fundraising platform for nonprofits" became
the engine: signups rose about tenfold in six months, and spend went from $5K
to $500K/mo over three years ([pmf.show](https://www.pmf.show/blog/zeffy-francois-de-kerret-30x-growth-after-vc-passed-free-nonprofit-fundraising)).
That was paid search on an intent the product answers directly, after years
and two pivots.

**What weighs against SEO pages (Q9 B).**
- Incumbent template libraries: SignUpGenius, SignUp.com and Grasshopper
  Signup (345 templates).
- Google's scaled-content spam policy.
- AI Overviews' click loss, reportedly 58% for top results (Ahrefs,
  secondary).

**Where organizers find tools.**
- **PTO Today's "PTO and PTA Leaders & Volunteers"** private Facebook group has
  about 60,000 members, and "many of you come to the group looking for vendor
  recommendations". It has banned vendor promotion since 2016, so the way in
  is a member posting about the kit ([group](https://www.ptotoday.com/facebookgroup), [rules post](http://www.ptotoday.com/pto-today-articles/updates-to-our-pto-and-pta-leaders-group-on-facebook)).
- **Paid reach** goes through the same publisher. Its Vendor Directory is free
  for a basic listing, and it claims $15–$20 per lead for fundraising vendors.
  The Leader Lowdown newsletter reaches 40–54k, at a $5,000 sponsor takeover
  per issue ([advertise](https://www.ptotoday.com/advertise)). These are seller
  claims.
- **Tools leaders report using**: Remind or GroupMe for texts, a private
  Facebook group for board business, plus BAND and Slack.
- **Mandated platforms close a door.** Little League makes one registration
  provider mandatory (Sports Connect, moving to PlayMetrics from 2027), so the
  open ground is the unmandated work around it: volunteer shifts, snack lists
  and team parents ([Little League](https://www.littleleague.org/partnerships/official-sponsors/sports-connect/)).
- **Organizer friction the kit answers**: a forced app download or login
  loses busy parents. A single volunteer often holds the list, the dues and the
  group text, and that breaks when officers change (vendor-sourced).

---

## Research (2026-11-15)

Four research runs on 2026-11-15 covered sign-ups, events, dues and
all-in-one apps. Most figures come from search summaries or competitor-written
blogs, several official pricing pages failed to load, and Reddit, G2 and
Capterra could not be read. Re-check a price at the vendor before use. "Nothing bundles all five" is a finding about what the researchers could
see, not proof. The Why bullets hold the headline claims. This section holds
the rest.

### The map: no tool across all four areas

- **Sign-ups.** SignUpGenius is free with ads, about $8.99–$59.99/mo paid
  (third-party), and sits inside the PE-backed Lumaverse ([Mergr](https://mergr.com/transaction/lumaverse-technologies-acquires-signupgenius)).
  SignUp.com runs $99.99–$499.99 a year, and its paid tiers still show an
  "ad-free upgrade available" line ([pricing](https://signup.com/pricing)).
  Free sheets (Perfect Potluck, VolunteerSignup.org, Google Forms) take no
  payments, and Forms has no slot caps or reminders ([Zelos](https://getzelos.com/apps-for-sign-up-sheets)).
  Shift-scheduling suites start near $119–$143/mo ([Capterra](https://www.capterra.com/p/79209/VolunteerHub/pricing/)),
  which prices out a PTA committee.
- **Events.** Luma Free takes 5% + Stripe and Plus is $59/mo at 0% ([pricing](https://luma.com/pricing)).
  Meetup's free tier bars recurring events and dues ([Nexspark](https://nexspark.org/journal/meetup-cost-worth-it)).
  Hi.Events hosted (1.25% + $0.60) and pretix (2.5%, capped at 15 euros) pay
  to the group's own Stripe, with no shifts or dues ([Hi.Events](https://hi.events/pricing), [pretix](https://pretix.eu/about/en/pricing)).
- **Dues.** Cheddar Up Free is 3.95% + $0.95 per card, payer-paid by default
  ([pricing](https://www.cheddarup.com/pricing/)). Wild Apricot is $66/mo for
  100 contacts ([pricing](https://www.wildapricot.com/pricing)). Open
  Collective's largest US fiscal host dissolved in 2024 ([statement](https://blog.opencollective.com/open-collective-official-statement-ocf-dissolution/)).
  Venmo and Zelle terms bar personal accounts from collecting for a group
  ([Zelle agreement](https://www.zellepay.com/legal/user-service-agreement)).
- **All-in-one.** Heylo runs from $0 at 5% + $0.59 to $199/mo at 1% + $0.10
  ([pricing](https://heylo.com/pricing)). Spond is $1.00 + 3.29% per product,
  Stripe included ([help](https://help.spond.com/app/en/articles/118091-payments-costs-in-the-spond-app)).
  Planning Center sells groups, registration and shift scheduling as roughly
  $10–$20 modules (third-party, [ChurchMemberPro](https://churchmemberpro.com/blog/tithely-vs-planning-center/)).
  It is congregation-shaped, and it proves organizations pay for a bundle.

### Fees: raw Stripe is the floor

Stripe is 2.9% + $0.30 per card and ACH is 0.8% capped at $5 ([Stripe](https://stripe.com/pricing)).
The tables are the researchers' arithmetic from rate cards, with no refunds or
disputes. Cost per ticket, platform fee and Stripe fee together:

| Option | $10 | $25 | Basis |
|---|---|---|---|
| Raw Stripe, Luma Plus | $0.59 | $1.03 | Plus adds $708/yr |
| Zeffy | $0 | $0 | payer tip instead, nonprofits only |
| Givebutter, tips off | $0.89 | $1.78 | 3% + Stripe ([pricing](https://givebutter.com/pricing)) |
| Heylo Base | $1.09 | $1.84 | 5% + $0.59 |
| Luma Free | $1.09 | $2.28 | 5% + Stripe |
| Hi.Events hosted | $1.32 | $1.94 | 1.25% + $0.60 + Stripe |
| Spond | $1.33 | $1.82 | 3.29% + $1.00 inclusive |
| SignUpGenius | $1.59 | $2.78 | 5% + $0.50 + Stripe |
| Eventbrite | $2.45 | $3.44 | 3.7% + $1.79 + 2.9% ([pricing](https://www.eventbrite.com/organizer/pricing/)) |
| Partiful | $3.00 | $4.50 | 10% + $2, Luma's estimate ([Luma](https://help.luma.com/p/luma-vs-partiful)) |

A percentage plus a flat fee is brutal under $15, where dues live. Luma Plus
matches Stripe only after $59/mo.

Dues, 100 members at one $50 card payment each, per year:

| Option | Cost to the group | Basis |
|---|---|---|
| Stripe ACH | $40 | 0.8% capped at $5 |
| Venmo business | $105 | 1.9% + $0.10, third-party |
| Stripe card | $175 | 2.9% + $0.30 |
| Zeffy | $0 | payers tip, about $200 at its cited 4% average, about $850 at 17% ([Nonprofit Software Guide](https://nonprofitsoftwareguide.com/blog/zeffy-tip-model-explained/)) |
| Spond | $264.50 | 3.29% + $1.00 |
| Cheddar Up Free | $292.50 | 3.95% + $0.95 |
| Givebutter, tips off | $325 | 3% + Stripe |
| Luma Free | $425 | 5% + Stripe, memberships not stated |
| MembershipWorks | $595 | $420 plan + $175 Stripe ([pricing](https://membershipworks.com/pricing/)) |
| Luma Plus | $883 | $708 + $175 |

The Why bullets carry Heylo, SignUpGenius and Wild Apricot. Heylo is $484 with
Stripe on top. On the platform side, Stripe's Connect page prices
"Stripe handles pricing" at $0 and "you handle pricing" at about $39.50 a year
per group on $5,000 of monthly payouts ([Stripe Connect pricing](https://stripe.com/connect/pricing)).
Step 0.2 records which Q2 setting buys which.

### The narrow, taxed or tip-funded incumbents

- **Luma** is the strongest honest rival on tickets. Plus adds recurring
  events, waitlists, approval-required registration, coupons, check-in, CSV
  export and paid memberships ([Luma](https://help.luma.com/p/luma-vs-partiful)).
  No complaint corpus was found.
- **Heylo** gives unlimited members, events and RSVPs on every tier, with
  directories and chat free ([Heylo vs Meetup](https://www.heylo.com/alternatives/meet-up),
  vendor marketing). No page says whether it pays out to the group's Stripe.
  No volunteer scheduling or independent complaints were found.
- **Zeffy** complaints cluster on the tip: a pre-selected 17% on $50 that the
  nonprofit cannot change, and holds of weeks. Zeffy says holds occur when
  Stripe needs to verify details ([Zeffy](https://www.zeffy.com/compare/zeffy-vs-stripe),
  via search summary). Whether it or Givebutter accepts unincorporated clubs
  was not confirmed.
- **SignUpGenius** already routes payments to the organizer's own Stripe
  ([SignUpGenius](https://sugeni.us/blog/signupgenius-payments-stripe)), so
  "own Stripe" alone is not new. Trustpilot reviewers cite ads on a paid
  trial, price and clunky mobile creation, though it holds 4.3 from 4,132
  reviews ([Trustpilot](https://www.trustpilot.com/review/signupgenius.com)).
- **Meetup** is the one documented mass-switching event: an organizer price
  rise in June 2024, the first since 2019, after the Bending Spoons purchase.
  Switchers went to Heylo and Luma ([Nexspark](https://nexspark.org/journal/meetup-alternatives)).

### The unincorporated-club hurdle

Every dues and ticket tool is priced for "nonprofits" or "organizations", and
none says how an unincorporated club passes onboarding.

- Stripe requires a verifiable tax ID and the SSN of associated individuals,
  even with an EIN, so a volunteer's identity attaches to the account ([Stripe support](https://support.stripe.com/questions/signing-up-for-a-us-stripe-account-without-a-tax-id-or-employer-id-number)).
- An unregistered business needs a US-located representative and a physical
  address, with no PO box ([Stripe](https://support.stripe.com/questions/requirements-for-having-a-us-stripe-account)).
- Stripe's nonprofit rate of 2.2% + $0.30 reportedly needs a registered
  501(c)(3) with 80% of volume as donations, so dues and tickets may not
  qualify ([Givebutter blog](https://givebutter.com/blog/stripe-for-nonprofits),
  a competitor).
- Under direct charges the connected account carries dispute liability ([Stripe docs](https://docs.stripe.com/connect/accounts)).
  Whether a treasurer is personally liable for chargebacks on a club with no
  legal entity was not researched.
- No source covers handing a Stripe account, roster and payment history to the
  next treasurer.

### What an entrant must match on day one

Mostly inference, not published fact.

- **Match:** the fee shown up front, ACH beside cards for dues, no tip and no
  ads including in email, name-and-email RSVP with no app or account, caps,
  waitlist and email reminders, several organizers on the free tier, recurring
  events with one-click duplication, QR check-in, promo codes, dashboard
  refunds, CSV export, unlimited free events, and import from SignUpGenius.
- **Defer:** SMS, chat, swaps, hours tracking, waivers.
- **Do not chase:** a volunteer CRM at VolunteerHub scale, a marketplace, a
  member app. 75% of US adults prefer a mobile site to an app ([survey](https://www.hostingadvice.com/studies/survey-mandatory-app-downloads/),
  not about groups).

### Owner decisions the report framed

Each maps to a Q above, and the report leaned the way each Q recommends. What
the Qs do not carry:

- **Q2.** Stripe labels Standard, Express and Custom legacy and says Express
  and Custom carry an additional cost ([docs](https://docs.stripe.com/connect/accounts)).
  Under C the group completes its own verification and bears disputes.
- **Q3.** Stripe's nonprofit rate likely does not apply to dues and tickets
  either way, and a gate removes the main separation from Zeffy.
- **Q4.** Rallly is free for 3 open polls with no voter login ([pricing](https://rallly.co/pricing)).
  SMS is a paid-tier feature elsewhere: SignUp.com Starter at $99.99 a year
  includes unlimited texts. GroupMe ended two-way SMS in August 2026
  ([RallyText](https://rallytext.app/groupme-sms-shutdown), a competitor).
- **Q6.** One homeschool group says Discord chat moved into Heylo raised
  participation ([Heylo blog](https://www.heylo.com/blog/meetup-move-homeschool-group), vendor).
- **Build order.** The all-in-one researcher's inference is a paid-RSVP event
  page first, then shifts, then dues. The report notes that shift sheets need
  no Stripe, so shipping them first meets SignUpGenius's installed base where
  its sharpest complaint, ads, is cheapest to answer.

No source tested whether organizers would accept an at-cost model.
