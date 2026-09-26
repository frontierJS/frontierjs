---
id: api-ontology
status: proposed
dated: 2026-09-25
---

# Idea — the API realm's primitives: the words Junction spells and no register defines

**Status: IDEA, and done. Call, Envelope, Directive and Route are blessed (`FJS-D391`), and the four questions are answered (`FJS-D392`–`FJS-D395`) and built: `ctx.caller`, the `log-listening` startup phase, Battery and Create excluded as ordinary English, Phase blessed and qualified.** Dated 2026-09-25. Counts were read off the tree that day with a path named. Do not cite this file as describing behavior — see `VERIFYING.md`.

It is `ui-ontology.md` asked of the API realm, and the answer is shorter. The
realm's big nouns were ruled early — Service, Hook and its three tiers, Plugin,
Channel, Event, Transport, Method, Context (`FJS-D02`, `FJS-D03`, `FJS-D06`,
`FJS-D44`) — so what is missing is not a tree. It is the words the code uses
every day with no row in `VOCABULARY.md` and no line in `ARCHITECT.md` § 2.

## 1. How the gap was found

`VOCABULARY.md`'s API rows were read against `packages/junction/CLAUDE.md`,
its `src/core/`, and the Bridge index in the root `CLAUDE.md`. A word counts as
a gap when the code names a thing with it in more than one place and no
register says what it is. Eight did. Four were already spelled one way
everywhere, and were blessed. Four spend one word on two or more things, and
are the questions.

## 2. Blessed — the code already agreed (`FJS-D391`)

| Word | What it names | Where the code spells it |
| --- | --- | --- |
| **Call** | one run of a service method through the pipeline | `$`, `enterCall`, `currentCall`, `CALL_OPTIONS_AT` — `junction/src/core/context.ts` |
| **Envelope** | the result shape `{ kind, object, data, errors, total?, limit?, offset? }` | `junction/src/core/envelope.ts`, which opens by naming the twelve places that each took it apart |
| **Directive** | `limit`, `offset`, `orderBy`, `select` — about the answer, not a filter on it | `ctx.directives`, `@frontierjs/toolbelt/directives`, Invariant 10 |
| **Route** | an HTTP handler outside the pipeline — no hooks, no gate, no Envelope | `app.get`/`app.post` (`junction/src/core/app.ts`), `FJS-D20` |

**A Call is not a Request.** One request can make several Calls, and a Job
makes one with no request at all, which is why `$` is the Call. That settles the
open `ServiceContext` row: it is the Call's Context, and an alias of Context
rather than a term.

## 3. What was found while measuring

- **`ctx.client` is a third sense of *client*.** Junction's browser client is
  `createJunctionClient`; Litestone's database client is what `$.db` is and what
  `FJS-644` means by *the caller's own client*; and `ctx.client` is the caller's
  ip, user-agent and headers (`junction/src/core/context.ts:89`), read in 14
  places across `packages/`.
- **`announce` is spent twice inside Junction.** The write announcement is the
  Event a mutation publishes (Invariant 4, `callService`), and the last startup
  phase is also named `announce` — the listening banner
  (`junction/src/core/app.ts`, phase list). *Mutation* appears in 239 lines of
  markdown and in no Junction identifier.
- **A refused word is a phase name.** § 2 refuses *middleware* for Hook and
  Plugin, and the startup list carries `config-middleware`, while a Route takes
  an `mw` argument. It is Hono-style HTTP middleware on a Route, which is
  neither a Hook nor a Plugin, so the refusal may be over-broad rather than the
  code wrong. Not asked below; worth a question of its own if the answers here
  hold.
- **`GatePlugin` was filed under API.** It is litestone's export. The row is
  retagged Data.

## Open questions

- ~~**What does `ctx.client` become?**~~ **Answered 2026-09-25 (`FJS-D392`): A — `ctx.caller`. The field's own comment already says *caller environment*, and it reads as `ctx.caller.ip`.** *Client* names the browser client and
  Litestone's database client, and both are spelled that way in API names.
  `ctx.client` is the third, and the only one that is not a client at all — it
  is facts about whoever is on the other end.
  - **A** — `ctx.caller`. The field's own comment already says *caller
    environment*, and it reads as `ctx.caller.ip`
  - **B** — `ctx.peer`. The network word: exact for the ip, loose for the
    headers
  - **C** — keep `ctx.client`, and qualify *client* in prose every time
  - **Recommend A** — the comment already chose the word, and a rename touches
    14 sites and no persisted value. `ctx.user` stays the principal, so
    *caller* names the machine end and not the person
- ~~**Is there a noun for a write's announcement?**~~ **Answered 2026-09-25 (`FJS-D393`): A — *announce* is the verb for publishing an Event after a write, and Event is the only noun. *Announcement* and *Mutation* are not terms — *a write* is the plain phrase. The startup phase is renamed `log-listening`.** § 2 calls an Event
  *Junction's announcement*, Invariant 4 says one owner *announces a mutation*,
  and the startup list has a phase named `announce` that prints a banner.
  - **A** — *announce* is the verb for publishing an Event after a write, and
    Event is the only noun. *Announcement* and *Mutation* are not terms — *a
    write* is the plain phrase. The startup phase is renamed `log-listening`
  - **B** — *Announcement* is blessed as the kind of Event a write publishes,
    under Event
  - **Recommend A** — a second noun for one Event is the thing § 2 exists to
    stop, and the phase rename frees the verb for its one sense
- ~~**Is *Battery* a term?**~~ **Answered 2026-09-25 (`FJS-D394`): A — ordinary English, excluded in `packages/cli/core/terms.js`. The unit is Plugin, and *batteries included* stays a phrase.** 33 lines in `DECISIONS.md` and 22 in `ISSUES.md` use
  it in two senses: a built-in capability (mail, cache, scheduler) and a
  ready-made Plugin (`membershipClaim()`, `bearerClaim()`).
  - **A** — ordinary English, excluded in `packages/cli/core/terms.js`. The unit
    is Plugin, and *batteries included* stays a phrase
  - **B** — blessed as *a Plugin Junction ships*, under Plugin
  - **Recommend A** — nothing checks what makes a Plugin a battery, and a
    Plugin already answers *what attaches a capability* (`FJS-D06`)
- ~~**What is a Phase?**~~ **Answered 2026-09-25 (`FJS-D395`): A — blessed and qualified at every use, the way Boundary is (`FJS-D06`): *a named step of an ordered list something runs*. *Startup phase* and *CI phase*, never bare.** The open `Phase` row covers two things: Junction's
  startup phases (one ordered, named list both entry points run — Invariant 4)
  and CI's thirteen phases (`scripts/ci.mjs`). Plugin's `register`/`boot`/
  `ready`/`shutdown` are not phases; `boot-plugins` and `ready-hooks` are the
  phases that call them.
  - **A** — blessed and qualified at every use, the way Boundary is (`FJS-D06`):
    *a named step of an ordered list something runs*. *Startup phase* and *CI
    phase*, never bare
  - **B** — ordinary English, excluded in `terms.js`
  - **Recommend A** — both lists are owners that tests and docs name by phase,
    and the Boundary precedent already rules the shape for a word that is right
    in two places

## Housekeeping

`WebSocket` and `Create` are open rows that are not terms — a technology and a
CRUD verb. Each is an exclusion in `packages/cli/core/terms.js` rather than a
ruling, and is taken with whichever answer lands first.
