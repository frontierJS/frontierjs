---
id: anchored-feedback
status: proposed
dated: 2026-10-04
---

# Idea — anchored feedback: pins and threads on a site-kit preview

**Status: PROPOSED. Nothing is built.** Do not cite this file as describing
behavior — see `VERIFYING.md`.

`on-page-editing.md` surveys the tools people praise and marks one lesson a
**gap**: *feedback anchored to an element* (BugHerd, Marker.io, Vercel
comments). That file is the developer's half — the dev server, a pick, a
Claude run. This one is the other half: a client or a teammate, on a preview
of the site, drops a pin on an element and talks about it in a thread, and a
developer turns that pin into a change without retyping it.

## The prior art in this tree: Pinmark

ksite carries a working answer, `site/src/components/Annotations.svelte`
("Pinmark", 2589 lines, its Vite plugin commented out in
`site/config/vite.config.ts`). It is the measurement that the road lacks this
(*paved road vs. the workaround*), and its defects are the requirements list.
Port the idea, not the code — site-kit is Mesa, so it is a rewrite either way.

| Pinmark does | What breaks | So this design |
| --- | --- | --- |
| localStorage is the source of truth; an optional worker gets the WHOLE session POSTed on every change, keystrokes and pointermoves included | two reviewers overwrite each other; a reload from the worker drops unsynced local work | one store, one row per write — a comment is an insert, a resolve is an update |
| the worker's write key is in `window.__pinmark_config` | the key is public, so anyone can write | access is a gate in the schema (Invariant 6) |
| identity is a typed name; "own comment" is `author === name` | anyone typing a name deletes that person's comments | the author is a principal, never a string |
| a pin is `xPct` of a fixed 1440/390 width plus `pageY` | pins drift on any other window width or any content change above them | a pin is anchored to an ELEMENT, with an offset inside its box |
| pins are renumbered in place on delete | "see #3" in a thread now names another pin | the number is derived from creation order and never rewritten |
| edit mode sets `textContent` on `p, li, span…` and keeps it in localStorage | flattens child markup; reaches no one and no source file | **cut** — the ask panel's direct text edit writes the source |
| share = the whole session base64'd into a query param | URL length; a fork, not a shared thread | share = a link to the review |
| a "session" per page path | collides with auth's `Session`; a review of a site spans pages | one **review** per round, across routes |

**Kept from Pinmark:** the viewport a pin was placed on (mobile/desktop), the
*abandoned* state when its element is gone, a permalink to one pin, a
read-and-reply-only link, and open/done per pin.

## The shape

**Three nouns, one of them already here.** A **pick** exists
(`inspect-client.js` `pick()` → `{ el, loc, … }`). A **pin** is a pick that
was saved with a thread. A **review** is the round the pins belong to. A
comment is a comment. No reactions, no presence cursors, no edit mode — each
is a later row if a review asks for it.

| Piece | Shape | Owner |
| --- | --- | --- |
| Anchor | route · `data-fjs-loc` · offset as a fraction of the element's box · a quoted run of its text · viewport · build id (`x-fjs-build`) | the pick, from `pick()` — never a second picker |
| Store | `Review`, `Pin`, `Comment` as `.lite` models, each `@@gate`d on review membership | a schema fragment + plugin pair, the shape `auth` already is |
| Identity | an invite link that establishes a session for one review; a teammate signs in normally | `auth` — a route establishes a session (`FJS-D20`), the rest is services |
| Client | a panel injected into a PREVIEW build only, the way mesa-vite injects the inspect client into dev | site-kit's build |
| Live | a channel per review; polling is the first cut | junction channels |
| Handoff | in dev, the ask panel lists a route's open pins; one click makes the pin's anchor a pick and its thread the instruction | `vite-ask.js` — the same run, ledger and Undo |

**Placing a pin on reload:** find the element by `loc`; where several share
it (a list item), narrow by the quoted text; then apply the offset. Nothing
found → the pin is listed as *unanchored* in the panel with its quote, never
placed at a guessed position. A build id that differs from the pin's marks it
*may have moved*.

