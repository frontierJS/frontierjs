---
id: web-push
status: proposed
dated: 2026-10-28
---

# Idea — Web Push: the browser half, the subscription row and the keys, so an app writes a formatter and nothing else

**Status: PROPOSED.** Dated 2026-10-28. The server driver is BUILT and tested;
everything else here is a proposal. Do not cite this file as describing
behavior — see `VERIFYING.md`. Nouns are provisional until `decision-rules`
has run; the open questions are at the end and a ruling cites one by its `Q`
number.

**Trigger.** The owner asked on 2026-10-28 what it would take to make Web Push
a supported feature that is easy to use. The answer found was that half of it
ships and the other half is six pieces an app writes by hand today, one of
them (the worker) gated on an owed ruling.

---

## What ships today

- **`webPush()`** (`packages/notifications/drivers/webpush.ts`): RFC 8291
  aes128gcm over ECDH-ES, RFC 8188 framing, RFC 8292 VAPID over plain `fetch`.
  One recipient is N devices, each sent independently; 404/410 retires the
  device through `subscriptions.remove`, every other refusal is collected and
  thrown after all devices were tried. `test/webpush.test.ts` holds RFC 8291
  Appendix A byte for byte and decrypts with the device's private key, because
  a push service answers `201` to a body it cannot read.
- **`generateVapidKeys(subject)`**, exported, no CLI in front of it.
- **The `push:` formatter contract**: `{ title, body, url, data, ttl, urgency,
  topic }`, body capped at ~3.9 KB, and the one place `@guarded` columns can be
  kept out of a payload (the driver holds decrypted keys and sees everything).
- **A worker file with an owner**: `postbuild/offline-shell.js` writes `sw.js`
  only when `sierra.config.js` says `offline: true`, answers for a precached
  file and a navigation, and touches nothing else (`homestead.md` Phase 3).

## What an app writes today, and should not

Six pieces. The README's Web Push section documents the first two and leaves
the rest to the reader.

