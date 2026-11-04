---
id: frontier-town
status: proposed
dated: 2026-10-31
---

# Frontier Town — the workspace as a town you run

**Status: PAUSED 2026-11-04 by the owner. Phases 1–7 are built and committed on
the `world` branch (worktree `~/code/FRONTIER/frontierjs-world`, last
commit `1e65dbda`), unmerged.** None of it is on dev; this copy of the paper is.
Do not cite this file as describing behavior — see `VERIFYING.md`.

## Where we left off

- Built: `fli ws:world` (atlas + codegraph + ledger + chronicle + rig) writes
  `repo-town.html`; `--json` prints the model. The page is four zoom scenes
  (World › Region › Field, and the Hall) plus the Workshop (`#/rig`), the 8-bit
  Claude Rig whose every figure is read off this machine.
- Last look: https://claude.ai/code/artifact/6919376c-243c-4f0d-9b14-54cc9f5c2583
  (v5, data as of 2026-11-01). It is rebuilt by a scratch script that strips the
  page to the artifact skeleton; the script was in a session scratchpad and is gone.
- Owed on resume, in order:
  1. The owner walks the page and says whether the zoom view reads.
  2. Merge `world` into dev or not. The branch is 11 commits off an old dev, so
     expect a rebase; it touches only `packages/cli/core/repo-*.js`,
     `world-*.js`, `commands/workspace/world.md`, `.gitignore` and this paper.
  3. Keep or retune the exchange rates (§ The exchange rates).
  4. Whether the Workshop becomes the Haven view (Haven Phase 11).
  5. Workshop gaps: toolshed and warehouse (built-in and deferred tools) have no
     file to read; claude.ai connectors are in no file; the window size is
     assumed (200k, or 1M on a `[1m]` model) while settings compact at 250k; the
     bench is the newest transcript in the workspace, not necessarily yours.
  6. Phone: the region scene's labels are tiny and long names truncate.
  7. Q1 below.
- To resume: `cd ~/code/FRONTIER/frontierjs-world && bun
  packages/cli/bin/fli.js ws:world`, open `repo-town.html`.

**The ask (owner, 2026-10-31).** Each person has a town with its own
resources, and the person is its mayor. Capital grows by spending tokens to
go out to the field and harvest — fixing issues and taking on projects. An S2
pays more than an S3, and so on down.

**The claim.** Every number in the town is already recorded somewhere in the
tree or on this machine. Only the exchange rates are invented:

| Town | Read from |
| --- | --- |
| the ground, packages on their ring | `fli ws:world` (atlas + codegraph) |
| crops in a field | the open issues filed against a package, by severity |
| a harvest | a closed issue: its `Closed` date, its severity, and the git author of its row |
| a project and its stages | a plan under `IDEAS/` and its step boxes |
| a crew's wages | the tokens a Claude session spent, read from `~/.claude/projects/*/*.jsonl` |
| the mayor | the git author; one town per author |
| the treasury | rewards minus wages, by day |

## The exchange rates

One table in `core/world-ledger.js`, so tuning them is a one-line change.

