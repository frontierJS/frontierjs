# US market for collecting dues, memberships, donations and shared group money for small adult-run groups (late 2026)

Method notes. Written 2026-11-15 with about 40 tool calls. Pages fetched directly (primary): Zeffy, Givebutter, Cheddar Up, Wild Apricot, MembershipWorks, Join It, Raklet, Memberful pricing pages; Open Collective pricing; Stripe Connect pricing, Stripe pricing, Stripe connected-account docs, Stripe support (EIN); Square fees; Venmo tax-law help page. **Pages that failed to load:** ClubExpress pricing (HTTP 403), Zeffy-review page learnofchrist.com (429), PayPal merchant-fees page (403), Venmo business-profile page (404), Stripe /nonprofits (404). For those, a third-party figure is used and flagged "third-party". WebSearch summaries stand in for pages I did not open; they are flagged as search summaries. Reddit threads were not reachable directly. Every Reddit quote below is secondhand through a review site and is flagged. Items dated before 2025 are marked **possibly stale**.

## 1. Free and tip-funded tools: Zeffy, Givebutter, Cheddar Up

### Takeaway
Zeffy and Givebutter are "free" because the payer is asked for a tip, and the tip default is the single most repeated complaint. Both are built for registered nonprofits and use Stripe underneath, with the platform (not the group) holding the Stripe relationship and controlling holds. Cheddar Up is the one aimed at PTAs and informal groups, and it charges per transaction (paid by the payer by default) with paid tiers.

### Cited Findings

