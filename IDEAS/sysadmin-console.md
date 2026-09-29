---
id: sysadmin-console
status: proposed
dated: 2026-09-24
---

# Idea — The sysadmin console: one screen for the people who run the app

**Status: PROPOSED. Nothing in § *What is missing* is built.** Dated 2026-09-24. Do
not cite this file as behavior — see `VERIFYING.md`. The pieces § *What exists*
names were read off the tree on that date.

---

## Trigger

`my.maid.tech`'s `web/src/routes/system/index.svelte` — a hundred lines, gated on
`isSuperAdmin`, and the screen its operators open every day. It does four things:

| On the screen | How the legacy app does it |
| --- | --- |
| **How many people are connected, and who** | `stats.get('connections')` → `app.io.fetchSockets()`, a count and a user list with the account beside each |
| **Imitate** one of them | `toggleImitation(currentUser, accountId)` from the connection row |
| **A message every signed-in user sees** | a `Message` row of `type: 'system-wide'`; the layout reads `body` and a `system:` prefix changes the toast's tone, and `system:reload` reloads every tab |
| **Reports** | 72 stored rows, 62 of them hand-written SQL, run against the unscoped client — the `@system/*` catalog `tenant-authored-queries.md` already read |

Every SaaS application grows this screen, and grows it by hand. An operator who has
it in Laravel (Nova, Filament) or Django (`/admin`) and does not have it here reads
the absence as *not production-ready* — this is a `stakes` item, not a
differentiator. What is FJS's own is that every row on it is already graded at a
declared standing, so the console is a set of ordinary gated services rather than a
god-mode switch.

---

## What exists

**Most of the screen, scattered across four packages.**

| Need | Already here | What it lacks |
| --- | --- | --- |
| Who may open the screen | `LEVELS.SYSADMIN = 7` in `@frontierjs/toolbelt/gate`, reached through `isSystemAdmin` | nothing — the standing exists and the schema can name it |
| Connections | junction's devtools console keeps a live map off the channel manager's `connection`/`disconnect` events (`plugins/devtools/index.ts`) | it is a DEV tool, bound to loopback with `auth` required off it (`FJS-691`), and the map is the devtools plugin's private copy rather than something the channel manager answers |
| Imitate | **support mode is shipped** (`support-mode.md`): bounded by the subject's standing, audited with the operator as actor, five credential operations refused inside an episode, proved by `verify:support` | an entry point from a connection row |
| `system:reload` | `x-fjs-build` + the `connected` frame's `build` → `client.stale` (`FJS-D160`) — the server states its build, the client compares, and a deploy's reconnect is when a stale tab finds out | nothing. A reload broadcast is a second mechanism for a question `client.stale` already answers, and the legacy one fires whether or not a build changed |
| CRUD over every model | `fli admin:generate` — gate-aware routes derived from the schema | nothing; the console links to it rather than restating it |
| Reports | raw SQL is `asSystem()`-only (`FJS-005`); `tenant-authored-queries.md` found the `@system/*` rows are *a fixed catalog wearing a table's clothes* | a noun, a place for the catalog to live, and a screen |

---

## What is missing

Three things, and a fourth that is only a button.

### 1. A message every user sees

A model the host imports, a service over it, and a component the layout mounts.

```
model Notice {
  id          Int       @id
  body        String
  tone        String    // a @frontierjs/css tone: info · warning · danger
  startsAt    DateTime  @default(now())
  endsAt      DateTime?
  dismissible Boolean   @default(true)
  authorId    Int
  author      User      @relation(fields: [authorId], references: [id])
  @@gate("1.7.7.7")     // VISITOR reads; SYSADMIN creates, updates, deletes
}
```

The banner is live for free: a write through the service already announces, and a
client holding the `notices` list receives the row. **`tone` is a column rather than
a prefix on `body`** — the legacy `system:` spelling was a type field nobody could
index, validate or grade, and a tone is how `@frontierjs/css` styles anything
(Invariant 13). Dismissal is per browser and never a row: the question *has this
person seen it* costs a write per user per notice and nobody has asked it.

### 2. Connections, owned by the channel manager

**The owner is junction's channel manager and not a new tracker beside it.** It
already emits `connection` and `disconnect`; it should answer
`app.channels.connections()` — id, user, tenant, connected-at — and the devtools
console should read that rather than keeping its own map. A `connections` service at
level 7 is then one read.

**It is per PROCESS.** The legacy answer was fleet-wide because socket.io's adapter
made it so. Two API instances here answer two lists, and the service says which
instance it is rather than presenting a half as the whole. The fleet-wide answer is
basecamp's to give, since basecamp is the thing that knows how many instances exist.

### 3. Reports as files

**A report is a file that names it, the way a job and a notification already are.**
`<name>.report.ts` declares typed parameters and a read; the loader stamps the name;
`app.reports` answers *what can this app report* with nothing run; a `reports`
service at level 7 runs one by name through `asSystem()`.

