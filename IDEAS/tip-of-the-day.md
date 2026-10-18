---
id: tip-of-the-day
status: proposed
dated: 2026-10-17
---

# Idea — Frontier Tip of the Day: `fli tip`

**Status: PROPOSED. Nothing built.** Dated 2026-10-17. What § *What the tree
already has* says was read off the tree that day, with the reader named. Do not
cite this file as describing behavior; see `VERIFYING.md`.

## The question

`fli tutor` is the long way in: thirteen lessons, each one building an app and
asking the world whether it worked. Nothing covers the short way, which is
**one true sentence about FrontierJS, with its reason, in the time it takes a
dev server to start.** `fli tip` prints one sentence and its citation.

**A tip is a rule the tree has already stated, and nothing else.** Writing
a separate tips corpus would state every rule a second time, and that copy
would go stale with nothing failing. So `fli tip` READS the rules the tree
already holds, and a tip with no authority behind it does not exist. That is
the same rule `fli check` grades by (`FJS-D133`).

```
$ fli tip
  Tip of the Day · Invariant 9

  Patch semantics: an explicit null clears. Test key presence
  (key in updates), not ??.

  why   fli tip --why     (what fails when it stops being true)
  next  fli tip           · fli tip null
```

## What the tree already has

Each source below already has a reader in `packages/cli/core/`, so `fli tip`
adds a picker and not a parser.

| Source | Reader | Count (2026-10-17) | Voice |
| --- | --- | --- | --- |
| Hazard bullets, three realm skills | `readHazards(root)` — `core/hazards.js` | 181: data 62 · api 67 · ui 52 | contributor |
| Invariants, root `CLAUDE.md` | `readInvariants(root)` — `core/invariants.js` | 19 | both |
| `VOCABULARY.md`, the `blessed` rows | `authoredVocabulary(root)` — `core/terms.js` | about 190 rows | both |
| Rulings, `DECISIONS.md` | `ws:ask`'s ruling intent | 1066 | contributor, mostly |
| The bold sentences in the Packages table | `repo-map.js` | 26 rows, not every one bold | newcomer |

**There's a gap in who these are for.** Most hazard bullets are written for
someone changing the framework, for example "a cache keyed on the ctx OBJECT is
shared across principals". Someone building an app needs rules like "a gate
refuses and an allow filters", "an explicit `null` clears", and "a resource
file is named for its noun". The sources hold both kinds without labeling
which is which.

**Ruled: anything can be a tip (`FJS-D1220`)**, which supersedes the audience
filter (`FJS-D1215`) and the default-by-source marker (`FJS-D1217`). Every
source in the table above except the rulings goes into the corpus, with no tag.
A ruling's title is not written as a rule a reader can act on, so the rulings
wait until one is shown to read as a tip.

**The skills don't ship.** `.claude/skills/` is not in `@frontierjs/cli`'s
`files`, and an app installs the cli from npm. Inside this workspace, `fli tip`
can read the tree directly. An app needs a copy of the corpus that ships with
the cli, and that is Q2.

## Shape

- **`fli tip`** — one tip the reader has not seen yet, chosen at random.
- **`fli tip <word>`** — the best match for a word, such as `fli tip null`, `fli tip gate` or `fli tip 9`.
- **`fli tip --realm data|api|ui`** — limit tips to one realm; only the hazards carry one.
- **`fli tip --today`** — chosen from the date, so everyone on a team sees the same tip that day. This is the literal *Tip of the Day*.
- **`fli tip --why`** — print what stands behind the last tip shown: a hazard's reference paragraph, an invariant's enforcer row, or a package's `CLAUDE.md`. That is the second rung of the ladder (doc-hygiene), reached when someone asks for it.
- **`fli tip --quiz`** — turn the rule into a question: "In a patch, what does an explicit `null` do?" The answer is the rule itself.

