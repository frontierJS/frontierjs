# @frontierjs/conduit-quo

Quo (formerly OpenPhone) over `@frontierjs/conduit`. Covers sending a text,
the read that finds a send whose answer was lost, webhook management (create,
list, get, update, rotate, delete), both webhook signature generations as conduit
Dialects, message, call and contact events handed over as mirror rows from either generation,
tasks: the row, its verbs, a call per change, and its twelve events; and
the workspace's phone numbers, their settings and members; its users and
the organization itself; and its A2P (10DLC) registration.
`docs/PLAN.md` holds the plan; every step in it is built.

**Sink-only.** No Quo key has been used, and the shapes and codes come from
Quo's two published OpenAPI specs (v1 and `2026-03-30`). The receiving half
was extracted from `fjs-prototypes/quo/api/src/providers/quo/`. The rest was
written new.

## Two generations, one origin

The dated API (`Quo-Api-Version: 2026-03-30`) covers reads, webhooks and the
Standard Webhooks signature, but it has **no send endpoint**. Sending is
`POST /v1/messages`. So `quoTargets()` returns two descriptors, `{ v1, dated }`,
that share one key. `bindQuo(conduit, targets)` returns `{ v1, dated }` Sends,
and each call chooses its own generation. Callers never choose.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `quoTargets({ ref?, address?, id?, fileDestinations? })` returns `{ v1, dated, files }`. The raw key goes in `Authorization` with no `Bearer`. Only the dated target pins the version header. `files` is request-addressed with no credential, for signed file URLs |
| send | `sendMessage(quo, { from, to, text, userId?, setInboxStatus?, defaultCountry? })` returns `{ message?, error?, attempt }` |
| C6 read | `findSent(quo, attempt)`: our outgoing messages to exactly that recipient set since the attempt, matched on text |
| reads | `getMessage(quo, id)`, `listWebhooks(quo)`, `getWebhook(quo, id)` |
| call artifacts | `getCall(quo, id)` returns `{ row }` with the summary and voicemail columns. `getCallRecordings(quo, id)` returns `{ rows }`, a `Recording` row per segment with a fresh signed `url`. `getCallTranscripts(quo, id)` returns `{ transcripts }`, one per segment, or none. `fileBytes(quo, url)` returns `{ bytes, type }` for any signed URL Quo hands out; an expired one is `gone` |
| delivery log | `listDeliveries(quo, webhookId, { status?, eventType?, resourceId?, createdAt?, after?, limit? })` returns one page newest first and `nextCursor`. `getDelivery(quo, webhookId, deliveryId)` adds the body sent and each attempt. `retryDelivery(quo, webhookId, deliveryId)` queues one more attempt, replayed. `healDeliveries(quo, webhookId, { since })` retries every `sending` and `failed` delivery since then, oldest first, and returns `{ retried, unretried }`. `sendTestEvent(quo, webhookId, eventType)` returns `{ event }`, the sample Quo then delivers, replayed |
| inbox state | `markRead(quo, conversationId)`, `markDone` and `markOpen` return `{ row?, error? }`, the conversation as the list reads it. Replayed. Quo never reports the state back, on an answer or an event, so an app that shows it keeps its own column |
| tasks | `getTask(quo, id)` and `backfillTasks(quo, { after?, pages? })` read whole `Task` rows; the list takes no bound, so a pass is the whole book, `deleted` tasks included. `setTaskStatus(quo, id, status)`, `linkTask`/`unlinkTask(quo, id, conversationId)`, `assignTask`/`unassignTask(quo, id, userId)` and `setTaskDueDate(quo, id, dueDate \| null)` each return `{ row?, error? }`: the task's id, its new `revision` and what the call set. Replayed |
| phone numbers | `getPhoneNumber(quo, id)` returns `{ row }`, a `PhoneNumber` row with its restrictions and business hours. `backfillPhoneNumbers(quo, { after?, pages? })` reads the whole book with restrictions and without business hours, which the list refuses. `getPhoneNumberSettings(quo, id)` and `updatePhoneNumberSettings(quo, id, { autoRecord?, callDisclosure? })` return `{ row }`, the `autoRecord` and `callDisclosure` part of the row; the update is replayed. `getPhoneNumberMembers(quo, id)` returns `{ row, users }`, the `memberExternalIds` part read to the last page and each member as a `User` row without its picture or times, or no row at all. `availablePhoneNumbers(quo, { areaCode?, contains?, countryCode?, inLocality?, inRegion?, tollFree?, limit? })` returns `{ numbers }`, E.164 strings; the API buys none. No event reports a number |
| users and the organization | `getUser(quo, id)` returns `{ row }`, a whole `User` row. `backfillUsers(quo, { after?, pages? })` reads the whole book; the list takes no bound. `getUserPhoneNumbers(quo, id)` returns `{ rows, error? }`, the user's numbers as `PhoneNumber` rows with restrictions, keeping the rows read before a failure; it writes no membership, and `[]` does not prove the user exists. `getOrganization(quo)` returns `{ row }`, the one `Organization` row; `subscriptionStatus: 'expired'` is when a send is `billing`. No event reports either |
| A2P registration | `getA2PRegistration(quo)` returns `{ registration }`, Quo's object with its times as `Date`, or `null` when the workspace has none. `createA2PRegistration(quo, draft)` names every field and is unreplayed; a second is Quo's 409. `updateA2PRegistration(quo, changes)` merges, `address` and `personOfContact` one level down, and is replayed; a patch naming the business name, type, website or contact name restarts autofill and must carry `messageTypes`. `submitA2PRegistration(quo, { forbiddenMessageTopicsAcknowledged: true })` bills, so it is unreplayed; a 409 is read, and a registration already submitted answers as the submit done. No row: no event reports it, and it carries the tax ID |
| retry | `retryMessage(quo, id)`: a `failed` text again, same `AC…` id. A permanent failure or `undelivered` is `refused`; a lost answer is `indeterminate`, never replayed |
| webhooks | `createWebhook(quo, { url, events, resourceIds?, label?, status? })` returns `{ webhook, key }`. The key is returned **only here**. `updateWebhook(quo, id, { url?, events?, resourceIds?, label?, status? })` changes only what is given and is replayed. `rotateWebhookKey`, `deleteWebhook` |
| rules (C9) | `toE164`, 1–10 recipients, non-blank text of at most 1600 characters, at least one event, an `AC…` id to retry, a digits-only webhook id, a non-empty delivery id, a delivery page of 1–50, a test of one of the 31 event types, an update with at least one field and, when it names `events`, at least one of the 31, a `CN…` id to mark, an `AC…` id for a call read, a URL to fetch, a `PN…` id for a number call, a `US…` id for a user call, a number update naming its name (1–500) or business hours (each day one of the seven, each window `HHMM`, the timezone IANA), a settings update naming one of the three disclosures, at most 100 available numbers, and an A2P write within the spec's schema (every field on a create, the write enums, 1–255 characters, integer counts, 1–5 regions, a URL, an email, an E.164 contact number, no unknown key, `messageTypes` with an autofilling patch) and a submit acknowledging the forbidden topics. All are refused before sending |
| error mapping | `translate`: see the table below |
| verifiers | `verifyQuoSignature` (Standard Webhooks, `whsec_`, seconds) and `verifyQuoLegacySignature` (`openphone-signature`, milliseconds). Both work on raw bytes |
| dialects | `quoDialect` deduplicates on `webhook-id`. `quoLegacyDialect` deduplicates on the envelope id. Both hand a message, call, contact or task event over as its mirror row (`payload.message`, `.call`, `.contact`, `.task`), holding only the columns the event names, with `errorCode`, `external`, `conversationExternalId` and `contactExternalIds` (Quo's own match of the other side's number) beside it. The summary and voicemail events fill the call's row; `payload.recordings` and `payload.transcript` carry the other two. `quoDialect` answers a test sample `ignored` |
| events | `QUO_EVENT_TYPES`: all 31 that `POST /webhooks` accepts |
| backfill | `backfillMessages(quo, { since?, after?, pages? })`, `backfillCalls` and `backfillConversations` the same, `backfillContacts(quo, { after?, pages? })`. Each returns `{ rows, truncated, after, error? }`: mirror rows, 50 a page, at most `pages` (20) a pass, `after` to resume. `since` is inclusive. Conversations are read by when they changed, oldest first; contacts take no time bound, so a pass is the whole book. `getContactProperties(quo, contactId)` returns `{ row }`, a contact's `phoneNumbers` and `emails`, read to the last page, or no row at all |
| mirror | `mirror`, the claim for `app.conduit.mirror()`: `Message`, `Conversation`, `Contact`, `Call`, `Recording`, `Task`, `PhoneNumber`, `User` and `Organization` rows keyed on `externalId`, relations as `<relation>ExternalId`, times as `Date`, empty as `null`. `Contact` has `create`, `update` and `delete`, in the row's names (`sourceId` goes out as Quo's `externalId`); with `sourceId` and `source` stated, a second create is Quo's 409, never a second contact. `Task` has the three too: create is unreplayed, update sends the title and description together, and delete is a status, so the row stays `deleted`. A task row from a write or an event holds only what it names. `PhoneNumber` has `update` alone, the name and business hours, replayed; a patch naming a setting is refused naming `updatePhoneNumberSettings`. The other six are Quo's to write |
| sink | `sink.ts`. It mints a `whsec_` key per webhook created and signs every delivery with that key |
| drive | `bun run drive`, 115 rows, against the sink only |

