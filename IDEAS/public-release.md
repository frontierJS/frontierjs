---
id: public-release
status: proposed
dated: 2026-11-13
---

# Public release — FrontierJS from a private workshop to something a stranger can adopt

**Status: PROPOSED.** Dated 2026-11-13. Nothing here is built or announced. Do
not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-13): a home for what it takes to "release FJS to the
world". Eight plans hold pieces of it, and none of them owns the whole. **This
plan is the order between them, plus the parts nobody owns:** the release bar,
the front door, the channels outsiders use, and the announcement. It links to
the other plans and never restates their steps.

## What exists (probed 2026-11-13)

- **The repo is already public:** `frontierJS/frontierjs`, 0 stars, Issues on,
  Discussions off (`gh repo view`). Publishing it is not a step in this plan.
  Telling people about it is.
- **MIT `LICENSE` at the root.** 22 of 28 packages are not `"private": true`.
- **The npm numbers contradict a ruling.** npm has `@frontierjs/litestone@1.1.16`
  and `@frontierjs/auth@1.0.12`. `FJS-D949` (2026-10-13) moves both to the
  train's `0.x` and deprecates their `1.x` on npm. That renumbering is not built,
  and a stranger reads a 1.x as a promise.
- **`FJS-009` is closed**: CI has gone green on a runner.
- **Outsider files: none.** There is no `SECURITY.md`, `CONTRIBUTING.md`, code of
  conduct or issue template. `.github/` holds `workflows/` only.