- Harvest: S1 120, S2 60, S3 25, S4 10, and a row with no severity 15.
- Project: a ticked step 20, a finished phase 50 more.
- Wages: 20 gold per million *weighted* tokens (1 made a median session cost
  0.4 against an S4's 10, so no harvest was a choice), where input weighs 1, a cache
  write 1.25, a cache read 0.1 and output 5 (the price ratios).

## Phase 1 — The ledger

Goal: `fli ws:world` carries an `economy` block: every harvest, project stage
and wage, dated, attributed and priced.
Done when: `fli ws:world --out x.json` prints treasury totals that a hand count
of one day's closed issues and one session's tokens agrees with.

- [x] 1.1 Harvests: every closed issue in `ISSUES.md` § Closed and
  `ISSUES_ARCHIVE.md`, with id, package, severity where the row has one,
  closed date and git author of the row.
- [x] 1.2 Projects: every ticked step with the date and author that ticked it (git blame
  of the plan file, one blame per file).
- [x] 1.3 Wages: tokens per session per day from the transcripts of this
  workspace's projects, with the session's first prompt as its name.
- [x] 1.4 Treasury: per town (author) per day, rewards, wages and running
  capital; `--since` limits the window.

## Phase 2 — The town page

Goal: `fli ws:world --as=town` writes `repo-town.html`, a self-contained page
to walk around.
Done when: the page opens with no console errors at desktop and 400px, in
light and dark.

- [x] 2.1 The map: the World tab's rings of packages as fields, open issues
  as crops colored by severity, roads as imports.
- [x] 2.2 The town hall: the mayor, the treasury, capital over time, today's
  harvest and wages.
- [x] 2.3 Projects as building sites: a plan's stages built up as its steps tick.
- [x] 2.4 Crews: recent sessions as workers walking from the hall to the field
  they harvested, wages over their heads.
- [x] 2.5 The harvest log: newest first, each row linking its issue.

## Phase 3 — The game

Goal: the mayor can see what to send a crew after next.
Done when: the page ranks the ripest crops by reward over expected wages.

- [x] 3.1 Expected wages per severity, from what past harvests cost (the wages of
  the sessions that closed them).
- [x] 3.2 A job board: the ripest crops and the open project stages, each with the
  command that sends a crew (`/fix-next`, `fli plan`).
- [x] 3.3 Other towns: a second author's ledger drawn as a neighbor across the road.

## Phase 4 — The town grows

Goal: the town has a history you can watch and a present you can see live.
Done when: dragging the day slider from the first day to today redraws the
treasury, the harvested fields and the built projects for each day, and a
session running right now stands in the field it is working.

- [x] 4.1 Finished projects as buildings: a plan whose steps are all closed
  stands as a finished building in a district by the hall, sized by its stages,
  instead of disappearing from the map.
- [x] 4.2 The replay: a day slider (and a play button) that redraws the
  treasury, the day's harvests flashing on their fields, and the building sites
  as they stood that day.
- [x] 4.3 Live crews: a session whose transcript moved in the last 15 minutes
  is a crew out now, standing at the package its latest edits touch, with
  today's wages so far.
- [x] 4.4 Seasons and weather: the field's ground follows how recently it was
  worked (lush, dry, fallow), from `edits`.

## Phase 5 — The chronicle

Goal: the town tells its own story, every line of it read off the ledger.
Done when: each week since the first harvest has a gazette page whose every
figure a reader can find again in the harvest log or the ledger JSON.

- [x] 5.1 The gazette: one issue per week, newest first. The headline harvest
  (the highest-paid, then the oldest id), the field harvested most, the
  costliest crew, projects finished, and the treasury's change. Written from
  templates, never invented.
- [x] 5.2 Monuments: milestones stand on the map as small landmarks: the first
  S1 harvest, every thousandth harvest, the best day, the first finished
  project. Each has a card with its date and what it was.
- [x] 5.3 Stewards: the person or the session that harvested a field most is
  its steward, named on the package card, with a share of the field's harvests.

## Phase 6 — The overworld

The owner, on Phases 1–5: "the visual is a rats nest and too much — I have no
clue what's going on." Asked for a high-level map like an old 8-bit game,
where clicking a place zooms into it. So one scale is drawn at a time, and
each scale shows only its own things; nothing is toggled.

Goal: a stranger can say what they are looking at on every screen.
Done when: each of the four scenes, at 1280px and 400px in both themes, shows
no more than one kind of thing per layer, and Esc, the breadcrumb and the
browser's back button each return to the scene above.

- [x] 6.1 The overworld: five regions, one per atlas ring, drawn as pixel
  terrain on a canvas. Spine is the castle hill with the hall, Substrate is
  farmland, Batteries is villages, Tooling is the forge and mines, and
  Frontier is the wilds. Each region has one sign: its name, open issues by
  severity, and a marker when a crew is out there.
- [x] 6.2 The region: its packages as fields on a grid, their crops, the
  building sites of plans working there, roads between its own fields only,
  and one signpost per neighboring region. The side panel shows the region's
  job board.
- [x] 6.3 The field: one package fills the view. Each open issue is one
  plant, with its title on hover or tap. The granary holds what was
  harvested; the panel shows the steward, the plans building here, and the
  field's jobs and harvest log.
- [x] 6.4 The hall: the treasury, the replay, the gazette, the mayor switcher,
  and the monuments as a trophy room.
- [x] 6.5 Getting around: a breadcrumb (World › Batteries › caravan), Esc to
  go up, `#/region/field` in the URL so back works, and a short zoom between
  scenes that `prefers-reduced-motion` turns into a cut.

## Phase 7 — The workshop

The owner, 2026-10-31, on the Claude Rig mockup: "I want the 8-bit version of
the rig; it should be something like the town." The Rig drew the Claude Code
setup as a town but every number was typed in by hand. Here it is one more
place in Frontier Town, drawn in the same pixels, every figure read off this
machine when `fli ws:world` runs.

Goal: a stranger can walk into the workshop and say what Claude is carrying,
what it can reach for, and who is out working.
Done when: `#/rig` opens from the overworld, each building's number matches a
hand count of its source, and the scene passes Phase 6's checks.

- [x] 7.1 The data: `world.rig` from a new `core/world-rig.js`, every field read
  from a file: the bench (the newest live session's model and context fill, from
  its transcript's last usage), the library (skills, project and global), records
  (memory files), the gate (hooks by event, from every settings file), roads out
  (MCP servers), the council (rulings waiting on the owner), the lodge (subagents
  and lanes out now), town law (the CLAUDE.md files that load), package houses
  (packages with their own CLAUDE.md).
- [x] 7.2 The scene: one pixel canvas, a building per field above, each with its
  sign and one number; the bench drawn as a table piled to its fill, a red line
  where compaction starts. Click a building and the panel says what it stands
  for in Claude Code and lists what it holds.
- [x] 7.3 The way in: a workshop on the overworld beside the castle, the route
  `#/rig` (`#/rig/<building>` selects one), the breadcrumb World › Workshop.

## Built so far

- Harvests: closed rows of `ISSUES.md` and the archive; a ruling (`FJS-D`) is
  no harvest. Severity is recovered from the last `S`-section each id sat in
  across `ISSUES.md`'s git history (2072 of 3395); the rest pay `none`. The
  author is the author of the first commit whose `## Closed` held the id,
  because blame on the archive names whoever archived it.
- Full history at 20 gold/M: Jordan +92,845 rewards, -45,974 wages; Vlad
  +7,115 and no wages (transcripts are one machine's).
- Plain `fli ws:world` writes `repo-town.html` (gitignored); `--json` prints
  the model. Caches in `.cache/world-*.json`.

- 3.1: a harvest links to the session whose transcript ran `fli close <id>` as a
  Bash call (hand-edited closes leave no call and stay unlinked), on the harvest's
  day or the nearest within two; the session's wage that day, split over the
  harvests it closed, is the cost. `economy.costs` holds median and mean per
  severity plus `stage` (a median session-day); `harvest.session` and `.cost`
  where linked. Fix-loop lanes (`~/.fli/lanes/<repo>-N`) now count as wages.
- 3.2: `world.open` carries every open row; the job board ranks issues by bounty
  minus the severity's median wage (older id wins a tie) and plans' next steps by
  step plus phase bonus (`next.finishes`) minus a session-day; a row selects its
  field and copies `/fix-next` or `fli plan`.
- 3.3: a mayor switcher in the hall (not neighbor halls on the map, which is full
  and whose fields Vlad shares) re-draws treasury and spark, and filters the log.
- 4.1: a plan with no open step and a ticked one stands as a finished building
  (house and roof, width by stage count, label on hover) in a district seeded just
  below the hall; each settles beside the last, so it stays a cluster. Its card
  gives stages, the date of the last tick (`economy.stages`) and the file. No
  "built district" caption when the ground beside the cluster is taken.
- 4.2: a play button and day slider over the town's calendar (quiet days carry the
  capital forward). A day redraws treasury, sparkline cursor, harvested/wages/net,
  glows the day's harvests on their fields with a rising `+Ng` (not under
  reduced motion), and repaints every site and finished building to the ticks
  dated on or before it; none ticked yet is not drawn. Stage ticks are every
  author's (a building belongs to the workspace); harvests are the picked mayor's.
  The last day is the page at rest. Stage dates begin 2026-10-13, so earlier days
  show no buildings.
- 4.3: `economy.live` from `liveCrewsOf`: sessions whose transcript or subagent
  file moved within 15 minutes of the run, the package of their latest Edit/Write
  under a workspace root (else cwd), `since` and today's wages. Read fresh, not
  cached. Drawn as green crews at their field (a row under the hall when none),
  and listed in the hall "as of HH:MM" with the page's frozen-time caveat.
- 4.4: a field's meadow is lush (edits in the last 3 slices), dry (only earlier) or
  fallow (never), from token mixes; the pkg card names it.
- 5.1: `chronicleOf` (`core/world-chronicle.js`, set as `world.chronicle` in
  `world.md`) gives one gazette issue per Monday-to-Sunday week from the first
  harvest, newest first, in a "Town Gazette" panel under the map with Older,
  Newer and a week picker. Each issue: the headline (highest reward, lower id on
  a tie; its id selects its field), the field harvested most, the costliest
  session by the week's wages, projects whose last stage fell in the week and
  have no open step now, the treasury change and the count by severity. Scope
  is the workspace: every author's harvests and stages, this machine's wages,
  so it ignores the mayor switcher. Lines are templates over those figures.
- 5.2: monuments are the first S1 harvest, every 1000th harvest in (day, id)
  order, the best day by net, the first finished project and the costliest
  session-day. Obelisks mark harvests, statues the town-wide ones; each takes
  the free spot nearest its field's lower-left corner (a pkg with no field, or
  a town-wide one, rings the hall), is placed before the sites so it does not
  collide, and is hidden on replay days before its date. A card gives the date
  and the inscription.