**Zeffy**
- Pricing: $0. Zeffy says it covers all transaction and card fees itself and earns only from optional donor contributions; the page lists Free/Basic/Premium all at $0 with the same features — [Zeffy pricing](https://www.zeffy.com/pricing)
- Zeffy says about 2 in 3 donors tip; another Zeffy-cited figure is about 60% of donors tipping, averaging 4% of the gift — [Zeffy pricing](https://www.zeffy.com/pricing); [search summary of review sites](https://checkthat.ai/brands/zeffy/reviews)
- Features listed: donation pages, recurring donations, ticketing, raffles/auctions, memberships and membership cards, online store, card/Apple Pay/Google Pay/bank transfer, CRM, donation receipts, newsletters — [Zeffy pricing](https://www.zeffy.com/pricing)
- Payouts: weekly by default (Mondays), or monthly (first Monday); a 1 to 3 business day security review means recent payments can roll into the next payout; payouts cannot be triggered manually — [search summary of Zeffy help material](https://www.zeffy.com/blog/how-does-zeffy-work-get-to-know-our-help-centre) (summary only, page not opened)
- Who holds funds: Zeffy's terms say it uses Stripe; each org's payments run through a Stripe connected account created through Zeffy, and Zeffy onboards and verifies orgs, sets pricing, controls payout schedules, and can hold or refund funds — [search summary of Zeffy terms/help](https://www.zeffy.com/blog/how-does-zeffy-work-get-to-know-our-help-centre) (the pricing page itself says only "100% goes directly to the nonprofit" and does not name a processor)
- Pre-selected tip: one October 2026 test found 17% pre-selected on a $50 gift and 11% on a $500 gift; the nonprofit cannot customise it — [search summary citing review sites](https://checkthat.ai/brands/zeffy/reviews), [Donorbox review (competitor)](https://donorbox.org/nonprofit-blog/zeffy-reviews)
- Secondhand Reddit quotes (not verified at source; retrieved via search summaries): r/nonprofit, January 2026, "I despise companies like Zeffy; I am a donor" ("free to nonprofits because the donors are paying"); r/EndTipping: a parent says a school nonprofit on Zeffy now tells every parent to set the tip to 0% manually; r/nonprofit: over $1,000 raised and held "nearly 2 months"; r/BSA: funds held a couple of days for anti-fraud review; r/Charity July 2023 (**possibly stale**): $2,000 donation charged $2,199.95 with no confirmation screen — [search summary](https://checkthat.ai/brands/zeffy/reviews), [Zeffy review roundup](https://learnofchrist.com/resources/zeffy) (that page returned 429; it appeared only in search results)
- Zeffy's reply (Trustpilot, 16 Mar 2026): holds occur when Stripe needs to verify details before releasing funds. Trustpilot score 4.7 from 571 reviews as of 16 Oct 2026 — [search summary](https://www.zeffy.com/compare/zeffy-vs-stripe) (figure reported by summary; Trustpilot page not opened)
- Limitations: QuickBooks Online sync covers payouts only, not two-way; recurring donations cannot be migrated in; a recurring gift stops if every retry fails — [Donorbox review (competitor)](https://donorbox.org/nonprofit-blog/zeffy-reviews); sources conflict on whether membership/recurring forms are supported (Zeffy says yes; [paymentreview.com](https://paymentreview.com/reviews/zeffy/) says no, possibly outdated)

**Givebutter**
- Free plan: fundraising tools free "thanks to optional donor tips"; free CRM with no contact limit. With tips on: 0% platform fee. With tips off: 3% platform fee plus standard processing (2.9% + 30¢ card, 1.9% + 30¢ ACH) — [Givebutter pricing](https://givebutter.com/pricing)
- Givebutter Plus: from $29/month (250 or fewer contacts; $348/yr annual at the entry tier), 30-day trial; adds workflows, reporting, texting, QuickBooks Online integration — [Givebutter pricing](https://givebutter.com/pricing)
- Payouts: direct deposit to bank or debit card in 2 to 3 business days, no payout fees — [Givebutter pricing](https://givebutter.com/pricing)
- Complaints (Trustpilot and BBB, via search summary): an automatic 15% tip with fine-print opt-out; a reviewer reported being unable to proceed without agreeing to a $75 tip on a $500 transaction (Givebutter replied tips are optional and that is not how it is meant to work); $45.28 "tips and fees" on a $250 donation; funds held up to ten days; a BBB reviewer said the account was cancelled without notice — [Trustpilot](https://www.trustpilot.com/review/givebutter.com), [BBB](https://www.bbb.org/us/tx/austin/profile/marketing-software/givebutter-inc-0825-1000210184/customer-reviews) (search summary; pages not opened)
- Givebutter's stated policy: an unintended tip is refunded immediately — same search summary above.
- Positive: support praised as quick and courteous — same sources.

**Cheddar Up**
- Plans: Free Forever $0 (up to 5 items per page, 1 form/sign-up per page, recurring payments, peer-to-peer); Pro $15/mo billed annually; Team $35/mo billed annually (ticketing, group website, waitlists, tax-deductible receipts, integrations); Partner custom — [Cheddar Up pricing](https://www.cheddarup.com/pricing/)
- Card fees: Free 3.95% + $0.95; Pro/Team 3.59% + $0.59. eCheck: Pro 1.59% (min $1), Team flat $0.95, not on Free. Cash/check free. Standard withdrawal to bank free; instant 1.95% (min $1). By default the payer covers fees; the organizer can absorb them. The fetch tool flagged that the fee table was hard to align, so verify the exact columns before relying on them — [Cheddar Up pricing](https://www.cheddarup.com/pricing/)
- Payouts: organizer starts withdrawals manually; no automatic schedule documented — [Cheddar Up pricing](https://www.cheddarup.com/pricing/)
- Who holds funds: not stated on the pricing page; I did not find the processor named. Gap.
- Complaints (Capterra, via search summary): a Jan 2024 1-star (**possibly stale**) said the service "suddenly stopped" and the user could not see the money; reviewers mention a 5-product limit and constant upsell, a paid template losing their information, high per-transaction cost, and a wait for funds to clear. Software Advice shows 4.9 from 84 reviews; one reviewer said the hardest part is getting families to cover the convenience fees — [Capterra](https://www.capterra.com/p/276323/Cheddar-Up/reviews/), [Software Advice](https://www.softwareadvice.com/nonprofit/cheddar-up-profile/reviews/), [Trustpilot](https://www.trustpilot.com/review/cheddarup.com) (search summary; none opened). No Reddit threads found.

### Inferences
- A tip-funded model works only if the payer sees the tip as part of the product. An at-cost kit that never prompts for a tip removes the single most repeated complaint against both Zeffy and Givebutter.
- Cheddar Up's actual price to a PTA is mostly paid by parents as a "convenience fee", which the org experiences as friction when it tries to absorb it.
- Zeffy and Givebutter hold a Stripe connected account on the group's behalf and can freeze it. A kit where the group owns its Stripe account directly changes who is accountable for holds.

### Gaps
- Cheddar Up's processor and who legally holds funds.
- Whether Zeffy or Givebutter accept unincorporated clubs (non-501(c)(3)) at all. Both are marketed to nonprofits and I did not confirm eligibility terms.
- Reddit threads were read only through secondary sources.

## 2. Membership management: Wild Apricot, ClubExpress, MembershipWorks, Join It, Raklet, Memberful, GroupWorks, Glue Up

### Takeaway
Member-count-priced subscriptions dominate: roughly $35 to $66 a month for a 100-person club, plus Stripe's own fees. Wild Apricot is the incumbent and the most resented on price. GroupWorks closed in 2024. Join It and Raklet add a platform percentage on top of Stripe.

### Cited Findings

**Wild Apricot** (owned by Personify)
- Pricing: scales by contact count (100, 250, 500, 2,000, 5,000, 15,000, 50,000); the 100-contact tier is $66.00/mo monthly, $59.40/mo on annual prepay (10% off), $56.10/mo on two-year prepay (15% off); other tiers not shown on the fetched page. Flat rate, no per-transaction fee from Wild Apricot; only the payment provider's fees. 60-day free trial; account deleted if you do not upgrade — [Wild Apricot pricing](https://www.wildapricot.com/pricing)
- Features in every plan: event registration/ticketing/reminders, member database, renewals, member directory, email, website builder, invoicing/reporting/exports, donations, recurring dues, online store, admin and member mobile apps — [Wild Apricot pricing](https://www.wildapricot.com/pricing)
- Payment surcharge: integrated processing is through Personify Payments; "Other payment systems carry an additional servicing fee" — [Wild Apricot pricing](https://www.wildapricot.com/pricing). A search summary of reviews puts it at 20% of the monthly subscription for Stripe, PayPal or Authorize.Net — [search summary of Capterra/G2/Trustpilot](https://www.capterra.com/p/76116/WildApricot/) (the 20% figure not confirmed on the vendor page I fetched)
- Price complaints (search summary of review sites; individual reviews not opened): a G2 reviewer was told the rate would rise another 20% a year; a Trustpilot reviewer reports annual fee $640 to $810 (about 27%) for the same plan; Capterra reviewers say support is poor since the Personify acquisition, with no live help; the jump from 250 to 500 contacts nearly doubles the bill — [G2](https://www.g2.com/products/wildapricot/reviews), [Trustpilot](https://www.trustpilot.com/review/wildapricot.com), [Capterra](https://www.capterra.com/p/76116/WildApricot/)
- Competitor claims, treat as marketing: the 100-contact plan was about $40 before reaching $66 ([orgo.space](https://orgo.space/alternatives/wild-apricot/)); a pattern of 25% increases in odd-numbered years ([fatlabwebsupport](https://fatlabwebsupport.com/blog/nonprofit/wild-apricot-alternative/)).
- Ownership: Personify. Stated only in the brief and in review summaries; I did not find a primary source for the acquisition or date. Gap.

**ClubExpress** (pricing page returned 403; third-party figures)
- Per member per month: up to 200 members 42¢; 201–300 38¢; 301–500 34¢; 501–1000 30¢. Minimum monthly fee $24 (Capterra, Gappsy) or $30 (Covey). One-time setup fee reported $150 to $3,180 (up to $4,850 per Covey); merchant processing quoted separately; extra charge for QuickBooks integration — [search summary: Capterra](https://www.capterra.com/p/42550/ClubExpress/), [Covey comparison (competitor)](https://coveyhq.com/vs/clubexpress/)
- Another source lists a "Member tier at $95/mo" — [group.app blog (competitor)](https://www.group.app/blog/membership-management-software/)
- Review complaints not retrieved. Gap.

**MembershipWorks**
- Free up to 50 accounts; $35/mo up to 300; $59 up to 600; $95 up to 1,200; $145 up to 2,500; $205 up to 5,000; $259 up to 10,000. No platform transaction fee; gateways Stripe, PayPal, Authorize.net; no free trial, 30-day money-back guarantee; Mailchimp add-on $9/mo — [MembershipWorks pricing](https://membershipworks.com/pricing/)
- Features: member management, online payments, directory, event calendar/registration, donation forms, shopping cart, forms — [MembershipWorks pricing](https://membershipworks.com/pricing/)
- Funds: paid to the group's own gateway account (Stripe/PayPal), per the gateway model above (inference from "your payment gateway charges its own fees under your agreement with it").

**Join It**
- Starter $29/mo with 3.0% service fee; Total $99/mo with 2.0%; Extra $199/mo with 1.5%; Enterprise custom. Annual billing saves 10% (Starter $313.20/yr); eligible nonprofits get a further 10% off, stacking to 19%. Price rises with member tier. Stripe fees are separate. Includes recurring payments and renewal reminders at Starter; member directory only from Total — [Join It pricing](https://www.joinit.com/pricing)
- Which member-count tier the $29 price covers is not stated on the page. Gap.

**Raklet**
- Annual billing: Free $0; Essentials $49/mo; Professional $99/mo; Premium $399/mo. Monthly billing $59/$119/$499. Per-transaction fee on top of gateway fees: Free 4% + $0.60; Essentials 3% + $0.60; Professional 2% + $0.60; Premium 1% + $0.60. Payouts weekly (Free through Professional), instant on Premium. Uses Stripe (gateway setup about 24 hours). Automated reminder emails only from Professional. Admin seat $19/mo, extra 1,000 contacts $29/mo — [Raklet pricing](https://www.raklet.com/pricing)

**Memberful** (WordPress/creator-oriented, included as asked)
- Standard $49/mo plus 4.9% transaction fee per the fetched page, with a "try free until you go live" line; Enterprise custom. The 4.9% fee figure looks high relative to what I remember; verify on the live page. Payout terms not stated — [Memberful pricing](https://memberful.com/pricing/)
- Built for paid content, newsletters and podcasts rather than clubs. No member directory or chapter tooling listed.

**GroupWorks**
- Ceased operations 21 June 2024 (**possibly stale but final**); MembershipWorks published a migration page for its customers — [search summary](https://membershipworks.com/groupworks-alternative/)

**Glue Up** (no public price list)
- Custom quote, billed annually. Glue Up FAQ (old) says basic from $125/mo; a May 2026 read reports Lite from $1,000/yr up to $15,500/yr; Capterra lists $9/user/mo; ITQlick lists $99–$299/mo (least reliable). No free trial — [search summary of Memberlytic, xpay, Capterra](https://memberlytic.com/blog/glue-up-pricing-guide), [Glue Up FAQ](https://www.glueup.com/faqs/what-cost-associated-using-glue-membership-crm)
- Aimed at chambers and associations, not small clubs.

**Broad market context**
- Entry-level small-club setups typically $50 to $150 per month; per-contact pricing counts lapsed members, attendees and donors, so a 60-member club can carry 150+ contacts — [search summary: group.app and other blogs, vendor-biased](https://www.group.app/blog/membership-management-software/)

### Inferences
- Pricing by "contacts" instead of paying members is the structural complaint: a 100-member club often lands in a higher tier because of past members and guests.
- Tools that sit on the group's own Stripe/PayPal gateway (MembershipWorks, Join It, Raklet, Wild Apricot via Stripe) leave funds with the group but still stack the subscription on Stripe's fee.
- No tool in this group is both under about $20 a month and complete for a 100-person club (sign-ups, volunteer scheduling, events, dues).

### Gaps
- ClubExpress official pricing and review quotes; Memberful review quotes; Glue Up review quotes; Join It and Raklet review quotes; primary source for the Personify acquisition; Capterra/G2 individual reviews were only seen via summary and not quoted verbatim.

## 3. Group treasurer and fiscal tools: Open Collective, HOA and neighborhood tools

### Takeaway
Open Collective is fiscal-host infrastructure with the host holding the money; its largest US host collapsed in 2024. HOA software (PayHOA) is priced per unit at about $49 to $54 a month for 25 units and is built for property dues, not clubs.

### Cited Findings
- Open Collective pricing for hosts: Discover $0, Basic $60/mo, Pro $320/mo, each capping active Collectives and paid expenses with overage charges. Crowdfunding contributions free if "Platform Tips" are activated, otherwise a 5% Crowdfunding Fee. Payouts via Wise and PayPal. Hosts hold contributions on behalf of Collectives; Collectives do not hold funds. The page does not state host-fee rates; the older 15% revenue share on host fees is replaced — [Open Collective pricing](https://opencollective.com/pricing)
- Open Collective Foundation (US 501(c)(3) fiscal host, about 600 collectives holding roughly $18 million) announced on 28 Feb 2024 it would dissolve effective 31 Dec 2024; last day to accept donations 15 Mar 2024, to spend or transfer funds 30 Sep 2024 (**2024, possibly stale as status, not as history**) — [search summary: Open Collective statement and explainers](https://blog.opencollective.com/open-collective-official-statement-ocf-dissolution/), [Community Over Code explainer](https://communityovercode.com/2024/02/open-collective-foundation-shutdown-explainer/)
- The platform stayed up; since 2024 it is stewarded by the Open Finance Consortium (OFiCo); Open Source Collective and OC Europe remain active hosts — [search summary: Wikipedia](https://en.wikipedia.org/wiki/Open_Collective)
- A former OCF collective admin said OCF charged 5% against 10% at many hosts; a 2026 overview says 5–10% plus processing is typical. No official 2026 host fee schedules found — [search summary: HN thread](https://news.ycombinator.com/item?id=39533004), [goodkeep.org](https://goodkeep.org/blog/open-collective-foundation-alternatives) (secondary)
- PayHOA: entry $49 to $54/mo for up to 25 units (sources disagree; $49 reads as annual billing, $54 as monthly). Tiers: 26–50 units $65; 51–100 $109; 101–150 $142. Processing fees separate and not captured — [Capterra/G2/Software Advice listings](https://www.capterra.com/p/146693/PayHOA/pricing/), [The HOA Guide](https://www.thehoaguide.com/hoa-software-management/payhoa-review/) (search summary)

### Inferences
- A fiscal host is the legal answer for an unincorporated group wanting tax-deductible or insured handling, but it puts custody and a 5–10% cut in someone else's hands, and the OCF collapse shows the single-host risk. Not the fit for an at-cost, group-owns-its-Stripe kit.
- HOA tools price per unit and assume assessments, liens and a board; neighborhood associations without a legal HOA are underserved.

### Gaps
- Primary 2026 host fee schedules for Open Source Collective and others; PayHOA's processing fees; other neighborhood-association tools (Nextdoor-adjacent, Wild Apricot use) were not researched; r/Treasurer, r/PTA threads not found.

## 4. Informal tools: Venmo, PayPal, Zelle, Splitwise, Square

### Takeaway
Venmo, PayPal and Zelle are cheap or free but their terms bar personal accounts from collecting dues for a group; the compliant route is a business profile with a fee. The 1099-K threshold is back to $20,000 and 200 transactions, so a small club rarely gets a form. Splitwise only tracks debts and does not move money. Square has no nonprofit rate.

### Cited Findings
- 1099-K: the One Big Beautiful Bill Act (law 4 July 2025) restored the $20,000 and more-than-200-transactions threshold, replacing the $600 level scheduled for 2026 — [search summary: Avalara and others](https://www.avalara.com/us/en/blog/one-big-beautiful-bill-act-1099-reporting-threshold.html)
- Venmo's own help page for 2025: Venmo and PayPal issue a 1099-K only when goods-and-services payments exceed $20,000 and 200 separate transactions; friends and family payments are excluded; state thresholds are lower in Maryland, Massachusetts, Vermont and Virginia ($600) and Illinois (more than $1,000 and 4+ transactions); anyone subject to 24% backup withholding gets a 1099-K regardless — [Venmo help](https://help.venmo.com/cs/articles/about-current-tax-laws-vhel103) (the page covers 2025 only, not 2026)
- Venmo seller fee: 1.9% + $0.10 on payments marked goods and services, on personal or business profiles. Venmo's terms bar personal accounts from business use except where authorised; if its system flags commercial activity it can freeze the account, hold funds or require a business profile — [search summary: PetaPixel, BiggerPockets, others](https://petapixel.com/2021/06/28/venmo-will-let-personal-users-sell-goods-and-services-for-a-price/) (the Venmo business-profile page returned 404; Venmo's terms not read directly)
- A competitor blog argues dues are services and that automated detection can freeze recurring-pattern personal accounts — [Somiti blog (competing product, possibly biased)](https://somiti.net/blog/stop-using-venmo-for-club-dues)
- PayPal: confirmed-charity rate 1.99% + $0.49; unconfirmed nonprofits pay the standard donation rate of 2.89% + $0.49; discount requires PayPal's Confirmed Charity approval; Venmo charity profile 1.9% + $0.10, requires a PayPal Business account and cannot convert from a Venmo business nonprofit profile — [search summary of PayPal's merchant fee page, updated 1 Oct 2026](https://www.societ.com/blog/nonprofit-resources/paypal-nonprofit-fees-everything-you-need-to-know/) (PayPal page returned 403; third-party figure used). The standard rate for non-donation payments such as dues was not confirmed. The "purchase protection" cost question: for personal accounts the cost is the goods-and-services fee above, which gives the payer buyer protection; I found no source quantifying a separate "purchase protection fee". Gap.
- Zelle: the User Service Agreement says the service is for personal, not business or commercial, use; business terms exclude requests for "money owed to another person" (arguably a treasurer collecting dues, not applied to clubs by any source I found); small-business Zelle must be linked to a business account at participating banks; limits vary by bank (e.g. Wells Fargo consumer $3,500 per 24 hours, $20,000 per 30 days; Citi untenured consumer $500 daily, $2,500 monthly) — [Zelle User Service Agreement](https://www.zellepay.com/legal/user-service-agreement), [Wells Fargo Zelle terms](https://www.wellsfargo.com/mobile-online-banking/transfers/zelle-terms/), [NerdWallet](https://www.nerdwallet.com/business/software/reviews/zelle-for-business) (search summary)
- Splitwise: US App Store Pro $4.99/mo or $39.99/yr (as of August 2026, per a third-party blog; another says about $49.99); free plan limited to about 3 to 5 expenses a day with ads; a ledger, not a payment processor — [search summary of third-party blogs](https://usefairsplit.com/blog/splitwise-pricing/)
- Square: online card 3.3% + 30¢ on Free, 2.9% + 30¢ on Plus ($49/mo) and Premium ($149/mo); invoice ACH 1% ($1 min); no nonprofit pricing on the page; custom pricing only above $250,000/yr — [Square fees](https://squareup.com/us/en/payments/our-fees) (the Plus/Premium prices and free-plan rate change come from [search summary](https://www.zeffy.com/blog/square-for-nonprofits), a competitor)

### Inferences
- At $50 a year and 100 members, a group sits at $5,000 a year, well below the $20,000 1099-K trigger, so tax reporting is not a practical driver for small clubs. It becomes one for a rec league or a gala-style event year.
- Venmo/Zelle personal-account collection is the status quo for a volunteer treasurer; the pain is not fees but freezes, commingled personal funds, and no records.

### Gaps
- Venmo and PayPal terms of service read directly; Venmo "purchase protection" cost; Reddit threads in r/Treasurer, r/PTA.

## 5. Stripe Connect: account types, platform cost, nonprofit rates, ACH, onboarding

### Takeaway
Stripe now labels Standard, Express and Custom as legacy "account types" and steers new platforms to controller properties or the Accounts v2 API. A platform can pay nothing (Stripe sets and collects fees) or $2 per active account plus 0.25% + 25¢ per payout. A group's own Stripe account needs an EIN or an SSN of an individual regardless.

### Cited Findings
- Account types (Stripe docs): Standard has Stripe-handled onboarding and a full Dashboard, direct charges only, with fraud and dispute liability on the connected account for direct charges. Express has Stripe onboarding, an Express Dashboard, and platform liability. Custom has platform or Stripe onboarding, no dashboard, platform support and liability. "There's an additional cost for using Express or Custom connected accounts." The page marks these as legacy and says new platforms should use the Accounts v2 API or controller properties — [Stripe: connected account types](https://docs.stripe.com/connect/accounts)
- Connect platform pricing: "Stripe handles pricing" means Stripe sets and collects processing fees and the platform pays no account, payout-volume or per-payout fees. "You handle pricing" costs $2 per monthly active account plus 0.25% + 25¢ per payout, plus 0.25% of payout volume for funds routing. 1099 forms $2.99 per IRS e-file. Instant payouts 1% — [Stripe Connect pricing](https://stripe.com/connect/pricing)
- Standard card pricing 2.9% + 30¢; ACH Direct Debit 0.8% capped at $5.00; dispute $15; instant payout 1.5% (min 50¢). No nonprofit discount listed on the pricing page — [Stripe pricing](https://stripe.com/pricing)
- Nonprofit discount (third-party; Stripe's nonprofit page returned 404): 2.2% + 30¢ for verified 501(c)(3)s with at least 80% of volume as tax-deductible donations, applied by request, not retroactive. Ticket sales, tuition or membership fees may not qualify — [Givebutter blog (competitor)](https://givebutter.com/blog/stripe-for-nonprofits), [Zeffy blog (competitor)](https://www.zeffy.com/blog/stripe-for-nonprofits), [Donorbox help](https://donorbox.zendesk.com/hc/en-us/articles/360020292952-Can-nonprofits-get-discounted-processing-fees)
- Onboarding: Stripe requires a verifiable TIN; without an EIN, an SSN or ITIN; "Even when using an EIN to verify a business, you are still required to provide the SSN" of associated individuals — [Stripe support](https://support.stripe.com/questions/signing-up-for-a-us-stripe-account-without-a-tax-id-or-employer-id-number)
- Stripe's EIN entity types include unincorporated associations and non-profits; an unregistered business needs a US-located owner or representative and a physical address, no PO boxes; an older (about two years) sports-club help page describes a "Don't have a business registry number?" option for unincorporated organisations (**possibly stale**) — [search summary of Stripe docs](https://docs.stripe.com/acceptable-verification-documents?country=US&document-type=entity), [Stripe requirements](https://support.stripe.com/questions/requirements-for-having-a-us-stripe-account), [Sportlabs help](https://sportlabs.zendesk.com/hc/en-us/articles/360050822551-Stripe-Verification-Support)
- Stripe says that on Express/Custom accounts using direct charges, the connected account is charged at standard sticker rates rather than the platform being billed, so pricing control needs destination charges — [Stripe: connected account types](https://docs.stripe.com/connect/accounts)

### Inferences
- "Payments go into each group's own Stripe account" maps to the legacy Standard type (or the v2/controller-property equivalent): the group has the Dashboard, a direct Stripe relationship, and takes dispute liability. This is the lowest platform cost and the clearest "who holds the funds" story, but the group sees the full Stripe Dashboard and must complete verification itself.
- A rough annual Stripe platform cost under "you handle pricing" for one group with monthly payouts of about $5,000 total: $24 account fees plus $3 plus $12.50 payout volume = about $39.50 a year (my arithmetic from the published rates).
- Stripe's guidance to use controller properties instead of Standard/Express/Custom is a design fork the build team should resolve against current docs rather than the older vocabulary.

### Gaps
- Stripe's own nonprofit-rate and unincorporated-association onboarding pages did not load or did not address clubs; Stripe's EIN-by-entity-type page was not fetched; whether an informal club can pass verification with the treasurer's SSN as an "individual" versus needing a real business structure was not confirmed from a Stripe primary source.

## 6. Comparison table: effective annual cost for $50/yr dues, 100 members ($5,000 gross)

### Takeaway
Cheapest paths to the group are Stripe directly (about $175) and ACH (about $40), then Venmo Business (about $105); subscription membership tools land between about $400 and $1,000 a year before any payer-side fees. The "free" tools shift cost to a payer tip.

### Cited Findings
All figures are my arithmetic from the cited rate cards, 100 separate $50 payments in a year, no refunds or disputes, org absorbs fees where noted. Stripe card = 2.9% + $0.30 = $1.75 per payment = $175. "Third-party" means the vendor page did not load or does not state the figure.

| Tool | Platform subscription | Per-payment cost | Estimated total to the group | Who holds funds | Source |
|---|---|---|---|---|---|
| Stripe direct, card | $0 | 2.9% + 30¢ | $175 | Group's own Stripe account | [Stripe pricing](https://stripe.com/pricing) |
| Stripe direct, ACH | $0 | 0.8% capped $5 = $0.40 | $40 | Group's Stripe | [Stripe pricing](https://stripe.com/pricing) |
| Stripe nonprofit rate (if eligible; unlikely for dues) | $0 | 2.2% + 30¢ | $140 | Group's Stripe | third-party: [Givebutter blog](https://givebutter.com/blog/stripe-for-nonprofits) |
| Zeffy | $0 | $0 to org; payer tip (Zeffy: avg 4% of gift; a pre-selected 17% on $50 in one test) | $0 to org; payer side about $200 at 4% up to $850 at 17% | Stripe connected account via Zeffy, Zeffy controls payouts | [Zeffy](https://www.zeffy.com/pricing); [search summary](https://checkthat.ai/brands/zeffy/reviews) |
| Givebutter, tips on | $0 | $0 to org; payer tip | $0 to org | Givebutter; payout 2-3 days | [Givebutter](https://givebutter.com/pricing) |
| Givebutter, tips off | $0 | 3% + 2.9% + 30¢ | $325 | Givebutter | [Givebutter](https://givebutter.com/pricing) |
| Cheddar Up Free (payer covers, default) | $0 | 3.95% + $0.95 = $2.93 | $0 to org if payer pays; $292.50 if org absorbs | Not stated | [Cheddar Up](https://www.cheddarup.com/pricing/) |
| Cheddar Up Pro | $180 | 3.59% + $0.59 = $2.39 | $418.50 if org absorbs ($180 if payer pays) | Not stated | [Cheddar Up](https://www.cheddarup.com/pricing/) |
| Cheddar Up Team | $420 | 3.59% + $0.59 | $658.50 absorbed | Not stated | [Cheddar Up](https://www.cheddarup.com/pricing/) |
| Wild Apricot, 100 contacts, annual prepay | $712.80 | gateway fees; Personify Payments rates not found | $888 via Stripe ($712.80 + $175), or about $1,030 if the reported 20% servicing fee applies | Group gateway or Personify | [Wild Apricot](https://www.wildapricot.com/pricing); 20% figure from [reviews summary](https://www.capterra.com/p/76116/WildApricot/) |
| MembershipWorks (51-300 tier) | $420 | Stripe only | $595 | Group's Stripe/PayPal | [MembershipWorks](https://membershipworks.com/pricing/) |
| Join It Starter, annual | $313.20 | 3% + Stripe | $638 ($313.20 + $150 + $175) | Group's Stripe | [Join It](https://www.joinit.com/pricing) (member-tier cap for $29 not stated) |
| Raklet Free | $0 | 4% + $0.60 plus gateway | $435 ($260 + $175) | Stripe | [Raklet](https://www.raklet.com/pricing) |
| Raklet Essentials | $588 | 3% + $0.60 plus gateway | $973 | Stripe | [Raklet](https://www.raklet.com/pricing) |
| ClubExpress | $504 (100 x $0.42 x 12) plus setup $150+ | merchant processing extra | about $680 plus setup | Group merchant account | third-party: [Capterra summary](https://www.capterra.com/p/42550/ClubExpress/) (vendor page 403) |
| Memberful | $588 | 4.9% + Stripe | about $1,008 | Group's Stripe | [Memberful](https://memberful.com/pricing/) (4.9% figure to verify) |
| Glue Up | about $1,000 to $1,500 | not stated | about $1,175 and up | not stated | third-party: [Memberlytic](https://memberlytic.com/blog/glue-up-pricing-guide), [xpay](https://www.xpay.sh/saas-pricing/glue-up/) |
| Open Collective via a host | host plan or $0 | 5% platform fee unless tips, plus host fee 5-10% (unverified), plus processing | about $425 to $925 | Fiscal host | [Open Collective](https://opencollective.com/pricing); host fee from [secondary](https://goodkeep.org/blog/open-collective-foundation-alternatives) |
| PayHOA (25 units; not a fit for 100 members) | $588 to $648 | processing extra | n/a | not retrieved | [Capterra](https://www.capterra.com/p/146693/PayHOA/pricing/) |
| Venmo Business | $0 | 1.9% + $0.10 = $1.05 | $105 | Venmo balance | third-party: [PetaPixel](https://petapixel.com/2021/06/28/venmo-will-let-personal-users-sell-goods-and-services-for-a-price/) |
| Venmo personal, "friends and family" | $0 | $0 | $0 but against terms, freeze risk | Treasurer's personal Venmo | [same](https://petapixel.com/2021/06/28/venmo-will-let-personal-users-sell-goods-and-services-for-a-price/) |
| PayPal (donation rate used; dues rate not confirmed) | $0 | 2.89% + $0.49 = $1.93 | $193.50 | PayPal balance | third-party: [Societ](https://www.societ.com/blog/nonprofit-resources/paypal-nonprofit-fees-everything-you-need-to-know/) |
| Zelle | $0 | $0 | $0 but personal-use terms | Treasurer's bank | [Zelle agreement](https://www.zellepay.com/legal/user-service-agreement) |
| Square Free, online card | $0 | 3.3% + 30¢ = $1.95 | $195 | Square | [Square](https://squareup.com/us/en/payments/our-fees) |
| Square invoice ACH | $0 | 1% (min $1) = $1 | $100 | Square | [Square](https://squareup.com/us/en/payments/our-fees) |
| Splitwise | $0 to $40 | does not process payments | n/a | n/a | [third-party](https://usefairsplit.com/blog/splitwise-pricing/) |

### Inferences
- Stripe-direct with ACH offered next to card is the floor for a group-owned account: about $40 to $175 on this volume. A kit priced at cost sits at that floor plus whatever the platform pays Stripe (about $0 to $40 per account a year by the Connect rate card).
- Raklet Free and Cheddar Up Free look cheap but their 4% + $0.60 and 3.95% + $0.95 card rates are higher than Stripe's own 2.9% + $0.30 because the small fixed fee hits $50 payments hardest.

### Gaps
- Several rows rest on third-party figures where the vendor page failed (ClubExpress, PayPal, Venmo, Glue Up, Stripe nonprofit).

## 7. Gaps no current tool fills

### Takeaway
No surveyed tool combines group-owned Stripe, volunteer scheduling, event pages, tickets and dues at near-Stripe cost for a non-501(c)(3) adult group without a tip prompt.

### Inferences (derived from the findings in sections 1 to 5; no new sources)
- Group-owned money with an at-cost platform: the tip-funded tools (Zeffy, Givebutter) hold the Stripe connected account and set payout schedules; the membership tools charge $35 to $66 a month plus a percentage; none sells "your Stripe account plus the tools, at cost".
- Volunteer scheduling is absent from every pricing page read (Wild Apricot lists events and registration; Cheddar Up lists sign-ups and ticketing); no volunteer-shift feature was found on any of them. Confirm this by direct check of each product's feature list before treating it as settled.
- Unincorporated clubs: tools are priced for "nonprofits" or "organizations"; none of the pages fetched say how an unincorporated club passes onboarding.
- Small-count pricing: per-contact pricing counts non-payers; the cheapest compliant path in the table is a payment-only tool without membership features.
- A record the volunteer treasurer can hand to the next treasurer: Venmo/Zelle leave records in a personal account; the only handoff story I found was Open Collective's hosted ledger.
- ACH presented first: Stripe ACH is 0.8% capped $5 against 2.9% + 30¢ card, yet the membership tools surveyed mostly lead with cards.
- Handover and succession of the Stripe account when a treasurer leaves was not addressed by any source found.

### Gaps
- No review corpus was found about treasurer turnover; r/Treasurer and r/PTA threads were not retrieved.

## 8. The hurdle for an unincorporated volunteer group taking card payments

### Takeaway
An unincorporated club has no entity with an EIN-backed identity unless it applies for one, and Stripe requires a verifiable TIN plus the SSN of an individual either way, so a volunteer personally attaches their identity to the account.

### Cited Findings
- Stripe requires a verifiable TIN (EIN, SSN or ITIN) and still requires the SSN of associated individuals even with an EIN — [Stripe support](https://support.stripe.com/questions/signing-up-for-a-us-stripe-account-without-a-tax-id-or-employer-id-number)
- Stripe accepts EIN documents such as IRS Letter 147C or SS-4 confirmation and lists unincorporated associations among entity types; unregistered businesses need a US-located owner or representative and a physical (non-PO-box) address — [search summary of Stripe docs](https://docs.stripe.com/acceptable-verification-documents?country=US&document-type=entity), [Stripe requirements](https://support.stripe.com/questions/requirements-for-having-a-us-stripe-account)
- Using an SSN as a sole proprietor means Stripe checks the individual, not the club name — [search summary of Stripe support](https://support.stripe.com/questions/signing-up-for-a-us-stripe-account-without-a-tax-id-or-employer-id-number)
- Stripe's nonprofit discount needs a registered 501(c)(3) with at least 80% of volume as donations, which dues and ticket sales may not meet — [Givebutter blog (competitor)](https://givebutter.com/blog/stripe-for-nonprofits)
- Zeffy-style holds follow Stripe verification: Zeffy says holds occur when Stripe needs to verify details; reviewers report weeks of holds — [search summary of Zeffy Trustpilot reply](https://www.zeffy.com/compare/zeffy-vs-stripe)
- Venmo and Zelle terms bar personal accounts from business collection, so the alternative to Stripe is a terms violation — see section 4.

### Inferences
- The specific hurdle is identity and liability: the treasurer's SSN is the verification record (or the club gets an EIN as an unincorporated association from the IRS), Stripe's 1099-K/KYC sits on that person, and when that treasurer leaves the account tied to their identity must be changed. Whether the treasurer is personally liable for chargebacks (the connected account bears dispute liability under direct charges per [Stripe docs](https://docs.stripe.com/connect/accounts)) for a club with no legal entity is a legal question this research did not answer.
- Obtaining an EIN is the usual mitigation; the IRS EIN process was not researched here.
- Stripe's own account-ownership and bank-account-in-the-club's-name requirements for unincorporated clubs were not found; the bank account needs to be a club account, which itself needs an EIN at most banks (not researched, unverified).

### Gaps
- Stripe primary source on exactly what an unincorporated association must submit (the entity-types page was surfaced only in a search summary).
- IRS and bank requirements for an unincorporated-association EIN and bank account.
- Legal exposure (treasurer personal liability) not researched; needs a lawyer or a primary source.

## Left uncovered (for the notes the brief asked for)
- Direct Capterra, G2 and Trustpilot review quotes for Wild Apricot, ClubExpress, MembershipWorks, Join It, Raklet, Memberful, Glue Up: seen only through search summaries; individual reviews were not opened or quoted verbatim.
- All Reddit threads (r/nonprofit, r/PTA, r/Treasurer): not retrieved directly; Zeffy-related Reddit quotes are secondhand.
- ClubExpress, PayPal, Venmo business, Stripe nonprofit pages failed to load; third-party figures used and flagged.
- Volunteer scheduling features of the competitors were not verified per product.
- Open Collective hosts' 2026 fee schedules; neighborhood-association tools beyond PayHOA.
- Memberful's $49 + 4.9% figure looks unusual and needs a re-check; Cheddar Up's fee table alignment was flagged by the fetch tool as uncertain.
