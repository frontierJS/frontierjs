---
id: town
status: proposed
dated: 2026-10-13
---

# Idea — the town: a terminal village anyone with `fli` installed can walk into

**Status: PROPOSED. Phase 0 is built; the app is not.** Dated 2026-10-13. The
probe below is now `packages/mesa/test/terminal/specs/town.spec.mjs`; everything
past Phase 0 is argument. Do not cite this file as describing behavior — see
`VERIFYING.md`.

**The ask.** `fli town` draws a village in the terminal. Every person online
has a figure in it. Arrow keys walk, a door enters the tavern, a typed line
appears as a bubble over your figure until the next one. Anyone who has `fli`
installed can join — it is the framework's own chat place, not a workspace tool.

**The claim.** This is one hosted FJS application with a terminal client, and
nearly every piece already has an owner. Presence, rooms, graded broadcast and
rate limiting are Junction's. The client is a `web/` surface compiled for the
terminal, which `fli dev:tui` already does for any app (`FJS-D809`). What is
new is small: a schema of three models, an identity for a machine with no
browser, one terminal lowering, and the deploy. It is also the first FJS app
with strangers on it, which makes it the best dogfood this repo could run —
`basecamp` has one tenant and `example` has none.

---

## What the probe found

Run on `test/terminal/run.mjs`'s headless renderer, 40x12, a `<pre>` of three
houses and three figures, one moved by arrow keys and given a bubble by Enter.
Kept as `specs/town.spec.mjs` over `fixtures/Town.mesa`.

- **A figure is an absolute box over the art, and it lands on the cell asked
  for.** `<pre>` keeps its columns, the figure paints over it, and when the
  figure moves the art under its old cell is drawn again. Nothing clears.
- **`style:` cannot place it.** The terminal paints no CSS, pinned by
  `specs/style.spec.mjs`, so `style:left` is inert. Placement went through
  `{@attach}` writing the engine's own `position`, `left`, `top` and `zIndex`
  on the renderable.
- **The attach must be a factory the template calls** — `{@attach at(p.x, p.y)}`
  — so the template reads the coordinates. An action that reads `p` only inside
  its body is never re-run when a keyed `{#each}` replaces the item, and the
  figure stays where it was mounted while its bubble, a fresh `{#if}` node,
  appears at the new place.
- **A bubble's spaces are transparent.** `(hi all)` painted as `(hi;all)` with
  the hedge showing through until the box was given a background. The engine
  draws a cell only where there is a character. Since 0.3 a box of
  `@frontierjs/css`'s surface lineage (`surface`, `card`, `dialog`, `popover`,
  …) blanks its own cells, unless `outlined` or `ghost` — the two variants a
  browser paints transparent — rides beside it.
- **`<mesa:window on:keydown>` hears the arrows as `ArrowRight` and friends**,
  the DOM names, through the engine's key table. Enter reaches the same handler.

So the UI half is a day of `.mesa`: placement is an attach in the app
(`FJS-D978`), and the opaque box is the surface class (`FJS-D979`).

## The shape

```
packages/town/              an FJS app, the basecamp shape: db/ api/ web/ tests/
  db/schema.lite           Member · Room · Message
  api/                     services, presence per room, rate limit on, the mods
  web/src/routes/          the village and the tavern, compiled for the terminal
fli town                 runs that web/ in this terminal against the hosted API,
                           the way fli dev:tui runs an app's own against localhost
```

**Member** is a nick and a public key, claimed once per machine. **Room** is a
scene — the square, the tavern, a door per topic — and each is one Junction
channel, so presence per room is `presence.ts` with nothing added. **Message** is
a row: the bubble is the newest one per member, the tavern's history pane is the
rest, and the audit trail comes free. A move is a raw channel frame, never a row.

