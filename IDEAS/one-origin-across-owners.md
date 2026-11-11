---
id: one-origin-across-owners
status: proposed
dated: 2026-11-10
---

# Idea — one origin across owners: institutions that stop copying each other's records

**Status: PROPOSED.** Dated 2026-11-10. Do not cite this file as behavior — see
`VERIFYING.md`. Outside claims carry their source, and § Prior art marks the weak
ones.

**This file is the argument; the build is `app-peering.md` Phases 4–10**
(`FJS-D2066`), along with what crosses, the nine and the open questions.

This file coins no noun. **Peer** is `FJS-D1188`, the **Frontier network** is
`frontier-network.md`, and *institution* is an ordinary word for an owner of
records.

---

## The claim

`PHILOSOPHY.md` opens on one fact written five times in five dialects, inside one
app. The same failure is more expensive between organizations. A contractor's
license lives at the licensing board, and a PDF of it lives at every county office
that ever issued that contractor a permit. The board suspends the license and
every PDF goes on saying otherwise.

**Axiom 1 applied across an ownership boundary:** each institution runs its own
app on its own box and holds the only authoritative copy of the facts it owns.
Another institution that needs one asks, through a signed Peer call graded by the
owner's gate. The board's suspension is then true everywhere at the moment it is
written, because there is nowhere else for it to be false.

**Why FJS, when exchange layers already exist.** X-Road and its descendants
standardize the exchange and leave each member to build what sits behind it. Here
the gate a Peer is graded by, the audit of who read what, and the description of
what can be asked are all projections of the schema the institution already has.
Joining would cost a declaration rather than an integration project. That is the
part to test, because nothing yet shows it.

**The economics are the other half.** Most institutions that would benefit cannot
afford custom software. Discovery and `packages/oracle` turn a conversation into a
`.lite` schema, so an agent can draft a small office's app and a person reviews
the schema, which is short enough to read. Enforcement sits at the Data boundary
whatever the rest of the generated code does (Invariant 6).

---

## Prior art, and what it charges

