---
id: rig-catalog
status: assessment
dated: 2026-10-15
---

# Assessment — the rig catalog: which features the apps keep rebuilding

**Status: ASSESSMENT.** A count of rig-shaped model clusters across every app
schema in the two trees, set against the features most SaaS products ship.
Nothing here is built, and no candidate below is a rig until it is a package.
Do not cite this file as describing behavior — see `VERIFYING.md`.

**Where a rig lives is already ruled:** a rig is a package, `packages/<feature>`,
named for its feature and never its vendor (`FJS-D630`). The format and the
installer are `rigs.md` and overview 3.2, both unbuilt. This file answers a
different question: **which rigs, in what order.**

## What was read

The `model` lines of every `db/schema.lite` in `fjs-prototypes/` (twenty
stressors and starters), plus basecamp, haven and `example/`. Read 2026-10-15,
models only: no services, routes or resources. A cluster counts when two or more
apps modeled the same thing by hand under any name. Re-run the count before
acting on it, because the stressors keep growing:

```sh
for f in ../fjs-prototypes/*/db/schema.lite packages/*/db/schema.lite example/db/schema.lite; do
  echo "== $f: $(rg -o '^model (\w+)' -r '$1' "$f" | tr '\n' ' ')"
done
```

## Already owned: no new rig

| Feature | Owner |
| --- | --- |
| Sign-in, sessions, account, API keys | auth (rig) |
| Notifications: in-app record, WS event, email | notifications (the reference rig) |
| Automations | orion (rig) |
| Uploads and attachments | litestone `attachments` |
| Audit trail | litestone trail |
| Outbound webhooks, inbound events | junction batteries; inbound is the Receiver (`FJS-D681`) |

A stressor that rebuilt any of these (basecamp `AuditEvent`, saas-starter
`ApiKey`, `InboundEvent` in three apps) is a gap in the owner's reach, not a
rig candidate: file it against the owner.

## Candidates: strong evidence

Ranked by how many apps rebuilt it.

| Rig | Rebuilt in | Paper |
| --- | --- | --- |
| **teams**: organization, member, invitation, role | saas-starter, lago, chatwoot, quo, linear, notion, basecamp, serpgrid (`Agency`), ela and maidtech (`Account`): **9** | overview 3.8, `membership-from-schema.md` |
| **share links**: a bearer link to one record, and the portal behind it | transit, serpgrid, maidtech, lago, calendly, ela (three `*Grant`s), jazzhr, sstime, example: **~10** | `bearer-access.md`; `bearerClaim()` is built, so the rig is the portal half |
| **chat**: room, member, message, read state, reactions, threads | serpgrid, haven, chatwoot, quo, jazzhr, ela, maidtech: **7** | none; `chat-surface.md` is the AI chatbot, a different feature |
| **boards**: stage, card, move between stages | ela, maidtech, serpgrid (twice), linear, jazzhr: **6** | `manual-order.md` |
| **contacts**: contact, identity, lead source, custom properties | chatwoot, quo, maidtech, serpgrid, ela: **5** | none |
| **billing**: plan, subscription, usage, coupon | lago, example, saas-starter, portal: **4** | `billing.md`, overview 2.5 |
| **invoicing**: quote, invoice, line, payment, credit | ela, lago, example, Charter's `rigs/quotes-invoices`: **4** | Charter `RIGS.md` |
| **tags**: tag, tag-on-record | ela, maidtech, linear, sstime: **4** | none |
| **comments**: a thread on any record, with mentions | linear, notion, ela and maidtech (`Note`): **4** | Charter catalog |
| **tasks**: task, assignee, status | ela, maidtech, serpgrid, linear: **4** | none |
| **templates**: stored and canned text | ela, transit, chatwoot, serpgrid (`Prompt`): **4** | `stored-templates.md` |
| **forms**: form, response, survey | ela (twice), maidtech, connectteam: **3** | `typed-json-forms.md` |

## Candidates: two or three apps, closer to a vertical

