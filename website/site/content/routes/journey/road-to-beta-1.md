---
layout: Journey
title: Road to the beta, week 1 — The journey
description: The goal is an invited beta. Ten things stand between here and there. This is where each one starts.
---

**[Your take — two or three sentences, in your voice. Why this goal, and why now?]**

## The goal

An invited beta: a handful of named testers build a real app with FrontierJS and deploy it, with no announcement. Things will break, and they will be told so up front. A public alpha follows once the beta has found what our own apps could not.

FrontierJS is not short of features. What stands between here and a first outside user is mostly decisions, names and proofs. We wrote down the ten that matter, and this update tracks them every week until the list is empty.

## The scoreboard

| # | Before the beta | Where it stands |
|---|---|---|
| 1 | Decide what the first release is | **Open.** Recommended: invited beta first, then a public alpha. |
| 2 | Get CI green and keep it green | **Moving.** 5 failures, down from 7. |
| 3 | Walk it as a stranger on a clean machine | **Not started.** |
| 4 | Clear the questions that change what a stranger types | **Moving.** 53 more ruled since Saturday, 1,137 in all. |
| 5 | Close the last high-severity bug and the silent failures | **Moving.** One bug left, and it waits on a live test. |
| 6 | Settle the names while a rename is still free | **Not started.** |
| 7 | Build the front door | **Not started.** |
| 8 | Run the proofs only a real server can give | **Moving.** 2 of 6 real-machine checks done. |
| 9 | Say plainly where hydration stands | **Ruled, not written.** |
| 10 | Make the history readable | **Not started.** |

**0 of 10 done.** It is the starting line, so that is the honest number.

## What each one means

**1. Decide what the first release is.** Three choices: an invited beta, a public alpha, or a 1.0 with a stability promise. A 1.0 is off the table until something checks every change to the public surface, and nothing does yet. Meanwhile two packages already carry 1.x version numbers, which a stranger reads as a promise we have not made.

**2. Get CI green.** The last full run failed in five places: a lint error, two packages over their structure baselines, two findings in the issue register, and one failing test suite. None looks deep. The rule after this is that a release cannot be tagged on a red run.

**3. Walk it as a stranger.** Nobody has gone from an empty machine to a deployed app using only the published packages and the quickstart. Every other item on this list is a guess until that walk runs, because the walk is what produces the real blocker list. Once it passes, it becomes a test that runs on its own.

**4. Clear the questions.** Every design question gets written down with its options before it is ruled. 347 are still open, but most do not block a beta. The ones that do are few: what the release is (item 1), whether renames land before an announcement (item 6), and where a tenant's data may live.

**5. The last high-severity bug.** One is left in the whole register: deploying a site from a private git repository cloned it without its key. The fix is written and released, and it is proven only when a real private repo deploys through it. Two quieter bugs closed this week: in both, the UI compiler failed without saying why.

**6. Settle the names.** Two package names clash with existing trademarks. Today a rename moves every caller in one change, with no alias. After an announcement, every rename needs a deprecation window. Trademark clearance has outside lead time, so it starts now.

**7. Build the front door.** The repo is public, with no security policy, no contributing guide, no issue templates and no place for discussion. Most of the docs were written for the agents that work inside the repo, not for a stranger arriving at it.

**8. The proofs only a real server can give.** The deploy side is built and mostly unproven where it counts: a restore from backup has never run for real, nobody has stopped the control panel to show the apps keep serving, and the full path from a fresh cloud account to a live app has run end to end on real machines for only two of its six checks.

**9. Say where hydration stands.** We decided to add hydration, so a server-rendered page can pick up in the browser where the server left off, and to build it in phases. The design rule that says "there is no hydration" still says so, and so does a comment in the renderer. For the beta, the docs will say hydration is planned and not in this release.

**10. Make the history readable.** Testers will read the git log, and the last eight commits are titled "updates", "fix" and "ts fix". Either the commits say what changed, or every release ships notes that do.

## Next week

**[Your words: which one or two of the ten you will move.]**
