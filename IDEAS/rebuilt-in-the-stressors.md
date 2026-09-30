---
id: rebuilt-in-the-stressors
status: assessment
dated: 2026-09-29
---

# Assessment — what the stressors rebuilt that the framework should own

**Status: ASSESSMENT.** A reading of `fjs-prototypes/` against the packages, asking
one question: *which file in an app is a reimplementation of something universal,
rather than a domain module or a scaffold copy?* Open work carries an id in
`ISSUES.md` and is named below; this file is not a register.

## What was read

The seven stressors — calendly, connectteam, jazzhr, ksite, linear, portal, remnant.
Every source file outside `routes/`, `resources/` and `services/`, the drive scripts
in both trees, and each suspect probed against the framework's owner rather than
read beside it.

## The answer: no kernel is missing

The three realms held. What repeats across every app is `fli new`'s own output —
`api/src/core/{auth,db,env,gate,channels}.ts` and `web/src/datetime.js`
(byte-identical in five apps; calendly extended its copy). Those are the app's
files by design and are not reimplementations.

What the stressors DID rebuild is seven leaves. One of them is a live defect, and
it is the one with an owner already in the tree.

| # | Rebuilt | Where | Framework state | Row |
| --- | --- | --- | --- | --- |
| 1 | **The outbound-URL guard** — refuse a person-chosen URL that resolves inside the network | portal `api/src/domain/pages/fetch.ts` | Owned by junction, **private to webhooks**; the copy drifted into a bypass | FJS-1578 (defect) · FJS-1579 (owner) |
| 2 | **A browser drive harness** (CDP launch, profile, dead network, console capture) | linear + connectteam `web/test/lib/drive.mjs` | Shared inside the repo, offered to no app | FJS-1580 · `ecosystem-gaps.md` § 8 |
| 3 | **Web Push** (RFC 8291/8188/8292, one recipient → N devices, prune on 410) | connectteam `api/src/core/push.ts` | `@frontierjs/notifications` ships `inApp` + `email`; the driver seam held | FJS-1269 · `ecosystem-gaps.md` § 16 |
| 4 | **A fractional rank key** for drag-to-reorder | linear `web/src/lib/rank.js` | Proposed as `@rank(scope:)` | FJS-D366 · `manual-order.md` |
| 5 | **Composing two principal resolvers** | linear + portal `api/src/core/principal.ts` | `createApp({ principal })` takes one; no composer | FJS-1450 |
| 6 | **A browser reader for a streamed answer** | portal `web/src/search/spellings.js` | **Shipped**: `readEvents` in `@frontierjs/sierra/fetch`, over toolbelt's `/sse`, which `ctx.sse()` writes with | FJS-1581 (closed) · the reader half of FJS-1420 |
| 7 | **A form control for `@money`** | jazzhr `web/src/components/MoneyInput.mesa`; also `example/web/src/money-control.js` | Shipped: `@frontierjs/ui`'s `MoneyInput`, drawn by the control table (`FJS-D555`) | FJS-1582 |

---

## 1 · The outbound-URL guard — one owner, private, and the copy drifted

**The owner exists.** `assertDeliverableTarget` in
[`webhooks/url.ts`](../packages/junction/src/plugins/webhooks/url.ts) grades a URL
someone else chose: scheme, the resolved address against private, loopback,
link-local, CGNAT and reserved ranges, and the IPv4-mapped IPv6 forms — including
the hex spelling `new URL()` normalizes `[::ffff:127.0.0.1]` into. It re-runs before
every attempt, because DNS moves.

**Nobody outside webhooks can reach it.** `@frontierjs/junction/webhooks` exports
`webhooks` and `createSqliteWebhookStore`, and nothing else. So portal, which
fetches pages, feeds and links a person pasted, wrote its own — and its
`isBlockedAddress` matches only the dotted mapped form.

**Measured 2026-09-29:** `fetchPage('http://[::ffff:127.0.0.1]:<port>/')` returned
200 from a listener on 127.0.0.1, while the plain `127.0.0.1` URL was refused.
Junction's guard, handed the same URL, refuses it by name. The owner was right and
the copy was wrong, which is Invariant 4's argument in one probe.

**Who else will need it.** Any feature that fetches a URL a person supplied: link
previews and unfurls, feed polling, link checks, import-from-URL, avatar-from-URL.
Conduit is not a caller — its targets are declared by the app, not chosen by a
caller — unless a target's URL takes caller input.

**The proposal.** Export the guard from junction under a neutral name and error
(its message says *webhook url*), and have webhooks import it from there. A pure
address classifier could move to toolbelt, but the DNS half cannot be pure and
nothing outside a Bun server fetches a stranger's URL; split it only when a second
kind of caller appears.

The nine, for this proposal:

