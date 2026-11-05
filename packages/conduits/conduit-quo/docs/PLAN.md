---
status: ACTIVE
---

# conduit-quo — plan

conduit-quo calls 6 of the dated API's 64 operations, plus the v1 send. This
plan takes it to the depth of `conduit-mattermost`: calls, every event type,
the gap healer, a mirror claim, and the reads that backfill it.

Sources: the two OpenAPI specs, `openphone-public-api-2026-03-30-prod.json`
and `openphone-public-api-v1-prod.json`, both under
`https://openphone-public-api-prod.s3.us-west-2.amazonaws.com/public/`.
The event payloads are at `https://www.quo.com/docs/2026-03-30/webhooks-event-payloads.md`.
The legacy call object is described at `support.quo.com/core-concepts/integrations/webhooks`.

### Phase 0 — The comparison

Goal: know what conduit-quo covers, against Quo's specs and against conduit-mattermost.
Done when: the baseline drive is green and each gap is a step below.

- [x] 0.1 Compare with conduit-mattermost and with both specs
- [x] 0.2 Baseline: `bun run drive`, 17 rows green

**Done 2026-10-19.** Mattermost has eight patterns that Quo lacks: a mirror
claim, row shapes, backfill reads, gap handling, read-state calls,
`fileBytes`, wide receive coverage, and a reason for each item in Not built.
Two of its patterns do not apply to Quo. Quo has no websocket, and a Quo key
covers the whole workspace, so there is no per-user token. Quo is ahead of
Mattermost in three places: `findSent`, the quota and unregistered error
codes, and verification for both signature schemes.

The spec check corrected the first report in two places:

- **v1's `phoneNumberId` body field is deprecated.** The spec says to use
  `from`, which takes a `PN…` id. Putting the id in `from` is therefore
  correct, and that defect is withdrawn.
- **Dated call events do not carry the message context's field names.** Call
  events carry `participants.workspace` and `participants.external`, with a
  `resolution` flag. Message events carry `senderIdentifier` and
  `recipientIdentifiers`. The prototype read the message names for calls and
  marked that UNVERIFIED, and on the dated envelope it is wrong. So 1.1 does
  not restore the prototype's code; it rebuilds the flattening from the spec.

### Phase 1 — Calls and every event type

Goal: each call event, in either generation, reaches `parse` as one flat shape, and `QuoEventType` names every event Quo accepts.
Done when: the drive has call rows for both generations, and a mutant that reads the message context for a call fails.

- [x] 1.1 Flatten call lifecycle events to one `QuoCallEvent`, for both envelopes
  - This covers events whose `resource.id` is the call: `ringing`,
    `menu.selected`, `answered`, `completed`, `forwarded`, `missed`,
    `recording.completed`.
  - `from` and `to` come from `participants` and the call's direction. When
    `resolution` is `unavailable` they are empty, which means unknown.
  - `menu.selected`, `forwarded` and `missed` carry no `direction`. The spec
    says each happens only on an incoming call, so their direction is
    `incoming`.
  - `status` is passed through as Quo sends it. On the dated envelope only
    `call.completed` has one, so every other dated event gives `null`. The
    connector does not make up a status from the event type, because the
    type already says what happened.
  - The artifact events (`summary`, `transcript` and `voicemail`) name the
    call as `resource.callId` and have their own shapes. 4.2 maps them.
- [x] 1.2 List every event type in `QUO_EVENT_TYPES`, which `QuoEventType` derives from
  - There are 31, not 28. The `POST /webhooks` events list also has
    `integration.created`, `integration.updated` and `integration.deleted`,
    and the payload page documents none of the three.
- [~] 1.3 Send `phoneNumberId` in its own field. Dropped: v1 deprecated the field in favor of `from` (Phase 0).

**Done 2026-10-19.** The drive went from 17 rows to 23. The sink now places
calls, incoming or outgoing and answered or missed, in both generations, and
can mark a call's participants `unavailable`. Five mutants each fail at least
one row: reading the message context for a call, dropping the incoming
default, not swapping sides on an outgoing call, flattening a voicemail as
though it were the call, and dropping the legacy call.

### Phase 2 — The gap healer

Goal: a lost or failed delivery is found and replayed through Quo's delivery log, and a failed send is retried by id.
Done when: drive rows prove that a delivery the receiver refused is listed, retried and then applied, and that a test event verifies.

