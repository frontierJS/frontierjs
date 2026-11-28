---
id: crowd-tower-defense
status: reading
dated: 2026-11-27
---

# Reading — a tower defense the public internet plays together

**Status: READING.** This is the research behind stressor #52 (Keepfall,
`fjs-prototypes/keepfall/PLAN.md`), a browser tower defense that anyone on the
internet can join. It proposes nothing for the framework and describes no
behavior of it. Each claim carries its source. A claim marked *(inferred)* is a
synthesis nobody published, a claim marked *(summary)* was read from a
search-result summary and not from the page, and § Not verified lists what was
looked for and not found. Researched 2026-11-27 by four read-only agents.

**The owner ruled the daily solo form first** (2026-11-27), so § A daily game
is what the plan's phases build on. § Crowd-played precedent and the live half
of § Technical shape feed the plan's § Added later.

Five topics: § What the framework already has, § Crowd-played precedent,
§ Tower defense, § A daily game, § Technical shape. Each of the last four ends
with **Recommended**, which is what the plan's Questions start from.

---

## What the framework already has

Read from this tree on 2026-11-27. Nothing here was run.

- **No multiplayer game exists in the catalog.** The nearest is #38, the live quiz (`fjs-prototypes/quiz/PLAN.md`): 300 strangers, one server clock, never built. Its open Q1 (burst writes), Q2 (a principal with no account), Q4 (the server's clock in the client) and Q5 (the per-IP socket cap) all carry into this game.
- **A channel sends one frame to every member.** `app.channel(name).send(event, data)` (`packages/junction/src/transport/channels.ts:216`) is not graded per recipient, which suits public game state and nothing private. `announce()` (`:2428`) is the graded path for service writes.
- **Presence ships.** `channels(setup, { presence: [...] })`, five updates per second per socket by default (`channels.ts:2139`). Haven uses it for who stands where (`packages/haven/api/src/rooms.ts`).
- **A visitor with no account can hold an identity.** `createApp({ principal })` resolves a bearer claim per request; `bearerClaim` (`packages/junction/src/core/bearer.ts:280`) is the owner and `example/api/src/domain/shop/cart-grant.ts` the worked case, and `channels({ claims })` carries it to a socket (`FJS-D191`). A guest's claims never become `ctx.user` (`FJS-D113`).
- **Socket limits have defaults that a public game meets at once**: 256 connections per IP, 100 frames per second per socket, no total cap (`packages/junction/src/transport/http.ts:294`). A slow reader is closed once 8 MB queues behind it (`send-queue.ts`).
- **No server-stepped simulation exists.** A plugin's `work()` is where a timer starts (`packages/junction/src/core/app.ts:108`), and `app.scheduler.every` drops a tick that overlaps the last. Nothing in the tree runs a loop faster than twenty seconds outside a test.
- **Fan-out is unmeasured past 100 sockets.** The records are 3,000 idle sockets accepted in 2.2 s and grading cost at 100 sockets (`packages/junction/docs/internals.md:104`).
- **A canvas owned by a `.mesa` component has two precedents**: `fjs-prototypes/five-to-nine/site/src/islands/Room.mesa` (WebGL, renderer made in `{@attach}`) and `fjs-prototypes/darkroom/web/src/components/Stage.mesa` (2D bitmap).
- **A public deploy needs a container.** Junction needs Bun (`packages/junction/docs/guide/running/deploying.md:12`), so the API goes out by `fli deploy` or `fli basecamp:deploy`, which route `/ws` back to it. A Cloudflare Worker can serve the static client alone.

---

## Crowd-played precedent

