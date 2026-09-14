---
id: release-notes
status: proposed
dated: 2026-09-14
---

# Idea — Release notes: what shipped, told to the people it shipped to

**Status: PROPOSED. Nothing described here as the proposal exists.** Dated
2026-09-14. Do not cite this file as describing behavior — see `VERIFYING.md`.
The survey of how other projects do it is from memory rather than from a run, and
is marked where a claim is about a named product.

---

## The claim

**"Release notes" is two things with two audiences, and every design that goes
wrong starts by treating them as one.**

- **A changelog** tells a DEVELOPER what changed in the code. It lives in git and
  nobody stores it in a database. This repo already has both halves of it: every
  package's `CHANGES.md`, and `fli changelog` / `fli gr`, which write a
  `CHANGELOG.md` out of commit history for any project.
- **What's new** tells a USER of the application what they can now do. It is
  shown inside the app, it has an unread badge, and it is the half this file is
  about. The framework has nothing for it.

The split is already argued once in this tree: `packages/frontierjs-vscode` keeps
`CHANGELOG.md` for the marketplace beside `CHANGES.md` for contributors, cited in
`DECISIONS.md` § `FJS-D163` as the precedent for two audiences being two files.

**Commit messages are the wrong source for the second one.** They are written for
the person reviewing the diff, so a what's-new panel generated from conventional
commits reads as *fix(resource): adopt version on 409* to somebody who sells
shoes. The prose has to be written for the user, and the only moment anyone
reliably knows what a change means to a user is when the change is made.

---

## How others do it

| Shape | Where the text lives | Where the seen-state lives | Examples |
| --- | --- | --- | --- |
| A hand-written or generated changelog | `CHANGELOG.md`, GitHub Releases | — | Keep a Changelog, release-please, semantic-release |
| One note per change, gathered at release | `.changeset/*.md` in the PR | — | Changesets |
| A changelog page on the docs site | MDX in the repo, a content collection | — | Linear, Vercel, Stripe |
| Notes in files, read by the running app | YAML in the repo | per user | GitLab's *What's new* (`data/whats_new/`) |
| Notes as rows, authored after deploy | the app's own database | per user | Mastodon's `announcements` table (with per-user dismissals), Jumpstart Pro's `Announcement` model, Laravel Spark's announcements |
| A hosted widget | the vendor's database | the vendor's | Beamer, Headway, AnnounceKit, Canny |

**The pattern underneath the table**: the TEXT sits in a database exactly when
somebody other than a developer writes it after the code has shipped — scheduled,
targeted, edited live. It sits in files when it describes code. **The per-user
seen-state is a row in every design that has one.**

---

## The proposal

### 1. A note ships with the change it describes

A note is a file in the repo, written in the PR that makes the change — the
changesets shape, with prose for the user rather than a version bump. It is
bundled into the surface that shows it, so it reaches production exactly when the
code does.

**This is the whole argument against rows**, and it is about revert rather than
about authoring convenience. `fli deploy`'s revert puts the previous Release back.
A note in the bundle goes back with it; a note inserted as a row stays, and every
user is told about a feature that is no longer there. A deploy step that syncs the
files into a table has the same defect unless it replaces the whole set on every
deploy, at which point the table is a cache of the bundle with a failure mode the
bundle does not have.

**It is the build that carries it, not the Release** — `FJS-D160`'s distinction,
and it holds here for the same reason: a browser holds the web bundle, and two
Releases sharing one bundle ship the same notes. A note is a bundle change, so
adding one moves the build and fires junction's client `stale` event on every
open tab. That is the right cadence: *a new version is available* and *here is
what is in it* arrive together, and the notes are in the bundle the reload
fetches.

### 2. The only row is what each person has seen

Derived at read: *the notes in this bundle, minus the ones this person has
seen*. No endpoint, no sync, no job.

**The seen-state cannot be a timestamp, and this is the trap the design turns
on.** A note is dated when it is WRITTEN and reaches a user when it is DEPLOYED,
and the two are days apart on any team that batches deploys. A person who looked
at the panel on the 10th has `seenThrough = 10th`; a note written on the 8th and
deployed on the 12th is older than that and is never shown to them. Ordering by
build does not rescue it either — a build id is a content hash and has no order.

**So the state is the set of note ids seen**, bounded by a window: the panel only
ever offers notes from the last N months, so ids older than that are pruned on
write and the set stays small with no cron. A reverted note's id stays in the set
harmlessly, and if the change is redeployed later the person is not told twice.

**A person who has never opened the panel is not shown the history.** An absent
set means *everything before this account existed is seen*, read against the
account's own creation, or a new signup's first screen is forty notes.

