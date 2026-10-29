---
id: phone-ping
status: proposed
dated: 2026-10-28
---

# Phone ping — one toggle, and a critical notification reaches a phone

**Status: PROPOSED.** Dated 2026-10-28. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. `IDEAS/workbench.md` row 9
(*Phone alerts — ntfy or web push*) is the parent; this paper is its shape.

The want: an app flips one switch and its critical notifications ring a phone.
Basecamp first — a monitor down at 3am, a failed deploy, a server that stopped
checking in. An email is read in the morning; a ping is heard.

## What ntfy is, and what of it transfers

ntfy (`binwiederhier/ntfy`, read at `3cb7a98`, 2026-10-27) is a topic pub/sub
server with a phone app. Its heart is ~1,500 lines of Go: a topic is an in-memory
map of subscriber closures with a per-subscriber send chain so order holds; a
message is one struct; the cache is one SQLite table that doubles as the
replay log for `since=`; publish is `POST /<topic>` with the body as the text
and headers as metadata (`Title`, `Priority`, `Tags`, `Click`, `Actions`). The
other ~45k lines are accounts, tiers, billing, cluster, Firebase, Matrix,
Twilio, SMTP — plugin points, not the heart.

Graded against `@frontierjs/notifications`, nothing of the heart is missing
here: junction's `app.channel()` is the topic fan-out, the `Notification` row
is the replay log, `readAt` is the cursor. The rig is a different noun — a
notification AUTHORED to a RECIPIENT over several transports — and porting
ntfy's topic model into it would be a second fan-out beside one that exists.
Three ideas transfer, and all are small:

1. **A phone is one HTTP request away.** ntfy's publish protocol is an
   authenticated POST with six headers. A transport driver that speaks it is
   a formatter, not a vendor SDK, exactly the shape `drivers/webpush.ts` already
   takes for RFC 8291 — and unlike a push service, ntfy answers 4xx/5xx
   honestly.
2. **Priority is a property of the message.** ntfy's `Priority: 5` (urgent)
   breaks through Android do-not-disturb. The rig's `InAppMessage` has no
   priority; a ping without one is a ping that is muted when it matters.
3. **A topic is an address, and a known one is a channel.** ntfy's own model is
   that a phone subscribes to a NAME. With the blueprint's `deny-all` default,
   a name is readable only by a user or token granted `read` on it, and ntfy's
   admin API (`/v1/users`, `/v1/users/access`) grants that. So who hears a
   workspace's pings is decided in the ntfy app by subscribing, and Basecamp
   publishes each event ONCE.

Web push is the other road and the driver already exists. It loses on the
phone: iOS needs the PWA installed to the home screen before it hears anything,
and every app would need a service worker. The ntfy app is installed once,
subscribes to a topic, and the Basecamp `ntfy` blueprint already stands up the
server on the operator's own box (`db/blueprints.js`, `NTFY_*` params,
including the iOS relay).

## The design — known topics, an `ntfy()` driver under `push`

**One POST per critical event to `<workspace-slug>-critical`. The toggle is the
env pair that registers the driver.** Ruled Q1–Q4 on 2026-10-28.

- `packages/notifications/drivers/ntfy.ts` — `ntfy({ url, token, deliver? })`
  answers a `NotificationDriver` under `transport: 'push'`. It reads
  `recipient.pushTopic`, refuses an absent one by name, and POSTs
  `${url}/${topic}` with `Authorization: Bearer <token>` and the headers
  below. A `deliver` stub is the test seam, as `WebPushOptions.deliver` is.
- `push:` formatter on a definition → `PushMessage { title, body, priority?,
  tags?, click?, actions? }`. A new builder `push()` beside `inApp()`/`mail()`.
  This is where `@guarded` columns stay out of the wire, the webpush rule.
- **The recipient of a ping is the TOPIC, not a person.** `FJS-096` says a
  Recipient is not a User and names a mailing-list address as the case; a
  topic recipient is `{ pushTopic: 'acme-critical', transports: ['push'] }`.
  So `app.notify` stays the one fan-out: Basecamp sends a critical kind to its
  person-recipients (inApp, email, as today) and to one topic-recipient.
- **Who builds the topic recipient is `domain/notification/notify.ts`** — the
  owner of *who gets told*. It adds the topic recipient when the kind's row in
  `kinds.ts` says `push: true` AND a `push` driver is registered on the app.
  `available()` reads the driver off `app`, never a second config flag.
- **No new column.** `kinds.ts` gains `push: boolean` — *published to the
  workspace's critical topic* — and `db/test/schema.test.ts` already holds the
  enum and that table together. `NotificationPreference` is untouched: a
  person's choice is made in the ntfy app, by subscribing or not.
- **The topic name is `<workspace-slug>-critical`.** One topic in Phase 2 (Q2
  rules failures only). Two Basecamps on one ntfy server would collide on a
  shared slug; that is the hub-name prefix of Phase 3, not Phase 2.
