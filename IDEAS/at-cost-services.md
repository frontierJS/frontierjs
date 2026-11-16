---
id: at-cost-services
status: reading
dated: 2026-11-15
---

# Idea — At-cost services: which everyday service a small team should run at cost

**Status: READING.** Dated 2026-11-15. A ranked research record, not a plan. Nothing here is built. Do not cite this file as behavior; see `VERIFYING.md`.

**Verdict.** The group kit for adult organizers ranks first in all four directions and is planned in `IDEAS/group-kit.md`. Volunteer and learner matching (adult ESL partners, tutoring programs) ranks second because it reuses the scheduler. Paid tickets in the organizer's own Stripe account, a per-maker newsletter and membership page, and small-congregation management tie for third. Family photo and file storage, the service people name first, ranks near the bottom.

**Evidence caveat.** Most figures are secondary: search summaries and comparison blogs, many written by competitors. Vendor pages that loaded (Apple, Fastmail, Bitwarden, Backblaze, Hetzner, Squarespace, Gumroad, Ghost, beehiiv, Stripe, Anthropic) are the firmest. Etsy, Meetup, SignUpGenius, Ko-fi, Substack and Patreon fee pages were blocked. Sources conflict (SignUpGenius paid tiers appear as $8.99 to $44.99 a month; Meetup as $29.99 a month to $299.99 a year). The 373,000-congregation count is a 2017 estimate and Linktree's survey is from 2021. Read dollar amounts as ranges.

## Ranking

Scores are 1 to 5 for value (people reached, overpayment) and feasibility (running cost, support, moderation, payments and tax, child-safety exposure) for a few developers who self-host. They are judgments, not measurements, and assume Q1 = A and Q2 = A.

| Rank | Candidate | Direction | Value | Feas. | Score | Why |
|---|---|---|---|---|---|---|
| 1 | Sign-up, event, dues and volunteer-scheduling kit (adult organizers) | Community | 4 | 5 | 20 | Overcharge, CRUD plus email, per-group Stripe |
| 2 | Volunteer and learner scheduling and matching | Learning | 4 | 4 | 16 | Gap is capacity; reuses rank 1's scheduler |
| 3 | Paid tickets and registration, organizer's Stripe | Community, creators | 4 | 3 | 12 | Largest per-ticket saving; chargebacks are the burden |
| 3 | Per-maker newsletter and membership page | Creators | 3 | 4 | 12 | Simplest tax story; flat-fee rivals exist |
| 3 | Small-congregation management and giving | Community | 4 | 3 | 12 | Free Planning Center People competes |
| 6 | Youth league registration and payments | Community | 5 | 2 | 10 | Biggest dollars, heaviest COPPA and SafeSport exposure |
| 7 | Per-maker storefront | Creators | 3 | 3 | 9 | Beats Etsy only for makers with traffic |
| 7 | Managed custom-domain email and site setup | Digital life | 3 | 3 | 9 | Setup is the gap; deliverability stays with the host |
| 9 | Lending ledger (tool, instrument, seed) | Community, learning | 2 | 4 | 8 | Cheap; Lend Engine's free tier exists |
| 9 | Non-custodial digital-legacy kit | Digital life | 2 | 4 | 8 | Free tools exist |
| 9 | Time bank | Learning | 2 | 4 | 8 | hOurworld is free; better as a feature (Q4) |
| 12 | Give-away board | Community | 3 | 2 | 6 | Moderation is hours a day; Facebook's network effect |
| 12 | Family photo and file storage | Digital life | 3 | 2 | 6 | Retail about $5 per TB; honest redundancy costs more |
| 14 | Podcast hosting | Creators | 2 | 2 | 4 | Bandwidth cost unsourced |
| 15 | Shared marketplace | Creators | 3 | 1 | 3 | Ampled and Resonate failed; tax duties land on the operator |

**Four shared builds.** The **group build** (organizations, roles, slots, reminders, event pages, per-group Stripe, email) delivers ranks 1, 2, 3, 5, 6 and the time bank. The **ledger build** (items or hours, check-out, balances) covers lending, the give-away board and the time bank. The **maker build** (per-maker Stripe, a sending domain, static pages) delivers newsletters, memberships, storefronts and, with event pages, tickets. The **home build** (storage, mail, vault) shares nothing and carries the heaviest operations.

