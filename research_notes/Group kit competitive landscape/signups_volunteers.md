# US sign-up sheet, volunteer scheduling and group coordination tools (late 2026)

Research date: 2026-11-15. About 40 tool calls. Reading guide: "(primary)" means I loaded the vendor's own page; "(third-party)" means a comparison site, review aggregator or search-result summary. Many comparison sites are written by competing vendors (Zelos, Signupkit, SignUpReady, Grasshopper, Zeffy, CircleCare); their framing is biased and I flag where it matters. I could not retrieve any actual Reddit thread (reddit.com is blocked to the fetch tool and web search returned none), so Reddit evidence is a gap, not a finding.

## 1. SignUpGenius and SignUp.com (the two incumbents): pricing, payments, ads, ownership

### Takeaway
Both are freemium with ads shown to participants on the free tier, and paid tiers do not fully remove ads. SignUpGenius is owned by a PE-backed roll-up (Lumaverse), SignUp.com is a small VC/angel-backed company. Payments on SignUpGenius carry a 5% + $0.50 platform fee on top of Stripe, which is the main number an at-cost entrant undercuts.

### Cited Findings
- **SignUpGenius pricing page failed to load twice** (signupgenius.com/pricing and www.signupgenius.com/pricing returned only nav and "Loading..."). Figures below are third-party, "verified August 2026" by Zelos, a competitor — [Zelos SignUpGenius vs SignUp.com](https://getzelos.com/signupcom-vs-signupgenius) — and agree with a search summary of [Capterra pricing](https://www.capterra.com/p/135392/SignUpGenius/pricing/).
- SignUpGenius plans: Basic free (ads shown); Silver $8.99/mo billed annually, $11.99 monthly (1 ad-free sign-up); Gold $22.49 annual, $29.99 monthly (10 ad-free); Platinum $44.99 annual, $59.99 monthly (unlimited ad-free); Enterprise custom — [Zelos](https://getzelos.com/signupcom-vs-signupgenius)
- SignUpGenius' own cost article names the plans Free, Starter, Essentials, Premium, Enterprise (names differ from the third-party Silver/Gold/Platinum; no prices on page, date unstated) and says ad-free pages are on Starter and above — [SignUpGenius cost article (primary)](https://www.signupgenius.com/resources/signupgenius-cost)
- Third-party detail on tiers: Silver has 2,500 emails and 150 texts/month, 2 custom questions; Gold adds 10 admins, 10,000 emails, 500 texts; waitlist management needs Gold — search summary citing [Capterra](https://www.capterra.com/p/135392/SignUpGenius/pricing/) and [Software Advice](https://www.softwareadvice.com/nonprofit/signupgenius-profile/) (not fetched; moderate confidence)
- SignUpGenius payments: organizer chooses whether buyer or seller pays a service fee of 5% of the price + $0.50 per transaction; setup goes through the organizer's own Stripe account; same fee on all plans — [SignUpGenius fee help page (primary, via search snippet)](https://www.signupgenius.com/support/collect-money-fees), [SignUpGenius Stripe blog](https://sugeni.us/blog/signupgenius-payments-stripe)
- Conflict: SignUpGenius' cost article says payment collection needs Starter or above; Zelos says the 5% + $0.50 applies "including the free plan" — [cost article](https://www.signupgenius.com/resources/signupgenius-cost) vs [Zelos](https://getzelos.com/signupcom-vs-signupgenius)
- SignUpGenius SMS reminders cover US and Canada numbers; no full mobile app, only a Payment Companion App — [Zelos](https://getzelos.com/signupcom-vs-signupgenius)
- Participants do not need an account (email address is enough) — [Zelos sign-up sheet roundup](https://getzelos.com/apps-for-sign-up-sheets)
- **SignUpGenius ownership:** Lumaverse Technologies (Charlotte, NC), PE-backed. Providence Strategic Growth announced a strategic majority investment 10 July 2017; Lumaverse portfolio per a 2020 release: SignUpGenius, NonProfitEasy, TimeTap, Fundly, Membership Toolkit, AtoZConnect, Learning Stream, GoSignMeUp. Sources disagree on whether the 2017 deal was "acquisition by Lumaverse" or a PSG investment. — [Mergr](https://mergr.com/transaction/lumaverse-technologies-acquires-signupgenius), [PitchBook](https://pitchbook.com/profiles/company/436551-58), [BusinessWire 2020](https://www.businesswire.com/news/home/20200625005173/en/SignUpGenius-Joins-Technology-Leaders-to-Launch-New-Group-Management-Platform)
- **SignUp.com (formerly VolunteerSpot)** pricing page loaded (primary): Basic free (unlimited emails, participants, sign-ups, one organizer, one custom question, one group page); Starter $8.34/mo or $99.99/yr (unlimited SMS, 1 assistant organizer, participant spot limits, waitlist notifications); Plus $20.83/mo or $249.99/yr (5 assistants, waivers, sign-up lock, participant check-in); Max $41.66/mo or $499.99/yr (15 assistants, hours tracking and reporting, custom URLs); Campus from $99/yr for K-12 — [signup.com/pricing (primary)](https://signup.com/pricing)
- SignUp.com page shows an "AD-FREE UPGRADE AVAILABLE" line on paid tiers, i.e. ads remain on paid plans and removal is an add-on; one search result prices removal at $9.99/month (unverified) — [signup.com/pricing](https://signup.com/pricing), [Zelos](https://getzelos.com/signupcom-vs-signupgenius), [Signupkit](https://www.signupkit.co/best-signup-sheet-apps)
- SignUp.com payments about 2.9% + $0.30 (US/Canada organizers only); participant app costs $1.99 on the US App Store — [Zelos](https://getzelos.com/signupcom-vs-signupgenius) (third-party; fee not stated on the pricing page I loaded)
- Zelos describes paid SignUp.com as adding slot limits, waitlists, swaps and SMS reminders — [Zelos roundup](https://getzelos.com/apps-for-sign-up-sheets)
- SignUp.com ownership: private, rebranded from VolunteerSpot July 2016, founded 2009 Austin TX, raised roughly $2M to $5.3M depending on source (company's 2016 release says $5M), investors include AXA Strategic Ventures ($1.3M, Sept 2015), ff Venture Capital, WildBasin, Fresco, Capital Factory; acquired MySignUp in 2017; PitchBook lists a latest private secondary transaction with Provident Trust Group as minority investor, undated — [PitchBook](https://pitchbook.com/profiles/company/54704-98), [Rebrand release](https://support.signup.com/about/company-press-releases/austin-based-consumer-app-rebrands-from-volunteerspot-to-signupdotcom), [FinSMEs](https://www.finsmes.com/2015/09/volunteerspot-raises-1-3m-vc-funding.html). Funding data may be stale (2015-2017).

### Inferences
- The two incumbents split the market on one axis: SignUp.com's paid tiers are a cheaper annual flat fee ($100/yr entry); SignUpGenius is pricier month to month but has the bigger installed base (Trustpilot 4,132 reviews).
- Both keep ads as the lever pushing organizers to pay, so ad-free-by-default is a real differentiator, not a nicety.
- The organizer's-own-Stripe model already exists at SignUpGenius, but with an extra 5% + $0.50, so "payments into the group's own Stripe at cost, no platform cut" is a pure price differentiator.

### Gaps
- SignUpGenius official pricing page never loaded; official plan names and prices in 2026 unconfirmed (names conflict between its own article and third parties).
- No official source for SignUp.com's payment fee or ad-removal price.
- Recent SignUpGenius price hikes: none found (a Trustpilot summary reported none specifically).

## 2. What users complain about: SignUpGenius and SignUp.com

### Takeaway
Ads dominate complaints for both, followed by paid-tier cost (especially for schools/nonprofits), then slow or clunky site and mobile creation. Ratings remain high (Trustpilot 4.3, Software Advice 4.8), so the pain is irritation, not abandonment.

### Cited Findings
- SignUpGenius Trustpilot: 4.3, 4,132 reviews, 80% five-star. Recurring: "the ridiculous ads that constantly pops up every 10 secs is HORRIBLE" (5 Nov 2026); "there were still ads popping up" on a paid trial (11 Aug 2026); "I do wish the subscriptions were more inexpensive" (6 Nov 2026); "Starting a new Signup is not intuitive" (17 Feb 2026); "not very mobile friendly when it comes to creating signups" (5 Nov 2026); a longtime free user regretted losing the option to add hyperlinks to text (2 Nov 2026) — [Trustpilot](https://www.trustpilot.com/review/signupgenius.com)
- Other Trustpilot reviewers: asked about paying $120 a year to send 12-18 sign-ups; wanted a monthly option for occasional users; one said ads make email programs flag the notices as spam so volunteers miss information (older cached pages, 1-2 years old, may be stale) — search summary of [Trustpilot pages](https://www.trustpilot.com/review/signupgenius.com)
- SignUpGenius Capterra reviewers: free version "has ads that can be distracting," some advanced features need paid upgrade — search summary of [Capterra reviews](https://www.capterra.com/p/135392/SignUpGenius/reviews/?page=10) (reviews page itself returned 403)
- SignUp.com on Software Advice/Capterra/G2: "EXTREMELY spammy" with ads on volunteer page, admin page and in sign-up emails; Capterra reviewers complain of ads in notification emails; one complained of the price and being unable to share admin rights without upgrading, "nonprofits have little funds"; another said no way to edit a shift on the volunteer calendar, you must delete and re-add; ratings 4.8 (401 reviews, Software Advice), 4.7 (47, G2) — search summary of [Software Advice](https://www.softwareadvice.com/nonprofit/volunteerspot-profile/reviews/) and [G2](https://www.g2.com/products/signup-com/reviews) (pages themselves returned 403; unverified quotes)
- SignUp.com Google Play app: 2.4 stars from 66 reviews; one reviewer upgraded to ad-free, "experience didn't improve," no refund — search summary of [Google Play listing](https://play.google.com/store/apps/details?id=com.volunteerspot.mobile&hl=en_US)
- Vendor claim (competitor, treat with caution): ads land on top of sign-up buttons — [Zelos alternatives](https://getzelos.com/signup-genius-alternatives)

### Inferences
- "Ads in the emails that volunteers receive" is the sharpest version of the complaint because it hurts deliverability and trust with the organizer's own members.
- Admin-sharing gated behind paid tiers hits PTAs where officers rotate yearly.

### Gaps
- No Reddit threads (r/PTA, r/nonprofit, r/churchtech, r/volunteer) could be retrieved; user voice here is only from review sites.
- Capterra, G2 and Software Advice pages returned 403; quotes come from search summaries.

## 3. Meal and care-coordination tools: Meal Train, TakeThemAMeal, Lotsa Helping Hands, CaringBridge

### Takeaway
Meal Train is free to start with ads and a fee on cash gifts; Lotsa Helping Hands is still running but stagnant; CaringBridge retired its Planner and is donor-funded; TakeThemAMeal is a small meal-delivery-plus-scheduler business. This segment is consumer/family caregiving, not group admin.

### Cited Findings
- Meal Train: creating a page is free; "Meal Train Pro" exists; trademark held by Meal Train LLC — [mealtrain.com (primary)](https://www.mealtrain.com/)
- Meal Train Pro is $15/month, up to 10 administrators, unlimited Plus pages — [Meal Train Pro page (primary via search)](https://www.mealtrain.com/learn/pro/)
- Third-party: free page allows one volunteer per day; Plus is $10 once per page (multiple helpers per day, non-meal help). SignUpReady lists $4.99/$19.99 which conflicts; treat as unreliable. — [Rallee](https://rallee.com/best-mealtrain-alternative-comparison), [SignUpReady](https://www.signupready.com/compare/meal-train/pricing)
- Meal Train cash gifts/tips: 5% platform fee plus 2.9% + $0.30 card fee (7.9% + $0.30); help center example shows $100 arriving as $91.80 — [SupportNow comparison](https://www.supportnow.org/meal-train-alternative) (third-party; Meal Train help page I fetched did not state fees)
- Gift cards fulfilled by InComm/TheGiftCardShop.com; cannot be cancelled or refunded; giver's name can be anonymous but amount cannot be hidden — [Meal Train help (primary)](https://www.mealtrain.com/help/article/485-other-gift-card-questions)
- Meal Train 2026 comparison says free tier has ads and ad-free premium is $7/month — [SignUpReady blog](https://www.signupready.com/blog/best-meal-train-apps-2026) (vendor; unverified)
- Meal Train ownership: independent private LLC, founded 2009 by Michael Laramee and Stephen DePasquale Jr, Burlington VT, 1-10 employees, no acquisition found — [PitchBook](https://pitchbook.com/profiles/company/128921-86), [Crunchbase](https://www.crunchbase.com/organization/meal-train)
- Meal Train complaints: double charge on a gift card purchase (BBB), frozen transactions and a "processing" hang over a minute (Trustpilot), unclear what Meal Train keeps from gift cards (BBB), the gift amount shown publicly (Trustpilot), support seems to be only the founders (BBB). Trustpilot 2.5 from 7 reviews, BBB 2/5 from 3 reviews: tiny samples. — [BBB](https://www.bbb.org/us/vt/burlington/profile/mobile-apps/meal-train-llc-0021-555358/customer-reviews), [Trustpilot](https://www.trustpilot.com/review/mealtrain.com)
- TakeThemAMeal: Harrisonburg VA, 1-10 employees, runs a store selling meals (about $65.95 to $77.95 for 3-4 adults) and a $75 gift card; no official pricing page found for the scheduler — [TakeThemAMeal store](https://takethemameal.com/shop/), [Crunchbase](https://www.crunchbase.com/organization/takethemameal). A comparison claiming it has no gift cards contradicts its own store — [SignUpReady](https://www.signupready.com/compare/vs/meal-train-vs-takethemameal).
- Lotsa Helping Hands: appears still operating in 2026, free ("Get started for free," no paid tier or pricing page found in an August 2026 check by competitor CircleCare); iOS app v5.0.1 updated April 2026; 3.0/5 from 97 App Store reviews per one aggregator; dated interface, no payments — [CircleCare](https://circlecare.app/blog/circlecare-vs-lotsa-helping-hands/), [Carezano](https://carezano.com/software/lotsa-helping-hands), [Soft112](https://lotsa-helping-hands-ios.soft112.com/). Ownership and funding not found (one source calls it a nonprofit/community resource, single source).
- CaringBridge: 501(c)(3), donor-supported since 1997, no advertising, donation buttons throughout; its Planner was retired December 2023 and replaced by "Requests" (discrete asks one helper claims), per its help center as quoted by competitors — [CircleCare](https://circlecare.app/blog/circlecare-vs-caringbridge/), [Rallee](https://rallee.com/best-caringbridge-alternative), [Caring Village](https://caringvillage.com/blog/caregiver-tech/caringbridge-alternatives/). I did not load the CaringBridge help page; some pages still describe the Planner as live (likely stale).

### Inferences
- Meal Train's fee on cash gifts (7.9% + $0.30) is the highest take rate found in the segment and also the least explained; a transparent at-cost model contrasts directly.
- This category is thin on adult-organizer "group" features; the leaders are tiny teams, so no consolidator pressure.

### Gaps
- No App Store / Google Play reviews retrieved for Meal Train or Lotsa.
- TakeThemAMeal's scheduler pricing and ads unknown.
- Lotsa Helping Hands ownership unknown.

## 4. Potluck and free volunteer sheets: Perfect Potluck, VolunteerSignup.org, Google Forms and Sheets

### Takeaway
There is a free, ad-free floor already: Perfect Potluck, VolunteerSignup.org and Google Forms cost nothing and show no ads. They lack reminders (Forms), payments, and real slot management, and the single-purpose ones have privacy and editing weaknesses.

### Cited Findings
- Perfect Potluck: free, no paid tiers, no ads, no participant account, dish categories and quantities, potluck calculator, email reminders, no payments; sign-up pages are public and Google-indexed and anyone who opens a page can change others' sign-ups — [Zelos roundup](https://getzelos.com/apps-for-sign-up-sheets) (vendor)
- Perfect Potluck help page: no RSVP, cannot rename or delete a category once claimed, no duplicate for recurring potlucks — search summary of its help page via [Zelos search result](https://getzelos.com/apps-for-sign-up-sheets); Whocan claims accounts are required, contradicted by other sources. Owner not found. — [Whocan](https://www.whocan.org/en/potluck-sign-up-sheet/)
- VolunteerSignup.org: self-described "completely free," made by volunteers, no ads or fees, restricted to non-commercial volunteer-supported organizations; no registration for volunteers; Canadian project running since 2011 per one review; sheets are search-indexed and show first name and last initial, entries remain after the event — [volunteersignup.org (primary)](https://volunteersignup.org/), [Zelos](https://getzelos.com/apps-for-sign-up-sheets)
- Google Forms: free, no ads, no respondent account, responses to Sheets, but no slot caps, no reminders, no payments, no overbooking prevention — [Zelos](https://getzelos.com/apps-for-sign-up-sheets), [Signupkit](https://www.signupkit.co/best-signup-sheet-apps)
- Google Sheets add-on "One Link Sign-up" turns a sheet into a sign-up web app — [Google Workspace Marketplace](https://workspace.google.com/marketplace/app/one_link_signup/272479866492)

### Inferences
- Free-and-ad-free is table stakes; an entrant cannot compete on "no ads" alone against these.
- The unmet piece is a free floor that also does reminders, slot caps and payments.

### Gaps
- Perfect Potluck owner and any recent changes unknown. VolunteerSignup.org operator only from a third-party review. No user-complaint data beyond vendor roundups.

## 5. Scheduling polls: Doodle, When2meet, Rallly, Framadate

### Takeaway
Doodle is the ad-heavy, paywall-tightening incumbent owned by Swiss media group TX; When2meet and Framadate are free and ad-light; Rallly is open source with a cheap Pro tier. Polls are a separate job from sign-ups, but an event page needs one.

### Cited Findings
- Doodle pricing page returned 404; figures are third-party. Free: ads, one group poll, one booking page, basic sign-up sheet. Pro $11/seat/month annual ($15 monthly); Team $16/seat annual ($21 monthly), 2-seat minimum; Enterprise from $15k/yr. Capterra's older $6.95 figure is likely outdated. — [SyncWhen](https://syncwhen.com/blog/doodle-free-vs-paid), [Koalendar](https://koalendar.com/blog/doodle-pricing), [Zelos](https://getzelos.com/apps-for-sign-up-sheets); older: [Capterra](https://www.capterra.com/p/142620/Doodle/pricing/)
- Doodle Pro adds ad-free, custom branding, unlimited booking pages and reminders; free tier caps polls at 10 time slots (one aggregator says cut from 20 to 10) — [SyncWhen](https://syncwhen.com/blog/doodle-free-vs-paid), [Tryorbye](https://www.tryorbye.com/products/doodle)
- Doodle ownership: subsidiary of TX Group AG (Zurich), full acquisition 2014; Christian Fielitz appointed CEO May 2025 — [TX Group release](https://tx.group/news-events/detail/doodle-sets-the-course-for-accelerated-growth-christian-fielitz-appointed-as-new-ceo/), [Crunchbase](https://www.crunchbase.com/organization/doodle-ag)
- Doodle complaints: free version "plastered with ads in every square inch" and almost unusable (Trustpilot); ads leave "1½ to 3 inches of viewing space"; Doodle replied ads let it offer services free and blocked booking links sound like a rendering issue; Capterra reviewer says editing options moved behind paywall; one Trustpilot review claims prices raised with no warning; confusing cancellation. Trustpilot's own summary is a 4.1 score, an aggregator claims 1.9 from 197 reviews (conflict; aggregator is suspect). — [Trustpilot](https://www.trustpilot.com/review/www.doodle.com), [Tryorbye](https://www.tryorbye.com/products/doodle), [Capterra](https://www.capterra.com/p/142620/Doodle/reviews/?page=13)
- Rallly (rallly.co/pricing, primary): Free = up to 3 open polls, 30-day retention; Pro $6/seat/month billed yearly (unlimited polls, email invites, team spaces, branding, API); page says "It's free! No login required"; pricing page notes rate is an early-adopter rate that will rise; page does not mention ads — [Rallly pricing](https://rallly.co/pricing)
- Rallly is AGPLv3; self-host licences: Personal 1 user free, Plus up to 5 users $49, Organization up to 50 users $499 (shown $299 limited offer), Enterprise from $999; guests voting do not count as users — [Rallly licensing](https://support.rallly.co/self-hosting/licensing), search summary
- Framadate: Framasoft (French non-profit) open-source poll, no tracking, no ads, no accounts, self-hostable, current version on Pollaris (AGPL-3), polls expire after 180 days per one comparison — search results at [Usecarly](https://www.usecarly.com/blog/group-scheduling-tools/), [Lunacal](https://lunacal.ai/blogs/doodle-alternatives) (not fetched)
- When2meet: free, no account, no tracking, outdated interface and not mobile optimized, not open source; one review notes a third-party ad outside the core flow — same sources (not fetched). Ownership not found.

### Inferences
- Doodle's free plan is the model of how ads degrade an organizer tool, and the reason people look for alternatives.
- Rallly shows how little a poll needs; it can be embedded or cloned as a feature rather than a product.

### Gaps
- Doodle official pricing not loaded. When2meet owner and Framadate/Pollaris current state only from secondary summaries.

## 6. Volunteer management platforms: VolunteerHub, Galaxy Digital, Better Impact, Bloomerang Volunteer, VolunteerLocal

### Takeaway
These are quote-based or $100-$300+/month annual products aimed at nonprofits with staffed volunteer programs; they are PE-owned or being rolled up. Their complaints are cost, setup effort and clunky UI. A PTA or church committee is priced out.

### Cited Findings
- VolunteerHub: Plus from $143/month, Pro $288/month, flat, billed annually, setup fee not published; Plus covers about 1,000 volunteers — [Capterra pricing](https://www.capterra.com/p/79209/VolunteerHub/pricing/), [Toolradar](https://toolradar.com/guides/best-volunteer-management-software) (third-party; vendor page not loaded)
- VolunteerHub reviews: Capterra 4.3 (43 reviews), G2 4.0 (17); complaints: clunky interface ("was clunky to use and did not meet our needs"), basic report formatting, "way too many marketing and reminder emails," pricey for features, Plus and Pro list identical features — [Capterra](https://www.capterra.com/p/79209/VolunteerHub/reviews/), [Toolradar](https://toolradar.com/guides/best-volunteer-management-software) (search summaries)
- Better Impact (Volunteer Impact): no published price; tiers Foundation (500 volunteers, 3 admins), Growth (2,000, 10), Impact (unlimited); one sample is about $315/month annual for 1,000 volunteers — [Getcommunal](https://getcommunal.com/guides/volunteers/best-volunteer-management-software-for-nonprofits) (third-party)
- Galaxy Digital (Get Connected): quote-based, no free plan; **acquired by Better Impact, announced 11 March 2026**; Better Impact is backed by veteran-led private equity The Brydon Group (bought December 2024); no immediate price changes stated — [NonProfit PRO](https://www.nonprofitpro.com/article/better-impact-acquires-galaxy-digital-to-expand-its-volunteer-tech/), [Better Impact](https://www.betterimpact.com/better-together)
- Bloomerang Volunteer (formerly InitLive): Bloomerang acquired InitLive in 2023; from $119/month billed annually for up to 250 records, unlimited users, higher tiers unpublished; one third-party claims $3,000+/yr (looks unreliable) — [GetApp](https://www.getapp.com/customer-management-software/a/initlive/), [Software Advice](https://www.softwareadvice.com/event-management/initlive-profile/)
- Bloomerang Volunteer complaints: setup "a little difficult, with many steps," one org dropped it after two years because entering shift changes took too long; no email logs; volunteers must install the app; shifts built by location not role, can't duplicate program elements across days; price was the deciding factor against for one festival — [Capterra](https://www.capterra.com/p/144845/InitLive/reviews/), [Software Advice](https://www.softwareadvice.com/event-management/initlive-profile/reviews/) (search summary)
- VolunteerLocal (primary pricing page): ongoing programs Discover $600/yr, Grow $2,400/yr, Enterprise custom; single events Discover $200/event, Grow $800/event, Enterprise $3,000/event; extra admin seats and add-ons (branding $200; group registration, vetting, hours tracking $200/yr or $100/event) — [VolunteerLocal pricing](https://www.volunteerlocal.com/pricing)

### Inferences
- The floor for "real" volunteer management is roughly $1,700+/yr (VolunteerHub Plus) or $200 per event (VolunteerLocal); SignUpGenius/SignUp.com cover the sub-$250/yr gap.
- Consolidation is under way: Lumaverse (PE), Better Impact + Galaxy Digital (PE), Bloomerang + InitLive (platform). Price-hike risk for incumbents is plausible but I found no confirmed 2026 hike.

### Gaps
- G2 and Software Advice pages returned 403; no verbatim review text beyond search summaries. Neither VolunteerHub nor Better Impact official pricing pages loaded. VolunteerHub ownership and funding not researched. Reddit evidence absent.

## 7. Adjacent tools found: payments, dues and tickets (Cheddar Up, Zeffy, PlanHero, SignupKit and others)

### Takeaway
Dues and ticket collection for PTAs is served by Cheddar Up (fees passed to the payer) and Zeffy (free, funded by optional donor tips, nonprofits only). Neither is a full sign-up plus scheduling kit.

### Cited Findings
- Cheddar Up (US only): Free Forever $0 at 3.95% + $0.95 per card; Pro $15/month and Team $35/month annual at 3.59% + $0.59; fees pass to the payer by default; handles dues, spirit wear, field-trip fees, donations, tickets (ticketing reported on Team) — [Cheddar Up fees page (primary, via search)](https://www.cheddarup.com/blog/cheddar-up-fees/), [Zeffy comparison](https://www.zeffy.com/compare/zeffy-vs-cheddar-up) (vendor)
- Zeffy: no card fee, platform fee or subscription; donors may add optional contribution; donations, tickets, auctions, memberships, receipts, donor CRM; needs an EIN and bank account — [Zeffy comparison](https://www.zeffy.com/compare/zeffy-vs-cheddar-up), [Zeffy on Cheddar Up](https://www.zeffy.com/en-gb/blog/cheddar-up-reviews) (vendor, not verified against Zeffy's own pricing page)
- Smaller sign-up entrants: PlanHero (free 1 active event; $140/yr and $260/yr; Stripe on every plan), SignupKit (free 5 sheets, Pro $10/mo or $99/yr, no ticket fee, Stripe fees apply), SignUpReady (free 1 sheet, Plus $9/mo, 1.5% + $0.20 platform fee on free plan), Lome (from $10/mo, Venmo/Cash App/Zelle/PayPal), Track It Forward (free under 25 participants), Zelos (Pro $99/mo flat, participants need account) — [Zelos roundup](https://getzelos.com/apps-for-sign-up-sheets) (written by a competitor; unverified against each vendor's pricing page)
- PTA-oriented lists also name Konstella (parent engagement suite) — [WorldMetrics](https://worldmetrics.org/best/pta-software/) (low-quality list)

### Inferences
- Tiny entrants are already pushing "ad-free, no participant account, free tier" into the market; the gap is not the ad-free sheet, it is the combination.

### Gaps
- Not researched: Planning Center Services, Breeze, church tools, Eventbrite, TeamSnap, Givebutter, Konstella details, Membership Toolkit (Lumaverse). Church-specific complaint threads (r/churchtech) not retrieved.

## 8. Comparison table

### Takeaway
At-a-glance map; "Source" column points to the section where each figure is cited. All prices are US, 2026, with caveats from sections 1-7.

### Cited Findings

| Tool | Free tier and ads | Paid pricing | Payments | Participant account | Reminders, waitlist, swaps, check-in | Owner | Notes |
|---|---|---|---|---|---|---|---|
| SignUpGenius | Free, ads shown | $8.99-$59.99/mo annual-or-monthly (third-party; official page failed) | 5% + $0.50 via own Stripe (plan gating disputed) | No | Email on all; SMS and waitlist on paid (third-party) | Lumaverse, PE (PSG) | Ads on paid tiers beyond 1, 10 or unlimited sign-ups |
| SignUp.com | Free, ads | $99.99, $249.99, $499.99/yr | about 2.9% + $0.30 (third-party) | No | SMS, waitlist, check-in (Plus), swaps on paid (third-party) | Private, VC/angel | $1.99 app; Android app 2.4 stars |
| Doodle | Free, ads, 1 poll | Pro $11/seat/mo annual | Not offered | No | Reminders on Pro | TX Group | Free slots cut, paywall creep |
| When2meet | Free, little to no ads | None | None | No | None | Unknown | Dated UI |
| Rallly | Free, 3 open polls | Pro $6/seat/mo; self-host $49-$999 | None | No for voters | None | Open source AGPL | Early-adopter price |
| Framadate | Free, no ads | None | None | No | None | Framasoft nonprofit | Self-host; 180-day expiry |
| Meal Train | Free, ads (third-party) | Plus $10/page; Pro $15/mo | 5% + 2.9% + $0.30 on cash gifts | Not verified | Meal-specific | Meal Train LLC, independent | Gift card complaints |
| TakeThemAMeal | Unknown | Unknown | Sells meals | Unknown | Unknown | Private, small | |
| Lotsa Helping Hands | Free | None found | None | Not verified | Calendar | Unknown | Stagnant app |
| CaringBridge | Free, no ads, donation asks | None | Links to GoFundMe | Not verified | Requests only | 501(c)(3) | Planner retired 2023 |
| Perfect Potluck | Free, no ads | None | None | No | Email reminders | Unknown | Public pages, editable by others |
| VolunteerSignup.org | Free, no ads | None | None | No | Reminder emails | Volunteer-run | Non-commercial only |
| Google Forms/Sheets | Free, no ads | Workspace from $7/user | None | No | None, no slot caps | Google | |
| VolunteerHub | None | $143 and $288/mo annual | Not covered | Yes | Full | Not researched | Setup fee |
| Galaxy Digital | None | Quote | Not covered | Yes | Full | Better Impact (Brydon PE), 2026 | |
| Better Impact | None | Quote, about $315/mo for 1,000 | Not covered | Yes | Full | Brydon Group PE | |
| Bloomerang Volunteer | None | From $119/mo annual | Not covered | App required | Full | Bloomerang | Setup friction |
| VolunteerLocal | Trial | $200-$3,000 per event; $600-$2,400/yr | Not covered | Yes | Full | Not researched | Published pricing |
| Cheddar Up | Free | $15, $35/mo | 3.95% + $0.95 free; 3.59% + $0.59 paid | No | Forms | Not researched | Payer pays fee |
| Zeffy | Free | None | $0, optional donor tip | No | None | Not researched | Nonprofits only |

(Every cell is cited in sections 1-7.)

### Inferences
- Nobody combines sign-ups, event pages, tickets and dues in one ad-free kit paid into the group's own Stripe at cost.

### Gaps
- Table cells marked "Not verified" or "Not researched" were not found in this pass.

## 9. Gaps no current tool fills well

### Takeaway
The unfilled space is a single ad-free, low-fee kit for volunteer-run adult groups that unifies shifts, events, tickets and dues.

### Cited Findings
- Free tools lack payments: Perfect Potluck, VolunteerSignup.org, Google Forms, Framadate offer none — [Zelos](https://getzelos.com/apps-for-sign-up-sheets)
- Payment-capable tools tax the group: SignUpGenius 5% + $0.50, Meal Train 7.9% + $0.30, Cheddar Up 3.95% + $0.95 (free plan) — sections 1, 3, 7 above
- Ads persist even on paid tiers at both incumbents — [Trustpilot](https://www.trustpilot.com/review/signupgenius.com), [signup.com/pricing](https://signup.com/pricing)
- Admin sharing and rotating officers gated by tier on SignUp.com (one Capterra reviewer) — section 2
- Volunteer-management suites start near $119-$143/month and need setup — sections 6

### Inferences
- Payment cost without a platform fee: only Zeffy approaches this (and is nonprofit-only with donor tips), so a Stripe-direct kit for non-501(c)(3) groups (neighborhood groups, clubs, informal PTAs) is open ground.
- Privacy: public indexed sheets with names (Perfect Potluck, VolunteerSignup.org) leave room for private-by-default sheets.
- Rotating leadership: shared admin and handoff of a group's sheets and Stripe link year to year is not offered well anywhere I looked.
- Meal-train style recurring "one volunteer per day" plus multi-helper plus recurring series is split between Meal Train (paywalled) and general sheets.

### Gaps
- Demand-side validation (what organizers ask for most) requires Reddit and forum data I could not retrieve.

## 10. What an at-cost entrant must match on day one

### Takeaway
Day-one parity is: no ads, no participant account, email reminders, slot caps with waitlist, easy admin sharing, mobile-friendly creation, CSV export, and payments straight into the group's Stripe with only Stripe's own fee.

### Cited Findings
- The free floor already includes no ads, no participant account, email reminders (Perfect Potluck, SignupKit, VolunteerSignup.org) — [Zelos](https://getzelos.com/apps-for-sign-up-sheets)
- Paid incumbents gate SMS, waitlist, swaps, check-in (SignUp.com Starter/Plus), 5 assistants at $249.99/yr — [signup.com/pricing](https://signup.com/pricing)
- Users complain most about ads, price, slow site and mobile creation — [Trustpilot](https://www.trustpilot.com/review/signupgenius.com)
- Entrants already offer CSV/PDF export and QR codes — [Zelos](https://getzelos.com/apps-for-sign-up-sheets), [SignUpReady blog](https://www.signupready.com/blog/best-signup-sheet-tools-for-schools-2026)

### Inferences
These are my read, not sourced findings.
- **Must match (day one):** no ads anywhere including emails; guest sign-up with name and email only; slots, spot limits, waitlist; email reminders; multiple organizers on the free tier; recurring series and one-click duplicate (a recurring complaint across Perfect Potluck, Bloomerang, Trustpilot); CSV export; QR/link share; mobile-first organizer creation; Stripe Connect direct payments with fees disclosed up front (who pays, how much, what arrives).
- **Could defer:** SMS (cost-bearing and carrier fees, paid tier elsewhere), swaps, check-in, hours tracking, waivers.
- **Do not chase:** enterprise volunteer CRM (VolunteerHub-class), scheduling polls beyond a simple date vote (Rallly is a thin competitor).
- **Judgment forks for the owner (not decided):** (a) whether to take SMS at cost passthrough or defer; (b) whether payments need nonprofit verification (Zeffy requires an EIN, Cheddar Up does not); (c) whether to include a poll feature or link to Rallly/When2meet.
- Risks: incumbent installed base (Trustpilot shows 4,132 SignUpGenius reviews, many schools and churches already use it) means migration and import of existing sheets will matter more than features.

### Gaps
- Church-specific (Planning Center, r/churchtech) and PTA-specific (Konstella, Membership Toolkit) workflows not covered; ticketing for events (Eventbrite) not researched.

---

### Coverage notes (not a key question)
Left uncovered or weak: all Reddit sources; Meal Train, TakeThemAMeal, Lotsa app-store reviews; official pricing pages for SignUpGenius (failed twice), Doodle (404), VolunteerHub, Better Impact, Bloomerang; G2, Software Advice and Capterra review pages (403, used search summaries); VolunteerHub, VolunteerLocal, Perfect Potluck and When2meet ownership; Planning Center and church tools. Items from before 2025: SignUp.com funding (2015-2017), the 2017 SignUpGenius investment, older Trustpilot pages: possibly stale.