The rejected alternative is a `(user, note)` row per read. It makes *how many
people read the pricing note* a query, which is real value, and costs a table
growing users × notes for a question nobody has asked yet. It is the upgrade
path, not the starting point.

### 3. A message about the SERVICE is not a release note

*Maintenance on Saturday*, *we have changed our terms* — written by whoever runs
the app, with no code behind it, often scheduled and often targeted. That is the
Mastodon shape and it belongs in the database.

**It does not get a new noun here.** The ecosystem's word is *announcement*, and
in this framework *announce* already means one thing — a mutation being published
(Invariant 4, `ARCHITECT.md` §3.7). A model called `Announcement` would put two
meanings on one word in the realm that uses the first one most. The existing
owner is `@frontierjs/notifications`: an in-app record, a WS event and an email
fan-out, addressed to a `Recipient`. Whether a notice to EVERY user is a
notification fanned out per person, or wants a broadcast shape notifications does
not have, is open question 3.

---

## What the framework owes, cut one level simpler

**The smallest version needs no framework change at all**, and it should be built
first in `example/` to find out what the second version is:

- a directory of `.md` notes with frontmatter (`id`, `title`, `date`), imported
  with a Vite glob into the one surface that shows them;
- a seen-set column on `User`, added by the app through `extend model User`;
- a panel in `web/` that reads the bundle and the column.

What only the framework can then add, each earning its place separately:

| Piece | Owner it would join | Why it cannot be app code |
| --- | --- | --- |
| frontmatter validated against a declared `type` | the collection half of `IDEAS/content-collections.md` | a typo in `date` is a silently missing note; the validator exists and content never meets it |
| `fli make:note` | `packages/cli` | writes the id, so two PRs cannot collide on one |
| the same notes on `site/` as a public changelog page and in `web/` as a panel | content collections again | Invariant 3 gives each surface its own `src/`; a set two surfaces read has no home yet |
| a report of which changed surfaces carry no note | a REPORT in the `access` phase's shape, never a gate | a branch with no user-visible change is most branches, and a red that fires on them trains everyone to write a note that says nothing |

**This idea is therefore mostly a caller for `content-collections.md`**: a
changelog is named there as one of the texts that will never be a row, and this
is the first case with a concrete second reader (the panel) beside the page.

---

## The nine questions

Answered before the file was written (`PHILOSOPHY.md` § V).

- **Another origin of truth?** No — the note file is the only one. The rows-and-sync
  design fails here, which is why it is refused.
- **Concept budget?** No new noun. A note is an instance of a content collection,
  and the service notice is a notification. *Announcement* is refused as a word.
- **Complexity the problem's?** Yes — authored-date against deployed-date is the
  problem's, and the seen-set is its smallest answer.
- **Predictability?** Improved: a revert takes its notes with it, which is what a
  person reading the panel would assume.
- **Derived instead of restated?** Which notes a build carries is read off the
  bundle; nothing records it in the deploy journal. Generating the text from
  commits is a restatement for the wrong audience and is refused.
- **One owner?** The text: the collection. What a person has seen: one column.
  Whether the tab is behind: `core/build-id.ts`, unchanged.
- **Boundary explicit?** Only once the collection half exists; until then the
  frontmatter is a hand-read object, which is question 1.
- **Failure proportional?** A malformed note fails the build, which is cheap. A
  missing note costs nothing loud, and nothing should be loud about it.
- **Wrong without anything saying so?** Yes — a shipped feature with no note is
  silent. The report in the table above is the artifact, and it reports rather
  than judges.

**Adjudications in tension** (§ IV): *batteries vs. smallness* — nothing lands in
a core package until `example/` has run the zero-framework version; *familiarity
vs. precision* — the changesets shape is stolen and the word *announcement* is
not.

---

## Open questions

1. **Does this wait for the content-collections half, or ship with a hand-read
   frontmatter first?** Recommendation: build the `example/` version against a
   glob now, and let its frontmatter bugs be the evidence the collection half is
   argued with.
2. **Where does a set two surfaces read live?** `content/` at the root is what
   `content-collections.md` sketches, and it is a new top-level directory against
   Invariant 3's list of surfaces. It is not a surface — nothing is built or
   released from it — so it may be the `db/` shape rather than the `web/` shape.
3. **A notice to every user**: a notification fanned out per person, or a
   broadcast shape `@frontierjs/notifications` does not have? The fan-out is
   correct and costs a row per person per notice.
4. **Tenancy.** Under `strategy database` every shop is its own database and its
   own users; the notes are the app's and identical across shops, and the
   seen-set is per shop's user. That falls out of the column living on `User`,
   and should be checked in `example/` rather than assumed.