**Context picks the tip when there is context.** Inside an app, `db/schema.lite`
is parsed (litestone's parser) and the choice leans toward rules the app can
actually hit:
- No model declares `@@gate`: show the gate-versus-allow hazard.
- A model declares `@encrypted` or `@guarded`: show Invariant 7.
- A model declares `@@softDelete` and a `@unique`: show the soft-delete hazard.

Outside an app, the choice is plain random.

**Seen state** lives at `$XDG_CONFIG_HOME/fli/tips.json`, using the base
`core/registry.js` already resolves. It records which tips have been seen and
when, and `fli tip` shows unseen tips first. Losing the file only means tips
repeat.

## Precedent

**Not yet researched. These are recalled, not read, and each one needs a source
before any Q below is ruled** (owner preference, 2026-10-16: precedent with
sources comes before a recommendation).

- **JetBrains *Tip of the Day*.** A dialog at startup, with tips curated per product and per feature used. *Inferred:* most people switch it off, which argues for a passive line rather than a dialog.
- **Homebrew hints.** One line after a command, switched off with `HOMEBREW_NO_ENV_HINTS`. This is the shape for Q4.
- **`fortune`, Laravel's `artisan inspire`, Python's `import this`, Go Proverbs.** One sentence, no state, and a little ceremony around it.
- **tldr pages.** A community corpus searched by word. This is the shape for `fli tip <word>`.
- **Rustlings and Elm's compiler messages.** Teaching where the mistake happens. This is the shape for Phase 3's tips chosen from `fli check` findings.

## Open questions

- ~~**Q1 — Who is it for?**~~ **Answered 2026-10-18 (`FJS-D1215`): A — app developers only; the corpus is a curated subset.** Superseded by `FJS-D1220`: anything can be a tip.
  - **A** — app developers only; the corpus is a curated subset.
  - **B** — both audiences, each tip tagged `app` or `framework`, with the tag chosen by where `fli tip` runs (this workspace or an app).
  - **Recommend B** — The sources already mix both audiences, and inside this workspace the contributor tips are the ones worth having.
- ~~**Q2 — How does the corpus reach an installed cli?**~~ **Answered 2026-10-18 (`FJS-D1216`): A — a generated `packages/cli/tips.snapshot.json`, written by `fli ws:tips` and failed when stale by CI's `snapshots` phase.**
  - **A** — a generated `packages/cli/tips.snapshot.json`, written by `fli ws:tips` and failed when stale by CI's `snapshots` phase.
  - **B** — tips written by hand into `packages/cli/tips/`.
  - **Recommend A** — A generated copy is the pattern `exports.snapshot.md` and `hazards.snapshot.md` already follow, and B is the second corpus that § *The question* rules out.
- ~~**Q3 — How is a tip marked fit for an app developer?**~~ **Answered 2026-10-18 (`FJS-D1217`): C — no marker: invariants and the Packages table count as `app` by default, everything else as `framework`.** Superseded by `FJS-D1220`: anything can be a tip.
  - **A** — a marker on the source line, such as `<!-- tip:app -->` after the bullet; a block-level HTML comment is stripped before an agent reads it.
  - **B** — an allowlist of keys inside `ws:tips`.
  - **C** — no marker: invariants and the Packages table count as `app` by default, everything else as `framework`.
  - **Recommend C** — for Phase 0, then A if C proves too coarse.
- ~~**Q4 — Does `fli dev` print a tip when it starts?**~~ **Answered 2026-10-18 (`FJS-D1218`): B — no; tips only on request.**
  - **A** — yes, one line every start, switched off with `FLI_NO_TIPS=1` (Homebrew's shape).
  - **B** — no; tips only on request.
  - **C** — yes, on the first `fli dev` of the day only, with no flag: the seen state already knows the date.
  - **Recommend C** — A switch-off flag widens the shoulder rather than fixing the road (§ IV *paved road vs. the workaround*); once a day is quiet enough that nobody needs one. It needs Phase 2's state.
- ~~**Q6 — Do hazard bullets get into the corpus?**~~ **Answered 2026-10-18 (`FJS-D1220`): neither option — Q1 and Q3 were reversed instead, so anything can be a tip.**
  - **A** — a `<!-- tip:app -->` marker after a hazard bullet lets it in; a block-level HTML comment is stripped before an agent reads the skill, so it costs no context.
  - **B** — no; the corpus stays the Invariants and the Packages table.
  - **Recommend A** — this is Q3's A, which its recommendation already named as the next step if C proved coarse, and the gate tip is the one an app developer hits first.
- **Q5 — Does a tip with a code example run in CI?** Invariant 16 says a runnable example is verified, not a sketch. The literate runner (`commands/literate/`) and litestone's fence runner (`FJS-D860`) already exist. Phase 0 tips are plain sentences, so this becomes a question only when `--try` arrives (4.2).

## The nine

Answered after the first draft was written, not before, and so recorded as late.
Tier: **Assessment** (§ VII). Nothing here is a ruling.

1. **Origin** — no new one; every tip is read from a source that already exists. Q2-B would add one, which is why it is not the recommendation.
2. **Concept** — one command verb, and no framework concept. `tip` collides with nothing in `VOCABULARY.md` or `ARCHITECT.md`.
3. **Complexity** — Phase 0 is the problem's own size. Phase 3's matching against the schema is complexity this design adds, and it has to justify itself against Phase 0 on a real app.
4. **Predictability** — `--today` is deterministic. Plain `fli tip` is random by design, and `<word>` is deterministic.
5. **Derived** — yes: the snapshot is generated, and 3.1's schema-feature tags are read from the attributes the lead cites rather than written by hand.
6. **Owner** — the parsers already exist (`core/hazards.js`, `core/invariants.js`, `core/terms.js`). `fli tip` owns only the choosing and the seen state.
7. **Boundary** — the snapshot's row shape (1.1) is the seam between `ws:tips` and `fli tip`, and the `snapshots` phase tests it.
8. **Failure** — a wrong or irrelevant tip costs a reader ten seconds, so nothing about choosing a tip refuses. A tip whose `why` path does not resolve is a broken citation, so `ws:tips` refuses to write it.
9. **Silence** — *must stay true:* each shipped tip matches its source line and its `why` resolves. *What fails:* the `snapshots` phase, plus `ws:tips` refusing an unresolved path. *Relevance (Phase 3):* `none` — a tip chosen for the wrong app is reported by nothing.

Adjudications: *batteries vs. smallness* — `fli tip` is one command file and one snapshot, and removing it touches nothing else. Q4 was ruled B (`FJS-D1218`): a tip appears only when someone asks, so no flag is needed.

## Plan

### Phase 0 — One tip, no state

Goal: `fli tip` prints one hazard bullet or invariant with its citation, from
inside this workspace.
Done when: `fli tip` run ten times prints ten rules, and `--why` prints the
reference behind each one.

- [ ] 0.1 `commands/tip.md`: pick at random from `readHazards` + `readInvariants`, and print the rule with its realm/section or invariant number
- [ ] 0.2 `fli tip <word>`: plain substring match over the rule; print the best match, or the three nearest with the count when nothing matches exactly
- [ ] 0.3 `--why`: a hazard's reference-file paragraph (the `referenceLines` map in `core/hazards.js` already joins them), or what fails when an invariant stops being true (`invariantCoverage()` in `core/invariants.js`)

### Phase 1 — A corpus that ships

Goal: `fli tip` works in an app installed from npm.
Done when: `fli tip` in a scratch app whose cli is a packed tarball (no
workspace above it) prints a tip, and a hazard edited without `fli ws:tips`
fails the `snapshots` phase.

- [ ] 1.1 `fli ws:tips` writes `packages/cli/tips.snapshot.json`: `{ id, audience, realm, section, lead, why, cite }`; `id` is a hash of the lead, so a moved bullet keeps its id
- [ ] 1.2 Add the vocabulary `blessed` rows and the Packages-table bold sentences as sources (`FJS-D1220`)
- [ ] 1.3 Add `tips.snapshot.json` to the `snapshots` CI phase and to the cli's `files`
- [~] 1.4 Audience tags — dropped: anything can be a tip (`FJS-D1220`)

### Phase 2 — Seen and today

Goal: tips stop repeating and a team can share one.
Done when: twenty runs with no `tips.json` show twenty distinct tips, and
`--today` prints the same tip on two machines on the same date.

- [ ] 2.1 `$XDG_CONFIG_HOME/fli/tips.json`; unseen tips first, then the oldest seen
- [ ] 2.2 `--today`: the date hashed to an index over the snapshot's ordered ids
- [ ] 2.3 `--realm`

### Phase 3 — The tip the app needs

Goal: inside an app, the tip is about something the app does.
Done when: an app with no `@@gate` gets the gate tip first; an app with an
`@encrypted` field gets Invariant 7 within its first three runs.

- [ ] 3.1 Each tip names the schema features that make it relevant (`@@gate`, `@encrypted`, `@@softDelete`, `@@transitions`, …), written by `ws:tips` from the attributes cited in its lead
- [ ] 3.2 `fli tip` parses `db/schema.lite` and prefers tips that match the app's schema features
- [ ] 3.3 A `fli check` finding names the tip that explains it: `fli check` ends with `fli tip <id>` under a red rule that has one

### Phase 4 — Ways in

Goal: tips reach people who did not type `fli tip`.

- [~] 4.1 `fli dev` prints one tip on start — dropped: tips only on request (`FJS-D1218`)
- [ ] 4.2 `--try`: a tip that cites a tutor lesson step runs that one step in a throwaway workspace (`core/tutor.js`)
- [ ] 4.3 `--quiz`
- [ ] 4.4 A tip card in `fli gui`
- [ ] 4.5 An MCP tool, `tip`, for the agent surface (`IDEAS/agent-surface.md`)
