---
id: free-services
status: reading
dated: 2026-11-15
---

# Idea — Free services: what a small team could build for US individuals

**Status: READING.** Dated 2026-11-15. A ranked research record, not a plan. Nothing here is built. Do not cite this file as behavior; see `VERIFYING.md`.

**The owner declined this direction on 2026-11-15 as "too intense"** and chose the lighter at-cost round instead (`IDEAS/at-cost-services.md`, then `IDEAS/group-kit.md`). The verdict below is the research's, not a plan.

**Verdict.** Build medical paperwork first: a hospital charity-care application with a 240-day deadline tracker, then insurance-denial appeals and record requests. The gap is large (29% of eligible patients get hospital aid; under 1% of denials are appealed) and the legal posture is the cleanest, because a user-signed letter drafted by software sits outside both unauthorized-practice-of-law (UPL) rules and HIPAA. Eviction and debt answers have the largest need (about 4% of tenants have a lawyer) behind the tightest legal gate, so they rank third and are feasible only as one court-partnered state build. Tax, benefits and student-loan help have real needs but run through channels software cannot enter: IRS e-file credentials, state portals with no submission API, federal loan portals. Services survive when someone other than the user pays running costs and the tool avoids holding sensitive data; the failures carried human-heavy unit costs (Benefits Data Trust) or one political patron (Direct File). The research that followed this one is `IDEAS/at-cost-services.md`, which led to `IDEAS/group-kit.md`.

## Evidence caveat

Most figures come from search-result or small-model summaries, not primary pages; only a dozen were read (LSC 2022, the *Upsolve v. James* docket, the IRS e-file page, three KFF pages, ProPublica, Technical.ly and a few others). "(secondary)" marks a vendor, blog or aggregator source; "(pre-2022)" marks older data. The "80% of medical bills contain errors" claim has no traceable study and is not used. The status of *Upsolve v. James* is unverified. The scores below are judgment from the notes, not measurements.

## Ranking

Need (1-5): people excluded, documented gap, cost today. Feasibility (1-5): UPL and licensing exposure, sensitive data held, a submission channel, upkeep, a proving precedent. Product is need times feasibility.

| Rank | Service | Need | Feas. | Product | Deciding factor |
|---|---|---|---|---|---|
| 1 | Hospital charity-care application and 240-day tracker | 4 | 4 | 16 | 29% uptake; published policies; user signs; Dollar For proves demand, not scale |
| 2 | Denial appeals (authorized-representative form), record and itemized-bill requests | 4 | 3 | 12 | Under 1% appealed; ERISA hook; state UPL limits unsourced |
| 3 | Eviction answer (one uniform-form state, court partner) | 5 | 2 | 10 | 4% represented; per-state procedure; JustFix block; court approval is the shield |
| 4 | Medicaid/SNAP work-reporting documentation | 4 | 2 | 8 | Jan 1, 2027 deadline; need inferred; no submission API |
| 5 | Record-clearing eligibility and petition | 4 | 2 | 8 | Rasa proves $250 at cost; hardest rules engine; automation erodes market |
| 6 | Medicare plan choice from a user's drug list | 4 | 2 | 8 | SHIP at $1 per beneficiary; CMS marketing and broker rules unresearched |
| 7 | Tax: EITC/CTC claim help via prepare-and-print or partner | 3 | 2 | 6 | Fixed EFIN and 7216 costs; Free File shows 3% take-up |
| 8 | Student-loan RAP/IDR/PSLF helper | 3 | 2 | 6 | Real surge; federal portals only; volatile rules |
| 9 | Good faith estimate checker and PPDR starter | 2 | 3 | 6 | No filing counts; best as a module of ranks 1-2 |
| 10 | Credit-dispute letters | 2 | 3 | 6 | Pure document generation; low need |
| 11 | Name change, wills, small estates | 2 | 3 | 6 | Court packets and cheap forms exist |
| 12 | Debt-collection answer | 5 | 1 | 5 | Largest need; where *Upsolve v. James* bites |

Eviction and debt fall from the legal note's first places because UPL and court e-filing bind, and the *Upsolve* uncertainty holds debt at feasibility 1 under either version. Tax falls because the fixed regulatory cost does not scale down. Ranks 1, 2 and 9 share infrastructure (representative-form generator, deadline tracker, letter builder), so the first build is one medical-paperwork app whose first module is charity care. Not ranked: immigration, protective orders, SSDI, vital records, prescription prices.