| System | What it did | What it teaches |
| --- | --- | --- |
| **X-Road** | Each member runs a Security Server that signs, time-stamps and logs every message. The center holds the member registry and trust policy and no data ([architecture](https://x-road.global/architecture)). | The shape works at national scale. Services are described in OpenAPI or WSDL and built by each member, which is the cost derivation would remove. |
| **Estonia's once-only rule** | In the Databases Act from 1997 and the Public Information Act since 2008, per a secondary source ([ORF](https://www.orfonline.org/expert-speak/development-and-promotion-of-digital-public-infrastructures)). An RIA architect says replacing all duplication quickly "doesn't add up" ([Digiriik](https://medium.com/digiriik/b%C3%BCrokratt-network-to-apply-once-only-principle-on-gov-e-services-29eed18d5b61)). | The rule was law first and technology second. Even there, copies persist. |
| **Data Tracker** | A citizen sees who read their data, when and why. Each database must implement the protocol itself, and it is pull-only ([RIA](https://ria.ee/en/state-information-system/people-centred-data-exchange/data-tracker), [thesis](https://dspace.ut.ee/items/c1cdbf82-65ab-46b7-a790-a25cf8b4bfc6)). | The strongest thing to copy, and a place derivation wins outright, since `@@trail` could supply it. |
| **EU Once-Only Technical System** | A legal deadline of 12 December 2023 and a core launch that day; design documents were still at v2.0 in February 2026 ([Commission](https://ec.europa.eu/digital-building-blocks/sites/x/zAADKg)). I found no country-by-country completeness figures. | A launch date measures infrastructure and says little about use. |
| **India's Account Aggregator** | Licensed consent managers move financial data on explicit consent, past 100 million consents by August 2024 ([Sahamati](https://www.sahamati.org.in/media-article/indias-account-aggregator-framework-crosses-100-million-consents-in-three-years/), [Ministry](https://financialservices.gov.in/account-aggregator-framework)). That the aggregator cannot read the data rests on a secondary source. | Consent as its own signed object, and a regulator forcing the banks to answer. |
| **GOV.UK Registers** | Canonical lists, each with one named custodian, launched in 2016 and retired 15 March 2021, still described as alpha; data moved to the departments ([data.gov.uk](https://data.gov.uk/dataset/a8f488fd-eaea-4176-92b0-6d0437b4d121/historical-gov-uk-registers), [UKAuthority](https://ukauthority.com/articles/gds-terminates-two-data-services)). The stated reason is only "end of life". | A central service holding other people's truth ended with the truth going back to its owners. Inference, not a finding. |
| **Gaia-X** | Federated data spaces criticized for slow, committee-bound delivery; its own CEO concedes thin adoption, and Catena-X is the cited success ([Cloudflight](https://www.cloudflight.io/en/blog/why-gaia-x-hasnt-been-successful-yet/), [DCD](https://www.datacenterdynamics.com/en/news/eus-gaia-x-initiative-suffering-chaos-and-infighting-report)). Opinion sources. | Governance before a working exchange fails. A single sector with a real need did better. |
| **Solid** | Personal data pods. Criticism is anecdotal: unclear purpose, complex standards, no compelling use ([Dodds](https://blog.ldodds.com/2024/03/12/baffled-by-solid/)). | Institutions already hold records and already have to exchange them, which people with pods did not. |
| **Carequality / TEFCA** | A federated network with no national patient id, so matching is demographic and probabilistic ([QTF](https://rce.sequoiaproject.org/wp-content/uploads/2024/07/QTF-v2_508.pdf), [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC9662291)). | *Which person is this* is the hardest problem here and no part of FJS answers it. |
| **AT Protocol Lexicons** | After release: new fields optional, nothing removed, renamed or retyped, and a breaking change takes a new name ([spec](https://atproto.com/specs/lexicon)). | The cleanest stated rule for a schema other owners depend on. |
| **FHIR** | R5 broke compatibility and adoption stayed on R4, which US certification pins (vendor sources: [Health Samurai](https://www.health-samurai.io/blog/fhir-r4-vs-fhir-r5-choosing-the-right-version-for-your-implementation); [HL7 R4](https://www.hl7.org/fhir/R4/versions.html) for normative rules). | A published contract outlives its authors' wish to improve it. |
| **Estonia's ID cards, 2017** | A chip flaw put 750,000+ certificates at risk, and they were suspended and renewed nationally ([TalTech](https://ws.lib.ttu.ee/digibase/en/Publ/Item/b06f38e4-c8eb-49f0-bdfb-ed9c55ba1804/FullRecord), [SC](https://www.scworld.com/estonia-suspends-national-760000-id-cards-found-prone-to-encryption-vulnerability/article/706134/)). | Mass revocation of a shared trust root is a scenario to plan for. |

**The pattern across the table is that a legal or financial force made the
institutions answer.** Estonia had a statute, India a regulator, the EU a
regulation and US health care certification. Solid had none. That is inference
from a dozen cases, and it is the finding most likely to decide this idea, so
`app-peering.md` Q10 asks it directly.

---

## Open questions

- ~~**Q1 — Does this stand as its own plan?**~~ **Answered 2026-11-11 (`FJS-D2066`): A — this file keeps the argument, and § Phases moves into `app-peering.md` as steps after Phase 4. One owner for the build.**
  - **A** — this file keeps the argument, and § Phases moves into
    `app-peering.md` as steps after Phase 4. One owner for the build.
  - **B** — this file keeps its own plan and depends on `app-peering.md`. Two
    plans must then agree on who builds Phase 4.
  - **Recommend A** — peering already owns the mechanism, and a separate plan is
    a second owner for it. Low confidence, since Phases 2–5 are about records
    more than about calls.