## Errors

The body's `code` decides before the status does.

| Quo answer | HTTP | `QuoFailure.kind` | retryable |
| --- | --- | --- | --- |
| `0206400` A2P Registration Not Approved | 400 | `unregistered` | no, until 10DLC is approved |
| `0200429` Daily Conversation Limit Reached | 429 | `quota` | no, not today (it is **not** the rate limit) |
| `0204403` A2P 10DLC Daily Message Cap | 403 | `quota` | no, not today |
| `Open Tasks Limit Reached` (by its title; no code) | 402 | `quota` | no, until a task is completed or deleted |
| `0201402` Subscription Expired (any other 402) | 402 | `billing` | no |
| not a member of the number, international messaging off, any other 403 | 403 | `forbidden` | no; the key is good |
| 404 | 404 | `gone` | no |
| other 4xx | 4xx | `refused`, with `fields[]` naming each bad path | no |
| per-key rate, 10/s | 429 | `rate_limited`, with `retryAfterMs` | by the caller; a send is never replayed |
| 5xx, or a timeout on a send | — | conduit's kind, `indeterminate` | call `findSent` before sending again |

## Webhooks

- **The generation is fixed per subscription.** A webhook created through
  `createWebhook` signs Standard Webhooks. One created in the Quo app or on
  `/v1/webhooks` signs the legacy header. Quo migrates nothing. To receive
  both, an app mounts both dialects, at two paths or behind a dispatch on the
  header.
