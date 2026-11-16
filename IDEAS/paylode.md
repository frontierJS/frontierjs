---
id: paylode
status: proposed
dated: 2026-11-15
---

# Idea — Paylode: one channel bet, measured

**Status: PROPOSED.** Dated 2026-11-15. Nothing here is built. Do not cite this
file as behavior; see `VERIFYING.md`. "Paylode" is a working name (Q1).

**The product.** A tool that makes a founder commit to one marketing channel
for a fixed window, and then tells them whether it worked. It covers four
jobs:
- **A bet.** One channel and its specific targets: communities, searches or
  lists. It has a hypothesis, a window of about 90 days, and a stop signal
  agreed in advance.
- **A community ledger.** Each community's self-promotion rules, its cap, and
  the date we last posted there.
- **Attribution.** Each signup and payment traced to a channel by referrer,
  UTM tags and a "how did you hear about us" answer.
- **Invite-loop metrics.** For products used by groups: guest views, then guest
  signups, then guests who start their own group, then activation.

It does not write and auto-post content. Drafting comes last (Phase 4), uses
real product evidence, and a person always posts by hand.

**First user: us.** Group kit (`IDEAS/group-kit.md`) is the first product it
markets. Group kit's step 0.3, recruiting three pilot groups, is the first bet.
Other founders get it only after Group kit has produced a verdict (Phase 5).

**Why this, from the research.** The evidence, with sources, is § Research
at the end of this file.

- Generating content is solved and commoditized. Jasper retreated to
  enterprise, Copy.ai pivoted and sold, and 10+ near-identical "AI CMO" agents
  have no independent retention data.
- Founders' pain is deciding which channel and knowing if it worked. In one
  70-story dataset, first customers came from other people's communities 34%
  of the time, the founder's own audience 20% and cold outreach 15%. None came
  from ads.
- **Nothing found does gaps 1 and 4.**
  - Gap 1 (bet with stop signal): the nearest is Traction (onlytraction.com),
    a Bullseye board with an experiment log, at $49 lifetime. Its pages show no
    time box, kill criteria or attribution (unverified: step 0.2).
    GrowthHackers Experiments and Panobi are dead.
  - Gap 4 (rules ledger): free subreddit-rules readers exist, but none tracks
    our cap and last post.
- **Gaps 2 and 3 have parts but no product.**
  - Attribution: DataFast and TrackRev join referrer to payment for $9–29/mo.
    PostHog and Formbricks have free "how did you hear" surveys. Nothing joins
    the two for a product with tens of users.
  - Invite loop: GrowSurf and Viral Loops model reward referrals, not a guest
    becoming an organizer. PostHog says to compute K-factor yourself from
    events.
- **Founders give the method away free.** Two separate 2026 Ask HN threads
  advised "pick one forum, answer five threads a week, track signups before
  adding another channel". The method is wanted, but founders will not pay for
  advice alone. That is one reason the first user is us.
- **The free channels are closing.** GummySearch shuts down 2026-12-01 because
  it got no commercial Reddit license. r/SaaS caps self-promotion, and many
  subreddits ban AI-written posts. So Reddit communities are entered by hand
  (Q6), and nothing reads Reddit's API.
- **Group-app growth points at the loop.** TeamSnap, Spond, SignUpGenius,
  Partiful and Givebutter grew through organizers exposing non-users. Heja
  tracks one activation number: teams with six members within seven days.
  PTA leaders ask for vendor recommendations in PTO Today's 60,000-member
  Facebook group, which bans vendor posts. Word of mouth is the door there.
  The growth stories and the organizer channels are in `IDEAS/group-kit.md`
  § Marketing.

**Scope calls, settled before the run.**

- **No auto-posting, ever.** A post is recorded after a person makes it. Bans
  and spam labels (ReplyGuy) are the failure this avoids.
- **No platform API scraping.** A community's rules are typed in, or fetched
  from a public rules page where that platform's terms allow it (Q6).
- **Every seam the framework lacks is filed as an `FJS-###` row**, not worked
  around in the app.
- **Nouns are the field's, not the framework's.** `Channel` (an acquisition
  channel) and `Target` (a community, query or list to work) are marketing
  words. They are not `VOCABULARY.md`'s broadcast Channel or Integrations
  Target. The app never imports either framework type under these names.