## V1 — no store: the browser holds it, a link carries it

**The table above is V2.** V1 ships the anchor, the panel and the handoff with no
server at all, so a static preview needs nothing deployed beside it.

| Piece | V1 shape |
| --- | --- |
| Store | the reviewer's `localStorage`, one key per preview origin, holding the review's pins and comments |
| Share | **Copy link** writes `#fjs-review=` + base64url of the review, deflate-raw'd by the browser's own `CompressionStream`. A hash, so the payload never reaches a server or its log |
| Open | the panel reads the hash, merges the review into its own `localStorage`, and strips the hash with `history.replaceState` |
| Merge | pins and comments carry a `crypto.randomUUID()` id and merge as a union by id. A comment is never edited. A pin's status carries the time it was set, and the later one wins. A delete is a tombstone, so a merge does not bring it back |
| Identity | a typed name, kept in `localStorage`. It is a label and grants nothing, because nothing is written anywhere but the reader's own browser |

**This is Pinmark's share, which the table above lists as a defect, taken on
purpose.** What makes it tolerable here is the merge: a link is a transfer
between two copies rather than an overwrite, so a review can go client →
developer → client and both sides' replies survive.

**The limits, stated:**

- **A link is a snapshot.** Two reviewers working at once see each other only when
  links cross; nothing is live.
- **Length.** Fifty pins with their threads compress to a few kilobytes, which a
  browser takes easily and a chat or mail client may wrap or cut. The panel shows
  the link's size and warns past 8 KB.
- **No screenshots** in the link — V2's.
- **Anyone with the link reads the review**, which is the reach the preview link
  already has.
- **Clearing site data loses what was never shared.**

**V2 imports V1.** The anchor and the ids are the same, so the store's first
feature is uploading a browser's review once.

## Open questions

1. ~~**A preview build has no `data-fjs-loc`.**~~ **Answered 2026-10-09 (`FJS-D838`): A — a preview build stamps `data-fjs-loc`, behind a named `site-kit build --preview` mode that production cannot reach by default.** `mesa-vite` stamps it in dev only
   (`README.md`: "A production build stamps nothing"). Either a preview build
   turns stamping on — it leaks source paths to whoever has the link, which a
   preview may accept and production must not — or the anchor stores a
   selector + quote and the dev server maps it to a `loc` at handoff. **Recommend
   the stamp**: the handoff is the payoff, and a selector is the thing Pinmark
   shows drifting. This needs `site-kit build --preview` to be a named mode, so
   production cannot get it by accident.
   - **A** — a preview build stamps `data-fjs-loc`, behind a named
     `site-kit build --preview` mode that production cannot reach by default.
   - **B** — the anchor stores a selector and a quote, and the dev server maps
     it to a `loc` at handoff.
   - **Recommend A** — the handoff is the payoff, and a selector is the anchor
     Pinmark shows drifting. Leaking source paths is acceptable on a link handed
     to a reviewer and not in production, which is what the named mode and a
     `dist/` check for an absent panel are for.
2. ~~**Where the store runs.**~~ **Answered 2026-10-09 (`FJS-D839`): C — no store in V1: the reviewer's `localStorage` and a share link, as § *V1* lays out; A or B is chosen in V2.** A site-kit site is static.
   - **A** — one hosted FJS app serving every site's reviews (Kobami runs one).
   - **B** — Basecamp as the store, a pin becomes a to-do in the client's
     project; it is where Kobami's client feedback already goes and where
     `daily-check` reads, but it needs a server proxy and puts site-kit behind a
     vendor.
   - **C** — no store in V1: the reviewer's `localStorage` and a share link, as
     § *V1* lays out; A or B is chosen in V2.
   - **Recommend A** — with a notification sink: the plugin announces a new pin
     or comment through `app.notify`, and Kobami's host adds a Basecamp channel.
     The sink carries a link, never a copy of the pin's state, so there stays one
     origin.