- **Deduplicate on `webhook-id`, not the envelope `id`.** The `id` names the
  EVENT and is the same for every subscription. `webhook-id` names one
  delivery and stays the same across Quo's retries, which run for about 27
  hours.
- **A rotation takes effect at once.** Store the key `rotateWebhookKey`
  returns before the next delivery, or that delivery fails verification.
- **An event's row is partial.** A webhook resource names fewer fields than
  a read: `call.missed` is the call's id and two times, and no message event
  carries `updatedAt`. A column the event does not name is left out of the
  row, not set to `null`, so an upsert of it keeps what a read wrote. A
  contact resource is whole, and its `null` clears.
- **A call event names the other side; its row does not.** The dated context
  marks `participants.workspace` (ours) and `.external` (theirs); the row's
  `participants` is a read's list of every party with its user. So the row
  carries none, and `payload.external` is the other side's numbers.
  `menu.selected`, `forwarded` and `missed` carry no direction, and Quo sends
  them for incoming calls only. When Quo marks the participants
  `unavailable`, `external` is `null`, which means unknown, not nobody.
- **Quo matches the number to a contact.** `payload.contactExternalIds` is
  Quo's own lookup on a message or call event: `[]` when it found none,
  `null` when it could not look, on `call.ringing` (sent before the lookup)
  and on legacy. At ring time, match `external` against the Contact rows'
  `phoneNumbers` yourself.
- **A contact's numbers and emails come from an event or a read, never the
  contact list.** On a row from `backfillContacts` they are absent rather
  than `[]`, so an upsert keeps them. `getContactProperties` fills them, one
  request per contact on a key limited to 10 a second.
- **A test delivery writes nothing.** Every id in Quo's sample is a sample,
  its `orgId` (`ORsampleorg…`) included. `quoDialect` verifies it and
  conduit answers it `ignored`, so the endpoint is proved and no row lands.
- **A call's `status` belongs to its generation.** Legacy sends `ringing` and
  `completed`. Dated sends a status on `call.completed` only (`answered`,
  `unanswered`, `forwarded`, and others), and `null` on every other event.