The order is group, then maker, then home only after a funded operating base. Admitting minors would lift league registration and tutoring along with their costs; a firm tax opinion could lift the marketplace; a cheap two-copy storage design could lift storage to mid-table.

## Community

Rank 1 and its landscape live in `IDEAS/group-kit.md`. Runner-ups for a later idea file:
- **Paid tickets (rank 3).** Eventbrite takes [about 6.6% plus $1.79 per ticket](https://www.eventcloud.io/blog/how-much-does-eventbrite-charge-2026), 24.5% on a $10 ticket by the notes' arithmetic from [Eventbrite](https://www.eventbrite.com/organizer/pricing/).
- **Congregations (rank 3).** About 373,000, median 70 regular participants ([Hartford Institute](https://hirr.hartfordinternational.edu/fast-facts-on-american-religion/)). Breeze is $864 a year, a small-church suite about $1,680 ([Church Stack](https://www.churchstack.io/blog/average-cost-church-management-software)).
- **Youth leagues (rank 6).** 27.3 million children play organized sports, family costs up 46% since 2019 ([Project Play](https://projectplay.org/state-of-play-2025/participation-trends)). TeamSnap's club tier was last published at [$199 a month](https://clubside.io/blog/teamsnap-alternative).
- **Lending ledger (rank 9).** About 204 US tool libraries. Lend Engine's free tier covers 100 items and 100 members, paid about $150 to $600 a year ([Lend Engine](https://www.lend-engine.com/pricing)); a new entrant must win on ownership.
- **Give-away board (rank 12).** Buy Nothing has 7.5 million members ([Wikipedia](https://en.wikipedia.org/wiki/Buy_Nothing_Project)); a 116,000-member group's three admins moderate about 3 hours a day ([SF Standard](https://sfstandard.com/2025/11/07/buy-nothing-group-facebook-taken-down-trademark-infringment/)).

Overcharge and alternatives:
- SignUpGenius paid plans cost about $108, $270 and $540 a year ([SignUpKit](https://www.signupkit.co/signupgenius-pricing)). Meetup roughly tripled organizer prices to about $175 a year for a small group ([HN](https://news.ycombinator.com/item?id=40854275)).

Payments and law:
- Stripe charges 2.9% plus 30 cents and $15 per dispute ([Stripe](https://stripe.com/pricing)). The nonprofit discount excludes tickets and memberships ([Stripe support](https://support.stripe.com/questions/fee-discount-for-nonprofit-organizations)), so "at cost" means passing Stripe through.
- Charging in each group's own account keeps sales tax and 1099-K with the group. That is a design inference for a tax advisor to confirm.
- The amended COPPA rule has been fully in effect since April 22, 2026 ([Federal Register](https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule)). The Safe Sport Act requires 24-hour abuse reporting and adult training ([Sadler Sports Law](https://www.sadlersports.com/new-safe-sport-act-applies-amateur-sports-organizations/)); its reach comes from law-firm summaries, not statute text.

## Learning

Runner-ups for a later idea file:
- **ESL volunteer and learner matching (rank 2).** 51% of ProLiteracy programs keep waiting lists and under 10% of adults in need are served ([ProLiteracy](https://www.proliteracy.org/wp-content/uploads/2023/09/2023-PL-AdultBasicEducation-FactSheet-2467.pdf)). Portland, Maine had about 1,300 enrolled and at least 1,000 waiting ([Press Herald](https://www.pressherald.com/2024/11/22/demand-for-english-adult-education-courses-outpaces-class-space-in-portland-region/)). No outcome data exists for conversation-partner matching.
- **Scheduler with match check-ins.** Early-ended mentoring matches last about 7.4 months against 25.1 for all matches ([Am J Community Psychol](https://onlinelibrary.wiley.com/doi/full/10.1002/ajcp.12585)).
- **Tools for community music schools.** About 70% of Springfield's students get free or reduced lessons ([CMS Springfield](https://www.communitymusicschool.com/impact/)); software can serve waitlists, aid and instrument loans. No lending economics were found.
- **AI that assists volunteers.** Tutor CoPilot cost about $20 per tutor per year ([arXiv](https://arxiv.org/html/2410.03017)); Claude Haiku 5.5 lists at $0.10 and $0.50 per million input and output tokens ([Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)).

Why capacity, not price:
- Tutoring runs $25 to $80 an hour ([Wise](https://www.wise.live/blog/average-tutoring-rate-in-the-usa/)), yet with school help the lowest-income families get 72% more tutoring ([Fortune](https://fortune.com/2026/11/04/richest-families-outspend-poorest-13-to-1-per-child-schools-equalizer/)).
- Drop-in tutoring is used by 1% to 5% of eligible students ([KQED MindShift](https://www.kqed.org/mindshift/62572/schools-keep-buying-online-drop-in-tutoring-research-doesnt-support-it)). Khanmigo added nothing over Khan practice in a two-year Tennessee trial ([EdWorkingPapers](https://edworkingpapers.com/ai26-1551)).
- Background checks run about $19 to $95 per volunteer ([VCU](https://equity.vcu.edu/protection-of-minors/background-check-platform/)); state tutoring and mandated-reporter rules were not researched.

## Creators and makers

Runner-ups for a later idea file:
- **Per-maker newsletter and membership (rank 3).** Ghost is $18 to $29 a month with 0% on subscriptions ([Ghost](https://ghost.org/pricing/)). AWS SES sends 1,000 emails for $0.10, so 10,000 weekly subscribers cost about $4 a month ([AWS SES](https://aws.amazon.com/ses/pricing/)). Deliverability reputation is the real cost.
- **Per-maker storefront (rank 7).** A $25 Etsy item costs about 11% in fees, about 26% with an Offsite Ad ([FeeProofed](https://www.feeproofed.com/guides/etsy-fee-increase-history-2018-2026/)). Gumroad takes 30% via Discover ([Gumroad](https://gumroad.com/pricing)). Ownership pays only for makers who already have an audience.

Overcharge and population:
- Stripe's 30 cents takes 6% of a $5 payment. A $5 supporter nets the creator about 81% on Patreon ([Patreon](https://www.patreon.com/pricing)) and about 91% on Ghost or beehiiv (notes' arithmetic).
- Etsy has 5.6 million active sellers ([10-K](https://www.sec.gov/Archives/edgar/data/1370637/000137063726000019/etsy-20251231.htm)), but 68% of part-time creators earned under $1,000 a year in a 2021 survey ([TechCrunch](https://techcrunch.com/2022/04/20/linktree-creator-economy-report-research/)). That favors per-sale or low-flat pricing.

Why not a marketplace:
- Ampled closed in 2023 citing burnout and no money to hire ([Billboard Canada](https://ca.billboard.com/ampled-music-platform)); Open Collective Foundation dissolved, reportedly because a 5% fee could not cover compliance ([Open Collective](https://blog.opencollective.com/open-collective-official-statement-ocf-dissolution/)).
- Facilitator sales-tax laws cover 45 states and DC, mostly $100,000 thresholds, $500,000 in Texas and California ([Kintsugi](https://trykintsugi.com/blog/marketplace-facilitator-laws-by-state)). 1099-K reporting reverted to $20,000 and 200 transactions ([IRS](https://www.irs.gov/newsroom/form-1099-k-faqs)). No source says whether a facilitator duty reaches a software host that holds no funds.

## Digital life

Runner-ups for a later idea file:
- **Managed email and site setup (rank 7).** Migadu starts at $19 a year ([Migadu](https://www.migadu.com/pricing/)); Fastmail is $60 for one person, $132 for six ([Fastmail](https://www.fastmail.com/pricing/)). The wedge is DNS and setup on a resold host, not mail servers.
- **Non-custodial digital-legacy kit (rank 9).** A checklist that never holds secrets. 48% have no instructions for their digital accounts ([AfterYou, citing Trust & Will](https://blog.afteryou.me/digital-legacy-planning-online-accounts-after-death/)); Google may delete an account inactive for two years ([Google](https://support.google.com/accounts/answer/3036546)).

Why storage ranks low:
- Apple and Google both sell about $5 per TB at 2 TB and up ([Apple](https://support.apple.com/en-us/108047), [Google One](https://one.google.com/about/plans)).
- Hetzner is about EUR 2 per TB ([Hetzner](https://www.hetzner.com/storage/storage-box/)) and Backblaze $6.95 ([Backblaze](https://www.backblaze.com/cloud-storage/pricing)). The notes' arithmetic puts three copies near $9 to $12 per TB; both hosts raised prices in 2026 ([Tom's Hardware](https://www.tomshardware.com/tech-industry/hetzner-to-raise-prices-by-up-to-37-percent-from-april-1)).
- Lasting providers pay staff ([Framasoft](https://framasoft.org/en/): 74% of spend).
- No per-user support cost exists. Data-loss liability and duties around illegal imagery in hosted uploads were not researched; review before any storage launch.

## Open questions

Leans are the report's, not rulings.

- **Q1 — Minors, or adult organizers only?**
  - **A** — Adult organizers only: parents register children, no accounts under 13, no child photos or messaging. Report lean for the first release.
  - **B** — Admit minors through organizations or schools. Needs verifiable parental consent, Safe Sport duties, volunteer screening and legal review.
  - **C** — Serve minors directly. No source supports it.
  - Group kit takes A in its scope calls (`IDEAS/group-kit.md`).

- **Q2 — Per-maker tools, or a shared marketplace?**
  - **A** — Each maker on their own Stripe account, with their own tax and 1099-K treatment. Report lean.
  - **B** — Operate a marketplace and take on facilitator collection and 1099-K reporting.
  - **C** — Per-maker tools plus an optional directory that never touches money.

- **Q3 — What storage redundancy to promise?**
  - **A** — One Hetzner copy at about EUR 2 per TB, labeled not a backup, with an open file layout.
  - **B** — Two copies (Hetzner plus Backblaze), near the $9 to $12 three-copy figure.
  - **C** — Three copies above $5, sold on ownership.
  - **D** — Skip hosting; offer a backup-and-handover guide.
  - Report lean: limited replication stated plainly plus an exportable layout.

- **Q4 — Build a time bank, given hOurworld exists?**
  - **A** — Standalone ledger against a free incumbent with 27,541 members in 303 communities ([hOurworld](https://www.hourworld.org/index.htm)), down from 44,000 in 2019 ([Salon](https://www.salon.com/2019/04/06/time-really-is-money-with-increasingly-popular-cooperative-time-banks_partner/)).
  - **B** — Skip it and point groups to hOurworld.
  - **C** — Offer hours as a feature of matching and lending. Report lean.

## Funding model

- **Precedents.** Disroot ran on about EUR 25,000 in 2023 from an average 197 monthly supporters ([Disroot](https://disroot.org/annual_reports/AnnualReport2023.pdf)). May First charges $50 a year for basic membership and employs three workers ([May First](https://mayfirst.coop/membership-options/plans-pricing/)).
- **Concentration kills.** Dollar For lost about a third of its budget when two donors left ([KFF Health News](https://kffhealthnews.org/news/podcast/an-arm-and-a-leg-podcast-charity-care-nonprofit-dollar-for-medical-bills/)). Upsolve runs about 70% grants and 30% earned revenue ([Upsolve](https://upsolve.org/learn/how-upsolve-is-free/)).
- **The model.** A flat annual price per group or maker set to real costs; Stripe passed through at the published rate with no markup; a free tier sized like Lend Engine's; a sliding scale with a voting seat on the May First pattern; grants only for the build, with a cap on any one funder.
- **Arithmetic.** A $60 annual plan, about half the cheapest paid SignUpGenius tier, needs roughly 1,700 paying groups per $100,000 of budget, about 0.5% of US congregations alone.
- **Open costs.** Running cost per group is mostly email and support; no support figure was measured. Insurance runs about $1,200 to $5,000 a year ([Hotaling](https://hotalinginsurance.com/hotaling-insurance-blog/nonprofit-cyber-liability-insurance)).

**What would change the answer:** a pilot's support hours, a tax advisor's view on facilitator duties, a legal read on adult-only design for leagues, and a wholesale quote for two-copy storage.