## Medical paperwork

**Charity care.** Dollar For says only 29% of eligible patients get hospital aid, relayed by a secondary roundup ([Houston Public Media](https://www.houstonpublicmedia.org/articles/news/health-science/healthcare/2026/10/28/565447/texas-nonprofit-hospitals-must-offer-charity-care-but-many-patients-never-realize-they-can-apply/)). In Oregon, where hospitals must screen, about 80% of those helped in 2025 never applied ([KFF Health News](https://kffhealthnews.org/health-care-costs/medical-debt-hospital-bills-presumptive-eligibility-explainer-charity-care/)). IRC 501(r) covers only nonprofit hospitals, requires only "reasonable efforts" to screen, and gives patients 240 days from the first post-discharge bill to apply (secondary); a complete application pauses collection. Six states (CA, DE, IL, MD, NC, OR) mandate presumptive eligibility.

Dollar For holds criteria for 2,000+ hospitals, maps a patient's answers onto each form and follows up. It helped erase over $55 million of bills in 2025 ([KFF Health News](https://kffhealthnews.org/news/podcast/an-arm-and-a-leg-podcast-charity-care-nonprofit-dollar-for-medical-bills/)). Its approval rates disagree (57% in 2024, 42% of fully tracked applications in June 2025; [NY Focus](https://nysfocus.com/2025/06/12/new-york-charity-care)). The opening is scale: policy lookup, an application pre-filled from the hospital's form, a deadline tracker. Upkeep of thousands of policies is the cost: partner with Dollar For or start in presumptive-eligibility states.

**Legal posture.** Policies are published and the user signs and submits. HIPAA does not reach an app that receives data at the patient's direction for no covered entity, but the FTC and state consumer-health privacy laws do ([HHS OCR](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/access-right-health-apps-apis/index.html)).

**Denial appeals.** ACA marketplace insurers denied 19% of in-network claims in 2024; under 1% of denials were appealed and 66% of appeals were upheld ([KFF](https://www.kff.org/patient-consumer-protections/claims-denials-and-appeals-in-aca-marketplace-plans-in-2024/)). Prior-authorization denials were overturned on appeal 43-67% of the time in 2025 ([Fierce Healthcare](https://www.fiercehealthcare.com/payers/insurers-denied-between-12-18-prior-auth-requests-2025-kff)). The price to beat is a paid advocate at 25-35% of savings (secondary).

The legal hook: an ERISA plan may not bar an authorized representative from pursuing a claim or appeal ([DOL Information Letter](https://www.dol.gov/agencies/ebsa/about-ebsa/our-activities/resource-center/information-letters/02-27-2019)), though the representative may lack standing to sue. Unsourced: employer-plan denial rates and state UPL limits on billing advocates.

**Record requests** (30-day HIPAA deadline, escalation to OCR) are cheap and low-liability, on thin evidence: a 2019 audit found 51% of 51 providers noncompliant ([Healthcare Dive](https://www.healthcaredive.com/news/most-providers-not-fully-compliant-with-hipaa-access-requirements-research/560954/)) (pre-2022).

**Medicare plan choice** stays on the list: SHIP served about 4.3 million people in 2022 on about $1 per beneficiary ([KFF](https://www.kff.org/medicare/the-role-of-ships-in-helping-people-with-medicare-navigate-their-coverage/)). CMS marketing and broker rules for an unpaid recommendation tool are unresearched and could be the barrier.

## Eviction and debt courts

LSC found 92% of substantial civil legal problems of low-income Americans got no or insufficient help ([LSC](https://www.lsc.gov/press-release/low-income-americans-face-immense-justice-gap-according-new-legal-services-corporation-report)). Tenants have a lawyer about 4% of the time, landlords 83-84% ([Pro Bono Institute](https://www.probonoinst.org/2025/07/21/sustaining-tenants-right-to-counsel/)); the Eviction Tracking System counted 1.23 million filings in 2025 in 38 city areas and 10 states ([Eviction Lab](https://evictionlab.org/ets-report-2025/)). Pew's 2020 report is cited for default judgments in over 70% of debt suits and about 90% of defendants unrepresented (pre-2022, secondary; [Pew](https://www.pew.org/-/media/assets/2020/06/debt-collectors-to-consumers.pdf)). No study measured an online eviction-answer tool's effect on defaults.

**Why this is a court-partnered build.** Suffolk's open-source Document Assembly Line powers Massachusetts Court Forms Online, where 300+ people completed an eviction-record sealing petition in the first week ([State Justice Institute](https://www.sji.gov/national-document-assembly-hosting-and-e-filing-initiative/)). A New York court blocked JustFix's e-filing tool in 2021 after about 3,000 tenants used it ([Georgetown Law Tech Review](https://georgetownlawtechreview.org/wp-content/uploads/2022/06/4.1-Clement_Housing_Formatted.pdf)). The safe lane is legal information plus form assembly on the court's own forms, ideally court-approved as in Massachusetts. The court is both UPL shield and payer. LSC Technology Initiative Grants have funded $92 million since 2000, but a grant takes 10-12 months to start ([LawNext](https://www.lawnext.com/2026/02/lsc-issues-blueprint-for-narrowing-the-justice-gap-through-technology-innovation-in-civil-legal-services.html)).

**Upsolve v. James is unverified.** Both notes agree the Second Circuit vacated (September 9, 2025, per a search summary) the injunction that would have let non-lawyer advocates advise New York debt defendants. They then differ: The legal note reports cert petition No. 25-948 filed February 6, 2026 and certiorari denied March 30, 2026, from the docket the researcher read ([docket](https://www.supremecourt.gov/search.aspx?filename=%2Fdocket%2Fdocketfiles%2Fhtml%2Fpublic%2F25-948.html)). The precedents note reports the district court (Judge Kaplan) ruled against Upsolve on remand in March 2026, cert "apparently pending" ([Volokh Conspiracy](https://reason.com/volokh/2026/03/08/court-upholds-new-yorks-limits-on-unauthorized-practice-of-law/)). Both imply one assumption: no near-term route for non-lawyer advice, so a debt product supplies information and court forms and routes advice to a lawyer or legal aid.

**Record clearing** is where at-cost is proven. Rasa Legal charges a flat $250 plus government fees for AI-drafted, lawyer-reviewed petitions against $1,500-$3,000 from a lawyer ([KSL](https://www.ksl.com/article/50955517/clearing-your-record-just-got-easier-expungement-costs-cut)). Eligibility changes with statute yearly; Clean Slate laws shrink the market. Code for America's Clear My Record, sold to prosecutors, cleared about 144,000 California marijuana convictions ([Code for America](https://codeforamerica.org/news/record-clearance-at-scale-how-clear-my-record-helped-reduce-or-dismiss-144-000-convictions-in-california/)).

## Tax, benefits and loans

**Tax.** The IRS told states on November 3, 2025 that Direct File would not return in 2026 ([NATP](https://www.natptax.com/news-insights/blog/direct-file-is-gone-what-s-next-for-free-filing-and-tax-pros/)). It had 140,803 accepted returns in the 2024 pilot, at Treasury's later figure of at least $138 per return against projections of $9-$16 ([Accounting Today](https://www.accountingtoday.com/news/irs-ends-direct-file-program)). Free File reaches 3% of eligible taxpayers ([CRS](https://www.congress.gov/crs-product/IF11808)). An e-file provider needs an EFIN, fingerprinting, a suitability check of up to 45 days and MeF testing ([IRS](https://www.irs.gov/e-file-providers/become-an-authorized-e-file-provider)); unconsented disclosure of return data is a misdemeanor under IRC 7216 (secondary). The public-domain [Direct File code](https://github.com/IRS-Public/direct-file) cuts tax-logic cost. A team needs prepare-and-print or a partner channel, not a new transmitter.

**Benefits.** Medicaid work reporting starts January 1, 2027 in 44 states ([Morgan Lewis](https://www.morganlewis.com/pubs/2026/11/medicaid-work-requirements-remain-on-track-despite-partial-vacatur)). Most adult enrollees already work or are exempt (CBO, 2023), so losses will be verification failures; a "document my hours" tool is an inferred gap, not a documented one. There is no submission channel: the Patient Access API retrieves data and does not submit applications ([Federal Register](https://www.federalregister.gov/documents/2019/03/04/2019-02200/medicare-and-medicaid-programs-patient-protection-and-affordable-care-act-interoperability-and)). The tractable design is screening, document packaging and renewal reminders; the MyFriendBen screener exists ([Urban Institute](https://www.urban.org/research/publication/myfriendben-benefits-screener)).

**Loans and credit.** SAVE ended by court order on March 10, 2026 and the Repayment Assistance Plan launched July 1, 2026, with about 7.2 million borrowers displaced ([Forbes](https://www.forbes.com/sites/adamminsky/2026/03/16/ominous-student-loan-backlogs-persist-as-7-million-borrowers-are-soon-forced-to-change-plans/)). It is the most time-sensitive surge of late 2026, but only federal portals accept submissions. Credit-dispute letters are a module, not a mission: credit-repair firms drive much of the CFPB's 5.8 million complaints ([CFPB](https://files.consumerfinance.gov/f/documents/cfpb_2025-cr-annual-report_2026-03.pdf)).

## Funding and operating models

Cost per person is an artifact of what is counted: a small team's fixed costs divided by few users dominate.

**Failed.**
- **Benefits Data Trust** closed in August 2024 with 273 layoffs on a budget over $30 million, two-thirds philanthropy. A $20 million gift did not close the gap: states paid for one or two benefits while it staffed for 10 to 15, at "a few hundred dollars" per application against about $2 for lean tools ([Technical.ly](https://technical.ly/civic-news/benefits-data-trust-shutdown-trooper-sanders/)).
- **Direct File** had 90% positive ratings among 11,000 surveyed users and was closed for political reasons; the code lasted.
- **Dollar For** lost two donors in early 2025, about $500,000 and almost a third of its budget ([KFF Health News](https://kffhealthnews.org/news/podcast/an-arm-and-a-leg-podcast-charity-care-nonprofit-dollar-for-medical-bills/)).

**Survived.**
- **GetCalFresh** (Code for America) helped 6.2 million people claim $12.8 billion in SNAP and was sunset into the state's BenefitsCal, a planned handoff ([CDSS](https://cdss.ca.gov/inforesources/cdss-programs/calfresh-outreach/getcalfresh-transition)).
- **Clear My Record** sells to prosecutors, who hold the records.
- **Suffolk LIT Lab** blends a State Justice Institute grant, court and legal-aid contracts and a Hewlett grant, aiming for court funding ([Suffolk LIT Lab](https://suffolklitlab.org/reintroducing-the-document-assembly-line/)).
- **Upsolve** runs at $1.8-$2.1 million of expenses a year, about 70% grants and 30% program revenue including partner referral fees, plus a $4.25 million Gates grant in 2024 ([ProPublica](https://projects.propublica.org/nonprofits/organizations/821736267)).

**The shape that follows.** Build and iteration is grant-funded, but grants of this size (Technology Initiative Grants average about $130,000 by the report's arithmetic) fund a prototype, not a run. The run layer (hosting, upkeep, support, yearly re-audit of forms) needs a payer: a court, a state agency, legal aid or a foundation line item. The hidden layer is liability and cyber insurance (about $4,000-$10,000 a year per insurer blogs) and security and accessibility reviews.

**Design choices that cut cost.** Do not hold sensitive data: Clear My Record runs on bulk records the prosecutor holds, and Dollar For maps answers onto the hospital's form. Substantiate claims: the FTC's DoNotPay order bars untested "AI lawyer" claims ([FTC](https://www.ftc.gov/news-events/news/press-releases/2025/02/ftc-finalizes-order-donotpay-prohibits-deceptive-ai-lawyer-claims-imposes-monetary-relief-requires)). Use AI only as retrieval over curated sources with human review: legal research tools erred 17-33% of the time ([Stanford](https://dho.stanford.edu/wp-content/uploads/Legal_RAG_Hallucinations.pdf), 2024).

## If the direction is reopened

The research points to three things to do before any build:
- Approach Dollar For about its hospital-policy database before building charity care alone. Keeping those policies current is the real running cost.
- Find a payer for running costs other than the user, such as a court, a state or a hospital. Every surviving precedent above has one.
- Verify *Upsolve v. James*, billing-advocate UPL limits and CMS marketing rules. They could move ranks 12, 2 and 6.