- **An artifact names its call as `callId`.** The summary and voicemail
  events land on the call's row, in the columns each names; the voicemail
  event's own `id` is another activity. A voicemail Quo could not tie to a
  call has no row. The transcript event names no recording, so it is
  `payload.transcript`; `call.recording.completed` puts each segment in
  `payload.recordings`.
- **Keep the file, not the URL.** Every recording, voicemail and media URL is
  signed and stops answering. `fileBytes` fetches it through the `files`
  target, which sends no key, and an expired one comes back `gone`: read
  the call or its recordings again for a fresh URL.
- **The delivery log is joined on `webhook-id`.** A listed delivery's
  `id` is the header the receiver saw. A delivery the receiver refused
  reads `sending`, with `nextAttemptAt`, while Quo keeps retrying, and
  `failed` only once it gives up, so `healDeliveries` lists both. Run it
  on a schedule with `since` set to the last pass, a little early.
- **An update is partial, but each field is whole.** `events` replaces the
  list, so adding one event means sending every event the hook keeps.
  `label: null` clears; a field left `undefined` is not sent.
  `resourceIds` `null`, `[]` and `['*']` all mean every number, so an empty
  list is not "none": to hear nothing, set `status: 'disabled'`.
- **A test event is a sample.** `sendTestEvent` answers with the envelope
  Quo will send, and every test carries the same envelope `id`, which is
  one more reason to deduplicate on `webhook-id`. `quoDialect` answers it
  `ignored`, so no sample row lands.
- **Delivery order is not guaranteed.** `message.delivered` can arrive before
  `sendMessage` returns. `sent` and `delivered` are two columns.

## Not built

Every step of `docs/PLAN.md` is built.
A lost task create has no key to find it by but the whole book. A legacy recording
names no id and lands no row.
A contact's custom fields are not kept, and its properties have no verbs.
MMS stays out, because v1's send takes text only.

## Chaos the sink owns

`{ lost }`, `{ rateLimit }`, `{ failNext }`, `{ deliverTwice }`,
`{ deliverFirst }`, `{ failDelivery: 'failed' | 'permanent' | 'undelivered' }`,
and `{ refuse: 'unregistered' | 'dailyCap' |
'conversationLimit' | 'subscription' | 'notMember' }`. A `+44` recipient is
international. `POST /_sink/inbound` makes the sink text our number. Every dated delivery
is logged for `GET /webhooks/{id}/events`; a refused one stays `sending`
until `POST /_sink/exhaust` turns it `failed`. A delivery retry makes one
`manual` attempt, signed with the hook's current key and a fresh timestamp.
A test event is delivered whatever the hook subscribes to, under its own
`webhook-id`, with the spec's fixed sample envelope id.
`{ expireFiles }` makes the next file fetch an expired URL's 403.
`POST /_sink/call` with `{ ours, theirs, direction, answered, unresolved?, segments?, voicemail? }`
places a call and delivers its events in both generations, and keeps it for
`GET /calls`. A text or call lands in its conversation. `POST /_sink/seed`
with `{ messages?, calls?, conversations?, contacts?, phoneNumbers?, users?, organization? }` adds rows dated in
the past; a seeded contact may list its `properties`, and a seeded number a
count of `members` or the `memberIds` of users who exist; `organization` sets
the workspace's fields. Every list pages by an `after` cursor, and `{ forbidAfter: n }`
answers the list read after the next `n` with a 403. A contact is created,
patched and deleted; two sharing a `source` and `externalId` is a 409. A
contact's properties are `GET` and `POST /contacts/{id}/properties`, and a
message or call context names the contacts holding the other side's number.
A task is made in a conversation that exists; every change moves its
revision and delivers its event. `{ openTasksFull: true }` is the 402 on a
create or reopen, and `POST /_sink/overdue` sends `task.overdue`.
Each of our numbers is a phone number whose members are the three users; its
PATCH merges a schedule's days into the stored one (our reading), and the
available numbers come from a fixed pool. The users list by id, and an
unknown user's numbers are `[]`, since the spec names no 404 there.
One A2P registration at most: autofill runs 60 ms after a create or an
autofilling patch, a submit inside it is the 409, and a submit counts a
payment. `{ paymentFails }` is the submit's 402 and `{ autofilling }` its
409 once more; an expired workspace's create is the 402. `POST /_sink/a2p`
is the carrier's verdict (`{ status, statusMessages }`), or `null` to remove
the registration.