1. **origin** — one: the ranges live in one file and the copy is deleted.
2. **concept** — no new noun; *target policy* already names it.
3. **complexity** — removes a module from every app that fetches.
4. **predictability** — a webhook and a page capture refuse the same addresses.
5. **derived** — nothing to derive; the table is the source.
6. **owner** — junction `webhooks/url.ts` IS the owner; the change widens its door rather than adding a second.
7. **boundary** — a caller passes a URL and a policy and needs to know nothing about address ranges.
8. **failure** — refuse, before a byte is sent; `allowPrivate` is the stated opt-out for a test receiver.
9. **silence** — must stay true: one classifier. Fails when it stops: nothing today. A `fli check` rule flagging `node:dns` `lookup` beside a `fetch` in app code would be the artifact.

Adjudication: *the paved road against the workaround* — the app wrote the
workaround because the road was closed, and the workaround is where the hole is.

## 2 · A browser drive harness

**42 non-markdown files name `--remote-debugging-port`** across `frontierjs/` and
`fjs-prototypes/` (counted 2026-09-29): 16 in `example/web/test`, 6 in litestone's
tests, 4 in basecamp's, the two stressor `drive.mjs` files, and one each in mesa,
sierra, the cli and the website. Mesa's `test/browser/` harness is the shared one
inside the repo, and it is a spec runner that is not published.

connectteam's copy says where it came from: the `drive-browser` skill's `drive.mjs`
plus `example/web/test/lib/offline.mjs`. What it added is the part an app's drive
actually needs — **a profile directory that outlives a tab**, because IndexedDB, the
service worker's Cache Storage and the OPFS database belong to the profile, and a
drive that relaunches Chrome between a write and a reopen is measuring a new phone.

The open question is its home, and it is not decided here: `@frontierjs/testing`
sits above junction and is API-realm; mesa is the leaf and its harness is shared
with `@frontierjs/ui` by relative path. FJS-1580.

## 3–5 · Already argued elsewhere

- **Web Push** — connectteam's `push.ts` is 354 lines of RFC, key derivation and a
  fan-out inside a fan-out, and it says the notifications seam cost nothing. It is
  the measurement `ecosystem-gaps.md` § 16 was waiting for: the subscription wants
  to be a Model, the VAPID key wants to sit beside `encryptionKey`, and the transport
  that delivers is also the one that must delete a row on 410.
- **Fractional rank** — linear minted, defaulted, tie-broke and bounded the key by
  hand under fifty concurrent drags. `manual-order.md` carries it.
- **Principal composition** — portal's plain function carries no `describe()`, so
  the principal snapshot, where access is reviewed, reports its bearer as nothing.

## 6 · A browser reader for a streamed answer

`EventSource` cannot carry a bearer token, so a page reading an authenticated stream
needed `fetch`, a body reader and the SSE frame format — about 40 lines in portal.
**Shipped** (FJS-1581): `readEvents(response)` in `@frontierjs/sierra/fetch`, over
`@frontierjs/toolbelt/sse`, the kit junction's `ctx.sse()` now writes with. FJS-1420,
the channel half of streaming, stays open.

## 7 · A form control for `@money`

The framework owns every other part of the type: the attribute, `x-money` on the
wire, minor units in the column, `toMinor`/`fromMinor` in `toolbelt/units`, and
`<Cell>` for display. The form control is left to the app on purpose
(`packages/ui/AGENTS.md`), so two apps have written it, both as a box that shows
major units and hands the form minor ones. A type whose every other surface ships
is the case for shipping the last one — FJS-1582, shipped under `FJS-D555`.

---

## Correctly left to the app

- **`ics.ts`** (calendly) — an iCalendar document is a domain artifact; its own
  header says a generated one would guess at half its fields.
- **`diff.js`, `parse.ts`** (remnant), **the search adapters** (portal) — domain.
- **`cassette.ts`** (portal) — record-and-replay for a paid provider, a dev tool
  outside the app. A second app with a paid provider would make it a candidate for
  conduit's `testing` export.

## Stale on arrival

- calendly's `mailer.ts` restates `assertMessageAddresses` because *the `exports`
  map has no `./mail` subpath*. It has one now: `@frontierjs/junction/mail` exports
  the function (measured). The package root still does not, so FJS-1224 stays open.
- Two side findings are already filed: FJS-1441 (a `String[]` column has no working
  control) and FJS-1297 (the scaffold's `.gitignore` misses `db/audit/`).

## Method, for the next pass

List the app files outside routes, resources and services; hash the scaffold copies
out; read each remaining header for *by hand*, *no driver*, *nothing in the
framework*; then **drive the copy against the owner**. Reading `fetch.ts` beside
`url.ts` said they did the same thing, and only the probe found the difference.