| # | Piece | Today | Precedent |
| - | ----- | ----- | --------- |
| 1 | VAPID key pair, kept beside the app's other secrets | `generateVapidKeys()` by hand, pasted into `.env`; `fli crypto:keygen` makes `secret` and `aes` only | Laravel ships `webpush:vapid`; django-webpush takes `WEBPUSH_SETTINGS` |
| 2 | `PushSubscription` row — endpoint, `p256dh`, `auth`, user, device, created, last seen | "the app's own model", per the README and the driver header; `Notification` ships as `db/notification.lite` and is installed, this one is not | Laravel publishes the migration and a `HasPushSubscriptions` trait on User; django-webpush owns the model |
| 3 | The subscribe route: `subscription.toJSON()` in, bound to the principal, upserted by endpoint | nothing | both ship one |
| 4 | Worker handlers: `push` → `showNotification` inside `waitUntil`; `notificationclick` → focus an open tab or `openWindow(url)` | nothing; a push-only app has no worker at all | FCM reserves `firebase-messaging-sw.js`; django-webpush templates its own |
| 5 | Client helper: `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, run from a gesture, posting to #3 | nothing (`browser-kit.md` 5.1 names `pushSubscription()`) | django-webpush's `{% webpush_button %}` |
| 6 | A drive that proves a `notify()` reaches a closed tab | nothing (`browser-kit.md` 5.2) | see § The drive problem |

`ecosystem-gaps.md` § 16 already made the argument for #2: **a subscription is a
writable handle to someone's device**, so making it a Model is what buys
`@@gate`, `@encrypted` keys, Invariant 7's redaction in the audit trail and a
retire-on-410 that is a `@@softDelete` rather than a hard delete nobody runs.
The driver header says "the app's row" and § 16 says "a framework Model", and
`decision-rules` found on 2026-10-28 that this is not a disagreement: the
mechanism is BOTH. `packages/notifications/db/notification.lite` ships the
text, `fli notifications:install` appends it to the app's `db/schema.lite`,
and `fli check`'s `package-model-drift` grades the copy. The row is the app's;
the words are the package's. `PushSubscription` joins that fragment.

## The claim

**An app that wants push writes a `push:` formatter and turns one key on.**
Everything else is the framework's because every piece fails silently when
hand-rolled: a wrong `applicationServerKey` encoding fails only on Safari, a
missing `waitUntil` drops the notification on a slow phone, a `notificationclick`
without `focus()` opens a second tab, a table nobody prunes sends to thousands
of dead endpoints. The cryptography was built here for exactly this reason
(`FJS-1269`); the other five pieces earn the same treatment.

**The split follows `FJS-D1442`'s option A.** Sierra owns the origin's one
worker, because `FJS-D1099` Q4 already gave worker registration to Homestead
and the platform allows one worker per scope anyway: push is a second duty of
the file that exists, not a second file. Notifications owns what knows the
VAPID key and the subscription shape: the fragment text, the route, the client
helper, a `vapid` type on the key command that exists. The payload shape crosses from notifications to
Sierra as a documented wire contract, not an import, so Invariant 1 holds.

## The drive problem

State it before building, because it shapes Phase 4. **Headless Chromium
installs a service worker but `pushManager.subscribe` fails**, and Chromium has
no Web Push in incognito either. A real end-to-end run needs headed Chromium
with a persistent profile and `context.grantPermissions(['notifications'])`,
which `fli prove` cannot assume on every machine (`FJS-3403` is the same shape
for css). So the proof is layered:

- the driver's bytes: already proved by decrypting them (`webpush.test.ts`)
- the helper: against a fake `pushManager` whose `subscribe` records its
  options and answers a canned subscription
- the worker: load `sw.js` in a worker context and dispatch a synthetic
  `PushEvent`; assert `showNotification` was called with the payload's title
  and the click handler opens `url`
- end to end: one headed drive, marked as needing a display in `DRIVES.md`,
  run on the owner's machine rather than in CI

Also true and worth one line each in the README: iOS delivers push only to an
installed PWA (manifest exists, Homestead); push needs HTTPS or `localhost`,
so dev works and a LAN phone does not; a payload over the cap sends an id and
the worker fetches the rest, which means the worker's fetch carries the
session cookie and a bearer-only app cannot use that pattern.

---

## Phases

### Phase 0 — rulings and wording

Goal: one owner per piece before any file moves.
Done when: `FJS-D1442` is closed in `DECISIONS.md` and the driver header, the README and § 16 say the same thing about the row.

- [x] 0.1 Ruled [`FJS-D1442`](../DECISIONS.md#fjs-d1442) A, with Q1 A, amended with the fragment finding above: the subscription is the app's row from text the package ships, as `Notification` already is. Decide with it whether `push: true` writes a worker without `offline` (Q1).
- [x] 0.2 One line in `drivers/webpush.ts`'s header and the README's Web Push section: the row is the app's, its text is `db/notification.lite`'s, installed and drift-graded; and one line in `ecosystem-gaps.md` § 16 saying the Model it asked for is the installed fragment.
- [x] 0.3 Fix `browser-kit.md` 5.1's wording: push is a TRANSPORT, not a channel (`FJS-D06`). Browser-kit Phase 5 then points here rather than carrying its own steps.

### Phase 1 — the row and the route

Goal: a subscription arrives at the API and lands as a gated, encrypted row with no app code.
Done when: `bun run test` in notifications covers the fragment and the route, and `example`'s schema gains the model by `fli new --with notifications` alone.

- [x] 1.1 `PushSubscription` joins `db/notification.lite` (or a sibling the same install appends): `endpoint @unique`, `p256dh @encrypted`, `auth @encrypted`, `userId`, `userAgent`, `lastSeenAt`, `@@gate` own-rows-only, `@@softDelete`. `package-model-drift` extends to it. Mind Invariant 2 (PascalCase singular) and Invariant 7 (keys redact).
- [x] 1.2 The `subscriptions` store defaults from the fragment: `list` reads through `asSystem()` (the driver header already says why), `remove` soft-deletes by endpoint. The `webPush({ subscriptions })` option stays for an app whose row lives elsewhere.
- [x] 1.3 A `push-subscriptions` service: `create` upserts by endpoint under the principal, `delete` retires. No `list` beyond own rows. Refuse a subscription whose `p256dh` is not 65 bytes or `auth` not 16, the same checks the driver makes, so a bad row is refused at the door rather than at send time. Built in `packages/notifications/services.ts`. It also refuses a delegated caller (`FJS-D1623`) and an endpoint that is not public HTTPS, and the driver grades the endpoint again before every send. The opt-out and rename are `FJS-D1624`.
- [x] 1.4 Register-and-snapshot: the fragment appears in `notifications.snapshot.md`'s neighbor or its own line, and the `snapshots` CI phase rechecks it. `example`'s schema carries the copy with its migration, so its `app`, `access`, `ddl`, `jsonschema` and `release` snapshots name the service, the gate, the encrypted keys and the table; no generator changed.

### Phase 2 — the worker

Goal: a build that asks for push emits the handlers, with or without an offline shell.
Done when: a Sierra build with `push: true` writes `sw.js` whose `push` handler shows `{ title, body, url }` and whose `notificationclick` focuses or opens `url`; the compiler test parses the output (Invariant 15).

- [x] 2.1 `sierra.config.js` `push: true`. `offline-shell.js` writes a worker when either key is on; with `push` alone the precache list is empty and the fetch handler is omitted, so a push-only app's worker intercepts nothing. Built: `writeOfflineShell(offline, outDir, root, push)`; anything but a boolean is refused; push alone writes no budget baseline and its `activate` still sweeps a left-over `fjs-shell-` cache. `test/offline-shell.test.js` § push: true runs the emitted source.
- [x] 2.2 The two handlers, from the wire contract: `push` parses JSON, `waitUntil(showNotification(title, { body, data: { url }, tag: topic }))`; `notificationclick` closes, then `matchAll({ type: 'window' })` → focus the first same-origin client and `navigate(url)`, else `openWindow(url)`. Built: `pushSource(scope)` in `offline-shell.js`, appended to either worker. The driver kept `topic` out of the payload, so `buildPushRequest` now sends it in both the `Topic` header and the payload (decision-rules: A); the app's `data` is spread under `url`; a non-JSON body is shown as text; a click with no url opens the scope. `test/offline-shell.test.js` runs both handlers against stand-ins — 2.4's real worker context is still owed.
- [x] 2.3 The payload shape has one owner: `PushMessage` in `drivers/webpush.ts`, plus one JSON fixture that the driver test and the worker test both read. The two READMEs point at it and copy nothing, so a change to `PushMessage` breaks a test in Sierra rather than a sentence. Built: `notifications/test/fixtures/push-message.json` holds `message` → `payload` → `shown`; the driver test decrypts to `payload` and holds `message` to `satisfies Required<PushMessage>`, so a new field is a type error until the fixture carries it; Sierra's worker test fires `payload` and expects `shown`. Sierra's README gained the `offline` and `push` rows it lacked.
- [x] 2.4 Worker test: load the emitted source in a worker context, dispatch a synthetic `PushEvent`, assert the `showNotification` call; same for the click. This is the "decrypt what you encrypt" test's browser-side twin. Built: `sierra` `test:push-worker` (`test/browser/push-worker.mjs`) registers the push-only worker in headless Chrome and delivers a TRUSTED push over CDP (`ServiceWorker.deliverPushMessage`) rather than a synthetic one, since a script-built event refuses `waitUntil`; `getNotifications()` must equal the fixture's `shown`, a second push on one topic replaces the first, a non-JSON body shows as text. The click can only be script-built, so `waitUntil` is shimmed and the browser refuses `focus()` / `openWindow()` outside a real click: the drive asserts the close and which refusal came back, and the focus and navigation themselves move to 4.2. Measured: a `getNotifications()` overlapping a `showNotification()` still being stored can lose that notification, so the drive reads the store only after the handler's call settles.

### Phase 3 — the helper and the keys

Goal: the client call and the key command, so the README's whole Web Push section is one formatter and two commands.
Done when: `example` subscribes from a settings toggle and a `notify()` with a `push:` formatter reaches the driver with a real row.

- [x] 3.1 `@frontierjs/notifications/client` `subscribeToPush({ vapidPublicKey })`: waits for `serviceWorker.ready`, converts the key to a `Uint8Array` (a bare string fails on Safari), `subscribe({ userVisibleOnly: true, applicationServerKey })`, posts `toJSON()` to the Phase 1 service. Plus `unsubscribeFromPush()`. Registers no worker itself. Where it lives relative to browser-kit's signal shape is Q2. Built: `packages/notifications/client.ts`. Both functions take `{ service }`, a junction service proxy rather than a name, so a server-side rename is stated once by the app; decision-rules chose this (B) over a `client` plus name default and over bare `fetch`, and 3.3's key read uses the same proxy. A page with no registered worker throws instead of waiting on `ready` forever. A permission of `denied` throws. A held subscription made under another key has its row retired and is unsubscribed before the new one is made: a scratch probe showed rotation otherwise left the old row live until a 410. `unsubscribeFromPush` retires the row, then the browser's subscription. Probed against the real service through the test harness with a fake `pushManager`; the committed test is 4.1's.
- [x] 3.2 `fli crypto:keygen vapid --env`: a third `type` beside `secret` and `aes` on the command that exists (`packages/cli/commands/crypto/keygen.md`), writing both halves and the subject, printing the public key, refusing to overwrite without `--rotate`. Rotating invalidates every subscription; the command says so. `notifications:install` prints the command. Built: decision-rules named the env names `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (`PUSH_*` is already Basecamp's ntfy) and the pair's one owner, so the command imports `generateVapidKeys()` from the app's installed `@frontierjs/notifications` and refuses, naming the install, when it is absent. `--subject` (mailto: or https:) is required unless the `.env` holds one; `--length`, a non-base64url `--format`, `--name` and `--rotate` without `--env` are refused rather than ignored. With `--env` only the public key is printed; `--dry` prints nothing it did not write. Probed every branch against `example` into a scratch `.env`, and the written pair signs a `vapidAuthorization` JWT that verifies against the written public key; no test file added, 4.1's turn.
- [x] 3.3 The public key reaches the browser as a signed-in `GET` on the `push-subscriptions` service ([`FJS-D1626`](../DECISIONS.md#fjs-d1626)). `subscribeToPush` reads it when no `vapidPublicKey` is passed. Built: `GET /push-subscriptions/key` is the service's `get`, answering `{ publicKey }`; `key` is its only id, any other is a 404 pointing at the list, and an anonymous caller is a 401. `webPush()` carries `vapidPublicKey` on the driver and the plugin hands the one under `transports.push` to the service at boot; with none (ntfy, or no push) the read is a 404 naming `webPush({ vapid })`. `subscribeToPush` reads the key AFTER the permission prompt, since a round trip before it can outlast the click's user activation; a passed key is still graded before anything else. One case joined the service's describe in `test/webpush.test.ts`; HTTP routing (`GET /key` → `get` with id `"key"`) and the client's order (prompt → key → subscribe → create) were probed in scratch.
- [x] 3.4 A `PushToggle` in `examples/` beside `Notification.mesa` — the gesture the permission prompt needs, showing granted / denied / unsupported. Copy-in, not kit, until a third app wants it. Built: `packages/notifications/examples/PushToggle.mesa` reads the browser's own answer at mount (support, `Notification.permission`, the worker's subscription) and never the server's row; `denied` has no button, since a page cannot re-ask. Copied into `example` and `thod`.
- [x] 3.5 `example`: toggle on the account page, `OrderPaid` gains a `push:` formatter, README's Web Push section rewritten to the one-formatter shape. Built ([`FJS-D1636`](../DECISIONS.md#fjs-d1636)): `via` naming `push` with no driver throws at `notify()`, so `example/api/src/core/push.ts` is the one answer to "is push on" (all three `VAPID_*` set) that `app.ts`'s registration and `OrderPaid`'s `via` both read; no per-boot dev pair, since it would rotate the key on every restart. `push: true` sits beside `offline`. The README section opens with the five-line recipe. A scratch probe sent `OrderPaid` to a real row with the push service's fetch stubbed: one aes128gcm request with `Topic: order-<id>` and a VAPID header, row still live. `thod` carries the same wiring and its `PushSubscription` copy with a migration, but no notification names `push` yet.
- [ ] 3.6 No double ([`FJS-D1627`](../DECISIONS.md#fjs-d1627)). The browser client's socket sends one frame on `visibilitychange`, and junction keeps the latest value on that `Connection`. The webPush driver skips a recipient with any visible connection. Test: two sockets for one user, one hidden and one visible, gets no push; both hidden gets one.
- [ ] 3.7 `push: { always: true }` on a definition sends whether a tab is visible or not. Name the one-process limit in the README's Web Push section.

### Phase 4 — the drive

Goal: proof at every layer the machine allows, and one headed run for the rest.
Done when: `fli proves` names the layered tests for a change here, and the headed drive has run once on the owner's machine with the tab closed.

- [ ] 4.1 Helper test against a fake `pushManager`: records `subscribe` options, asserts `userVisibleOnly`, the key bytes and the POST body.
- [ ] 4.2 `verify:push` in `example`: headed Chromium, persistent profile, `grantPermissions`, a fake push service standing in for the browser's (the driver's `deliver` option), then a real `notify()` and a `showNotification` observed in the worker, and a REAL click on it: the open tab focused and navigated to `url`, else a window opened at the scope (2.4 could only name the branch; a script-built click is refused both). No CDP call clicks an OS notification, so how a headed run clicks one is unproven; if none can, reopen it in `DECISIONS.md` rather than leave the focus path unproved. Marked in `DRIVES.md` as needing a display.
- [ ] 4.3 Retire-on-410 proved end to end: the fake service answers 410 for one device, the row is soft-deleted, the next send lists one fewer.

---

## Open questions

- ~~**Q1 — Does `push: true` write a worker when `offline` is off?**~~ Answered **A** in [`FJS-D1442`](../DECISIONS.md#fjs-d1442), 2026-10-29. A: yes, with an empty precache and no fetch handler. B: no, push requires `offline`. Recommend **A** — a push-only app is the common case and must not be made to adopt an offline shell to get it. This coins an option, so it runs `decision-rules` with `FJS-D1442`.
- ~~**Q2 — Is `subscribeToPush` a plain async function or a browser-kit signal?**~~ Answered **function** in [`FJS-D1625`](../DECISIONS.md#fjs-d1625), 2026-10-29. A function first: it is called once from a gesture and the state a page wants (`granted` / `denied` / `subscribed`) is `Notification.permission` plus one row, which the browser kit can wrap later as `pushSubscription()` reading this. Recommend the function; the signal is browser-kit 5.1's to add over it.
- **Q3 — Command name.** Answered by `decision-rules` on 2026-10-28 before anyone built: `encryptionKey` has no command of its own, `fli crypto:keygen` is the key-making owner (`type` is `secret|aes`), so `vapid` is a third type there and no new noun (confidence 3). Stays listed so the number resolves.
- ~~**Q4 — How the public key reaches the browser.**~~ Answered **B** in [`FJS-D1626`](../DECISIONS.md#fjs-d1626), 2026-10-29. A: Sierra inlines `PUSH_PUBLIC_KEY` at build. B: the API answers `GET /push-subscriptions/key`. Recommend **B** — the key is the API's secret's public half and a build should not need to know it; one unauthenticated read is cheap and rotation needs no rebuild.
- ~~**Q5 — Does the in-app driver's `notifications created` broadcast and a push to the same person double up?**~~ Answered in [`FJS-D1627`](../DECISIONS.md#fjs-d1627), 2026-10-29: never. The driver skips a user with a visible tab, and `push: { always: true }` overrides it. The recommendation below was turned down. Steps 3.6–3.7. A phone with the tab open gets a WebSocket frame and a push. Recommend: the formatter decides (`via()` already returns the transport list per recipient), and the README shows `push` only when no live connection is joined, which `channels()` knows.

---

## See also

- `packages/notifications/drivers/webpush.ts` — the built half and its header
- `packages/notifications/README.md` § Web Push — what an app writes today
- `IDEAS/owed-rulings.md` § `FJS-D1442` — the three options for the browser half
- `IDEAS/ecosystem-gaps.md` § 16 — the subscription-is-a-Model argument and the payload-leaves-the-building trap
- `IDEAS/homestead.md` Phase 3 — the worker file and why Sierra writes it
- `IDEAS/browser-kit.md` Phase 5 — the two steps this plan absorbs
- `ISSUES.md` `FJS-3395` — the open row
- Prior art: [laravel-notification-channels/webpush](https://root.packagist.org/packages/laravel-notification-channels/webpush) (migration + trait + `webpush:vapid`), [laravel-webpush-kit](https://packagist.org/packages/amjadiqbal/laravel-webpush-kit) (prunes on 404/410), [django-webpush](https://pypi.org/project/django-webpush/) (owns model, template button), [Notificare on headless Web Push](https://notificare.com/blog/2021/01/08/Automated-browser-tests/), [PushOwl on mocking `pushManager.subscribe`](https://build.pushowl.com/mocking-web-push-notification-in-cypress)
