---
id: mechanic-generator
status: partial
dated: 2026-11-16
---

# Mechanic generator — prompts for inventing board games from a balanced draw of mechanics

**Status: PARTIAL.** Stressor #50, codename gameplay, in
`fjs-prototypes/gameplay/`. The v1 scope (Q6) is built: Phases 0–3 closed
2026-11-17, uncommitted. Not yet proven: a deck sheet through a real printer.
What waits: B′ (2.3) at ≥10 playtests across ≥3 prompts, and the items in
§ Later. It becomes `shipped` when the app is committed and a sheet has been
printed.

The research below comes from three web passes on 2026-11-16. The claims
everything else rests on were re-read directly: the paper behind AutoBG, BGG's
API terms, and Ludii's license. The other findings are the agents' reading of
search results, and each one is marked where the source could not be opened.

---

## The headline

**The owner's idea:** take BoardGameGeek's list of about 190 mechanics and use it
to understand mechanics better, and to generate prompts for inventing new games
from a *balanced* set of mechanics instead of a random handful.

**The research changes the idea in three places:**

1. **The generator half has precedent, and recently.** AutoBG
   ([arXiv 2606.01976](https://arxiv.org/abs/2606.01976), June 2026, renamed CoBG
   in v3) uses BGG's 192 mechanics. It builds new designs by *mechanic
   hybridization* (2 or 3 core mechanics) and *theme migration*, and tiers each
   draft's mechanics as **Core / Supporting / Structural**. Its evaluation is
   mostly a model judging the output. The tool that combines mechanics *by the
   role each plays* and *learns from real playtests* was not found. **That is the
   open space.**
2. **"Balanced" is advice, not a prediction.** No source maps a combination of
   mechanics to balance with any strength. Samarasinghe et al. (2021, about
   10,000 games) found no visible effect of mechanic type on rating, and the
   best model (CoG 2024, 23,113 games) explains about 32% of rating variance
   from mechanics. So the app's balance claims are labelled designer folklore
   with sources, and **the playtest log is what tests them**.
3. **BGG's data comes with terms.** Since July 2025 the XML API needs a
   registered application and a bearer token. The license is non-commercial and
   requires credit. Using BGG data to train an AI or LLM is "strictly
   prohibited" ([terms](https://boardgamegeek.com/wiki/page/XML_API_Terms_of_Use)).
   The design below ships its **own** tags and definitions, keyed by mechanic
   name, and keeps BGG game data out of the product (Q2).

---

## The bones

### The catalog — a mechanic is a row with roles and dials

Each mechanic carries tags the app owns, written by us, not copied:

- **Family:** the chapter of Engelstein & Shalev's *Building Blocks of Tabletop
  Game Design*. BGG adopted that book's taxonomy on 2019-09-18, which took it
  from 51 terms to 186, so the families line up with BGG's list. The chapters
  are Game Structure, Turn Order, Actions, Resolution, Game End & Victory,
  Uncertainty, Economics, Auctions, Worker Placement, Movement, Area Control,
  Set Collection and Card Mechanisms.
- **Roles** (one or more): turn structure, core decision, economy, interaction,
  uncertainty, space, ending and scoring. Families like Auctions or Worker
  Placement are kinds of *core decision*, not roles of their own, which is why
  family and role are separate tags.
- **Tier:** whether the mechanic can carry a game (core), only season one
  (supporting), or is plumbing (structural). These are AutoBG's three tiers.
- **Dials**, taken from Elias, Garfield & Gutschera's *Characteristics of Games*.
  **Luck and skill are two dials, not one**, because the book treats them as
  independent. The others are hidden information, interaction (none, indirect or
  direct), downtime, snowball versus catch-up, and length.
- **Feel:** the player experience it aims at, from the eight aesthetics of the
  MDA framework (Hunicke, LeBlanc & Zubek). It is the output side of the dials.

### The draw — a small core plus plumbing, not eight equal slots

The sources agree on the shape. Designers want a core of 2–3 mechanisms, and
"fewer mechanics, better game" says no two mechanics should play the same role.
Meeple Mountain's account of *Arcs* says trick-taking and wargaming each felt
watered down when combined. So a draw is:

- **1–2 core**, **0–2 supporting**, and **structural fills** for any role still
  empty: turn order, an ending and scoring.
- **A theme**, which must connect to at least one mechanic, not just skin it.
  Engelstein's *Thematic Integration* calls one connection point the minimum,
  and Euphoria's tunnels are the model.
- **A constraint** as a role of its own: 18 cards, a mint tin, solo only, one
  die. These come from the 9-card, 18-card (Button Shy) and 54-card contests.
  Designers report that constraints force a design to finish. This is the main
  defense against homogeneity: LLM-assisted ideation measurably narrows idea
  diversity ([ACM C&C 2024](https://dl.acm.org/doi/pdf/10.1145/3635636.3656204)).
- **Lock and reroll per slot, and both are cheap.** Ludi's lesson
  ([Browne & Maire](https://cambolbro.com/cv/publications/ciaig-browne-maire-19.pdf))
  is that only about 1% of its generated games were viable, and pruning broken
  rules only produced copies of the parents. Novelty came from keeping many bad
  combinations around. Expect most draws to be duds.
- **A tension table as data.** Pairs that clash, pairs that duplicate a role, and
  pairs that need a third mechanic (association rules from BGG data, e.g. Crayon
  Rail + Network Building → Pick-up and Deliver at 86%). This is Variations
  Forever's lesson: keep the space of allowed combinations as declared data,
  separate from whatever generates within it.

### The prompt — the model writes it, and must name what a playtest can check

The model turns a draw into a prompt. Every prompt it writes has to name:

1. **The core decision a player makes each turn.**
2. **How the game ends and who wins.**
3. **The theme–mechanic connection.**
4. **One degenerate strategy or failure risk** to look for in the first playtest.

Items 1, 2 and 4 come from the failures the LLM papers report: generic output, a
draft dropping its own constraints, and rules a table cannot run. Boardwalk
([arXiv 2508.16447](https://arxiv.org/html/2508.16447v1)) found the best model
produced error-free game code from natural-language rules only 55.6% of the time.

### Risk flags — folklore with sources

A rule table that flags risks from the draw, each rule citing where it comes
from and labelled as advice. Examples:

- Direct attack among three or more leads to kill-the-leader, and a player
  near the lead holds back so as not to become the target (Schreiber, *Game
  Balance Concepts*, Level 10). That page does not say it makes games longer.
- Player elimination in a long game leaves players with nothing to do.
- A last-place player who can still affect others creates a kingmaking risk.
- Many actions that touch other players create analysis-paralysis risk.

No source maps BGG mechanics to these risks, so the table is ours. **Every
flag is checkable against the playtest log**, and the app reports how often each
flag's prediction agreed with what the testers found.

### The playtest log — the part no prior tool closes the loop on

Each playtest row records:

- prompt or version, player count, blind or guided
- **seat order, score and winner per player**, and actual length against
  planned length (a 45-minute game that ran 90 is a pacing problem)
- each tester's experience level
- a **Goldilocks grid**, too little / right / too much, for rules, length,
  downtime, interaction, luck against skill, and choices (Board Game Design
  Lab's form)
- one "most frustrating moment" in free text, and whether they would play again
- Ludi's viability signals, scored by hand: did the game finish, was the length
  sane, was the outcome uncertain to the end, were there lead changes, was there
  a runaway leader

Ludi's human study is the reason for the last line. Viability signals alone
matched human rankings at 0.609, and rule-level features alone at 0.115.
Outcomes measured in play beat analysis of the rules.

From these rows the app can compute what BGG cannot: **first-seat win rate per
design** (no systematic BGG study exists), how far actual length strays from
planned, and **which mechanic pairs, not single mechanics, produced games people
wanted to replay**. That last figure feeds the tension table and the draw.

### Later, and maybe never

- **Pair statistics from real games.** Lift or PMI with a minimum support
  threshold, using a CC0 dataset taken after September 2019 (earlier snapshots
  use the old 51-term list), keeping only aggregates. Small samples mislead: one
  23-game rule showed 100% confidence. "Rare but promising" needs a rating
  filter on top of lift, and no prior work has published one.
- **Simulation.** Ludii-style measures (P1 advantage, balance, completion, draw
  or timeout rate, length, branching factor), computed with random and greedy
  bots over a tiny rules language. Jaffe et al.'s *restricted play* comes after
  that (win rate of an agent forbidden one action). Bot win rate is not human
  win rate: MCTS agents won 22% from the first seat in Catan, which says
  something about the agents. Ludii itself is CC BY-NC-ND 4.0 (read
  2026-11-16), so it is a research aid, not a dependency.

---

## What it stressed (checked 2026-11-17, after Phase 3)

- **A model answer by schema from `claude -p`.** `prompts.write` calls the
  model inside the service call (about 14 s), not in a job, and refuses an
  answer missing one of the four parts with a 422. Its `door.ts` is a trimmed
  copy of Chronicle's, which makes this the second app on **FJS-4171** (open).
- **A tethered list after a remove.** The total stayed one too high, so an
  empty state never showed. Filed and fixed as **FJS-4412**.
- **Per-seat rows as `Json @type(Seat[]) @minItems(1)`.** The auto factory
  ignored `@minItems`, so every Playtest rung of the gate ladder failed until
  the app added a factory override. Filed and fixed as **FJS-4413**, and the
  override is gone. Fixing it found **FJS-4430** (`@uniqueItems` refused every
  typed list of two or more members) and **FJS-4431** (no validation cases for a
  typed list's count rules), both fixed.
- **Statistics from the log are shown and never fed back into the draw** (2.3 =
  A), so the same seed gives the same draw. The guess that rates would tilt
  the draw did not survive decision-rules.
- **No framework gap in:** the reference catalog no tenant owns, the weighted
  many-to-many the draw reads, the Mesa draw screen, or the printable deck
  (CSS crop marks, `@page { margin: 0 }`, one grid for Letter and A4).

---

## Research (2026-11-16)

Three web passes on this date. Where a primary page returned 403 (most BGG
pages, ResearchGate, ACM), the claim comes from search summaries and says so.

### Taxonomies and data

- *Building Blocks of Tabletop Game Design*: 1st edition 2019, 2nd edition March
  2022, 13 chapters, entries coded by category (RES-01, ECO-01).
  [Routledge](https://www.routledge.com/Building-Blocks-of-Tabletop-Game-Design-An-Encyclopedia-of-Mechanisms/Engelstein-Shalev/p/book/9781032015811)
- BGG adopted the book's taxonomy on 2019-09-18, going from 51 to 186 terms.
  About 20 more were added after the 2nd edition. Legacy terms that don't map to
  the book stayed, e.g. Crayon Rail System. Oliver Kiley argues 186 is too many
  and the taxonomy is locked behind a paywalled book.
  [Kiley](https://boardgamegeek.com/blog/829/blogpost/94701/shakedown-tabletop-game-classification-and-the-bgg)
  (search summary only)
- BGG XML API: registration and a bearer token required since July 2025.
  Non-commercial license, credit required, the "Powered by BGG" logo required in
  public use, no modifying the data, no AI or LLM training. Rate limits are
  unpublished; about 5 s between requests is what developers report.
  [Using the XML API](https://boardgamegeek.com/using_the_xml_api) ·
  [Terms](https://boardgamegeek.com/wiki/page/XML_API_Terms_of_Use) ·
  [developer notes](https://github.com/gstephan30/reddit_kotw/issues/24)
- Datasets with per-game mechanics:
  - extralime 20k, CC0
    ([Kaggle](https://www.kaggle.com/datasets/extralime/20000-boardgames-dataset))
  - threnjen, CC BY-SA 3.0
    ([Kaggle](https://www.kaggle.com/datasets/threnjen/board-games-database-from-boardgamegeek))
  - mattadamhouser 2023 matrix, CC0
    ([Kaggle](https://www.kaggle.com/datasets/mattadamhouser/ranked-board-game-data-from-boardgamegeek))
  - TidyTuesday 2022-01-25
    ([readme](https://github.com/rfordatascience/tidytuesday/blob/main/data/2022/2022-01-25/readme.md))

  A dataset's own license does not override BGG's terms on where the data came
  from. Sizes and dates were not read from the Kaggle pages.
- Co-occurrence studies:
  - Samarasinghe et al., IEEE Access 2021: co-occurrence, mutual information
    and clustering; complexity and engagement are not a simple function of the
    mechanic set
    ([abstract](https://www.researchgate.net/publication/353787592_A_Data_Driven_Review_of_Board_Game_Design_and_Interactions_of_Their_Mechanics)).
  - Janis's association rules: Dice Rolling + Variable Player Powers is the top
    pair, at about 5.5% of games
    ([post](https://www.thewayir.com/blog/boardgames/)).
  - janbrrr's Gephi network
    ([repo](https://github.com/janbrrr/board-game-analysis)).
- Other taxonomies:
  - *Characteristics of Games* (MIT Press 2012): luck and skill independent;
    chapters on kingmaking, snowball and catch-up, downtime
    ([catalog](https://search.library.wisc.edu/catalog/9910204447202121)).
  - Björk & Holopainen, *Patterns in Game Design* (2004): about 200 patterns
    with relations between them, such as conflicts and modulates (relations from
    memory, not read).
  - MDA's eight aesthetics
    ([paper](https://users.cs.northwestern.edu/~hunicke/MDA.pdf)).
  - Ludii's game concepts, used as feature vectors
    ([arXiv 2107.01078](https://arxiv.org/abs/2107.01078)).
- Existing "fingerprint" tools:
  - randomgameidea.com: random mechanics, turn order and theme, no balance
    logic.
  - BoardGameFYI "Game DNA": method unknown.

  Neither tags mechanics by role.

### Generative design

- **Ludi** (Browne, 2008 thesis): 57 aesthetic criteria. Six mattered most to
  humans: uncertainty, lead change (negative), permanence, killer moves,
  completion and duration. Of 1,389 games, 19 were viable, and Yavalath was the
  first published game with computer-generated rules.
  [thesis](https://eprints.qut.edu.au/17025/) ·
  [Browne & Maire](https://cambolbro.com/cv/publications/ciaig-browne-maire-19.pdf)
- **Ludii**: a Java general game system with about 1,057 games, usable as a jar
  library, licensed CC BY-NC-ND 4.0.
  [overview](https://arxiv.org/pdf/1907.00240) ·
  [LICENSE](https://github.com/Ludeme/Ludii/blob/master/LICENSE)
- **Game-O-Matic** (Treanor et al. 2012): a concept map picks gameplay
  patterns, which are mashed up into games. It is the nearest analogue to
  "mechanic per role plus theme".
  [ACM](https://dlnext.acm.org/doi/pdf/10.1145/2538528.2538537)
- **Variations Forever** (Smith & Mateas 2010): the space of games is declared
  in answer-set programming, kept apart from the solver.
- **Sentient Sketchbook** (Liapis et al. 2013): suggestions pushed toward
  novelty act as prompts for lateral thinking.
  [paper](https://www.um.edu.mt/library/oar/bitstream/123456789/29459/1/Mixed-initiative_co-creativity.pdf)
- **ANGELINA and Mechanic Miner** (Cook): a mechanic is validated by what it
  makes reachable. [arXiv 1707.09661](https://arxiv.org/pdf/1707.09661)
- **LLM generation, 2024–2026:**
  - AutoBG/CoBG: above. 2,233 games, 207 held out. Evaluation is model-judged
    plus a 30-person study; users reported repetitive phrasing and generic
    feedback on unusual mechanics.
  - GameGrammar ([arXiv 2602.05636](https://arxiv.org/html/2602.05636v1)):
    mechanism names restricted to a fixed list, a five-agent pipeline, no
    playtests.
  - GAVEL ([NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/c7b04e4e13bb77996d3ae2ff667231ac-Paper-Conference.pdf)):
    an LLM mutating Ludii games under quality-diversity search; 130 of 185
    variants playable.
  - Mortar ([arXiv 2601.00105](https://arxiv.org/abs/2601.00105)): evolved
    mechanics, scored by whether stronger agents beat weaker ones.
  - Cardiverse ([arXiv 2502.07128](https://arxiv.org/abs/2502.07128)).
  - The common failure: unconstrained output is generic or derivative, and
    evaluation leans on model judges.
- **Human tools:**
  - Gamer Deck 1: Mechanics: draw 3–4 cards and sketch.
  - Card toolkits dominate ideation because cards are easy to shuffle
    ([toolkit survey](https://dl.acm.org/doi/10.1145/3337722.3341841),
    abstract only).
  - Constraint contests: 9-card, 18-card, 54-card.
- **Combining mechanics:**
  - Engelstein, *Thematic Integration*: at least one theme–mechanic connection
    point.
  - Stegmaier: "fun supersedes theme or mechanisms"
    ([League of Gamemakers](https://www.leagueofgamemakers.com/theme-is-more-important-than-mechanics/)).
  - [Meeple Mountain on mixing mechanics](https://www.meeplemountain.com/articles/the-good-the-bad-and-the-ugly-mixing-mechanics/).
  - [Fewer mechanics, better game](https://www.gamedeveloper.com/design/fewer-mechanics-better-game)
    (about video games).
  - No primary Wehrle or Ludology source was found.

### Balance and playtesting

- Jaffe et al. 2012, *restricted play*: the win rate of a restricted agent
  against an unrestricted one measures how much an action, search depth or
  starting choice matters. It covers two-player zero-sum games only.
  [PDF](https://homes.cs.washington.edu/~zoran/jaffe2012ecg.pdf) (text read)
- Ludii concept definitions: Advantage P1, Balance, Completion, Drawishness,
  Duration. Computed from 10,000 random playouts per game.
  [concepts](https://ludii.games/searchConcepts.php)
- AI playtesting:
  - de Mesentier Silva et al., FDG 2017: heuristic agents on Ticket to Ride
    found the dominant routes
    ([NYU](https://nyuscholars.nyu.edu/en/publications/ai-based-playtesting-of-contemporary-board-games)).
  - TAG "Seeding for Success": the Catan board shuffle matters more than the
    dice ([arXiv 2503.02686](https://arxiv.org/abs/2503.02686)).
- Machinations (Dormans): resource-flow diagrams with Monte Carlo runs. It
  models economies, not win rates, so it is a poor fit for small interactive
  rulesets.
- First-player data:
  - Gomoku: 67% to the first player at championships, about 52% with the Swap2
    opening ([Wikipedia](https://en.wikipedia.org/wiki/Gomoku)).
  - Terra Mystica faction statistics
    ([snellman](https://terra.snellman.net/ratings/)).
  - Catan sources conflict.
  - No Agricola or BGA data was found.
- Playtest forms:
  - Ask the same 3–5 questions every time, with nothing leading.
  - The Goldilocks grid
    ([BGDL form](https://boardgamedesignlab.com/wp-content/uploads/2020/11/Playtest-Feedback-Form.pdf)).
  - Blind playtests.
  - Logging tools: Boardssey (version, turn order, scores, changes made) and
    BoardForge (QR feedback per version).
- *Game Balance* (Schreiber & Romero): transitive versus intransitive balance,
  cost curves, and kill-the-leader as negative feedback with its side effects
  ([course](https://gamebalanceconcepts.wordpress.com/)).
- Weight and rating:
  - BGG weight is a community vote from 1 to 5 that the wiki admits is loosely
    defined.
  - Weight against rating: r = 0.48 (Samarasinghe), about 0.28 in blog
    analyses.
  - Mechanics explain up to 32% of rating variance. Variable player powers and
    solo play predict higher ratings, roll-and-move lower
    ([Perez et al. CoG 2024](http://diego-perez.net/papers/BGGMechanicsRatings-CoG24.pdf)).

---

## Open questions

- **Q1 — Name.** The codename is provisional.
  - **Ruled 2026-11-17 (owner): the codename is gameplay.** The app folder is
    `fjs-prototypes/gameplay/` and its package is `@frontierjs/gameplay`. This
    file keeps its name, as Group kit kept its file under the codename grouppi.
- **Q2 — BGG data.** **A**: our own tags and definitions only, keyed by
  mechanic name, with no BGG game data. **B**: A, plus pair statistics from a
  CC0 snapshot, shipping only the aggregates. **C**: register a BGG application
  and read the commercial terms. **Recommend A for v1; B only after C's legal
  read.** The draw needs no game data. A CC0 dataset license does not override
  BGG's terms on where the data came from, so B is not clean just because the
  snapshot is CC0. Under A a seed-shape test pins it: the shipped catalog holds
  no BGG id and no per-game column.
  - **Ruled 2026-11-16 (owner): A.** B and C wait for a reason to reopen.
- **Q3 — Balance claims.** **A**: present them as advice with sources and an
  agreement rate from the log. **B**: present scores as predictions. **Recommend
  A.** No source supports B.
  - **Ruled 2026-11-17 (owner): A.** And the model is shown a draw's flags as
    candidates for the prompt's fourth part.
- **Q4 — Seed games in the prompt.** AutoBG anchors drafts on real games per
  mechanic, which reduces generic output. Naming real games in a prompt is fine.
  Building a design *from* one edges toward a re-skin. Do we include them?
  - **Ruled 2026-11-16 (owner): as examples only.** A prompt may cite one or
    two well-known games per mechanic ("as in X"), never "build from X".
- **Q5 — Who uses it.** Only the owner as a designer's notebook, or a public
  tool with accounts and shared playtests? This decides whether the playtest
  statistics have enough rows to mean anything.
  - **Ruled 2026-11-16 (owner): the owner's notebook first.** Accounts and
    sharing come later, so the statistics grow slowly from the owner's own
    sessions.
- **Q6 — v1 scope.** Catalog + draw + prompt + playtest log, with pair
  statistics and simulation deferred. Confirm.
  - **Ruled 2026-11-16 (owner): that scope plus the printable deck** (Phase 3),
    so draws can happen at the table. Pair statistics and simulation stay
    deferred.

- **Q7 — What the deck holds.** **A**: the 191 mechanics only. **B**: four
  decks, namely mechanics, themes (60), constraints (24) and one rules card,
  as Design Space Cards splits mechanics from themes. **Recommend B.** A table
  draw fills the same five slots the app does, and A leaves the theme and the
  constraint to improvised words. decision-rules passed B.
  - **Ruled 2026-11-17 (owner): B.** Four decks.
- **Q8 — How a card shows its tier.** **A**: a colored band with the tier word
  on the front, and no backs. **B**: printed backs too, duplex or gutterfold.
  **Recommend A.** Duplex alignment changes from printer to printer, and a
  notebook deck sorts by band. Reopen B if the deck is ever sold.
  - **Ruled 2026-11-17 (owner): A.** Front band, no backs.
- **Q9 — How much of the draw the table follows.** **A**: loose. Flip one
  constraint, one theme, 1–2 core and 0–2 supporting, then structural cards
  until the four required roles show. **B**: A, plus the refusals printed on the
  card (its clash and needs names, and its job role), so a clash or a second
  card with the same job goes back and a needed card is fetched. **Recommend
  B.** Otherwise the same cards make a different game at the table than in the
  app. The refusals are names only, so a card stays one line of definition.
  - **Ruled 2026-11-17 (owner): B.** Refusals on the card.

---

## A sketch of the plan

### Phase 0 — The catalog by hand

Goal: every mechanic on BGG's list tagged with family, roles, tier and dials.
Done when: the catalog loads, and a draw of 1–2 core + structural fills every
role on 50 random draws.

The app is `fjs-prototypes/gameplay/` (renamed from mechanic-generator at
Q1), on ports 7520–7529. The proof is `bun run test`:
`api/test/catalog.test.ts` seeds a fresh database, reads the catalog back as a
signed-in user and runs 50 seeded draws. "Every role" means the four every game
needs (`REQUIRED_ROLES` in `shared/draw.js`): a core decision, turn structure,
an ending and scoring. Economy, interaction, uncertainty and space are optional.

- [x] 0.1 Write the tag scheme into the schema; settle Q2. `Mechanic`,
  `MechanicRole` (weight 1–3, where 3 is the mechanic's job) and `Tension` are
  in `db/schema.lite`, with gate `4.8.8.8`: anyone signed in reads, only the
  seed writes. A test pins Q2 = A by spelling out the allowed fixture keys and
  columns, and by checking that no fixture mentions BGG.
- [x] 0.2 Tag all mechanics, with our own one-line definition each. 191 rows
  are in `fixtures/mechanics.json`: 54 core, 92 supporting, 45 structural. The
  names were checked against a 2022 snapshot of BGG's list, from which only the
  names were taken and nothing was kept. All 182 are present, plus 9 added
  later from memory (Open/Closed Drafting, Auction Compensation, Bids As
  Wildcards, Multi-Use Cards, Neighbor Scope, Questions and Answers, Resource
  Queue, Spelling). **Owner to review:** family is our mapping onto the book's
  chapters, made without the book. These definitions were written from memory
  of the term and are the least certain: Bias, Bids As Wildcards, Targeted
  Clues, Kill Steal, Follow, Layering, Pieces as Map, Auction: Fixed Placement,
  Auction: Dutch Priority, Resource Queue, Relative Movement.
- [x] 0.3 Seed the tension table from the sources above. 23 rows are in
  `fixtures/tensions.json`. Two come from sources: the Crayon Rail invites row
  and the Arcs clash. The other 21 are our own reasoning and say so (solo
  against player interaction, cooperative against take-that, needs-a-market).
  A duplicate role is not stored as a row: the draw refuses two mechanics that
  carry the same role at weight 3.

**Found while proving it, settled in 1.1:** over 5,000 draws, 21 of the 45
structural mechanics were never drawn, because the structural tier only fills
turn order, ending and scoring. 1.1 closed it three ways (owner's go,
2026-11-16): the game frames are constraints, a mechanic played over a board
gets one, and a mechanic that needs another pulls it in. Five are still never
drawn, being plumbing that does none of the required jobs: Catch the Leader,
Income, Lose a Turn, Neighbor Scope and Variable Set-up.

### Phase 1 — Draw and prompt

- [x] 1.1 Slot draw with lock and reroll, dials as a target profile. Built
  2026-11-16, uncommitted. `draw(catalog, { keep, exclude, target })` in
  `shared/draw.js` is the one operation: draw again keeps the locked slots,
  and `reroll` keeps every slot but one, leaves that name out and puts the new
  one in its place. Two slots were added. A **theme** comes from 60 written
  for the app (`fixtures/themes.json`). A **constraint** comes from 24
  (`fixtures/constraints.json`), and the five frames among them (solo,
  cooperative, teams, traitor, semi-cooperative) name their mechanic, so the
  tension table judges them: solo only refuses negotiation. A `needs` row now
  pulls in the mechanic it names (a traitor brings the cooperative game), and
  a mechanic played over a board adds a structural one that carries space.
  An `invites` row is still only reported, because it is a tendency and not
  a dependency: the designer decides whether the third mechanic belongs.
  The **target** is any subset of the seven dials. It weighs each pick by
  1/(1+distance)², which tilts the draw without forbidding anything, and the
  draw reports its own profile beside the target. Proof: 9 new tests in
  `api/test/catalog.test.ts` (28 in all), each new behavior shown able to
  fail by breaking it. The screen is `web/src/routes/draw/index.mesa`, which
  reads the five read-only services through one resource each and runs the draw
  in the browser. It was driven 2026-11-16: locks survive draw again, 40 core
  rerolls kept the slot order and changed nothing before the rerolled slot,
  and the console was clean.
- [x] 1.2 Model prompt returning the four named parts, refused if one is missing.
  Built 2026-11-17, uncommitted. `prompts.write` (no `create` is offered)
  takes the draw as the browser holds it, checks every name against the
  catalog and takes a frame from the catalog rather than from the caller, then
  asks the model through `api/src/domain/door.ts`: `claude -p` with
  `--json-schema`, a trimmed copy of Chronicle's door (FJS-4171 now has two
  apps). The four parts are columns of a `Prompt` row, owner-only, never
  edited. `shared/prompt.js` names them (`PARTS`) for the service, the
  answer schema and the screen. An answer missing one is a 422 naming it and
  nothing is saved, and the columns' `@length(1, …)` refuses it below the
  service too, and a test holds the answer schema's lengths to the columns'.
  A door failure is a 502 with its reason. Proof: 9 tests in
  `api/test/prompts.test.ts` (38 in the app), each shown able to fail by
  breaking it. Driven twice live on /draw/ and /prompts/: answers in 13 and
  14 s, about $0.02–0.03 each as `claude -p` reports it, and the console was
  clean. The first answer read the target "luck 3" as a fact about a no-dice
  draw, so the prompt now calls the target a goal. `fli check` is clean.
  decision-rules passed the copied door and the synchronous call on two
  conditions: lift the door into conduit-anthropic at a third app or before
  either app deploys, and move the call to a queued job when a deployed door
  lands (behind a proxy timeout the child keeps running and spending).
- [x] 1.3 Risk flags from the rule table. Built 2026-11-17, uncommitted.
  `shared/risks.js` holds seven rules: kill the leader, runaway leader, idle
  after elimination, kingmaking, analysis paralysis, alpha player and
  downtime. Each one says "may", names something a playtest observer can see,
  and cites a page that was fetched and quoted (Schreiber Levels 7 and 10,
  League of Gamemakers, The Alexandrian, Board Game Design Course). The
  conditions are ours, and so is the half of analysis paralysis that counts
  moves aimed at other players. The rules read the draw's mechanics, dials and
  frame. Plumbing is left out of the dials, as in the draw's profile, so Player
  Elimination's wait counts toward its own rule and not toward downtime.
  `riskFlags` runs live on /draw/. On the server it runs over the checked
  draw, so a frame the caller made up raises nothing. The model is shown the
  flags as candidates for part 4 (Q3 ruling), and `Prompt.flags` keeps their
  ids: a rule changed later must not rewrite what was predicted, which 2.2's
  agreement rate needs. Over 5,000 draws, 39% raise no flag and under 3% raise
  more than three. Kill the leader and kingmaking share their condition apart
  from elimination and hidden scores (about 35% each), so only the log will
  tell them apart. Proof: 12 new tests, 50 in the app, and each of 11 breaks
  failed a test. `bun run check` is clean. Driven live: a flagged draw, a
  `claude -p` answer whose part 4 made kill-the-leader concrete for the draw,
  and the stored flags on /prompts/; the console was clean.

### Phase 2 — Playtest log

- [x] 2.1 Playtest rows with seats, scores, length and the Goldilocks grid.
  Built 2026-11-17, uncommitted. A `Playtest` row belongs to one of the
  owner's prompts (`promptId @immutable`, `onDelete: Restrict`, so a prompt
  with playtests cannot be deleted). It records version, blind or guided,
  planned and actual minutes, Ludi's signals as `isFinished`, `isUncertain` and
  `hasLeadChanged`, and notes. `seats` is `Json @type(Seat[])`, where the list
  order is the turn order, so the player count is the length of the list. Each
  seat holds score (null if the game keeps none), `isWinner`, experience,
  `isReplayWanted`, the six Goldilocks answers and the most frustrating moment.
  The observer answers **every** rule's `watch` question, not only the flagged
  ones, so 2.2 can count misses as well as hits. `watched` is `@system`: the
  service writes the table's ids at create, and a forged value is overwritten.
  `seen` may name only a watched rule, on create and on patch.
  decision-rules passed all four calls (seats as typed Json rather than a
  child model, every rule asked, no runaway-leader column because that rule's
  question asks it, the immutable prompt). Its conditions are built: a planned
  length column, the subset refusal, the prompt-owner policy, and yes-or-no
  wording for the two `watch` questions that asked "how long". A changed
  `watch` now retires an id, as a changed `when` does (`shared/risks.js`
  header). The screen is `/playtests/`, linked from each prompt card as "Log a
  playtest". Its form is the markup half of `Playtest.mesa`, written by hand
  because `<Form>` would draw `seats` as one JSON box. Rows can be corrected
  and deleted there. Proof: 8 tests in `api/test/playtests.test.ts` (58 in the
  app), and each of 9 breaks failed a test. `bun run check` is clean. Driven
  on the dev db: prompt card to form, with the prompt preselected and its two
  flags marked. Three seats, one added and removed, saved, then corrected, then
  deleted. The stored row matched the form and the console was clean. Found
  in the drive: the service needed `channel:` for the list to show a new row.
  Two framework rows were filed: FJS-4412 (a tether's `total` stays one too
  high after a remove) and FJS-4413 (the auto factory ignores `@minItems` on a
  typed list).
- [x] 2.2 Seat win rate, length drift, flag agreement rate. Built 2026-11-17,
  uncommitted. `web/src/lib/rates.js` is pure and runs in the browser over the
  two owner-scoped lists, which `/playtests/` now loads whole (`all: true`): a
  first page would be a partial log that reads as complete. Every figure is
  counts beside a share, because "1 of 1" is not a rate. **Seats:** a game
  counts only if it finished and some seats won but not all (a cooperative
  table that won or lost together says nothing about turn order); a shared win
  is split among the winners, the fair share is the sum of 1/n, and the left-out
  count is shown. **Length:** the median of actual over planned, with the
  shortest and longest, and no verdict on what is sane. **Agreement:** four
  counts per rule id (hit, false alarm, miss, quiet). A rule is graded only on a
  playtest whose prompt was checked against it, which needed a new column:
  `Prompt.checked` holds every rule id the draw was checked against, written by
  `prompts.write`, the twin of `Playtest.watched`. Without it a rule added later
  would count every earlier prompt as a miss it never predicted. Dev prompts 1
  and 2 predate the rule table and stay ungraded; prompt 3 was backfilled.
  decision-rules passed all five calls; its condition (load the lists whole and
  say "Over N playtests") is built. `rates.js` sits in `web/` because only the
  screen imports it (FJS-D1320); it moves to `shared/` when a second surface
  needs it. Proof: 16 new tests (74 in the app), each of 23 breaks failed one,
  and `bun run check` is clean. Driven on the dev db: four playtests logged
  through the form, every figure matched a hand count, the console was clean,
  and the playtests were deleted again.
- [x] 2.3 Pair outcomes fed back into the draw. Built 2026-11-17, uncommitted.
  Ruled 2026-11-17 (owner): A, show only. decision-rules failed tilting the
  draw (B/B′): same seed must give same draw, and a notebook's few seats over
  confounded pairs would bury a pair. Reopen B′ (Beta(1+yes,1+no) mean, opt-in
  per draw) when pairs have ≥10 playtests across ≥3 prompts, or Q5 flips to
  public. Proposing clash rows from a bad record (C) comes after. **Built:**
  `pairRecord(playtests, prompts)` in `web/src/lib/rates.js`, pure and returned
  by `rates()` as `pairs`. A prompt's game mechanics are its core, supporting
  and needed slots plus a constraint's frame, read through the draw's own
  `mechanicOf` (now exported) and leaving out structural and theme as
  `profile()` does. Its pairs are every unordered pair, keyed sorted by name.
  Every seat's `isReplayWanted` credits every pair of the prompt once (null
  skipped), and a row is `{ a, b, yes, no, playtests, prompts }` with the last
  two distinct counts, because pairs from one prompt move together. The log
  cannot say which pair a seat meant, so the line reads "seats at games that
  had this pair", with counts and no verdict: "5 of 7 seats would replay · 2
  playtests · 1 prompt". `/playtests/` shows the table beside the 2.2 figures
  (30 rows, then a count of the rest). `/draw/` lists each pair of the current
  draw with its record or "never played", over the same whole lists
  (`all: true`). `draw()` does not change and never sees the record. Proof: 15
  new tests in `api/test/rates.test.ts` (89 in the app), among them the
  invariant that `draw(catalog, { seed, record })` equals `draw(catalog, { seed })`
  over seven seeds with every pair of the draw recorded as a disaster. 19
  breaks of `pairRecord`, `pairsOf`, `gameMechanics` and `draw()` each failed a
  test; a 20th, a Set around the mechanic names, survived because `pairsOf`
  already dedupes, so the redundant copy was removed. `bun run check` and
  `fli check` are clean. Driven on the dev db: two playtests logged on prompt 3
  through the form (answers yes/no/not asked, then yes/yes), and all three of
  its pairs read "3 of 4 seats would replay · 2 playtests · 1 prompt", matching
  a hand count. /draw/ showed one recorded pair and two "never played" on a
  drawn game. The console was clean on both screens, and the playtests were
  deleted again.

### Phase 3 — Printable deck

Goal: the catalog prints as poker cards (63.5 × 88.9 mm, nine to a sheet on
Letter or A4), so a game can be drawn at the table without the app. Done when:
`/deck/` prints to PDF with one card per catalog row, and a draw dealt from
the printed cards by the rules card gives a draw the app's `draw()` could
have made. Q7–Q9 ruled 2026-11-17: four decks, a front band and no backs,
refusals on the card.

Prior art: Design Space Cards (ResearchGate 355114310) deals separate
mechanic, theme, pleasure and emotion decks to sample a design space.
Print-and-play generators (ilove.cards, getlabelmerge) agree that poker size
fits 3 × 3 on both papers with no gutter. Browsers ignore `@page { marks }`, so
the crop marks are drawn in the page.

- [x] 3.1 The catalog as cards. Built 2026-11-17, uncommitted.
  `web/src/lib/deck.js` is pure and turns the catalog into card objects, and
  `/deck/` (with `components/DeckCard.mesa`) only renders them, loading every
  list whole. A mechanic card has a tier band, its roles as colored chips with
  1–3 pips heaviest first, a JOB tag on a weight-3 role, three marks per dial
  (filled pips for numeric dials, one lit square for ordered ones) and the
  fixture's line unchanged. `shared/draw.js` now exports `JOB` and `CARRIES`,
  so the card prints the draw's own thresholds. The cards sit in a fixed
  190.5 × 266.7 mm grid with crop marks drawn from it, and `@page` sets only
  `margin: 0`, so Letter and A4 both print with no option. Colors are
  `--data-*` properties and print the same under either theme.
- [x] 3.2 Themes, constraints and the rules card (Q7 = B). A constraint card
  names its mechanic whenever the row names one: the five frames and
  Paper-and-Pencil, because the draw puts that mechanic in play for any
  constraint. The rules card has seven steps in `draw()`'s order and four
  refusals, with every number and role name read from `shared/draw.js`. It
  leaves out the target, `invites`, and lock and reroll, which the slot fill
  does not use.
- [x] 3.3 Refusals on the card (Q9 = B). Clash names print on both sides, and
  needs prints only on the side that needs, because `draw()` pulls the needed
  card in and never the reverse. A test checks that no printed refusal lacks a
  backing row. Proof for 3.1–3.3: 11 tests in `api/test/deck.test.ts` (100 in
  the app). Each of six breaks in `deck.js` failed a test: a dropped card, a
  one-sided clash, no needs, the job threshold off by one, an altered line, and
  an extra rules step. `bun run check` is clean. Driven: `/deck/` shows 276
  cards on 33 sheets, and the console was clean. `Page.printToPDF` gave 33
  pages on both Letter and A4 (22 + 7 + 3 + 1). Rendered at 110 dpi a card
  measures 63.3 × 88.9 mm, and the crop marks fall on every cut line.
- [x] 3.4 A table deal checked against the app. Done 2026-11-17 by script, not
  by typing deals into `/draw/`. That screen runs the same `draw()`, and a
  script could check 500 deals instead of five. The deal used only what
  `deckFrom()` prints (pips, JOB tags, clash and needs names) and followed the
  rules card. Every one of 500 deals held no duplicate, no clash and no
  shared job by the draw's own tests, and `draw()` with every slot kept added
  nothing. Two breaks of the table side show the check can fail: ignoring the
  printed refusals failed 101 deals, and skipping step 7 failed 179. Not
  proven: a sheet through a real printer, where an unprintable margin may clip
  the 5 mm crop ticks.