- 5.3: `chronicle.stewards` per package: the author with most harvests (all
  authors) with count of the field's harvests, and where sessions are linked,
  the session with most linked harvests. Shown as a "Steward" row on the
  package card.

- 6.1-6.5: `repo-town.js` is rewritten as four scenes on one 320x192 pixel canvas with
  HTML signs, links and buttons laid over it, one at a time and at most one side
  panel. 6.1 overworld: five regions, one sign each (name, up to 3 severity pips, a
  walking figure for a live crew); the panel is a short Town summary. 6.2 region:
  fields, up to 8 plan building sites, roads inside the region only, a signpost per
  linked region that travels there; the panel is the region's job board. 6.3 field:
  one plant per open issue (`world.open`), spacing chosen so the plants fill the
  soil, id and title on hover, focus or tap, the granary holds harvested and gold;
  the panel is the package card, 3 plans, jobs, harvest log. 6.4 hall: treasury,
  sparkline, replay slider, mayor switcher, gazette and a trophy-room card grid.
  6.5 routing: `#/`, `#/<region>`, `#/<region>/<pkg>`, `#/hall`; breadcrumb, Esc up
  a level, `hashchange` renders so back works, a 250ms zoom that is a cut under
  `prefers-reduced-motion`. The palette is `--px-*` tokens read back through a probe
  and repainted on `themechange`; no hex. Dropped: the ring map, the built district,
  crew-wage lists, rate chips, harvest flash.