- **Front door:** `website/` (a site-kit surface; its README defers docs to "a
  docs subdomain, later") and `docs/QUICKSTART.md`. Every other doc is written
  for agents working inside the tree.
- **The beta-tester rulings exist only in chat** (2026-10-31): testers build *and
  deploy*, and breakage is normal, with no upgrade notes. They are not in
  `DECISIONS.md`.

### The pieces other plans own

| Piece | Plan | Where it stands |
| --- | --- | --- |
| CI green, latest of every package on both hosts | [green-and-ship.md](green-and-ship.md) | proposed |
| A release that cannot strand a tag | [publish-order.md](publish-order.md) | 1.3 + Phase 2 on branch `publish-order-integ` |
| Installing without the monorepo | [package-host.md](package-host.md) | Phase 1 but 1.3 |
| What a version number promises | [version-compatibility.md](version-compatibility.md) | idea |
| Release notes | [release-notes.md](release-notes.md) | proposed |
| The name, and the Basecamp/Oracle conflicts | [trademark.md](trademark.md) | proposed, nothing filed |
| A newcomer's first run | [workspace-onboarding.md](workspace-onboarding.md) | Q4 open |
| Zero to a live app | [zero-to-live.md](zero-to-live.md) | Phase 0 next |

[go-live.md](go-live.md) covers an *app* going live, not the framework, and is
not a piece of this plan.

## Open questions

- **Q1 — What is "release"?**
  - **A** — an invited beta: a handful of named testers, no announcement.
  - **B** — a public alpha: announced, anyone may try, nothing promised.
  - **C** — 1.0: announced, with a stability promise.
  - **Recommend A, then B** — outsiders have never built and deployed an app,
    and the first ten will find what the stressors could not. The beta is
    Phase 6, the announcement Phase 7. C is gated by `FJS-D949`: 1.0 is the
    first release whose surface diff is graded. This recommendation comes from
    reasoning; the sources arrive with 0.2.
- **Q2 — Where do outsiders talk to us?**
  - **A** — GitHub only: Issues for defects, Discussions for questions.
  - **B** — GitHub Issues plus a Discord.
  - **Recommend A** — one place to watch. A chat server is a second inbox that
    has to be staffed every day, or it reads as abandoned. B is the way back in
    if Discussions turn out too slow for the beta.
- **Q3 — Where do the docs for a stranger live?**
  - **A** — on the website: a docs section built by site-kit from the repo's
    markdown.
  - **B** — a docs subdomain with its own build.
  - **C** — the repo's markdown, linked from the README.
  - **Recommend A** — the website's README already defers docs to "later",
    site-kit already builds pages from markdown, and doing it there tests
    site-kit too. B adds a second build. C leaves a stranger reading files
    written for agents. B is the way back in once the docs outgrow the site.
  - Whichever is picked, the agent-facing docs (`CLAUDE.md`, hazards,
    registers) are not the user docs. That split is the work of Phase 2.
- **Q4 — Must the Basecamp/Oracle renames land before the announcement?**
  - **A** — yes: the renames land before Phase 7's announcement.
  - **B** — no: announce under the current names and rename later.
  - **Recommend A** — a public page that ships a package called Basecamp
    invites the conflict [trademark.md](trademark.md) Q3 exists to avoid.
    Pre-alpha, a rename moves every caller with no alias, so before outsiders
    arrive is when it is cheapest. The renames wait on trademark.md 0.2's
    clearance. They do not block the invited beta.
- **Q5 — What does the first public version promise?**
  - Half-ruled already: `FJS-D949` puts every package on `0.x` until a graded
    surface diff earns 1.0. What is left is what the 0.x README says: either
    anything may break and the release notes say what did, or minor versions
    break and patches do not. That belongs in
    [version-compatibility.md](version-compatibility.md); this plan only needs
    the answer, and D949's renumbering built, before Phase 7.
- **Q6 — What is measured after launch, and with what?**
  - **A** — by hand: GitHub stars and issues, npm downloads, the launch post's
    score.
  - **B** — a FrontierJS app that tracks it: a launch tracker in the shape of
    [iampal/altar](https://github.com/iampal/altar) (channel counters, the
    public HN and GitHub APIs, webhook alerts), built as a stressor.
  - **Recommend A for the beta, B considered before Phase 7.**

---

## Plan

### Phase 0 — Groundwork

Goal: know what a stranger hits today, and what other frameworks did.
Done when: 0.1–0.3 have their findings written under them.

- [ ] 0.1 From a clean machine with no workspace, follow `docs/QUICKSTART.md`
  using only npm or tarball installs, through to a deployed app. Write down
  every place it stops.
- [ ] 0.2 Prior art: how Bun, Hono, Astro, SvelteKit and Deno ran their first
  public release (beta or announcement, channels, launch-day posts). Sourced,
  not from memory.
- [ ] 0.3 Write the 2026-10-31 beta rulings into `DECISIONS.md` (`fli decide`)
  so this plan can cite them.

### Phase 1 — The release bar

Goal: a written answer to "what are we releasing, and what does it promise".
Done when: Q1 and Q5 have `FJS-D` rulings, and the root `README.md` states the
stage in its first screen.

- [ ] 1.1 Rule Q1 and Q5.
- [ ] 1.2 Root `README.md`: the stage, what works, what does not, and where to
  report.

### Phase 2 — The front door

Goal: a stranger goes from "never heard of it" to a running app without reading
anything meant for agents.
Done when: 0.1's walk, rerun, has no stop that the docs do not answer.

- [ ] 2.1 Rule Q3.
- [ ] 2.2 Draw the line between user docs and agent docs. Q3's build owns the
  list of files a stranger is pointed at, so there is no hand-kept second list.
- [ ] 2.2a Turn 0.1's walk into a drive in `DRIVES.md`: QUICKSTART on a fresh
  machine from published packages. This is what keeps 2.3 and 7.2 true after
  launch.
- [ ] 2.3 Fix every stop 0.1 found, in the doc or in the code.
- [ ] 2.4 The website links to install, docs and the repo, and every runnable
  example on it is verified (Invariant 16).

### Phase 3 — Outsider channels

Goal: a defect, a question and a vulnerability each have a place to go.
Done when: each of the three can be filed from the repo's GitHub page.

- [ ] 3.1 Rule Q2.
- [ ] 3.2 Issue templates: bug and question, each asking for the package
  versions and the `fli` output.
- [ ] 3.3 `SECURITY.md` and `CONTRIBUTING.md` in `.github/`, which GitHub reads
  and which already exists. The security policy says whether private
  vulnerability reporting is turned on.
- [ ] 3.4 Decide how an outside issue becomes an `FJS-###` row, so `ISSUES.md`
  stays the one register.

### Phase 4 — The name

Goal: nothing announced under a name someone else owns.
Done when: [trademark.md](trademark.md) Phase 1 is done, or Q4 is ruled "no".

- [ ] 4.1 [trademark.md](trademark.md) Phases 0–1. Filing (its Phase 2) need
  not precede the announcement.

### Phase 5 — Shippable

Goal: the packages a stranger installs are the ones the docs describe.
Done when: a fresh app installs only from published versions and passes its own
`fli done`.

- [ ] 5.1 [green-and-ship.md](green-and-ship.md) to its end.
- [ ] 5.2 [publish-order.md](publish-order.md) merged, so every release is
  graded before it is tagged.
- [ ] 5.3 [release-notes.md](release-notes.md): at least the first release's
  notes, written for outsiders.
- [ ] 5.4 `FJS-D949`'s renumbering: litestone and auth on `0.x`, their `1.x`
  deprecated on npm.

### Phase 6 — Invited beta

Goal: people who are not the owner build and deploy an app.
Done when: each tester has a deployed app, or a filed reason they could not.

- [ ] 6.1 Pick the testers and write the invitation (what to build, where to
  report, what breaks).
- [ ] 6.2 Run it. Every report becomes an `FJS-###` row through 3.4.
- [ ] 6.3 Close or name every beta row before Phase 7.

### Phase 7 — Announce

Goal: the public hears about it once, on purpose.
Done when: the posts are live and linked from this file.

- [ ] 7.1 Pick the channels and the order (from 0.2's findings).
- [ ] 7.2 Draft each post. Every claim in it is one a stranger can run, and 2.2a
  is green on the day.
- [ ] 7.3 Launch day: the owner watches the channels picked under Q2 for the
  first 48 hours.

### Phase 8 — After

Goal: know what the launch did.
Done when: a dated readout of Q6's numbers at one week and one month is written
here.

- [ ] 8.1 Rule Q6, and build B if picked.
- [ ] 8.2 The one-week and one-month readouts.