**Identity without a browser.** First run writes a keypair under `~/.fli/`.
`fli town` signs a login with `signRequest()` (`toolbelt/src/signature/`), the
server verifies it and mints a session through `bearerClaim(...).mint()`
(`FJS-D819`), and the WebSocket carries that token. A principal resolver that
reads the signature is the one new seam, and it is a `principal` list element
(`FJS-D522`). GitHub sign-in is a later door, not a first one: it needs a
device flow the auth package does not have, and a nick behind a key is enough to
be the same person tomorrow.

**Strangers.** A public CLI is a spam bot within the hour. Rate limit middleware
on from the first deploy, `Message` at the signed-in level, a `banned` row
policy on `Member` so a ban is a gate and not a hook (Invariant 6), and a mod
standing that can set it. Nothing here is a new mechanism.

**Version skew.** Fifty clients on ten `fli` versions against one server. The
client sends `x-fjs-build`, the server refuses one it no longer speaks to by
name, and the frame shapes are the only contract — which is the argument for
making the client a `web/` surface the server's own package ships rather than
code inside `fli`: the two version together.

## The nine

Answered before the first edit, 2026-10-13.

1. **Origin.** Presence, rooms, grading, the session, the rate limit are read
   from Junction and auth; the client is the app's own `web/` compiled by the
   lowering `fli dev:tui` already runs. The one thing written twice would be the
   frame shapes, in the client and the server, and both sit in one package.
2. **Concept.** One new noun, the town. Room is `channel` wearing a scene; Member
   is `User` with a key; a bubble is a Message. No noun for "online" — that is
   presence. The word itself is Q1.
3. **Complexity.** The problem's: a stranger on a public endpoint needs identity,
   moderation and a version floor, and every chat system has those three. The
   complexity the design would add is a second client runtime inside `fli`, and
   the shape above avoids it.
4. **Predictability.** The town is an app, laid out like every app (Invariant 3),
   deployed like `basecamp`, run in a terminal like any `web/`. Knowing one FJS
   app teaches this one.
5. **Derived.** The client is derived from `web/` by the terminal target; the
   presence list is derived from channel membership; the bubble is derived from
   the newest Message. The hand-maintained part is the art.
6. **Owner.** Presence: `transport/presence.ts`. Session minting:
   `bearerClaim`. Signing: `toolbelt/signature`. Terminal lowering:
   `runtime-terminal.js`. The town adds owners only for its own models. The
   signature principal is a new element of an existing list, not a second
   resolver.
7. **Boundary.** The frame shapes, typed in the package and sent through
   `wsSend()`; a build the server refuses is refused by name. The client needs
   to know nothing about how a room grades.
8. **Failure.** A dropped frame is a figure one cell behind, and a reconnect is a
   gap the client already refetches (`FJS-701`). A failed login is a refusal with
   the reason. A ban is an empty room, which is what a gate does.
9. **Silence.** What must stay true: two clients in one room see each other's
   moves and bubbles, and a banned member sees nothing. What fails: a
   `@frontierjs/testing` test mounting two clients over one app, and a terminal
   drive on the headless renderer with two mounted village routes. Until Phase 1
   lands both: `none`.

**Adjudications.** *Batteries vs. smallness*: the town is an app, severable from
`fli` by being its own package; `fli town` is a thin door. *Familiarity vs.
precision*: the ecosystem word for a federated chat protocol is Matrix, and
`fli matrix` would read as joining one — Q1. No other row is in tension.

**Tier.** Assessment. Q1–Q4 are ruled: `FJS-D976` the noun, `FJS-D977` the
package, `FJS-D978` placement by attach, `FJS-D979` the opaque treatment.

## Plan

### Phase 0 — Groundwork

Goal: the name, the package shape and the two lowerings decided; the probe kept.
Done when: the opaque treatment is lowered and the probe is a spec in
`test/terminal/specs/`.

