---
id: stressor-coverage
status: assessment
dated: 2026-10-31
---

# Assessment — stressor coverage: what the list has not reached, and two shapes it lacks

**Status: ASSESSMENT.** Dated 2026-10-31. A reading of `IDEAS/stressors.md`
against `fjs-prototypes/`, asking which seams no stressor has yet pressed, plus
two product shapes the list does not have. Nothing here is committed to. The
depth figures are a snapshot taken from each prototype's `PLAN.md` status line,
its commit count and its `.mesa` file count; re-probe before planning from them
(`VERIFYING.md`). The "zero hits" claims are `rg -i` over every `*.md` in this
repo except `ISSUES_ARCHIVE.md`, and hold only as far as that reaches.

**A fresh scaffold carries 12 `.mesa` files**, so a prototype at 12–14 has no UI
of its own yet.

---

## Coverage

### Never started — Phase 2, #29–41

No folder in `fjs-prototypes/`. Four of the seams still have zero hits anywhere
in the docs: *break-the-glass*, *four-eyes*, a minimum-group gate, and *device
principal*.

| # | Product | Seam nothing here has pressed |
| --- | --- | --- |
| 31 | Clinical record | a READ as the audited event; a gate with an override path; data residency |
| 33 | Pulse survey | a gate on a count, not a row; no differencing two filters to one answer |
| 32 | Expense approvals | four-eyes: the approver may not be whoever moved the row last |
| 35 | E-signature | a tamper-evident trail, which `logbook.md` names and nothing builds |
| 29 | Developer API | an API pinned per caller while the schema moves; signed webhooks to a URL a tenant typed |
| 30 | Pretix | a hold the clock releases; 5,000 writers for 500 seats on one SQLite writer |
| 38 | Kahoot | 300 sockets in a two-second burst; the cohort broadcast never driven at that size |
| 39 | Device telemetry | a machine as a principal with a rotating, revocable key; a command delivered once to an offline device |
| 34 | Offline till | an invariant broken on purpose by an offline merge, and the sale still accepted |
| 40 | Newsletter | a forgotten address that must stay unsendable, so erasure keeps a hash |

**Two Phase 2 rows have been partly overtaken since the 2026-10-09 scan.** #36's
"push has no transport" is stale: `web-push.md` and `phone-ping.md` built it, the
terminal surface has thirty slices (`mesa-ir`), and the Lynx spike started a
native backend. A product carried by four surfaces is still untried. #37's
extension surface now carries Intake (#43); an anchor re-found on a page someone
else owns is still untried.

**#31, #33 and #32 are one argument.** Invariant 6 declares access per row. These
need a gate on a read with a reason, a gate on an aggregate, and a gate on who
acted last. Run them as one batch, and expect one design record.

### Schema and API only — stopped 2026-10-16

One commit each, no UI past the scaffold. Each `PLAN.md` says "Phase 2 done —
Phase 3 next" except immich, which is at Phase 2.

| # | Prototype | What its UI and later phases would press |
| --- | --- | --- |
| 17 | immich | a 4 GB upload streamed; `FJS-D1159` ruled the shape, so Phase 2 is unblocked — the cheapest to resume |
| 19 | vaultwarden | a server that must never read what it stores, behind an API a foreign client fixed |
| 9 | posthog | a write rate set by strangers' browsers; a query a tenant wrote |
| 10 | moodle | one value per locale in a column; a quiz attempt alive across a restart |
| 11 | etsy | one checkout across three tenants; payouts; geo for the first time |
| 8 | ci-runner | a cancellation that interrupts work in flight; log streaming |
| 15 | ghost | a transition at a future instant; a write that rebuilds a prerendered page |
| 12 | statuspage | cron precision against a prerendered public page |

### Stalled early

- **#20 dragonfly** — Phase 1 only (two writable views of one document).
- **#28 darkroom** — `status: partial`.
- **#5 chatwoot** — Phase 0 only; its mail half was built separately under
  `inbound-email.md`.
- **#41 chat** (Mattermost) — two commits; `mirror-apps.md` closed around it.

Every other row ran deep: #1–4, #6, #13, #14, #16, #18, #21–27, #42, #43, and
lago (#7).

---

## Shapes the list lacks

Neither is numbered. Each takes the next free `#N` when promoted into
`stressors.md`, so `#N` stays unique.

### Federated server — a peer nobody vetted, speaking a protocol nobody here designed

**Shape.** A small ActivityPub server in the GoToSocial mold, federating with
real Mastodon instances. CalDAV/CardDAV is the same category with one peer
instead of thousands.

**Why it is not on the list.** Every stressor talks to its own clients, a
provider it chose (#23, #24, #41), or an FJS app it has a key for (`Peer`,
`FJS-D1188`). ActivityPub and Matrix appear here only as prior art
(`frontier-network.md`, `app-peering.md`, `haven.md`). *HTTP signature*,
*CalDAV*, *CardDAV* and *WebDAV* have zero hits.

**What it breaks first:**

- **A principal that is another server's user**, known by a key fetched from its
  home server and proved by a signature on every request. It is not a User, a
  Peer or a bearer.
- **Rows held but not owned.** A remote post is cached, goes stale, and is edited
  or deleted upstream. `mirror-apps.md` has one upstream; this has thousands.
- **Fan-out to strangers.** One post to 5,000 inboxes on servers that are slow,
  down or hostile. Conduit sends only to a provider the app chose.
- **A gate keyed on a row's origin.** Blocking an instance removes its users'
  rows from every read, and nothing can declare that.
- **A surface fixed by a spec rather than derived from the seed** — #19's
  problem across a whole protocol, and #29's from the other side.
- **Verbs that are not JSON over HTTP.** CalDAV is `PROPFIND`, `REPORT`, ETags
  and XML; Junction speaks HTTP+JSON and WebSocket.

**Gradable.** A post written here appears on a real Mastodon instance and a reply
from there threads back. The instance blocked, its rows are gone from every read
over HTTP and over WebSocket.

### Uncertain records — a value that is a claim, with a source and a precision

**Shape.** Genealogy (Gramps, GEDCOM import), or a lab sample tracker (a LIMS)
for the same questions with stricter consequences.

**Why it is not on the list.** Every stressor's field holds one value the app
believes. *Genealogy*, *GEDCOM*, *circa*, *partial date*, *unit of measure*,
*chain of custody* and *LIMS* have zero hits.

**What it breaks first:**

- **A field that is a claim with a source.** Two sources disagree and both are
  kept; the record shows one and can say why. `conflict-as-data.md` resolves a
  clash, and here the clash is the permanent state.
- **A date with a precision** — *circa 1850*, *spring 1900*, *before 1910* —
  sorted and filtered beside exact ones. `datetime-kit.md` and `effective-time.md`
  hold instants and ranges, not a precision.
- **A quantity with a unit**, where 5 mg + 2 g is converted or refused at the
  Data boundary. `declared-semantics.md` § 2 (`@scale`, `@money`) is the nearest
  record, and its only unit is a currency.
- **One person entered twice**, merged with every claim kept and the merge
  undoable. #9 merges two ids; this merges two histories.

**Gradable.** A GEDCOM file round-trips with every source attached; a filter for
births before 1860 returns the *circa 1850* row and orders it among the exact
dates; adding a weight in grams to one in milligrams yields milligrams or a
refusal, never a bare sum.