| Case | Year | The one action | The limit | Time shape | Scale |
| --- | --- | --- | --- | --- | --- |
| [r/place](https://en.wikipedia.org/wiki/Place_(Reddit)) | 2017, 2022, 2023 | place one pixel | one per 5 to 20 minutes | event, 72 to 87 hours | 1.1M users (2017), 10.5M (2022) |
| [Twitch Plays Pokemon](https://en.wikipedia.org/wiki/Twitch_Plays_Pok%C3%A9mon) | 2014 | type a command | none, or a vote window | 16 days to the ending | 121k at once, 1.16M total |
| [The Button](https://en.wikipedia.org/wiki/The_Button_(Reddit)) | 2015 | press once | one press per account, ever | about 2 months | about 1M presses |
| [Wordle](https://techcrunch.com/2022/01/12/josh-wardle-interview-wordle/) | 2021 | solve, share the grid | one puzzle a day | daily | 1.2M grids shared in 13 days |
| [One Million Checkboxes](https://eieio.games/blog/scaling-one-million-checkboxes) | 2024 | check a box | per-session request limit | about 2 weeks, ended on purpose | 650M checks |
| [Internet Roadtrip](https://en.wikipedia.org/wiki/Internet_Roadtrip) | 2025 | vote on a direction | one vote per 10 s tick | always on | about 2,500 at once |
| [One Million Chessboards](https://eieio.games/blog/a-million-realtime-chess-boards-in-a-single-process/) | 2025 | move a piece | none | faded, then reset | 150k players in 10 days |
| [wplace](https://en.wikipedia.org/wiki/Wplace) | 2025 | paint a pixel on a map | pool of 30, one back per 30 s | always on | 10M users in a month |

### What repeats

- **The first action is one tap, and the fastest spreaders asked for no account.** Checkboxes tracked a session id and nothing else. Chessboards placed a newcomer beside someone who had just moved, so the board was alive on arrival. r/place, The Button and wplace required an account and borrowed a community that already existed.
- **The limit is the game.** r/place's cooldown was a live server setting, lengthened to hold writes near 333 a second ([discussion of Reddit's write-up](https://news.ycombinator.com/item?id=14109158)). One pixel per person made coordination the only way to draw anything, and factions followed. A study of the canvas found contribution stayed concentrated in a few people even so ([arXiv 2408.13236](https://arxiv.org/abs/2408.13236), abstract only).
- **Where there was no limit, scripts took the board.** Checkboxes' author received hundreds of angry messages about bots and asked their authors to slow down "with limited success" ([eieio](https://eieio.games/blog/the-secret-inside-one-million-checkboxes)).
- **Conversation came from four things a designer can choose** *(inferred from the cases)*:
  - *a visible shared state*: the canvas, the board, the car on the road;
  - *sides with a badge*: The Button's flair colors became the Emerald Council and the Violet Hand, and Roadtrip split into pathists and detourists;
  - *a shareable artifact*: Wardle called the emoji grid, added 16 Dec 2021, the catalyst;
  - *an ending*: The Button's last presser was named the Pressiah.
- **It also came from two things nobody can choose**: the Helix Fossil sat first in an item list and became a religion, and teenagers hid a URL in the checkbox bits. Both were harmless oddities the operator left alone.
- **An ending is cheap and was regretted when late.** Checkboxes' author wanted "a real ending before people moved on" and wrote that he should have shipped the sunset sooner. Chessboards faded without one. No source compared press coverage of the two shapes.
- **What broke, in every case, was abuse and bandwidth before CPU.**
  - Checkboxes: unvalidated input let one user grow the stored state about 100 times, a DDoS put Cloudflare in front, and outbound traffic was capped at 250 Mbit/s. The whole run cost about $850.
  - Chessboards: one Go process, a bit over 1 TB sent in the launch month, about $450 a month at first and $80 after.
  - Roadtrip: a bot flood of honks and U-turns in May 2025, answered with a captcha (fan wikis only).
  - r/place: admins kept the power to overwrite anything, and a race let users place more than one tile.
- **The first wave came from Hacker News and Reddit** for both eieio games, from Twitter for Wordle, and from the creator's own audience for Roadtrip *(inferred)*.

**Recommended.** One tap with no account. A per-person limit that is a server setting. A round that ends where everyone can see it. An artifact made for sharing from the first public day. Input validation, a proxy and a moderator's overwrite before launch, not after.

---

## Tower defense

### What makes one good

- **Mazing is the form where placement is the whole game.** Desktop Tower Defense (2007) gave an open field where towers are walls and the route forms around the build ([Wikipedia](https://en.wikipedia.org/wiki/Desktop_Tower_Defense)). The lineage is the Warcraft III maps Wintermaul, Element TD and Gem TD ([Maul Tactics](https://maultactics.gg/articles/mazing-guide)). Damage is rate times the time a creep spends in range, so the longest legal route wins, and a placement that seals the exit is refused.
- **A level with one long straight makes every tower equal**, so the choice stops mattering ([Reign Creative](https://reigncreativellc.com/blog/tower-defense-strategy-basics/)).
- **A good wave invalidates the current plan.** More of the same enemy is "the weakest lever", and the gap between waves is "a designed object, not dead time" ([Reign Creative](https://reigncreativellc.com/blog/wave-survival-game-design/)).
- **Teach inside the game, under eight words on screen** (George Fan on Plants vs. Zombies, [Game Developer](https://www.gamedeveloper.com/design/gdc-2012-10-tutorial-tips-from-i-plants-vs-zombies-i-creator-george-fan)).

### Multiplayer forms that shipped

| Form | Example | What each person does | How influence is limited |
| --- | --- | --- | --- |
| Co-op, 2 to 8 | Bloons TD 6 co-op, [Element TD 2](https://steamcommunity.com/app/1018830/discussions/0/3076496088129583899/) | builds in an own quadrant or lane | own territory, split or separate money |
| Versus with sends | [Line Tower Wars, Legion TD 2](https://maultactics.gg/articles/games-like-wintermaul-wars) | buys creeps to send at a rival | a send raises income, so turtling loses |
| Team event | Bloons TD 6 Contested Territory *(summary)* | captures a tile by beating its score | tickets per player per day |
| Streamer and chat | [ChatTDT](https://store.steampowered.com/app/3060850/ChatTDT_Tower_Defense_Twitch/), [Stream Defense](https://store.steampowered.com/app/2277250/Stream_Defense/), [Stream Siege](https://streamsiege.com/) | chat spawns enemies or plays one unit | 64 to 72 people, one streamer hosting |
| Viewer army | Stream Raiders *(summary)* | places one unit every 5 minutes | time gate, streamer starts the battle |
| Chat economy | [Twitch-Tower-Defense](https://github.com/MasstarVT/Twitch-Tower-Defense) | earns coins by chatting, spends on spawns | 2 coins a message, 15 s cooldown |

### Open ground

- **Nothing found puts more than about 70 people on one defense**, and every case that large needs a streamer's chat as its host. A search for a massively multiplayer tower defense found one abandoned repository ([mmotd](https://github.com/paddycarey/mmotd)) and no postmortem.
- **No mazing game found lets many people edit one maze.** Element TD 2 stops at eight.
- **No tower defense found uses a per-person limit as its designed rhythm.** Existing limits are bolted on to stop spam (Crowd Control's cooldowns and conversion cap, [Warp World forum](https://forum.warp.world/t/redemptions-limit-per-viewer/26243)). r/place's cooldown is the nearest design and it is not a tower defense.
- **Nothing found describes how a tower defense survives a troll.** Twitch Plays Pokemon answered its own stuck crowd by adding a vote mode.
- **A versus game "lives or dies on population"** ([Maul Tactics](https://maultactics.gg/articles/wc3-custom-maps-standalone-games), citing Tower Wars, 2012). A shared defense depends on population too *(inferred)*, so a round has to be playable by three people at four in the morning.

**Recommended.** Mazing on an open field, because it makes each placement visible and arguable. Each person's limit is a cooldown, as on r/place. The design answers the troll in its rules (anyone may spend a turn replacing a piece) before it reaches for moderation. The balance is proven with simulated crowds before any art is drawn.

---

## A daily game

### One seed, one attempt

- **Spelunky's Daily Challenge (2013) is the form**: the same levels for everyone, one attempt, and "if you die at any point, then you can't retry". The writer's verdict was that "a very single player experience has suddenly erupted into one of the most exciting multiplayer games" ([Game Developer](https://www.gamedeveloper.com/design/the-understated-genius-of-the-i-spelunky-i-daily-challenge)). No designer was found arguing one attempt against retries.
- **Its board stored no replays and was forged.** A community ranking site called the in-game board "worthless", with a hacked score on top "for long" ([MossRanking](https://mossranking.com/news/55), *summary*). Players also suspected seed previewing, and a reply said it cannot be policed.
- **Wordle has no board at all.** It shows a person their own win rate, streak and guess histogram. Wardle called even a friends board a "nice to have" that adds complexity ([Syntax 430](https://syntax.fm/show/430/creator-of-wordle-josh-wardle/transcript)).
- **A percentile has one working precedent**: Clues By Sam shows a fast solver a top 1, 5, 10, 25 or 50% band *(summary)*. No creator was found saying a percentile was chosen because of cheating.
- **Daily tower defenses exist** (Daykeep, Endless Siege with a new map at midnight UTC, Root Hollow), all known from summaries, none with a write-up. A hobby project plans this exact form, "replay-verified using the existing seed + command-list replay format" ([issue](https://github.com/satautiv/tower-defence/issues/60)).

### Why Wordle spread

- **Three minutes.** "I just wanted a game that was just three minutes of your time a day, and that's it" (Wardle, Syntax 430). No source was found on a daily game that ran too long.
- **No account and no back end.** State is `localStorage`, a streak needs the same device, and Wardle tied "there's no back end" to going viral. When the Times added accounts, some streaks reset ([Wikipedia](https://en.wikipedia.org/wiki/Wordle)).
- **The grid shares "how you did in the game, but without spoiling it for others".** A player in New Zealand invented it and Wardle added the button on 16 Dec 2021. Players went from 90 on 1 Nov 2021 to over 300,000 by 2 Jan 2022.
- **He left the link out on taste, not data**: "if you throw up a link there it kind of looks crappy in my opinion" ([Game Developer](https://www.gamedeveloper.com/marketing/josh-wardle-reflects-on-the-the-unconventional-road-to-wordle-s-success)).
- **A screen reader reads the grid as noise.** The fixes came after launch and from outside: a high-contrast mode, alt-text generators, a button that copies a sentence ([Access Armada](https://www.accessarmada.com/blog/how-wordle-falls-short-on-accessibility/), *summary*).

### Grading a run by replay

- **The shape has shipped**: the browser sends its input list with a signed run token, the server "imports the exact same game module, replays every tick headlessly", and a score is written only on a match. It uses a seeded stream and a 00:00 UTC day ([dev.to](https://dev.to/seethefutureco/how-we-built-a-zero-framework-daily-competitive-browser-gaming-platform-with-server-replayed-gi1)). Trackmania validates a replay from its recorded inputs the same way *(summary)*.
- **JavaScript engines do not agree on every `Math` call.** Add, subtract, multiply, divide and `Math.sqrt` are exact. `hypot`, `pow`, `exp`, `log`, `atan2`, `sin` and `cos` can differ in the last bit ([swarm-game](https://github.com/Dibz15/swarm-game/issues/26)). One project measured 9 of 600 runs ending differently in Chromium, WebKit or Firefox than in Node, and all 600 identical once those calls were replaced by arithmetic ([siege-works](https://github.com/definitelynotai729-bit/siege-works), x86-64 only). The ECMAScript text was not read to confirm.
- **The verifier is a door.** Hobby projects cap ticks, refuse a body with 413 before parsing it, and queue the replay; one measured 8 to 50 ms of CPU for a replay *(summaries)*.
- **A replay proves a log obeys the rules. It does not prove a person chose it.**

### The crowd after a solo run

- **The only evidence is from outside daily games**: a fan's map of about 20,000 Dark Souls deaths was widely shared ([PCGamesN](https://www.pcgamesn.com/dark-souls-prepare-to-die-edition/dark-souls-death-map), *summary*), and the Times added WordleBot, which grades a finished game.
- **No daily game was found with fixed sides.**

**Recommended.** One official run a day, with its input list stored. A percentile and a histogram, and no board. A run near five minutes. Integer arithmetic in the rules, proven equal in three engines before anything else is built. A pasted line that carries a plain sentence beside the emoji. The page plays with the server stopped.

---

## Technical shape

*The live forms need this section; the daily form needs only § A daily game.*

- **Two ways to keep a thousand screens in step.**
  - *Send inputs, simulate everywhere.* Bandwidth follows the number of inputs, not the number of creeps, and it needs an identical simulation on every machine with a checksum to catch drift ([Gaffer On Games](https://gafferongames.com/post/deterministic_lockstep/)). OpenFront works this way: intents are bundled into a turn every 100 ms and state is hashed for desync ([repository](https://github.com/openfrontio/OpenFrontIO), AGPL-3.0, so read and not copied).
  - *Send snapshots.* Ten a second with 100 ms of interpolation is "not generally noticeable" ([Gambetta](https://www.gabrielgambetta.com/entity-interpolation.html)), and a late joiner needs nothing else.
- **The arithmetic favors inputs** *(inferred)*: 300 creeps at about 6 bytes, ten times a second, is near 20 KB a second per viewer and 160 Mbit/s at a thousand viewers. Placements alone are a few hundred bytes a second for everyone. The costs of the two eieio games were bandwidth costs.
- **A late joiner needs one snapshot and then the inputs**, which lockstep alone does not give *(inferred)*.
- **One process can hold the sockets.** uWebSockets.js held about a million idle connections in 5.45 GB in one benchmark, whose broadcast test used 10,000 subscribers ([Evil Martians](https://evilmartians.com/chronicles/choose-your-fighter-benchmarking-5-websocket-servers-for-nodejs)). Junction's own ceiling is unmeasured.
- **Pathfinding is one breadth-first search from the goal**, giving every creep its next step, recomputed when a wall changes ([Red Blob Games](https://www.redblobgames.com/pathfinding/tower-defense/)). A placement is refused when the search from the spawn no longer reaches the goal *(inferred; the article does not state the check)*.
- **Rendering.** Canvas 2D reaches about 5,000 sprites at 60 frames a second in one benchmark and PixiJS 10,000 to 50,000 ([2dbench](https://github.com/debuffjp/2dbench), published by a rival renderer's authors). A cautious guide gives 30 to 50 animated sprites for Canvas 2D on a mid-range phone ([abratabia](https://abratabia.com/game-animation/animation-performance.php)). The two differ by a hundred times, so a real phone decides.

**Recommended.** The server owns the simulation and stamps each placement with the tick it takes effect. Clients run the same integer-math simulation from a snapshot plus the placements, and a periodic hash triggers a fresh snapshot on drift. Canvas 2D first, measured on a phone before any renderer is added.

---

## Not verified

- Reddit's own 2017 and 2022 r/place write-ups were blocked; the figures come through Wikipedia, a Fastly mirror and a Hacker News thread.
- Neal Agarwal's own account of Roadtrip's bots, cost and totals was not found; the bot flood rests on fan wikis.
- Whether a time-boxed event draws more press than a persistent one. No source compared them.
- Bloons TD 6's co-op money split and Contested Territory rules (the wiki refused the fetch), and Element TD 2's shared lives (sources conflict).
- How zombs.io or YORG.io handle a player who drops in. Sources conflict on whether YORG.io is multiplayer at all.
- Whether OpenFront's server also simulates (its two documentation sites disagree).
- `ayhoung/open-tower-defense` (MIT, co-op mazing, 20 ticks a second) is known from a summary; the repository returned 404.
- Desktop Tower Defense's play counts, and any shared-seed daily or replay precedent in a tower defense beyond Bloons TD 6's challenge codes.
- Dungeon Defenders, Orcs Must Die, Random Dice and Rush Royale: no sources found.
- Slay the Spire's and Bloons TD 6's attempts per day (both wikis refused the fetch).
- The ECMAScript specification's own words on `Math` accuracy; the engine findings rest on two hobby repositories.
- Verification cost and size limits from anything but hobby pull requests.
- Whether showing the crowd after a run, or sides in a daily game, drives sharing. No case was found for either.
- Creator material from Semantle, Framed, Connections, Tradle and Costcodle.