3. **Cross-origin.** *Waits on V2 — V1 has no store, so nothing crosses an origin.* The preview is on one origin and the store on another, so
   the client is Bearer over CORS. `FJS-1090` (no owner says which origins an
   API must allow) is open and this is one more caller of it; `FJS-788`
   (`sierraFetch` sent the Bearer to any absolute URL) is the closed trap to
   re-read before choosing the token's home.
   - **A** — Bearer over CORS with an explicit `cors.origins` list of every
     preview origin.
   - **B** — Bearer over CORS with `origins: ['*']`, the token scoped to one
     review by its invite link, and the client attaching it only to the store's
     configured origin.
   - **C** — same origin: the store serves each preview build under its own
     origin, so the session is a cookie and there is no CORS.
   - **Recommend B** — with no ambient credential a wildcard origin grants
     nothing, which is how `example` already runs, so `FJS-1090` does not block
     it. The token's reach is one review, and sending it only to the store's
     origin is the lesson of `FJS-788`. A is a list per site that drifts as
     previews are added, and C moves preview hosting into the store for a
     problem B does not have.

## The plan

Ranked by love per unit of work, as in `on-page-editing.md`. Each step adds its
own case to a `verify:review` drive before it is called done.

1. **Pins, threads, resolve — V1.** The preview-build panel over `localStorage`,
   and the share link. Drive: two browser profiles — one pins a heading and
   copies a link, the other opens it, replies and links back, and the first
   sees both comments; insert a paragraph above the heading, rebuild, reload;
   the pin is on the same heading.
2. **The handoff.** Open pins in the ask panel; a pin becomes a pick and an
   instruction. Drive: a pin's run changes the pinned element's source line.
3. **V2: the store, live and the sink.** The schema fragment and plugin, with a
   one-time upload of a browser's review; a channel per review; `app.notify`
   on a new pin.
4. **Screenshots.** `on-page-editing.md` step 4 owns the capture question; a pin
   takes whatever it lands on rather than a second capture path.

## The nine (`decision-rules`, answered before any edit)

1. **Origin** — one: the store. Basecamp gets a link through the sink, not a
   copy; a pin's *done* is a person's statement, stored once, not derived from a
   commit.
2. **Concept** — two nouns, *pin* and *review*; *pick* exists. Pinmark's
   *session* is not carried over, because auth owns that word.
3. **Complexity** — the problem's: every tool in the survey has pin + thread +
   resolve, and each anchors to an element with a fallback.
4. **Predictability** — the panel follows the inspect client's rule: injected
   in one named mode, absent from a production build.
5. **Derived** — the source location from `data-fjs-loc`, the pin number from
   creation order, *abandoned* and *may have moved* at render. Stored: anchor,
   text, status, author.
6. **Owner** — picking is `pick()`, a change is a `vite-ask.js` run, identity is
   `auth`, a notification is `app.notify`. The one new owner is the store, and
   it is a severable battery (*batteries vs. smallness*): site-kit's core never
   imports it; the preview mode is its one seam.
7. **Boundary** — the store's three models are gated in the schema; the client
   is an ordinary junction client; the handoff passes a pick, the shape the ask
   route already takes.
8. **Failure** — an anchor that does not resolve lists the pin as unanchored
   rather than placing it; a write without membership is refused by the gate.
9. **Silence** — *stays true:* a pin points at the element it was placed on,
   and a production build carries no review client. *What fails:* the step-1
   drive case for the first; for the second, `none` until a build check asserts
   `dist/` has no panel — owed with step 1.

**V1 against the nine** — the rows it changes. **Origin** fails: each browser
holds a copy, reconciled only when a link is opened, and that is the ruling's
reason to exist. **Owner** — none new; the share is the panel's. **Failure** — a
link past 8 KB warns rather than refuses, because a long link usually still opens.
**Silence** — *stays true:* a merge loses no comment. *What fails:* the step-1
round-trip drive case. *Batteries vs. smallness* decides it: V1 is the small
core, and the store is the battery V2 adds.

Adjudications: *paved road vs. the workaround* (Pinmark is the workaround,
measured), *batteries vs. smallness* (the store). Tier: Assessment (`IDEAS/`).