This is what `tenant-authored-queries.md`'s first question answers for the
`@system/*` catalog: a catalog that ships with the application is code, reviewed and
diffed, and it is never a row somebody can edit at runtime. It holds `FJS-005` and
Invariant 8 without restating either — the SQL is in the repository, and no caller's
text reaches it. **An operator-authored report is not this feature** and stays that
paper's open question.

### 4. Imitate

A button on the connection row that starts a support episode through
`/auth/support/*`. Nothing new under it.

---

## The shape

**Orion's install, because it is the same kind of thing** — a package with a model,
services and screens of its own, severable from the core:

- `db/sysadmin.lite`, imported by the host's schema, holds `Notice`.
- `sysadmin()` installs into a junction app: the `notices`, `connections` and
  `reports` services, and the `*.report.ts` loader.
- Its screens are `.mesa` routes the host mounts at `/system/` by one file
  (`FJS-D282`), plus a `<Notices>` banner the host's layout places.

**What proves it** is a drive in `example/`: a sysadmin posts a notice and a second
browser, signed in as someone else, shows it without a reload; the connection list
names that second browser's user; *Imitate* from that row starts an episode
`verify:support` already knows how to grade; a report runs and a level-5 caller is
refused by name.

---

## The nine questions

1. **Origin.** One per fact: the notice is a row, the report catalog is the file
   tree, a connection is the channel manager's. The devtools map is the one second
   origin in sight, and item 2 removes it.
2. **Concept.** Two new nouns, `Notice` and `Report`. *Report* is already on
   `machinery-models.md`'s list of machinery every app hand-writes, so it is a noun
   the framework owes rather than one it invents. *Notice* is new — see the first
   open question.
3. **Complexity.** The problem's. Every piece but the report loader is a service
   over something shipped.
4. **Predictability.** `.report.ts` follows `.job.ts` and `.notification.ts`: the
   file names it. A notice is a model like any other, graded like any other.
5. **Derived.** The report catalog derives from the tree, the banner from the
   service's announcements, the reload from `client.stale`. Nothing is restated.
6. **Owner.** Connections go INTO the channel manager, not beside it. Raw SQL stays
   behind `asSystem()`, whose owner is litestone. Impersonation is auth's.
7. **Boundary.** Every read and write is a service call at a declared gate, so
   `x-gate` on the console is an affordance and the server enforces regardless
   (Invariant 6).
8. **Failure.** A caller below 7 is refused by name. A report parameter that does
   not validate is refused before the SQL runs. A notice with a tone
   `@frontierjs/css` does not name is refused at write, since the alternative is a
   banner that renders unstyled on every screen at once.
9. **Silence.** *A report reaching the unscoped client is only reachable at 7* —
   fails when the drive's level-5 refusal stops being a refusal.
   *`connections()` agrees with what devtools shows* — `none` until devtools
   reads it, after which there is one list and nothing to disagree.

**Adjudication:** *batteries vs. smallness* — the console is a battery, owned and
severable, which is why it is its own package with orion's install rather than
growth inside junction or auth. *Familiarity vs. precision* for the legacy
`system:` prefix: the shape is kept (a message with a tone), the magic string is not.

**Tier:** Assessment until built. What survives the build is a package `CLAUDE.md`
(Map), and the report-file convention is a ruling (Register), because it fixes how
every app's catalog is spelled.

---

## Open questions

- ~~**What is the message called?**~~ **Answered 2026-09-28 (`FJS-D534`): A — `Notice`: free in the tree, and says what it is without a medium.** *Announcement* is the obvious word and it is
  taken: an Event is junction's announcement of a mutation (`ARCHITECT.md` §2,
  Invariant 4), so `Announcement` as a model puts two meanings on one word in the
  API realm. *Broadcast* is taken the same way, by a channel.
  - **A** — `Notice`: free in the tree, and says what it is without a medium.
  - **B** — `Bulletin`: also free, reads more like a board than a banner.
  - **Recommend A** — shorter, and the banner component reads naturally as
    `<Notices>`.
- ~~**Its own package, or part of auth?**~~ **Answered 2026-09-28 (`FJS-D535`): B — fold into `@frontierjs/auth` as a second plugin.** Auth already owns the level-7 standing and
  support mode.
  - **A** — `@frontierjs/sysadmin`, orion-shaped, depending on auth.
  - **B** — fold into `@frontierjs/auth` as a second plugin.
  - **Recommend A** — the console carries a model, a loader and screens, none of
    which an app that only wants sign-in should install; *batteries vs. smallness*
    says severable.
- **Is a report tenant-aware?** Under `strategy database` a sysadmin report is
  usually a question ACROSS tenants, which is basecamp's `/hub/` tier and
  `asSystem()` over the registry. Whether a `.report.ts` states `tenant: 'each' |
  'one'` or the service decides is unsettled.
- **Is the console's first caller maid.tech or example?** maid.tech has the real
  catalog to port; example has the drives.
