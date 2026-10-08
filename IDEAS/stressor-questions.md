---
id: stressor-questions
status: proposed
dated: 2026-09-26
---

# Idea — The stressor questions, as one catalog

**Status: PROPOSED, and parked.** Nothing is built. Until this is picked up, every stressor
keeps its questions in its own `PLAN.md` in the shape below, so the catalog can
be derived when it is built instead of re-typed. Do not cite this file as
behavior — see `VERIFYING.md`.

## Trigger

Each stressor run (`IDEAS/stressors.md`) produces a handful of sharp
questions, such as *is "no two of these may overlap" a declaration?* or *can a
write be anonymous when every write has an actor?* or *can a report outlive the
rows it counts?* They are the best material the project has for explaining
what FrontierJS is FOR. Asked of another stack (*how does Rails, Django, or Next
with Prisma answer this?*), the usual answer is *in a service, by hand, and
nothing checks it*, and that contrast is the schema-first thesis in one line.

Today they are scattered across three places and linked to none of them:

| Where | Holds | Gap |
| --- | --- | --- |
| `fjs-prototypes/<run>/PLAN.md` § The questions | the question, its hard version, the answer | outside this repo, local git only, no remote |
| `IDEAS/stressors.md` | the pre-run question per product | never updated with the answer |
| `ISSUES.md` / `DECISIONS.md` | the `FJS-###` / `FJS-D###` an answer became | the row does not say which question produced it |

As of 2026-09-26 there are 26: calendly 8, connectteam 7, linear 6, and jazzhr
5 (not run yet).

## The shape, if built

One entry per question:

- **the question**, readable by someone who has never seen FrontierJS
- **where it came from**: the product and the run
- **FrontierJS's answer**, with a status: *declared* (the seed says it),
  *ruled* (`FJS-D###`), *open* (`FJS-###`), or *refused on purpose*
- **how a typical stack answers it**, with a source and a version for each claim

Open and refused entries stay in. *Here is what we cannot do, and why* is more
credible than a list of wins.

## The convention that keeps it derivable (in force now)

Every `PLAN.md` states each question as a `### Qn — <question>` heading
followed by a `**Status: …**` line, and names the ids it produced in the
answer beneath. That is enough for a reader to extract question, status and
ids without a second copy.

## Open questions

- **Where does it live?** `docs/` (a reference), a generated section of
  `stressors.md` (the existing owner of the list), or the `website/` (the
  audience is outside the project).
  - **A** — `docs/`, a reference page.
  - **B** — a generated section of `IDEAS/stressors.md`, the existing owner of the list.
  - **C** — `website/`, beside `comparisons.json` and the comparisons page.
  - **Recommend C** — the audience is outside the project, and `website/` already holds the one other place this repo sets itself beside other stacks. B puts answers with a *declared* or *ruled* status into an assessment, which is never cited as behavior.
- **The source is outside the repo.** A generator reading
  `../fjs-prototypes/*/PLAN.md` depends on a sibling directory that CI does not
  have. Options: commit a snapshot, move the plans in, or give the prototypes
  a remote.
  - **A** — commit a snapshot: the generator runs where the sibling exists and writes a committed file CI reads.
  - **B** — move the plans into this repo.
  - **C** — give each prototype a remote CI can clone.
  - **Recommend A** — it is the `exports.snapshot.md` shape, a generated file committed and diffed. B and C publish the plans whole, and some of them are client engagements (maid.tech, ELA) whose plans name a live client's data; a snapshot carries only the extracted questions.
- **The comparison column cannot be derived, and it goes stale silently.** A
  claim about another framework said in public is expensive when wrong
  (Invariant 16's spirit), so each needs a cited source and version. Nothing
  flags it when that source moves; that is unenforced today.
  - **A** — every claim carries a source URL, the version it was read against and the date it was checked, and a check flags one older than a stated horizon.
  - **B** — the claims live in `website/comparisons.json`, which already names each system's version and a `graded` date, and one age check on `graded` covers them.
  - **C** — no comparison column: the catalog publishes FrontierJS's answer and status only.
  - **Recommend B** — one owner for *FrontierJS beside other systems* already exists, and a second file stating Laravel's version is the restatement that drifts. Age is the only staleness a check can see without reading the other project's docs, so the check grades the date, not the claim. C is the fallback if a row there cannot hold a prose answer.
