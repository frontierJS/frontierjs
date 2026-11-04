---
id: trademark
status: proposed
dated: 2026-11-03
---

# Trademark — register FRONTIERJS before anything is sold under it

**Status: PROPOSED.** Dated 2026-11-03. Nothing here is filed or renamed. It is
a desk search, not legal advice. Do not cite this file as describing behavior;
see `VERIFYING.md`.

The want: own the name the framework ships under before a paid product
(`IDEAS/frontier-cloud.md`) puts it in commerce, and ship no package under a
name somebody else owns in the same category.

---

## What exists

- **Namespaces, not marks.** The `frontierJS` GitHub org, the `@frontierjs` npm
  scope and `create-frontier` are held. A namespace gives no trademark right.
- **The name conflicts are already flagged.** `IDEAS/frontier-cloud.md` § Open
  before this could move says a paid product cannot ship as *Basecamp* (37signals)
  or *Oracle* (Oracle). Both are live packages: `packages/basecamp`,
  `@frontierjs/oracle`.
- **The framework is MIT.** A mark covers the name, not the code, so forks
  stay legal and only the name is protected.

## Findings — desk search, 2026-11-03

**"JS" carries no weight.** It describes the goods, so an examiner compares
FRONTIER with FRONTIER. The field in software is crowded:

| Mark | Holder | Goods | Status |
| ---- | ------ | ----- | ------ |
| FRONTIER (88134034) | not read | industrial process-control software; class 42 software services | registered |
| FRONTIER (98191739) | not read | class 42 software design and development, *excluding* payroll/HR software | filed 2023-09-21 |
| FRONTIER, FRONTIER FOUNDRY | Frontier Developments plc | game software, class 9 | registered (status per mark not read) |
| OpenAI Frontier | OpenAI | enterprise AI-agent platform, launched 2026-02-05 | no filing found |

- 98191739's carve-out suggests an existing payroll/HR FRONTIER software mark,
  probably Frontier Software. That record was not opened (Justia returned 403).
- **Unregistered use is in the same lane.** `@raystack/frontier` calls itself
  the "Frontier JS SDK" (auth), and `SierraSoftworks/frontier-js` (auth client) is
  about 12 years old. Neither has a registration that turned up, but prior use
  can still oppose a filing.
- **Crowded marks are narrow marks.** Each holder owns only its own goods, so
  FRONTIERJS for a downloadable web-application framework may register. Expect
  a likelihood-of-confusion office action (§ 2(d)) that has to be argued.
- **"Frontier" is descriptive in AI** ("frontier model"). That does not reach a
  web framework, but agent-related marketing copy should avoid leaning on it.

**Not checked:** Frontier Communications' marks; every other package name
(Phase 0.2).

Sources: [frontierJS/frontierjs](https://github.com/frontierJS/frontierjs) ·
[@raystack/frontier](https://www.npmjs.com/package/@raystack/frontier) ·
[SierraSoftworks/frontier-js](https://github.com/SierraSoftworks/frontier-js) ·
[Introducing OpenAI Frontier](https://openai.com/index/introducing-openai-frontier/) ·
[FRONTIER 98191739](https://trademarks.justia.com/981/91/frontier-98191739.html) ·
[FRONTIER 88134034](https://trademarks.justia.com/881/34/frontier-88134034.html) ·
[Frontier Developments marks](https://trademarks.justia.com/owners/frontier-developments-plc-3129253) ·
[USPTO refuses "GPT" as generic](https://www.theregister.com/software/2024/02/19/openai-tries-to-trademark-gpt-uspto-says-nope/1135726)

## Open questions

- **Q1 — What is filed: FRONTIERJS, or FRONTIER with a logo?** **Recommend
  FRONTIERJS as a word mark**: it is the name in every package and URL, and the
  compound is the only form with a chance against the table above. A logo mark
  can follow.
- **Q2 — Which classes?** **A** — class 9 only (downloadable framework).
  **B** — 9 and 42 (hosted platform). **Recommend A now.** Class 42 is where the
  registered FRONTIER marks sit, so it is the most conflicted class. An
  intent-to-use filing would be allowed, so delaying it is about fee and timing.
  The hosted product's own name (*Frontier Cloud*) is a separate mark that
  FRONTIERJS does not cover.
- **Q3 — When are Basecamp and Oracle renamed?** **A** — now, while nothing has
  shipped. **B** — before Frontier Cloud ships. **Recommend A, sequenced after
  0.2**, so each new name is coined and cleared once. The reason is the
  third-party mark: a paid product cannot ship as *Basecamp*. Nobody depends on
  either name, since both packages are `"private": true`. Oracle is not part of
  what Frontier Cloud sells, so it can trail Basecamp. Fall back to B if 0.2
  drags on.
- **Q4 — Who holds the mark?** The owner personally, or a company (Kobami, or a
  new entity). The holder has to be the one that controls the name's use.
- **Q5 — Are sub-brands registered?** **Recommend no.** Register the umbrella
  only, and keep Sierra, Junction, Litestone and the rest as package names under
  it, cleared but not filed. A sub-brand sold on its own gets its own filing,
  the way Vercel files Turborepo. If Basecamp's successor names the paid
  product, that name is one.

---

### Phase 0 — Clearance

Goal: know which names are safe before money or renames are spent.
Done when: a written clearance opinion on FRONTIERJS, and a cleared/conflicted
verdict per public-facing package name.

- [ ] 0.1 Search FRONTIER and FRONTIERJS in classes 9 and 42 at
  [tmsearch.uspto.gov](https://tmsearch.uspto.gov); open 98191739 and 88134034
  for holder and status; check Frontier Communications
- [ ] 0.2 Search each public package name in classes 9 and 42: Sierra (Bret
  Taylor's AI-agent company is a known one), Junction, Litestone, Mesa, Outpost,
  Caravan, Conduit, Jetty, Orion, Haven, Workbench
- [ ] 0.3 Attorney clearance search on FRONTIERJS (owner's spend)
- [ ] 0.4 Record a cleared/conflicted verdict per package name in this file, so
  a new package name with no verdict stands out

### Phase 1 — Rename the conflicts

Goal: no package ships under a mark another company holds in software.
Done when: `rg -i basecamp` and `rg -i oracle` hit only the 37signals connector,
references to the 37signals product, and DECISIONS.md history.

- [ ] 1.1 Coin replacement names through `decision-rules`, after 0.2, and
  clear each one before it is used
- [ ] 1.2 Rename Basecamp across packages, cli `basecamp:*`, docs and drives,
  keeping no alias
  - `conduit-37signals` and the Basecamp CLI skill keep the name: they mean
    37signals' product.
- [ ] 1.3 Rename Oracle the same way
- [ ] 1.4 Any Phase 0.2 conflict, the same way

### Phase 2 — File

Goal: an application on file for FRONTIERJS.
Done when: a USPTO serial number is recorded here.

- [ ] 2.1 File the word mark in the class Q2 picks; goods worded as narrowly as
  the use (open-source software framework for building web applications)
- [ ] 2.2 Answer the office action, if one comes

### Phase 3 — Trademark policy

Goal: forks, plugins and community packages know what they may call themselves.
Done when: a policy is linked from the root `README.md`.

- [ ] 3.1 Write the policy, modeled on the OpenJS Foundation's: who may use
  "FrontierJS", what a fork must rename, how `@frontierjs/*` and `frontier-*`
  third-party packages are named