- 7.1-7.3: `core/world-rig.js` `rigOf({ root })` is `world.rig`, every field read
  off this machine and null where its file is missing. Bench: the newest main
  transcript's last assistant usage (input + cache read + cache write), read from
  the last 3 MB; the window is assumed (`[1m]` ends the id, else 200k) and the red
  line is `autoCompactWindow` from `~/.claude/settings.json` (no setting, no line;
  past the assumed window, the bench scales to the line and says so). Library:
  SKILL.md frontmatter, project and global, symlinked folders counted. Records:
  the project's memory folder and MEMORY.md lines. Gate: hooks from the three
  settings files. Roads: MCP servers from `~/.claude.json` (global, then the
  project entry for the checkout or its main) and `.mcp.json`, name, transport and
  address only, never headers. Council: `openDecisions` (what `fli decisions`
  prints). Lodge: subagent files of the bench session and of live sessions, and
  `~/.fli/lanes`, out when written in the last 15 minutes. Law and package houses
  are CLAUDE.md sizes. Toolshed and warehouse have no file, so no building. The
  page: `#/rig` is a ninth-building scene in the same pixel machinery
  (`#/rig/<building>` picks one and only changes the panel, so back steps through
  picks), a workshop beside the castle on the overworld, breadcrumb World ›
  Workshop, Esc clears the pick then goes up.

## Open questions

- Q1 Does a harvest belong to the person who closed it or the one who filed it?
  Built as the closer; the filer gets nothing yet.