- [x] 0.1 Probe sprites on the headless renderer — § What the probe found.
- [x] 0.2 Rule Q1–Q4 — `FJS-D976` to `FJS-D979`.
- [x] 0.3 Lower the opaque treatment (`FJS-D979`) in `runtime-terminal.js`, with
  the probe rewritten as its spec: a figure placed by attach over `<pre>` art, moved
  by arrows, and a bubble that hides the art under it.

### Phase 1 — The app

Goal: two Junction clients in one room see each other.
Done when: a `@frontierjs/testing` test joins two clients, moves one, says one
line, and the other receives both; a third, banned, receives nothing.

- [ ] 1.1 `db/schema.lite` — Member, Room, Message, gates and the `banned` policy.
- [ ] 1.2 Services, a channel per room, `move` and `say` frames, rate limit on.
- [ ] 1.3 The signature principal and the minted session.

### Phase 2 — The village

Goal: the village walkable in a terminal against a local API.
Done when: a terminal drive mounts the village route twice over one app and the
second frame shows the first client's figure where it walked.

- [ ] 2.1 The village route — art, figures, bubbles, the input line.
- [ ] 2.2 Doors — a second scene and the room change behind it.
- [ ] 2.3 `fli town` — the door, the keypair, `--api` for a private server.

### Phase 3 — Strangers

Goal: a fresh machine joins the hosted town.
Done when: `bunx fli town` on a machine that has never seen this repo shows
a figure that a second machine can see.

- [ ] 3.1 Deploy through outpost, the domain, the build floor the server refuses.
- [ ] 3.2 The mod standing, a ban exercised end to end.
- [ ] 3.3 The history pane in the tavern, and what `forgetting.md` says about retention.

## Open questions

- ~~**Q1 — The noun.**~~ **Answered 2026-10-14 (`FJS-D976`): B — `town`, which is what the screen draws and gives the rooms their words: square, tavern, door.**
  - **A** — `matrix`, the name it was asked for.
  - **B** — `town`, which is what the screen draws and gives the rooms their
    words: square, tavern, door.
  - **Recommend B** — Matrix is the ecosystem's federated chat protocol and
    `fli matrix` reads as a client for it, which is *familiarity vs. precision*
    resolved the way § IV resolves it.
- ~~**Q2 — Where the client lives.**~~ **Answered 2026-10-14 (`FJS-D977`): B — a package that is an FJS app, `web/` and all, and `fli town` runs its `web/` the way `fli dev:tui` runs an app's own, against a hosted `--api`.**
  - **A** — inside `packages/cli`, which then gains mesa, OpenTUI and the
    Junction client as optional peers.
  - **B** — a package that is an FJS app, `web/` and all, and `fli town` runs
    its `web/` the way `fli dev:tui` runs an app's own, against a hosted `--api`.
  - **Recommend B** — the cli declares no framework package today and `dev:tui`
    already resolves the runtime from the app it runs; B keeps that and versions
    the client with its server.
- ~~**Q3 — Placing a figure on a cell.**~~ **Answered 2026-10-14 (`FJS-D978`): A — leave it to the app: an attach helper in the town's `web/`.** The probe placed it through `{@attach}`
  writing the engine's own fields.
  - **A** — leave it to the app: an attach helper in the town's `web/`.
  - **B** — lower `style:position|left|top` in `runtime-terminal.js`, which
    `specs/style.spec.mjs` currently pins as inert.
  - **Recommend A** — placement by cell is a thing only a game wants, and an
    attach is the escape hatch for exactly that.
- ~~**Q4 — A box that hides what is under it.**~~ **Answered 2026-10-14 (`FJS-D979`): B — one opaque treatment lowered in `runtime-terminal.js`, so no color is written in a `.mesa`.** The probe made the bubble opaque
  with a background color written in the `.mesa`.
  - **A** — leave it to the app, the same attach helper as Q3.
  - **B** — one opaque treatment lowered in `runtime-terminal.js`, so no color
    is written in a `.mesa`.
  - **Recommend B** — every dialog and dropdown on a terminal needs it, and a
    color in a `.mesa` is Invariant 13's failure.
