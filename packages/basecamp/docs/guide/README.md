# Basecamp Guide

How a release gets onto a machine and stays safe there, one quick page per idea.
The guide shows what is possible; the READMEs beside it explain it.

A page is a skim, not a lesson:

- one or two sentences on what the feature is for
- one example, the smallest that shows it working
- a short list of what else it can do, a line each, with no explanation
- a closing **In depth** link to the doc its `from` note names

Edge cases, refusals, rulings and `FJS-` ids belong in the full doc. If a page
needs a second example to make sense, that material belongs in the full doc and
the page links to it.

Every example is a command or a screen, and none is run by a test: a deploy
needs Docker and a machine, a fleet needs a server, a restore needs a bucket.
The lessons that do run them are `fli tutor:deploy` and `fli tutor:fleet`, and
the pages that have one say so. A command a page names is checked to exist by
`website/tests/verify.mjs`.

This list is the page order. The website builds `/docs/basecamp/` from it, so a
page that is not listed here is not published. Health and metrics is Junction's
and is not repeated here: [Health and metrics](../../../junction/docs/guide/running/health-and-metrics.md).

## Deploy

- [A release](deploy/a-release.md)
<!-- from: docs/QUICKSTART.md § fli tutor:deploy; packages/cli/commands/deploy/index.md, local.md -->
- [Redeploying and reverting](deploy/redeploy-and-revert.md)
<!-- from: packages/cli/commands/deploy/journal.md, revert.md, rollback.md -->
- [Secrets and environment](deploy/secrets-and-environment.md)
<!-- from: packages/cli/commands/deploy/setup.md, packages/cli/commands/env -->
- [Status and logs](deploy/status-and-logs.md)
<!-- from: packages/cli/commands/deploy/status.md, logs.md, doctor.md, pause.md, retire.md -->

## Fleet

- [Basecamp and Outpost](fleet/basecamp-and-outpost.md)
<!-- from: README.md § top, Quick start; ../outpost/README.md § top -->
- [Provisioning a server](fleet/provisioning.md)
<!-- from: docs/provisioning.md; packages/cli/commands/server -->
- [Enrolling a machine](fleet/enrolling.md)
<!-- from: ../outpost/README.md § Running one, Taking one off, The protocol -->
- [Releasing from Basecamp](fleet/releasing.md)
<!-- from: ../outpost/README.md § Where the bytes come from; docs/QUICKSTART.md § fli tutor:fleet -->

## Backups

- [What is backed up](backups/what-is-backed-up.md)
<!-- from: docs/backups.md §§ 1–6, 8 -->
- [Restoring](backups/restoring.md)
<!-- from: docs/backups.md § 7 -->
- [Rehearsing a restore](backups/rehearsing.md)
<!-- from: docs/backups.md § 7, 9; the restore drill (/charter/drill/) -->