- **Each value has one origin.** Payments come from Stripe through
  `conduit-stripe`'s Receiver, not from product posts. Visit and referrer data
  is checked against `conduit-plausible` before a snippet is built (2.2).
  Funnel rates, reports and "rules stale" are derived, never stored.
- **App home:** `fjs-prototypes/paylode/` as its own git repo. Its own `PLAN.md`
  takes over from this file once Phase 0 scaffolds it. Ports are 7510–7519
  (API 7510, web 7511), which no prototype used on 2026-11-15.

---

### Phase 0 — Groundwork

Goal: rulings, the one competitor checked by hand, and a running scaffold.
Done when: Q1–Q6 are ruled, `docs/prior-art.md` records what Traction does,
and the scaffold boots on 7510/7511 with a dev login.

- [ ] 0.1 Rule Q1–Q6 with the owner.
- [ ] 0.2 (Owner's; the owner chose to build first, 2026-11-15.) Open Traction (onlytraction.com) by hand. Record whether it has a
  time box, kill criteria or attribution. If it has all three, stop and
  re-scope.
- [x] 0.3 Scaffold the app and its dev login, with ports in `.env`.
  Done 2026-11-15: `fli new paylode --source local --full --with conduit`;
  `db:seed:admin` (login proven by `POST /api/auth/login` on 7510) and
  `db:seed:channels` (Traction's 19), both idempotent.
- [x] 0.4 Draft `db/schema.lite`:
  - Models: `Product`, `Channel`, `Bet`, `Target`, `CheckIn`, `Community`,
    `Post`, `Visitor`, `Signup`, `Payment`, `LoopEvent`.
  - Gates scoped to the owner. Each gap it hits is filed.
  - Done 2026-11-15, one migration, `fli check` clean. No gap hit. The
    stop signal is a floor only ("fewer than n by week w"); a ceiling waits
    for a bet that needs one.
- [x] 0.5 Write a gap map (`docs/gap-map.md`) of the framework seams each phase
  needs: keyed ingest, a first-touch cookie snippet, scheduled reminders,
  funnel queries and an LLM call. Each gap is a filed row or an existing one
  cited.
  Done 2026-11-15: filed FJS-4368 (first-party dialect), FJS-4369 (first
  touch), FJS-4370 (Stripe dialect); cited FJS-2615, FJS-4171.

### Phase 1 — Bets and the community ledger

Goal: run Group kit's pilot recruitment as a real bet, by hand, before any
product exists to measure.
Done when a browser drive at phone width goes through the whole loop:
- Create the Group kit product.
- Open a bet: "organizer communities for pilot recruitment", targets PTO
  Today's group and two others, 90 days, stop signal "fewer than 3 pilot
  conversations by week 4".
- Opening a second bet on the same product is refused.
- Log three weekly check-ins.
- Record a post in a community at its cap, and see the warning.
- The week-4 checkpoint surfaces the stop signal's verdict.
After the drive passes, the owner runs Group kit 0.3 as bet #1.

**Built 2026-11-16, uncommitted.** `bun web/test/drive-phase1.js` passes
40/0 at 390×844 on a throwaway database, and `bun run check` is green (33
API tests). Choices made while building, each reopenable:
- The open-bet form stays reachable beside an active bet, folded, so the
  one-bet refusal is something a person can meet.
- A target refused after its bet saved leaves the bet open and says so.
- The last, partial week of a window is never reminded or counted missing.
- A changed rules page keeps its old digest until "I re-read the rules".
Not driven: the keep and extend verdicts, and the community edit form.

- [x] 1.1 Product, and a channel catalog seeded with Traction's 19 channels.
- [x] 1.2 Bet: hypothesis, targets, window, and a stop signal written as
  metric, threshold and checkpoint week. One bet is active per product (Q3),
  held by a unique partial constraint in the schema, not a hook.
- [x] 1.3 Weekly check-in with what was done and the numbers. A reminder fires
  when a week passes with no check-in.
- [x] 1.4 At a checkpoint, the stop signal is evaluated and a keep, kill or
  extend verdict is recorded. A killed bet frees the slot for the next one.
- [x] 1.5 Community ledger: platform, link, rules text, promotion cap (n per
  days), date the rules were last checked. A warning shows when we are at the
  cap or the rules are over 30 days old.
- [x] 1.6 Post log: each post's link, community and bet, entered after posting.
- [x] 1.7 Rules source per community (Q6): typed, or a fetched public rules
  page. A scheduled check flags a changed page for the owner to re-read and
  never edits the cap itself.

### Phase 2 — Where customers came from

Goal: every Group kit signup and payment is traced to a channel without an
analyst.
Done when Group kit's waitlist or pilot form sends signups, and a Stripe
test-mode payment arrives. A drive then shows both credited to bet #1's
channel, with first-touch referrer, UTM tags and the "how did you hear"
answer side by side. Replaying the same event does not double-count it.
Group kit has no app yet (its 0.1 is open), so the drive's sender is a
stand-in junction app that signs as Group kit will; the real hop is
re-run once Group kit's form exists.

Built 2026-11-16; the drive figures, the choices made while building and
what was not driven are in
[`docs/plan-done.md`](../docs/plan-done.md#ideaspaylodemd).

- [x] 2.1 One webhooks subscription per product (Q2, `FJS-D1087`):
  Paylode runs `webhooks({ receive })` and `app.webhooks.subscribe({ to:
  'groupkit' })`, and Group kit registers the subscription's path and
  secret with `app.webhooks.register`. The signed body `id` is the dedupe
  key; `receive` finds the product by the subscription's id, kept on
  `Product`, and dispatches on the event name (`signup.created`). Never a
  raw route.
- [x] 2.2 First touch (Q7): a script on the product's pages keeps the first
  visit's referrer, UTM tags, landing path and time in the browser, and the
  product sends it inside `signup.created`, which writes the `Visitor` row.
  The report's visitor counts come from `conduit-plausible` totals by
  source. Paylode mounts no public endpoint.
- [x] 2.3 Mapping (Q8): a `ChannelRule` per owner (referrer, UTM source or
  "how did you hear" answer, lowercased, matched in code) credits a signup
  to a channel. An answer no rule matches is queued; classifying it can
  save the rule.
- [x] 2.4 Payments (Q9): each product's own Stripe signing secret, encrypted
  on `Product`, verifies `conduit-stripe`'s `stripeDialect` at
  `/webhooks/stripe/{productId}`. `checkout.session.completed` carries the
  product's user id as `client_reference_id` and records the Stripe
  customer on the `Signup`; `invoice.paid` joins on that customer.
- [x] 2.5 Report per channel and per bet window: visitors, signups and payers.

### Phase 2a — Guided setup

Goal: a person who has never used Stripe webhooks, Plausible or UTM tags
sets up a product alone, and learns what each piece is for as they go.
Done when a drive at phone width takes a fresh account through all seven
setup steps and sees each one turn to done on its own proof. Then the owner
does the same walk cold, with real Stripe test mode and a live Plausible
site, and without asking the main session anything.
Inserted 2026-11-16 after Phase 2, at the owner's request: Phase 2's pages
show a path, a secret and a receiver URL, and say nothing about where they
go or why.

**Built 2026-11-16, uncommitted.** `bun web/test/drive-phase2a.js` passes
112/0 at 390×844 on a throwaway database, with stand-ins for Group kit's
sender and for Plausible; `bun run check` is green (55 API tests). Choices
made by the main session with the owner away, each reopenable:
- The report step turns done when one real signup is credited to a channel.
- The column is `Signup.isTest` (`FJS-D1749`); the payload key stays `test`.
- The test signup is a real signed delivery to the product's own path.
- Paylode keeps the conduit store it builds to read receipts (`FJS-4383`);
  whether `app.conduit` should offer that read is the owner's.
- `PLAUSIBLE_ADDRESS` names a self-hosted or stand-in Plausible.
- Rate-limit, quota and bad-request answers from Plausible read as
  unreachable; a `failed` state would separate them.
- The channel picker keeping its text was the add-rule form never
  resetting; fixed.
Open: the Group kit example in the copy is invented (Reddit, r/PTA,
5 conversations by week 4) and wants the real bet. The Stripe click path
is from Stripe's docs, unchecked against the live dashboard until 2a.9. A
new account's verify link is only in the API log, since no mailer is set.

- [x] 2a.1 Rule Q10 and Q11 with the owner. Both ruled A, 2026-11-16.
- [x] 2a.2 Setup checklist on the product page, seven steps in order: add
  the product, open the first bet, connect signups, connect Stripe, connect
  Plausible, write the first channel rule, read the report. Each step links
  to the page that already does the work. A step's done state is derived
  from rows and is never stored. The home page's empty state points at
  step 1.
- [x] 2a.3 A short explainer folded under each step: what the piece is, why
  Paylode needs it, and Group kit's pilot bet as the worked example. Each
  term is defined once, where it first appears: channel, target, stop
  signal, first touch, UTM tag, referrer, webhook, signing secret.
- [x] 2a.4 Signups step: where the path, the secret and the script line go
  in the product's code, and a "Send a test signup" button (Q11). A test
  signup turns the badge to "receiver works"; only a real signup turns it
  to done. The checklist shows the count of test signups. A test seeds one
  and asserts every report, channel and bet-window figure is unchanged.
- [x] 2a.5 Stripe step: the click path in the Stripe dashboard to add the
  endpoint, pick the two events and copy the signing secret. Each click is
  checked against the live test-mode dashboard on the day it is written.
  Done when conduit holds a receipt for the product, which it writes only
  after the signature verifies. The receiver names the product as the
  receipt's `owner`, and conduit's store gains a read by owner, filed as an
  `FJS-###`; Paylode keeps no copy.
- [x] 2a.6 Plausible step: where the site id is found. Done when a
  Plausible query for that site answers, probed live and never stored. A
  refusal says which it was: wrong site id, wrong key, or unreachable.
- [x] 2a.7 Rule and report steps: write a rule from the test signup and
  watch it get credited (the report itself counts real signups only), then
  read the report with a legend for visitors,
  signups and payers and what the stop signal says to do. This step also
  settles whether the channel picker keeping its text after a save is a
  bug.
- [x] 2a.8 Drive: a fresh account at 390×844 walks the checklist, and each
  step's badge turns on its own proof, not on a click.
- [ ] 2a.9 The owner's cold walk. Each place they stall is fixed in the
  copy or filed. This walk is also Phase 2's owed proof of a real Stripe
  test-mode payment and live Plausible counts.

### Phase 3 — Invite-loop metrics

Goal: see whether Group kit's guests become organizers.
Done when Group kit's Phase 1 drive emits its events and the funnel shows
guest link views, then guest signups, then new organizers who were guests,
then activated groups. Activation is a definition each product sets.
Blocked on Group kit Phase 1.

- [ ] 3.1 Loop event types: `guestViewed`, `guestJoined`,
  `organizerCreated` (with the group that invited them), `groupActivated`.
- [ ] 3.2 Funnel per week, and the second-order rate (guests who become
  organizers).
- [ ] 3.3 Activation definition per product, Heja-style ("n members within d
  days").
- [ ] 3.4 Loop numbers usable as a bet's stop-signal metric.

### Phase 4 — Drafts from product evidence

Goal: a draft for one community that cites real evidence and respects that
community's rules.
Done when a drive turns one changelog entry and one pilot quote into a draft
for one ledger community, the draft shows the community's cap and rules, and
approving it records nothing until the post's link is entered.

- [ ] 4.1 Evidence: changelog entries, customer quotes and numbers from
  Phases 2–3.
- [ ] 4.2 Draft through an LLM (Q4), with each claim tied to its evidence.
- [ ] 4.3 Approve, copy, and open the community. The post is logged by link
  (1.6).

### Phase 5 — Decide whether others get it

Goal: a ruling, from Group kit's own record, on opening it to other founders.
Done when bet #1 has a verdict, and the owner rules on Phase 5 using what the
tool showed: which bet worked, what attribution said, and whether the loop
moved.

- [ ] 5.1 Write up Group kit's bets and their verdicts.
- [ ] 5.2 If yes: workspaces, sign-up and billing as a new plan. Usage or
  annual pricing, per the HN price-resistance evidence.

---

## Questions

- **Q1 — Name.** Working name **Paylode** (owner, 2026-11-15), chosen from
  Lode variants for "the channel that pays". Domain, app-store and USPTO
  checks are owed before it is final.
- **Q2 — How events arrive.**
  - **A** — A Conduit Receiver keyed per product, whose Provider is "one of
    our products". Payments come through `conduit-stripe`.
  - **B** — App peering (`IDEAS/app-peering.md`), not yet built.
  - **C** — A FrontierJS package that apps include.
  - **Recommend A.** It ships today for any product, keeps one owner per
    translation (Invariant 4, `app.conduit.receive`), and B can replace it
    once peering ships. A raw keyed route would be a second receiver beside
    the owner.
- **Q3 — One active bet per product, enforced?**
  - **A** — Yes, by a unique partial constraint in the schema.
  - **B** — Allow several at once.
  - **Recommend A.** Committing to one channel is the thesis. Several at once
    is what every tracker already allows.
- **Q4 — LLM for drafts (Phase 4).**
  - **A** — `conduit-anthropic` with a key.
  - **B** — Local `claude -p`.
  - **Recommend A deployed, B in dev**, matching Chronicle.
- **Q5 — Users in v1.**
  - **A** — One owner, many products, with an owner column on `Product`.
  - **B** — Workspaces with teammates, using `tenancy { }` from the start.
  - **Recommend A.** The first user is us. Phase 5's yes would move to B as a
    migration, which pre-alpha allows.
- **Q6 — Where community rules come from.** **RULED 2026-11-15: both, per
  community.**
  - Each community picks a rules source: typed in with a re-check reminder,
    or fetched from a public rules page where that platform's terms allow it.
  - A fetched page that changes is flagged for the owner to re-read. It never
    updates the cap silently.
  - Reddit stays typed, because its terms forbid commercial use of its data
    (the GummySearch closure).

- **Q7 — First touch (2.2).** **RULED 2026-11-16: A.** **A** — a browser
  snippet kept by the product and sent with the signup, visitor counts from
  Plausible. **B** — the snippet posts each visit to a public Paylode
  endpoint. **C** — no visitor counts.
- **Q8 — Mapping to channels (2.3).** **RULED 2026-11-16: A.** **A** — a
  rule table per owner, unmatched answers queued. **B** — classify every
  signup by hand.
- **Q9 — Stripe per product (2.4).** **RULED 2026-11-16: A.** **A** — an
  encrypted secret and a receiver path per product, joined by
  `client_reference_id` then customer. **B** — one environment secret for
  every product, product read from metadata.

- **Q10 — Shape of the guided setup (2a.2).** **RULED 2026-11-16: A.**
  - **A** — A checklist on the product page that links into the pages
    Phase 2 built.
  - **B** — A separate step-by-step wizard a new account is sent through.
  - A reuses every page, stays a health view of the connections after
    setup, and has no second copy of each form.
- **Q11 — Proving signups before the product has a form (2a.4).** **RULED
  2026-11-16: A.**
  - **A** — A "Send a test signup" button. Paylode signs a delivery with
    the product's own secret; the row is marked as a test, left out of
    every report, and can be deleted.
  - **B** — No button. The step waits for the product's first real signup.
  - Group kit has no form yet, so under B the first user
    cannot finish step 3, and watching a signup arrive and get credited is
    the lesson. The cost is a test mark on `Signup` that every count must
    respect; the mark and the delete rule for test rows are declared in
    `schema.lite`. Stripe's dashboard and CLI send test events the same
    way (from memory; check before citing). Reopen to B if the guard
    costs too much.

**Ruled 2026-11-15 by the owner** (AskUserQuestion): Q2 = A, Q3 = A,
Q5 = A, and Q6 as above. **Ruled 2026-11-16:** Q4 = A deployed, B in dev.
Q1 keeps Paylode as the working name; its domain, app-store and USPTO checks
wait for Phase 5, since nobody but us uses it before then.

---

## Research (2026-11-15)

Two research runs on 2026-11-15: a landscape of startup marketing tools, then
a check of the whitespace it proposed. Almost every performance figure is
vendor-, affiliate- or self-reported, no "AI CMO" product has independent
retention data, and prices drift monthly. Treat numbers as orders of
magnitude and re-check at the vendor before relying on one.

### The landscape: every task has a tool, none brings an audience

| Layer | Entry price | Evidence it works |
|---|---|---|
| Launch platforms, directories | Free–$99; $29–$499 one-time for directory services | Hundreds to low thousands of visitors per launch; Domain Rating gains only |
| Reddit/community monitoring | Free–$120; teams $159–$2,500 | Reddit API risk; auto-reply bans |
| Cold outreach | $37–$94 plus domains and data | 1.2–3.4% reply |
| AI CMO agents | $49–$250 plus credits | Vendor claims only |
| SEO suites, autopilot writers | $29–$199; $9–$99 | Vendor-only traffic claims |
| AI-visibility trackers | $29–$95 | Visibility rate stable, rank noisy |
| Fractional, done-for-you | $3K–$20K/mo | "Rarely moves pipeline in 90 days" |

A realistic solo stack of two to four tools runs about $100–$300/mo (the
notes' estimate, not survey data).

- **Launches are a lottery.** About 10% of Product Hunt launches are now
  Featured, against 60–98% in 2020–23 ([SHNO](https://www.shno.co/marketing-statistics/product-hunt-launch-statistics)).
  About 90% of Show HN posts fail; a front-page hit brings 50–500 signups.
  Micro-launchpads (Peerlist, BetaList, Uneed, Fazier) sell mainly a backlink.
- **Community monitoring depends on the platform.** GummySearch (140,000+
  users) shuts off 2026-12-01 for lack of a commercial Reddit Data API
  license, not demand ([notice](https://gummysearch.com/closing-time/)).
  ReplyGuy's auto-replies drew bans and a spam label; it sold at about $10k
  MRR. One study found 39% of 49 subreddits ban self-promotion; r/SaaS caps it
  at one mention or three links per 60 days from 2026-11-01 (secondhand).
- **Schedulers, outreach and ads don't find users.** No evidence that
  scheduling or build-in-public posting yields users. Cold email averages about
  3.4% reply. Reddit ads CPC rose 67% to $3.11. Of 66 first-customer stories,
  none came from paid ads.
- **"AI CMO" agents are a crowded 2026 wave**: Okara, Superscale ($5M
  pre-seed), Averi ($3M seed), Polsia (company-reported ~$10M ARR), Blaze,
  Sintra and others. Each keeps a human approval step, at 2–5 h/week of
  supervision. No independent retention data; Breyta closed; a "Vect AI" Show
  HN was flagged dead as spam.
- **Horizontal all-in-ones retreated.** Jasper ($1.5B valuation in Oct 2022)
  cut staff three years running and dropped its solo plan in May 2026. Copy.ai
  was sold to Fullcast (2025-10-15). Writesonic pivoted to AI search. Luppa,
  MarketDing and Unify Labs closed. Survivors narrowed to one channel with an
  audience (Typefully, ~$2M ARR by word of mouth; Taplio), moved upmarket, or
  became data infrastructure (Adobe bought Semrush for $1.9B).
- **Suites assume a list already exists.** HubSpot Professional is cited at
  $890/mo plus $3,000 onboarding; Mailchimp's free tier fell to 250 contacts.
  None addresses "no audience yet".
- **SEO is crowded and riskier.** Google's spam policy targets scaled
  low-value pages "no matter how it's created"; 2026 case studies show
  programmatic sites hit site-wide, and AI Overviews cut outbound clicks 39.8%
  in a randomized study. Programmatic SEO works only with unique data per page.
- **Education fills the middle of the ladder**: newsletters $0–$275/yr,
  communities to $499/yr, programs $996–$1,995/yr. Traction's Bullseye is the
  dominant framework and is already cloned by AI planners (TRYGO, siift.ai).

### What founders say the problem is

- **"Building got cheap, distribution did not."** A vendor scan of 600 founder
  posts ranks converting users and validating the idea above finding leads.
- **First customers** ([Lead Scorer](https://lead-scorer.com/blog/how-founders-get-first-customers-2026),
  70 self-reported stories graded by an outreach vendor): other people's
  communities 34%, own audience 20%, one-to-one cold outreach 15%, ads 0%.
  11% could not say which channel worked. A second ~40-case set did not
  replicate the ranking.
- **Tool complaints**: pricing cliffs, opaque credits and re-tiering, tool
  sprawl.

### Prior art for each gap (whitespace check)

**Gap 1 — one bet with a stop signal.** Nothing found combines a time-boxed
bet, a stop threshold agreed in advance, and attribution.
- Traction ([onlytraction.com](https://onlytraction.com/)) is the closest:
  "find your one working channel in 90 days". It has a Bullseye board of 19
  channels, 750+ tactics, an experiment log, directory auto-submit and DR
  tracking, at $49 lifetime per project (author's [post](https://olivercom.substack.com/p/i-got-tired-of-guessing),
  2026-05-28). It skews toward SEO and directories. The app was not opened (step 0.2).
- Dead: GrowthHackers Experiments (NorthStar), reported gone Aug 2026; Panobi
  closed May 2024. Team-priced: Growth Method $99–$150/user, Effective
  Experiments from £100/mo. Tability ($6/user) advises one growth bet per quarter.
- Free substitutes: Notion/Airtable ICE templates, and a DEV post's YAML file
  with `kill_if_below` and a script answering NOT YET / KILL / KEEP. A product
  has to beat a spreadsheet on something other than storage, for example by
  filling in the result from signup and payment data.
- Revnu ("AI growth employee") kills losing channels, but runs several in
  parallel instead of committing to one.

**Gap 2 — attribution without an analyst.** The pieces are cheap but separate.
- Referrer to Stripe revenue: DataFast from $9/mo (~$31K MRR), Attrifast
  $9.99/mo, TrackRev $29/mo, Plausible Business $19/mo via revenue goals (no
  Stripe join), Humblytics from $79/mo, Dub $30–90/mo for its own links only.
- "How did you hear": free in PostHog (1,500 responses/mo) and Formbricks
  (AGPL; Hobby free at 250/mo).
- TrackRev says it has [no survey field](https://www.trackrev.io/blog/self-reported-attribution-vs-tracked-data)
  and tells you to store the answer yourself. No product shows each customer's
  tracked source, stated source and revenue together.
- Practice from vendor blogs: ask at the point of commitment, free text over a
  dropdown, optional and late in the form, and treat the answer as a second
  signal beside the tracked one.

**Gap 3 — invite-loop measurement.** No product found.
- GrowSurf ($179–$1,429/mo) and Viral Loops ($35–$279/mo) model reward
  referrals, not a guest becoming an organizer.
- PostHog has no built-in K-factor; it says to compute it from events
  (`referral_sent`, `invitation_accepted`).
- Saxifrage calls guest-to-host the "second-order invite rate". No published
  guest-to-organizer number exists for Partiful, Luma, SignUpGenius, Spond or
  TeamSnap.

**Gap 4 — community rules ledger.** Free rule checkers abound: RedShip,
RedditGrow, Bazzly, RedNudge, Thread Otter, and OneUp's 64-subreddit
database. They read the current rules on demand. None stores a founder's own
cap and last post, or alerts on a rules change, and none covers non-Reddit
communities. Monitoring tools (Redreach, CommunityTracker, Octolens) do not
track the cap either. Mods announce rule changes in pinned posts, not the
sidebar. Alone this is worth little against free tools; it fits as a feature
of the bet.

**Open source to borrow from.** Borrow ideas, not code, from the AGPL ones:
Formbricks (survey templates), Dub and Plausible. Umami (analytics) is MIT, and
PostHog's core is MIT with enterprise features under ELv2. No open-source
channel-bet tracker or rules ledger was found.

### Willingness to pay

All from Hacker News threads read directly. Reddit and Facebook were
unreachable, so this is a technical, self-selected sample.
- **Founders want a person, not software.** "I know I need marketing help but
  giving equity to someone I met online feels like a huge risk"
  ([Ask HN, 2026-04](https://news.ycombinator.com/item?id=47667504)). No thread
  asked for a decide-and-measure tool, and none was asked about one, so the
  demand evidence is absent rather than negative.
- **The method is offered free.** "Pick one forum where your buyers already ask
  questions. Answer five relevant threads each week, without pitching. Track
  profile visits and signups before adding another channel."
  ([2026-08](https://news.ycombinator.com/item?id=49187337); the same advice
  appears in [2026-07](https://news.ycombinator.com/item?id=48918150).) That
  thread also reports ads drawing clicks with "abhorrent conversions", while
  forums convert well.
- **Monthly fees meet resistance.** A Trello power-up with 30k installs found
  "even $10/month was a huge barrier", while its $100 annual plan sold often
  ([thread](https://news.ycombinator.com/item?id=45220070)). The first request
  on an SEO tool launch was credits instead of a subscription. Freemium
  converts at 1–5%, opt-in trials at 15–25%.
- **Accountability sells as people**: peer groups at $16–$100/mo, GrowthMentor
  at $85/mo, a $500 one-off homepage teardown (Marketing Examples), coaches at
  $1,500–$5,000/mo, fractional CMOs at $4,000–$8,000/mo. Between $100/mo and
  $1,500/mo there is little on offer.
- **Lifetime deals**: AppSumo keeps 60–70%; a $59 deal nets the vendor $17.70.
- **The founder buyer is weak.** Indie hackers are called "the most cheapskate
  people on the planet" ([2022](https://news.ycombinator.com/item?id=34103896)).
  The notes add an unsourced inference: a tool bundled with the founder's own
  product sidesteps standalone distribution. That is the case for "first user:
  us".