- [x] 2.1 `retryMessage(quo, id)`, which is `POST /messages/{messageId}/retry`
  - Quo takes only a `failed` message with no `errorCode`. A permanent
    failure or an `undelivered` message is a 422, which `translate` already
    reads as `refused`, so no new failure kind.
  - Not replayed: once a retry is taken the message is no longer `failed`,
    so a replay would be refused and report a retry that worked as one that
    did not. A lost answer is `indeterminate`, and `getMessage` says.
  - A non-`AC…` id is refused before sending (C9).
  - The sink's 422 for a message that is not `failed` at all (queued,
    delivered) is our reading of "only `failed` can be retried"; the spec
    names no answer for it.
- [x] 2.2 `listDeliveries` and `getDelivery`, which are `GET /webhooks/{id}/events[/{deliveryId}]` with a `resourceId` filter
  - One page per call, `nextCursor` handed back as `after`. Paging to the
    end is Phase 3's `truncated` read, not this one.
  - A delivery's `id` is the `webhook-id` header, so the receiver's log
    and Quo's join on it. `eventId` is the payload's, and differs.
  - **Refused is not failed.** A delivery the receiver refused is `sending`,
    with `nextAttemptAt`, for as long as Quo retries (about 27 hours), and
    only then `failed`. So the healer in 2.3 reads `sending` as well, or it
    finds a lost delivery a day late. The sink keeps a refused delivery
    `sending` until `POST /_sink/exhaust`.
  - Filters are the spec's current names: `eventType` or `eventType[in]`,
    `createdAt[gt]`/`[lt]` (exclusive). The deprecated `eventTypes`,
    `createdAfter` and `createdBefore` are never sent.
  - `resourceId` matches nothing made before 2026-09-01; `eventId` and
    `resourceId` are null there and on a test delivery.
  - A dated webhook id is digits (the spec's pattern) and a page is 1–50,
    both refused before sending (C9).
- [x] 2.3 `retryDelivery`, which is `POST /webhooks/{id}/events/{deliveryId}/retry`, and `healDeliveries` over it
  - Quo takes a retry in any state; the spec names no refusal but a 404.
    It queues one `manual` attempt and answers 202 before making it.
  - **Replayed**, unlike `retryMessage`: the attempt carries the same
    `webhook-id`, so a second one is conduit's `duplicate`, and a retry
    whose answer is lost is otherwise a delivery nobody heals.
  - `healDeliveries(quo, webhookId, { since })` lists `sending` and
    `failed` since `since` (exclusive), every page, and retries them
    oldest first so events land in the order they happened. `since` is
    required: a pass over all time would replay a delivery older than the
    receiver's dedupe ever saw.
  - The sink signs a manual attempt with the hook's key at that moment and
    a fresh timestamp, as Standard Webhooks does per attempt (the `msg_`
    ids are Svix's). If Quo reused the first attempt's timestamp, a retry
    older than the receiver's 5-minute window could never verify; that is
    unconfirmed against Quo.
- [x] 2.4 `sendTestEvent`, which is `POST /webhooks/{id}/events/test`
  - Takes one of the 31 event types, refused before sending otherwise (C9).
    Quo answers 200 with the sample it will send, and delivers it later.
  - **The answer has no `data` wrapper.** Every other dated answer is
    `{ data: … }`; this one IS the envelope, `{ id, apiVersion, type,
    createdAt, data }`.
  - **The envelope `id` is one fixed sample shared by every test
    dispatch** (the spec says so). Each dispatch has its own `webhook-id`,
    so `quoDialect` applies each one; a receiver deduping on the envelope
    id applies the first test and swallows every later one.
  - Replayed: a second test is another sample, harmless.
  - The sink delivers a test whatever the hook subscribes to and whether
    it is enabled, and logs it with `eventId` and `resourceId` null. The
    first is our reading of "validate your endpoint before going live";
    the second is the 2.2 spec note.
- [x] 2.5 `getWebhook` and `updateWebhook`, which are `GET` and `PATCH /webhooks/{id}`. Webhook coverage is 10 of 10.
  - `getWebhook` is the list's row and no more; the key is still create's alone.
  - **The PATCH is partial, and its fields are not.** A field left
    `undefined` is not sent; `label: null` is, and clears (the patch rule of
    Invariant 9). `events` REPLACES the list: adding one event is sending
    every event the hook keeps.
  - **An empty number list is every number.** The spec reads `null`, `[]`
    and `['*']` all as "clear phone number filtering", so `[]` is not "no
    numbers". A hook that should hear nothing is `status: 'disabled'`.
  - Refused before sending (C9): a non-digit id, no field at all, an empty
    `events`, and a type outside the 31.
  - **Replayed**, though a PATCH is not idempotent by method: every field is
    set to a value, so a second one changes nothing.
  - The sink keeps the key across an update (the spec names no rotation
    there), reads `null` and `[]` back as `['*']`, and moves `updatedAt`.

### Phase 3 — Mirror claim and backfill

Goal: Message, Conversation, Contact and Call mirror as rows keyed on `externalId`, following conduit-mattermost's `MirrorClaim` shape, with reads that backfill them.
Done when: the `mirror.*` and `backfill.*` drive rows are green, including a `truncated` page.

- [x] 3.1 Row shapes with `parse → row`: `<relation>ExternalId` columns, `Date` times, and an empty value stored as `null`
  - `src/mirror.ts`: `Message`, `Conversation`, `Contact` and `Call`, keyed
    on `externalId`, every model on the dated target. No verbs yet (3.3).
  - A relation column is named for Quo's own field: `userId` →
    `userExternalId`, `actorId` → `actorExternalId`, `answeredBy` →
    `answeredByExternalId`. An empty value is `null` whether Quo sent `null`
    or `''`, an unreadable time is `null`, and an empty list entry is dropped.
  - **A message and a call share the `AC…` id space.** `parse` tells them
    apart by shape: a message has `to`, a call has `participants`.
  - **A contact's `externalId` is not its id.** It is the id the contact's
    source system knows it by, so the row calls it `sourceId`.
  - **A contact's phone numbers and emails are not on the contact.** The dated
    API keeps them at `GET /contacts/{contactId}/properties`, so the row has
    none. Matching an inbound number to a contact needs that read; 3.2
    decides whether the backfill makes it per contact.
  - A call row keeps `participants` as Quo lists them, our number included,
    and has no `from` and `to`: nothing marks which number is ours on a
    call nobody answered, and a group call has more than two.
  - `parse` takes the REST object. A webhook resource is another shape, and
    mapping it is 3.4.
  - The sink's incoming message had `userId: 'USdev'`; the spec says null
    for an incoming message, and the sink now sends null.
- [x] 3.2 Backfill reads over `/messages`, `/calls`, `/conversations` and `/contacts`, paged by `createdAt` and `after`, replayable, and with a `truncated` flag
  - `backfillMessages`, `backfillCalls`, `backfillConversations` and
    `backfillContacts` each answer `{ rows, truncated, after, error? }`.
    A pass reads 50 a page and stops at `pages` (20 by default, 1000
    rows) `truncated`; `after` resumes it. A failure keeps the rows already
    read and the `after` of the page that failed.
  - **The four lists bound time four ways.** Messages take `createdAt[gt|lt]`
    (exclusive), calls `createdAt[gte|lte]` (inclusive), conversations the
    same on `createdAt` or `updatedAt`, and contacts nothing at all. Our
    `since` is inclusive on every read, because a row read twice is an upsert
    and a row missed is gone; the message bound is sent a millisecond early.
    The sink refuses a bound the spec does not name on calls and
    conversations (`additionalProperties: false`), and ignores one on
    messages, where the spec forbids nothing.
  - **Messages and calls are filtered by `createdAt` alone.** A status that
    changes after the pass on an older message or call (`delivered`, a call
    that ends) is the webhook's to bring, or a per-id read's.
  - **Conversations are read by `updatedAt`, ascending.** An old
    conversation with new activity in the gap is the one a backfill exists
    for. Ascending, a conversation that changes while being paged moves to
    the end and is read again, and rows applied in order keep its later
    version.
  - **Contacts are the whole book on every pass.** A contact missing from a
    pass read from its first page to its last was deleted.
  - **The backfill does not read contact properties.** Each one is its own
    paged read, so N contacts would cost at least N more requests on a key
    rate-limited to 10 a second. The properties are their own rows (`id`,
    `type`, `name`, `value`), and that is 3.5.
  - The next pass's `since` is when this pass BEGAN, not its newest row.
  - The sink now keeps calls as `GET /calls` lists them and conversations as
    a text or call lands in them, pages every list by an `after` cursor, and
    takes `POST /_sink/seed` for rows dated in the past.
- [x] 3.3 Mirror verbs where Quo has them: contact create, update and delete
  - `contactModel.create`, `update` and `delete`, taking the row's names:
    `sourceId` goes out as Quo's `externalId` and `actorExternalId` as
    `actorId`. Contact is the one model of the four with verbs; Quo writes
    messages, calls and conversations itself.
  - **conduit's forward hands `parse` the answer whole, and a dated answer is
    `{ data }`.** Each verb carries a `validate` that unwraps it; without one
    the contact parses to null and junction answers the write 502.
  - **`source` + `externalId` is unique.** The spec's 409 says a second
    create naming the pair is refused, so a stated `sourceId` is the
    nearest thing Quo has to an idempotency key: create stays unreplayed (a
    replay of one that landed would report it as a conflict), and a retry
    after an `indeterminate` is the 409 that says it landed.
  - Update is a partial PATCH and replayed, as `updateWebhook`'s: `null`
    clears, `undefined` is not sent, and a key outside the contact's fields
    is ignored rather than refused, because junction hands the patch over
    whole and a `@local` column in it is the app's to write. Quo's PATCH
    takes no actor.
  - **A replayed delete answers 404.** conduit replays every DELETE, and
    Quo answers the replay of one that landed 404, so the caller is told
    the row is missing and junction keeps it until the next contact pass.
    conduit now reads that 404 as the row gone (`FJS-3369`).
  - Refused before sending (C9): a create with no string `firstName`, an
    actor that is not `US…`, a `sourceUrl` that is not a URI of 1–200
    characters, a field that is neither a string nor `null`, and an empty key.
  - The sink takes `POST`, `PATCH` and `DELETE /contacts[/{id}]`, answers
    the 409 on a create or patch that leaves two contacts sharing the pair,
    and a 404 on a second delete.
- [x] 3.4 Receive writes rows: each event with a row shape passes through its model's `parse`
  - `payload.message`, `payload.call` and `payload.contact` are rows now, in
    place of `QuoMessageEvent` and `QuoCallEvent`, the shape
    conduit-mattermost's socket hands over. Both generations land the same
    row. Beside the row: `errorCode`, `external` (the other side's numbers)
    and `conversationExternalId`, which a call row has no column for.
  - **A webhook resource is partial, so its row is too.** `call.missed`
    names the call and two times. A column the event does not name is left
    OUT of the row rather than set to `null`, because a `null` would clear
    what a read wrote (Invariant 9). Each family has one table of field →
    column, and the row keeps the columns whose field the event carries. A
    contact resource is whole, so a `null` there clears.
  - **No participants on a call event's row.** The webhook marks ours and
    theirs, and the row lists every party with its user. One cannot be
    written as the other, so the event's `external` is beside the row.
    `unavailable` is `external: null`, unknown rather than nobody.
  - The context's `userId` lands nowhere. Quo does not mark it as the sender,
    and a read says `null` on an incoming message. Legacy's `userId` lands
    on a message and not on a call.
  - **A test is ignored (owner, 2026-10-20).** A sample's `orgId` starts
    `ORsampleorg`, so `quoDialect.parse` answers null and conduit answers
    `ignored`: verified, 200, no receipt, no apply. Prior art: GitHub's
    `ping` is its own type, and Stripe marks `livemode` because a test-mode
    object is real. A flag is the reopen path, if an app wants to show that
    a test arrived.
  - The sink delivers `contact.updated` on a create or patch and
    `contact.deleted` on a delete, to every hook that asked, whatever its
    numbers (the spec: contact events are workspace-wide).
- [x] 3.5 Contact properties: a contact's numbers and emails, and Quo's own match of an inbound number
  - **Lists on the Contact row, not `ContactProperty` rows (owner,
    2026-10-20).** A contact event carries `phoneNumbers` and `emails`
    inline with no property ids, so rows keyed on a property id could be
    kept current by a read alone. As lists, the event and the read fill one
    row. Prior art: Google People API and Quo's own v1 contact keep phone
    numbers on the contact; this package's `Conversation.participants` is
    the same list of numbers.
  - **The lists are ABSENT on a REST contact's row, not `[]`.** The contact
    list and the verbs' answers carry neither list, so an upsert of a
    backfill row leaves what an event or the read wrote.
  - `getContactProperties(quo, contactId)` reads `/contacts/{id}/properties`
    to the last page, every type in one read, and answers `{ row }`: the key
    and the two lists. One request per contact, mostly, on a key limited to
    10 a second. **All or nothing:** a failure on any page answers no row,
    because a list from some pages would clear what the others hold.
    Custom fields are read and not kept.
  - **Quo already matches the number.** Message and call events carry
    `context.contacts = { ids, lookupStatus }`, which 3.4 dropped. It is
    `contactExternalIds` beside the row: `[]` for `none`, `null` for
    `unavailable` (unknown, as `external`), on `call.ringing` (sent before
    the lookup), and on legacy. So matching a number to a contact in the
    app is needed at ring time alone, against the row's `phoneNumbers`.
  - No property verbs. A property's answer does not name its contact, and
    no caller has asked.
  - The sink keeps properties beside each contact, answers `GET` and
    `POST /contacts/{id}/properties`, sends both lists on a contact event,
    and fills a message or call context's `contacts` from them. That a
    property `POST` fires `contact.updated` is our reading of "its fields
    changed".

**Done 2026-10-20.** The drive is 66 rows, and every `mirror.*`
and `backfill.*` row is green, the `truncated` page among them. All four
models mirror from a read, an event or a verb's answer through one `parse`,
and an event row or a REST contact row leaves out what it does not carry.

### Phase 4 — Conversation state and audio

Goal: the app can change a conversation's inbox state and keep the audio files.
Done when: drive rows for read, done and open pass, and a fetched recording's bytes match the sink's.

- [x] 4.1 `markRead`, `markDone` and `markOpen` on a conversation
  - `POST /conversations/{id}/mark-as-read|done|open`, dated, no body. Each
    answers `{ row? }`, the conversation through `conversationModel.parse`.
    v1 has the same three; the dated ones are used, as for every read.
  - **The state is write-only.** The answer is the conversation, the same
    eleven fields the list reads, and none of them is the unread mark or the
    inbox. No event of the 31 reports either. So the mirror has no column
    for it: an app that shows the state keeps its own, written when a mark
    succeeds, and a change made in Quo's own app reaches it nowhere.
  - **Read is one axis, done and open the other.** The spec says read clears
    the unread indicator and done and open move it out of the inbox and
    back, so the sink keeps them apart. Whether done also clears unread is
    unconfirmed.
  - **Replayed.** Each sets a state, so a second one changes nothing. Two
    marks to one conversation in flight at once can land in either order,
    so a caller sends them one at a time.
  - A 404 is `gone`. An id that is not `CN` and at least one more character
    is refused before sending (C9); the spec's pattern is `^CN(.*)$`.
  - The sink keeps each conversation's state beside it: whatever arrives
    makes it unread and open (our reading of an inbox), a send moves
    neither unless it says `setInboxStatus: 'done'`, and a mark leaves
    `updatedAt` where it was, which the spec does not say either way.
- [x] 4.2 Recording and voicemail bytes, and the artifact events flattened
  - **Where each lands follows Quo's REST (owner, 2026-10-20).** The call read
    already carries `summary` and `voicemail`, so both are Call columns, flat
    (`voicemailUrl`, `summaryStatus`…) rather than one object each, because
    an event names part of a section (the summary event has no `type` or
    `title`) and an object column would clear the rest. A recording is its
    own `Recording` row keyed on its `CR…` id with `callExternalId`, as
    conduit-mattermost's `FileInfo` and Twilio's Recording. A transcript is
    beside the event (`payload.transcript`) and `getCallTranscripts`'s
    answer, not a row: the event names no recording, so it cannot be keyed
    on the segment the read lists it under.
  - **A section is absent unless the read asked.** `GET /calls[/{id}]`
    leave both out without `include=summary,voicemail`, and leave the
    voicemail out of a call with none. `backfillCalls` and `getCall` always
    ask, so there a missing voicemail is `null` columns; `callModel.parse`
    of a call read without asking leaves the columns out, as 3.5 does the
    contact's lists.
  - **Each event row holds only what it names.** The voicemail event's
    `duration` is the voicemail's (`voicemailDuration`), its own `id` is an
    activity of its own, and `voicemailId` is the `VM…`. Neither the summary
    nor the voicemail event carries a status the read has, so a row from one
    leaves that column to the read. `jobs: []` on the event and `null` on the
    read are both `null`. A voicemail whose `callId` is `null` (Quo could
    not resolve the call) has no row.
  - **`call.recording.completed` is still the call's event** (its
    `resource.id` is the call), and `payload.recordings` holds a row per
    segment it lists, with no `status`.
  - `getCall(quo, id)` answers `{ row }`; `getCallRecordings(quo, id)`
    `{ rows }`, every page, keeping the rows read before a failure since each
    is its own; `getCallTranscripts(quo, id)` `{ transcripts }`, all or
    nothing, since they are read as one dialogue. A non-`AC…` id is refused
    before sending.
  - **The bytes go through a third target.** `quoTargets()` returns
    `files`, request-addressed with no credential, because the URL is signed
    and on a storage host: the key would otherwise go to that host, and
    storage refuses a request carrying a second credential. `fileBytes(quo,
    url)` answers `{ bytes, type }`, for a recording, a voicemail or a
    message's media. A 403, 404 or 410 is `gone`: the URL no longer
    answers, and the read that handed it out hands out a fresh one. A file
    past conduit's 10 MiB cap, about twenty minutes of audio, needs
    `resilience.max_response_bytes` on the files target.
  - **Legacy.** A legacy voicemail (`{ url, type, duration }` on the call,
    `null` on every earlier event) fills `voicemailUrl` and
    `voicemailDuration` only when present; `callSummary` fills the summary
    columns and `callTranscript` is `payload.transcript`. A legacy recording
    (`media[]`) names no id, so it lands no row; `getCallRecordings` reads it.
  - The sink records a call in `segments`, with a transcript per segment and
    a summary, leaves a voicemail on a missed one, serves every file at a
    signed `/_files/` URL that refuses an `Authorization` header, and takes
    `{ expireFiles }` for the expired URL's 403.

**Done 2026-10-20.** The drive is 79 rows; a recording's and a voicemail's
bytes fetched through `fileBytes` match the sink's.

### Phase 5 — Admin, when a caller needs it

Goal: the admin areas, each built once a caller asks for it.
Done when: each step has its own drive rows.

- [x] 5.1 Tasks: CRUD, status, linking a conversation, assigning, due date
  - A `Task` row on the claim, keyed on `taskId` (the REST task's id field is
    `taskId`, not `id`), with `create`, `update` and `delete` verbs; the rest
    are named calls, `setTaskStatus`, `linkTask`/`unlinkTask`,
    `assignTask`/`unassignTask` and `setTaskDueDate` (`null` is its DELETE),
    each answering `{ row }`. `getTask` and `backfillTasks` read whole rows.
  - **Every task write answers `{ taskId, revision }` alone, so the row is
    partial.** `taskModel.parse` keeps a column only where its field is
    present, and a write's row is the answer plus what the write set. The
    event lands before the answer does, so a create's row leaving out
    `createdByExternalId` and the number is what keeps the event's. A read
    fills a field it left out with `null` (`taskFromRead`); the spec marks
    nine fields optional, and the sink leaves a null one out.
  - **`revision` orders writes and reads; no event carries one.** An event
    row has no `revision`, so task events are applied in `occurredAt` order,
    or the task is read.
  - **The PATCH takes the title and the description together.** The spec's
    prose says "and/or" and its schema requires both; both always go,
    which either reading takes. A patch naming a column with its own call
    (`status`, `dueDate`, the assignee, the conversation) is refused naming
    that call, not dropped; an unknown key is ignored, as Contact's, for a
    `@local` column.
  - **A task event's status is the type's.** Most name the id alone; each of
    `created`, `completed`, `reopened` and `deleted` names one value of the
    read's `status`, unlike a call's events (1.1). The context's links land
    on `created` and `linked` only, because on `unlinked` they are what the
    task left. `assigned` takes its actor as `assignedByExternalId`.
    `payload.conversationExternalId` carries the context's conversation.
  - **Deleting is a status.** The read's enum has `deleted`, so the delete
    verb answers `{ status: 'deleted' }` and the row stays, as the event says.
    That a deleted task is still listed is the sink's reading.
  - **A DELETE is replayed whatever the call says**, and Quo's 400 or 404 on
    the replay of an unlink or unassign that landed is the write done
    (without a revision). Every PATCH and POST but create is replayed; a
    lost create is open, and `backfillTasks` finds it.
  - **The open-task limit is `quota`, not `billing`.** It is a 402 with no
    code, named by its title, which the spec fixes as a constant
    (`QUOTA_TITLES`). Through the create verb the reason is lost: conduit's
    forward answers 422 with its own status line (`FJS-3411`, filed).
  - Refused before sending (C9): a non-`TK` id, a create without a string
    title and description or a `CN…` conversation, a non-`US` assignee, a
    status outside the three, a due date `Date` cannot read.
  - The sink keeps tasks in conversations that exist, moves the revision on
    each change, delivers each event filtered by the task's number, takes
    `{ openTasksFull }` for the 402 and `POST /_sink/overdue` for Quo's
    overdue check. A removal of what is not there is its 400 (our reading).
- [x] 5.2 Phone numbers: list, get, update, settings, members, available numbers
  - A `PhoneNumber` row on the claim, keyed on the `PN…` id, with an
    `update` verb and no `create` or `delete`: a number is bought and
    released in Quo's app. `getPhoneNumber` and `backfillPhoneNumbers` read
    rows; `getPhoneNumberSettings` / `updatePhoneNumberSettings` and
    `getPhoneNumberMembers` read the part of the row they fill;
    `availablePhoneNumbers` is a plain list of E.164 strings.
  - **No event reports a number.** The 31 types have none, so every row is a
    read's: a name or forward changed in Quo's app reaches the mirror on the
    next backfill.
  - **Each read carries different columns, so four groups are absent unless
    read.** The list takes `include=restrictions` and refuses
    `businessHours`; the one-number read takes both; the PATCH answers
    `businessHours` and never `restrictions`; settings and members are reads
    of their own. A column the read did not carry is left out, so an upsert
    keeps what another read wrote (Call's voicemail rule, 4.2).
  - **`/phone-numbers/available` is a route beside `/{phoneNumberId}`.** An
    id that is not `PN…` reaches the available list, which parses to no row
    rather than a 404, so every number call checks the prefix first.
  - **The PATCH writes the name and the business hours, nothing else.** A
    patch naming `autoRecord` or `callDisclosure` is refused naming
    `updatePhoneNumberSettings`, one naming a column the API never writes
    (`forward`, `symbol`, `phoneNumber`…) is refused saying so, and an
    unknown key is ignored for a `@local` column, as Contact's. The name
    cannot be cleared; `schedule: null` clears every window.
  - **A day left out of a schedule keeps its window**, the sink's reading:
    the spec says "only the fields in the request change" of the top level
    alone. The connector sends the days given and no more, so under either
    reading the days named land as named.
  - **Members are all or nothing**, as a contact's properties (3.5); each
    member comes back beside the row as a `User` row (5.3).
  - Refused before sending (C9): a non-`PN` id, an empty update, business
    hours or schedule, a name outside 1–500 or `null`, a day outside the
    seven, a window not `HHMM`, a timezone `Intl` cannot read or an offset
    (`+05:00`, which IANA does not name), an empty settings update or
    `callDisclosure`, a disclosure outside the three, more than 100
    available numbers.
  - Not built: the list's `phoneNumber` filter, a number by its E.164. A
    mirror that has backfilled holds the answer, and no caller has asked.
  - The sink makes each of our numbers a phone number with the three users
    as members, `POST /_sink/seed` takes `phoneNumbers` with a count of
    `members`, and the available list filters a fixed pool.
- [x] 5.3 Users and the organization
  - A `User` row keyed on the `US…` id and an `Organization` row keyed on
    the `OR…` id, both on the claim with no verbs: a user is invited and
    removed in Quo's app, and the API writes nothing of the workspace.
    `getUser` and `backfillUsers` read whole users, `getOrganization` the
    one workspace, and `getUserPhoneNumbers` a user's numbers.
  - **No event reports a user or the workspace.** Every row is a read's, so a
    user renamed or removed in Quo's app reaches the mirror on the next
    backfill. The user list takes no time bound, so every pass is the whole
    book, and a user absent from one read to the last page was removed.
  - **A number's member is a partial user.** `GET /phone-numbers/{id}/users`
    lists the user without `pictureUrl`, `createdAt` and `updatedAt`, so
    `userModel.parse` leaves a column out when the object does not name it,
    and `getPhoneNumberMembers` answers `users`, rows an upsert can take
    without clearing what a user read wrote (Call's voicemail rule, 4.2).
  - **A member's `groupId` lands nowhere.** The spec calls it the group the
    user belongs to, and no user read carries it; whether it is the number's
    own group is unconfirmed, so no column holds it.
  - **A `SYU…` system actor is no user.** A message's or call's `userId` can
    name one, and no user read lists it, so `userModel.parse` takes `US…`
    alone and a `userExternalId` may point at no row.
  - **A user's numbers write no membership.** `GET /users/{id}/phone-numbers`
    reads numbers as the number list does, with `include=restrictions`, so
    each is a `PhoneNumber` row. A number's `memberExternalIds` is every
    member, which a read of one user cannot say, so the membership is the
    caller's to read off the answer. Each row is its own, so a failure keeps
    the rows read before it, as `getCallRecordings` (4.2).
  - **An unknown user's numbers are no 404.** The spec names none for that
    route, and the sink answers `[]`, so an empty list does not prove the
    user exists; `getUser` does, and its 404 is `gone`.
  - **`subscriptionStatus: 'expired'` is a lapsed billing period**, in which
    a send is the `0201402` refusal, `billing`. The read lets an app say so
    before it sends; that the two coincide is our reading.
  - Refused before sending (C9): a user id that is not `US` and at least one
    more character.
  - The sink gives each user a picture slot and times, lists a member
    without them and with `groupId`, lists users by id (the spec names no
    order), keeps the workspace as `ORdev`, and `POST /_sink/seed` takes
    `users`, `organization` and a number's `memberIds`.
- [x] 5.4 A2P registration: get, create, update, submit
  - **A plain answer, no row (owner, 2026-10-22).** `getA2PRegistration`,
    `createA2PRegistration`, `updateA2PRegistration` and
    `submitA2PRegistration` each answer `{ registration }`, Quo's object with
    its three times as `Date`, as `getWebhook` answers a webhook. No event
    reports the registration, so a row would be only as fresh as the last
    read, and its business info carries the tax ID, which a mirror would put
    in the app's database. Prior art: Twilio's BrandRegistration is a resource
    read the same way, with status events through Event Streams beside it;
    Quo has the read alone.
  - **None is `null`, not a failure.** A workspace has one registration at
    most, and Quo answers its absence with a 404 rather than a null `data`;
    the get turns that 404 into `registration: null`.
  - **Autofill writes `messaging`.** A create, or a patch naming the
    business name, alternate name, business type, website or the contact's
    first or last name, starts Quo's autofill from those fields and
    `messageTypes`, which Quo does not store and no read gives back. So
    `messageTypes` is required on such a patch, refused before sending
    without it, and a submit while autofill runs is Quo's 409.
  - **The PATCH merges one level down.** `address: { city }` changes the city
    alone. `null` clears `alternateName`, `ticker`, `exchange` and
    `address.line2`, the four the spec lets be null, and a `null` anywhere
    else is refused. A submitted registration takes no patch: Quo's 409,
    `refused`. Replayed, since it sets values; a replay naming the business
    name runs autofill again.
  - **A create is not replayed.** The replay of one that landed is Quo's 409
    ("already has an A2P registration"); after `indeterminate`,
    `getA2PRegistration` says whether it landed. A lapsed subscription is
    the create's 402, `billing`.
  - **A submit bills, so it is not replayed, and its 409 is read.** Quo
    charges for the submit and answers a payment that did not complete with
    402 `Payment Failed`, `billing`. On a 409 the call reads the
    registration: submitted and `pending` or `approved` is the submit done,
    which a retry after `indeterminate` finds, and it answers that
    registration; still a draft is autofill running, `refused` with
    `retryable: true`. A `rejected` or `failed` one is resubmitted by the same
    call, and bills again.
  - **The acknowledgement is the caller's.** `forbiddenMessageTopicsAcknowledged:
    true` is an argument, refused before sending otherwise, rather than a
    constant the connector would assert on the app's behalf.
  - Refused before sending (C9): a create missing any field, top level or
    nested; a value outside the write enums (business type, company type,
    industry, region, ID type, exchange, job position, message type); a string
    outside 1–255; a count that is not an integer; regions outside 1–5; a
    website `URL` cannot read; an email without `@`; a contact number not
    E.164; an empty patch or nested part; a key the registration does not
    have. Quo's own prose rules (an EIN's nine digits, a ticker and exchange
    for a `Public` company) are its 422, `refused`.
  - The sink keeps one registration, runs autofill for 60 ms after a create
    or an autofilling patch, counts payments, takes `{ paymentFails }` and
    `{ autofilling }`, refuses an EIN without nine digits, and takes the
    carrier's verdict, or `null` to remove it, at `POST /_sink/a2p`. Its
    readings: a submit of one already submitted and `pending` or `approved`
    is a 409, a `rejected` one may be submitted again without a patch, and
    autofill fills `useCase` from the message types.

## Stays not built

- **MMS.** v1's send takes `content`, `from`, `to`, `userId` and
  `setInboxStatus`, and nothing for media. The gap is in Quo's public API.