| Rig | Rebuilt in | Note |
| --- | --- | --- |
| **telephony**: number, SMS, call, call leg, device, dial | quo, serpgrid | **The two apps use the same model names**, so this is the cheapest extraction in the tree. `conduit-telnyx` sits underneath it |
| **booking**: event type, availability, override, booking | calendly, connectteam, eventmark | `time-and-recurrence.md` |
| **timeclock**: shift, clock entry, timesheet, leave | connectteam, sstime, eventmark | `field-workforce.md` |
| **ledger**: account, journal entry, posting | lago, example | `ledger.md`; billing builds on it |
| **email inbox**: mailbox, thread, inbound mail | serpgrid, chatwoot | `inbound-email.md` |
| **helpdesk**: inbox, SLA clock, CSAT | chatwoot, ela (`SupportThread`) | Built on chat and contacts |
| **reviews**: ask for a review, collect CSAT | serpgrid, chatwoot, Charter catalog | none |
| **dashboards**: dashboard, widget, report | basecamp, transit, maidtech | `metric-store.md` |
| **custom fields and saved views** | linear, quo, example | Overview 4.29; may belong to the framework rather than a rig |
| **follows**: pin, bookmark, follow | serpgrid, portal | none |
| **feature flags** | basecamp | Charter lists it as a starter add-on |
| **payroll** | example | Vertical |

## What SaaS products ship that no app here has built

The features a buyer expects from a SaaS product that no stressor has modeled
yet: onboarding checklist and product tour (serpgrid `SetupStep` is the only
seed; `in-app-guide.md`), CSV import and export (`bulk-data.md`), changelog and
announcements (`release-notes.md` is the framework's own), feedback and roadmap
voting (haven `Vote` is close), referrals and affiliates, e-signature, admin
impersonation and back office (`sysadmin-console.md`), personal-data export and
deletion (`forgetting.md`), global search, activity feed, newsletters and email
campaigns. Two-factor sign-in and SSO grow auth rather than becoming a rig.

## Order

**Rigs depend on each other, so the order is mostly forced:**

- **teams** comes before chat, helpdesk, boards, tasks and comments: a room, a
  board or a thread needs a "who is in it".
- **ledger** → **billing** → **invoicing**.
- **contacts** → **telephony**, **email inbox**, **helpdesk**.
- **chat** + **contacts** → **helpdesk**.

Two of these rank first, for different reasons. **teams** has the most
evidence and the most rigs depend on it (overview 3.8 says the same).
**telephony** is the cheapest to extract, because two apps already agree on its
models. **chat** comes right after teams, and haven is its in-tree first
consumer: its schema has `Room` and `Message` and almost no code yet.

## Open questions

- **Q1** — Which rig is first: teams (the most evidence, and others depend on
  it), telephony (the cheapest to extract), or billing (overview 2.5's
  "canonical first")?
  - **A** — teams first: an organization/member/invitation/role package whose
    gate input is a standing fragment, lifted from basecamp's `Workspace` +
    `WorkspaceMember` + `applyStanding()` (overview 3.8); chat, boards, tasks
    and comments then build on it
  - **B** — telephony first: quo and serpgrid's shared model names become one
    package over `conduit-telnyx`; nothing else in § Order waits on it
  - **C** — billing first, as overview 2.5 nominates: ledger → billing, phased
    in `billing.md`, with the rig as its phase 7
  - **Recommend A** — 9 apps rebuilt it, most of § Order depends on it, and it is
    the only candidate that tests a rig feeding the gate, the hard part of the
    format; telephony's cheapness proves the least about the format.
- **Q2** — Is a cluster that only verticals rebuild (payroll, timeclock) a rig,
  or a reference schema for `reference-library.md`?
  - **A** — a reference schema: payroll and timeclock go into the
    `reference-library.md` set as `.lite` files to compare against, and no
    package; a rig needs evidence across non-vertical apps
  - **B** — a rig like any other: connectteam, sstime and eventmark's timeclock
    becomes a package installed by `fli add` (`FJS-D630`), and only the vertical
    apps install it
  - **Recommend A** — a rig earns its cost through reuse across many apps;
    timeclock has 3 vertical consumers and payroll 1 (example), so a reference
    schema captures the modeling with no package to maintain.
- **Q3** — Custom fields and saved views: a rig, or a litestone feature (overview
  4.29)?
  - **A** — a rig: a `FieldDef` binding model, the pool of `@generated`
    columns, and a `SavedView` holding a stored `where`, shipped as a `.lite`
    fragment plus service; litestone is unchanged, since overview 4.29 measured
    that the pattern needs no framework change
  - **B** — a litestone feature: a schema attribute declares the pool and the
    client owns the binding and the saved view, so every app gets it without
    installing anything
  - **Recommend A** — 4.29 built and measured it with existing `@generated`
    and an ordinary `where`, so the remaining pieces are models and a service:
    what a rig is, with nothing for litestone to own.