- **Access is ntfy's.** Phase 0 grants `read` by hand (`ntfy access <user>
  <topic> read`); Phase 3 has Basecamp mint a reader token per person through
  the admin API and show it on the Workspace card.

Message shape on the wire, from the formatter:

| header | from | note |
| --- | --- | --- |
| `Title` | `message.title` | |
| body | `message.body` | |
| `Priority` | `message.priority ?? 3` | critical sends `5`, a resend `4` (Q3) |
| `Tags` | `message.tags` | `rotating_light`, `warning`, `white_check_mark` |
| `Click` | `appUrl(message.click)` | opens the Basecamp page |
| `Actions` | `view, <label>, <url>` | one per action |

### The driver, sketched

```ts
// packages/notifications/drivers/ntfy.ts
import type { App, NotificationDriver, Recipient } from '../types.ts'

export interface PushMessage {
  title:     string
  body?:     string
  priority?: 1 | 2 | 3 | 4 | 5
  tags?:     string[]
  click?:    string
  actions?:  { label: string; url: string }[]
}

export interface NtfyOptions {
  url:      string                        // https://ntfy.acme.com — the blueprint's NTFY_BASE_URL
  token:    string | (() => Promise<string>)
  deliver?: typeof fetch                  // the test seam
}

export function ntfy(options: NtfyOptions): NotificationDriver {
  const deliver = options.deliver ?? fetch
  return {
    transport: 'push',
    async send(recipient: Recipient, message: unknown, _app: App) {
      const topic = recipient.pushTopic
      if (typeof topic !== 'string' || topic === '')
        throw new Error('[notifications] push: the recipient names no pushTopic')
      const m = message as PushMessage
      const token = typeof options.token === 'function' ? await options.token() : options.token
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Title:         m.title,
        Priority:      String(m.priority ?? 3),
      }
      if (m.tags?.length)    headers.Tags    = m.tags.join(',')
      if (m.click)           headers.Click   = m.click
      if (m.actions?.length) headers.Actions = m.actions.map(a => `view, ${a.label}, ${a.url}`).join('; ')
      const res = await deliver(`${options.url.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
        method: 'POST', headers, body: m.body ?? '',
      })
      if (!res.ok) throw new Error(`[notifications] push: ntfy answered ${res.status} for topic ${topic}`)
      return (await res.json() as { id?: string }).id
    },
  }
}
```

### Basecamp wiring, sketched

```ts
// api/src/app.ts — the env pair is the toggle
app.configure(notifications({
  db,
  transports: {
    ...(mail ? { email: { mailer: 'default' } } : {}),
    ...(process.env.NTFY_BASE_URL ? { push: ntfy({ url: process.env.NTFY_BASE_URL, token: process.env.NTFY_TOKEN }) } : {}),
  },
}))
```

```ts
// api/src/domain/notification/notify.ts — one more recipient, built once
if (kind.push && available(app).has('push'))
  recipients.push({ pushTopic: `${workspace.slug}-critical`, transports: ['push'] })
```

```ts
// api/src/notifications/MonitorDown.notification.ts — one more formatter
push: (p) => push()
  .title(p.resend ? 'Monitor still down' : 'Monitor down')
  .body(`${p.monitorName}: ${p.message}`)
  .priority(p.resend ? 4 : 5).tags('rotating_light')
  .click(appUrl(`/monitors/${p.monitorId}/`)),
```

## What was rejected or deferred

- **A secret topic per person** (`User.pushTopic @secret` +
  `NotificationPreference.push`, one POST per recipient). Deferred, not
  rejected — Q1 picked known topics as the first door because it adds no
  column, sends once, and the person's filter already exists in the ntfy app.
  A per-person topic is Phase 3's second door for someone who wants a filter
  Basecamp applies.
- **A `conduit-ntfy` connector package.** `FJS-D153` makes a VENDOR connector
  its own package; ntfy here is the operator's own container from the
  blueprint, ordinary HTTPS, no SDK and no account — the same test
  `drivers/webpush.ts` passed. Basecamp's `delivery.ts` already holds Slack
  and PagerDuty as raw `fetch` under that reading. Reopen if hosted ntfy.sh
  with a vendor account becomes the default.
- **`ChannelKind` gains `ntfy`.** A `NotificationChannel` is reached only
  from alert rules and monitors; `DeployFailed`, `JobFailed` and
  `ServerUnreachable` are kinds, not rules, and would never reach it. Also
  half-derivable today: a `webhook` channel pointed at
  `https://ntfy.acme.com/<topic>` posts, minus title and priority. A fourth
  row for on-call channels can follow Phase 2 if a rule needs its own topic.
- **Porting ntfy's topic/cache into the rig.** Second fan-out beside
  `app.channel()`; nothing it adds is missing.

## Open questions

- ~~**Q1 — Which topic model first?**~~ **Answered 2026-10-28 (`FJS-D1586`): A — known topics per workspace: Basecamp publishes each critical event once to `<slug>-critical`; people subscribe phones in the ntfy app; access by ntfy ACL; no new columns.**
  - **A** — known topics per workspace: Basecamp publishes each critical event
    once to `<slug>-critical`; people subscribe phones in the ntfy app; access
    by ntfy ACL; no new columns.
  - **B** — a secret topic per person, `User.pushTopic @secret` +
    `NotificationPreference.push`, one POST per recipient.
  - **C** — both, A first.
  - **Recommend A** — one level simpler, and the person's filter already exists
    where the phone is.
- ~~**Q2 — Which kinds default `push: true`?**~~ **Answered 2026-10-28 (`FJS-D1587`): A — the failures only: `DeployFailed`, `ServerUnreachable`, `MonitorDown`, `AlertFiring`, `PostureFailed`, `JobFailed`.**
  - **A** — the failures only: `DeployFailed`, `ServerUnreachable`,
    `MonitorDown`, `AlertFiring`, `PostureFailed`, `JobFailed`.
  - **B** — A plus `ReplicaFound` and `HubPostureFailed`.
  - **Recommend A** — a ping is an interruption; the two in B are once-a-day
    states a morning email serves. Resolved/succeeded kinds stay off, as
    `email` does.
- ~~**Q3 — Priority per kind or per send?**~~ **Answered 2026-10-28 (`FJS-D1588`): A — the formatter sets it (`MonitorDown` resend is 4, the outage 5).**
  - **A** — the formatter sets it (`MonitorDown` resend is 4, the outage 5).
  - **B** — one priority per kind in `kinds.ts`.
  - **Recommend A** — the sender knows whether this is the outage or the
    reminder; a table cannot.
- ~~**Q4 — Does the ntfy server come from the blueprint or from env?**~~ **Answered 2026-10-28 (`FJS-D1589`): A — `NTFY_BASE_URL` + `NTFY_TOKEN` env on the Basecamp API, set by hand after installing the blueprint.**
  - **A** — `NTFY_BASE_URL` + `NTFY_TOKEN` env on the Basecamp API, set by hand
    after installing the blueprint.
  - **B** — Basecamp finds its own `ntfy` App row and reads the token from its
    Variables.
  - **Recommend A** — it works with ntfy.sh and with a server Basecamp did not
    install; B is Phase 3's zero-config step.

## Phases

### Phase 0 — Prove the wire by hand

Goal: a ping reaches the owner's phone from `curl` through the blueprint's ntfy, on a named topic the phone was granted.
Done when: the phone rings on `curl -H 'Priority: 5' -H 'Title: test' -d hi https://<ntfy>/acme-critical` with a sender token from `NTFY_AUTH_TOKENS` and a reader granted by `ntfy access`, and once more with the iOS relay blank to record what iOS loses.

- [ ] 0.1 Install the `ntfy` blueprint on a box, grant one phone `read` on `acme-critical`, send the curl above; record Android and iOS behavior in this section.

### Phase 1 — The driver and the builder

Goal: `@frontierjs/notifications` delivers on `push` through `ntfy()`.
Done when: `bun run test` in the package has a `push` row proving the request headers through a `deliver` stub, and `verify:notify` in `example/` sends one to a topic recipient.

- [ ] 1.1 `drivers/ntfy.ts` as sketched; `push()` builder in `builders.ts`; `PushMessage` in `types.ts`; export both.
- [ ] 1.2 Test through the `deliver` stub: headers, encoded topic, a missing topic refused by name, a 4xx thrown. (Lifted once the owner says the shape is settled — no new test files while experimenting.)

### Phase 2 — Basecamp's toggle

Goal: with `NTFY_BASE_URL` and `NTFY_TOKEN` set, a monitor going down rings every phone subscribed to the workspace's topic.
Done when: with the blueprint's ntfy and one subscribed phone, pausing a monitor's target rings within one interval; `db/test/schema.test.ts` holds the `push` column against the enum.

- [ ] 2.1 `kinds.ts` gains `push` with Q2's defaults; `notify.ts` builds the topic recipient when the kind says so and a driver is registered; the schema test grows to the third column.
- [ ] 2.2 `app.ts` registers `ntfy()` from env (Q4 A); every critical definition gains a `push:` formatter (Q3 A).
- [ ] 2.3 Workspace settings card: the topic name, the server URL, how to subscribe in the ntfy app, and a **Test ping** button through `app.notify`.
- [ ] 2.4 Hub posture row: *phone pings off* when no driver is registered, beside *no mailer*.

### Phase 3 — Access and the second door

Goal: nobody runs `ntfy access` by hand, and a person who wants their own filter can have one.
Done when: the Workspace card mints a reader token through ntfy's admin API, and a per-person topic receives only that person's `push` kinds.

- [ ] 3.1 Basecamp provisions a reader token per person through `/v1/users` + `/v1/users/access` and shows it once on the card; the hub-name prefix on the topic if two Basecamps share a server.
- [ ] 3.2 The second door: `User.pushTopic @secret` + `NotificationPreference.push`, the per-person recipient beside the topic one — only if someone asks for it.
