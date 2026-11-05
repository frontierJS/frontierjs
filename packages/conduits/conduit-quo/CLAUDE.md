# conduit-quo — package map

`src/index.ts`: `quoTargets` / `bindQuo`, `sendMessage`, `findSent`,
`getMessage`, `retryMessage`, the six webhook calls, `listDeliveries`,
`getDelivery`, `retryDelivery`, `healDeliveries` and `sendTestEvent`, the
four `backfill*` reads, `getContactProperties`, `markRead` / `markDone` /
`markOpen`, `getCall`, `getCallRecordings`, `getCallTranscripts`,
`fileBytes`, `getTask`, `backfillTasks`, the six task calls, the six
phone-number reads and writes, `getUser`, `backfillUsers`,
`getUserPhoneNumbers`, `getOrganization`, `toE164`. `src/a2p.ts` is the A2P
registration's four calls and the checks on what they send. `src/mirror.ts` is the
mirror claim: `Message`, `Conversation`, `Contact`, `Call`, `Recording`,
`Task`, `PhoneNumber`, `User` and `Organization` rows, `parseTranscript`, Contact's and Task's
`create`, `update` and `delete`, and PhoneNumber's `update`. `src/errors.ts` is the one
reader of `error.raw` and holds the code sets. `src/verify.ts` holds both
verifiers, both signers (for the sink), `parseQuoEvent`, and the two
Dialects, which hand a message, call or contact event over as a row. `src/types.ts` holds
`QUO_EVENT_TYPES`. `sink.ts`, `test/quo.drive.ts`. The plan is
`docs/PLAN.md`; the next step is its first open box.

## What bites

- **Each call picks its generation.** Send is v1 only. Everything else is
  dated and needs the version header. Moving a call to the other Send is a
  400 from Quo, and the `wire.eachCallOnItsGeneration` row catches it.
- **A file URL goes through `files`, never `dated`.** It is signed and on a
  storage host; through the dated target the key goes with it, and storage
  refuses the second credential. An expired one is `gone`; read the call's
  recordings or the call again for a fresh one.
- **A 429 can be a quota.** `0200429` is read off the body before conduit's
  `rate_limited` is believed.
- **The legacy timestamp is in milliseconds** and `now` is in seconds. The
  verifier converts the header, never the clock.
- **Nothing is replayed on a send.** It is unkeyed, so a retry is a second
  text. After an `indeterminate` result, call `findSent`.
- **A message retry is not replayed either.** A retry Quo took leaves the
  message not `failed`, so a replay is a 422 that reports success as
  failure. After `indeterminate`, read the status with `getMessage`.
- **An event's row holds only what the event names.** A webhook resource is
  partial (`call.missed` is an id and two times), so a column it does not
  carry is absent, not `null`; a `null` would clear what a read wrote. The
  field → column tables in `verify.ts` say what each event carries.
- **A call event's row has no participants.** The webhook marks ours and
  theirs (`participants.workspace` / `.external`), the row lists every party
  with its user, and the one is not the other. The event's `external` sits
  beside the row; `unavailable` is `null`.
- **A test delivery is `ignored`.** Its `orgId` starts `ORsampleorg`, and
  `quoDialect.parse` answers null, so no sample row lands.
- **A refused delivery reads `sending`, not `failed`,** until Quo's ~27
  hours of retries run out. Listing only `failed` finds a lost delivery a
  day late.
- **A delivery retry IS replayed, a message retry is not.** A second
  attempt carries the same `webhook-id` and the receiver answers
  `duplicate`; a second message retry is Quo's 422.
- **A test event's answer is unwrapped, and its envelope id is fixed.**
  `POST /webhooks/{id}/events/test` answers the envelope itself, not
  `{ data }`. Every test dispatch carries the same envelope `id`, so
  deduping on it swallows every test after the first.
- **`updateWebhook`'s `events` replaces the list, and `resourceIds: []` is
  every number.** A partial PATCH whose fields are whole: send every event
  the hook keeps, and disable a hook to make it hear nothing.
- **A message and a call are both `AC…`.** `messageModel.parse` needs `to`
  and `callModel.parse` needs `participants`; checking the id alone parses
  one as the other.
- **A contact's `externalId` is its source system's id, not Quo's.** The row
  keys on Quo's `id` and calls Quo's `externalId` `sourceId`.
- **A contact row's `phoneNumbers` and `emails` are absent, not `[]`, when
  the source lacks them.** The REST contact carries neither; a contact event
  carries both, and `getContactProperties` reads them. A `[]` from a backfill
  would clear what the event wrote.
- **`getContactProperties` is all or nothing.** A failed page answers no row,
  because a partial list clears the rest on upsert.
- **Quo matches the number for you.** `contactExternalIds` beside a message
  or call row is Quo's `context.contacts`; `null` on `unavailable`,
  `call.ringing` and legacy, which is unknown, not none.
- **The four lists bound time four ways.** Messages `createdAt[gt|lt]`,
  calls `createdAt[gte|lte]`, conversations that on `createdAt` or
  `updatedAt`, contacts none. A backfill's `since` is inclusive everywhere,
  so the message bound goes out a millisecond early. A wrong bound on calls
  is a 400; on messages Quo may ignore it and answer all of history.
- **A message or call backfill misses a later status.** Both filter on
  `createdAt` only; a `delivered` on an older message is the webhook's.
  Conversations are read by `updatedAt`, ascending, for the same reason.
- **The next backfill's `since` is when the last pass began**, not its
  newest row. Contacts take no bound, so every pass is the whole book.
- **A claim verb's answer must be unwrapped by its own `validate`.** conduit's
  forward hands `parse` the body whole, and a dated body is `{ data }`; a
  verb without the validator parses to null and the write is junction's 502.
- **A contact's `source` + `sourceId` is unique, so a create is not
  replayed.** A replay of one that landed is Quo's 409, reporting the
  success as a conflict. With the pair stated, a retry after `indeterminate`
  is that 409, never a second contact.
- **A replayed delete that landed is done.** conduit replays every DELETE
  and reads a 404 after a replay as the row gone (`FJS-3369`); the task
  calls read a 400 or 404 after a replay the same way.
- **A task row is partial everywhere but a read.** Every task write answers
  `{ taskId, revision }` alone and its event usually lands first, so
  `taskModel.parse` keeps only the columns whose field is present. A read
  goes through `taskFromRead`, which fills what Quo left out with `null`.
- **A task event carries no `revision`.** A write's answer and a read do;
  order events by `occurredAt`, or read the task.
- **The task PATCH sends title and description together**, and a patch
  naming `status`, `dueDate`, the assignee or the conversation is refused
  naming the call that writes it.
- **The open-task limit is a 402 named by its title**, read as `quota`
  (`QUOTA_TITLES`). Through the create verb it is conduit's bare 422
  (`FJS-3411`).
- **No event reports a phone number.** Every `PhoneNumber` row is a read's,
  so a name changed in Quo's app reaches the mirror on the next backfill.
- **Each number read carries different columns.** The list takes
  `restrictions` and refuses `businessHours`; the one-number read takes both;
  the PATCH answers `businessHours` without `restrictions`; settings and
  members are reads of their own. A column a read did not carry is absent,
  never `null`, so no read clears another's.
- **`/phone-numbers/available` sits beside `/phone-numbers/{id}`.** An id that
  is not `PN…` reads the available list and answers no row instead of a 404,
  so `phoneNumberPath` checks the prefix.
- **A number's PATCH writes the name and business hours alone.** A setting is
  `updatePhoneNumberSettings`; `forward`, `symbol` and the rest are set in
  Quo's app. `schedule: null` clears every window, and a day left out keeps
  its own (the sink's reading).
- **No event reports a user or the workspace either**, and a number's member
  is a user without `pictureUrl` or the times, so `userModel.parse` leaves
  out a column the object does not name. A `SYU…` system actor is no user:
  a `userExternalId` may point at no row.
- **A user's numbers write no membership.** `memberExternalIds` is every
  member of a number, which one user's read cannot say. Quo names no 404
  for an unknown user there, so `[]` does not prove the user exists.
- **The A2P registration is no row.** No event reports it and it carries the
  tax ID, so each call answers `{ registration }`, and none is `null`, not
  the 404 Quo answers.
- **A submit bills.** It is never replayed, and a 409 is read before it is
  believed: submitted and `pending` or `approved` is the submit done, a draft
  is autofill still running (`retryable`). A `rejected` one resubmitted bills
  again.
- **Autofill needs `messageTypes`, which Quo never stores.** A patch naming the
  business name, alternate name, type, website or contact name restarts
  autofill and is refused before sending without them.
- **A conversation's inbox state is write-only.** `markRead`, `markDone`
  and `markOpen` answer the conversation, which has no unread or open/done
  field, and no event reports a change. A mirror cannot hold the state; an
  app keeps its own column, and a change made in Quo's app never reaches it.
- **A call's summary and voicemail are absent unless the read asked.**
  `include=summary,voicemail` brings them, and a call with no voicemail
  then has none, which `backfillCalls` and `getCall` turn into `null`
  columns. Without the `include`, a row leaves them out.
- **The artifact events name the call as `callId`.** The voicemail event's
  own `id` is another activity and its `duration` the voicemail's; keyed on
  `id`, a voicemail row is a stray call. The transcript event names no
  recording, so it is `payload.transcript`, not a row.
- **A delivery id is the `webhook-id` header, not the event id.** Several
  subscriptions share one `eventId`; each delivery has its own `id`.
- **The codes are Quo's spec, not a live account.** `UNREGISTERED_CODES` and
  `QUOTA_CODES` are the one place to correct them.

## Proving a change

`bun run drive`: 115 rows. Mutants fail it: no version header, quota
codes ignored, legacy milliseconds read as seconds, a re-serialized body, an
unstable dedupe key, `findSent` ignoring the text, a call read off the
message context, no incoming default, no side swap on an outgoing call, a
voicemail flattened as the call, no legacy call, a retry marked
replayable, a retry on the v1 target, a retry's error swallowed, no
local id check on a retry, and on the delivery log: several event types
sent bare instead of `[in]`, no webhook id check, the cursor, the limit or
the status not sent, `nextCursor` dropped, the deprecated `createdAfter`,
and the detail read on the list path; on retry and heal: a delivery
retry not replayed, sent on v1, its error swallowed, no webhook id check,
the heal reading only `failed` or only `sending`, one page, newest first,
unsorted, or ignoring `since`; on the test event: not replayed, unwrapped
like the others, the body field misnamed, no event type check, no webhook
id check, sent on v1, its error swallowed, and the dialect deduping on the
envelope id; on get and update: not replayed, `null` dropped like
`undefined`, an empty update, an empty `events` or an unknown type sent,
no webhook id check on either, sent on v1, sent as PUT, the get not
unwrapped, and either one's error swallowed; on the mirror rows: a message
or a call read without its shape, a call or conversation id prefix
unchecked, `''` kept, times left strings, an unreadable time kept, a
contact keyed on Quo's `externalId`, a participant's `actorId` not
renamed, an empty media URL or list entry kept, and a relation column
under Quo's name; on the backfill: the message bound exclusive or `gte`,
the call bound `gt`, conversations by `createdAt`, unsorted or newest
first, one page only, never `truncated`, a failure dropping its rows or its
`after`, one page too many, Quo's default page size, `pages` unchecked,
`after` ignored, and a call read with the message model; on the contact
verbs: create or update not unwrapped, create replayed, update not
replayed, update sent as PUT, `sourceId` or the actor under the row's
name, the actor sent on a patch, `null` dropped like `undefined`, an
unknown key refused, no delete verb, and each local refusal missing
(`firstName`, `null` `firstName`, the actor, the URI, its length, a
non-string, an empty key). On receive writing rows (3.4,
18 of 18, which superseded the flattening's): no column filter, media,
`answeredBy`, `sourceId` or a call's number not carried, the context's
`userId` carried, no incoming default, `unavailable` as `[]`, `external` read
off `workspace`, no side swap on a legacy call or a message, a sample
applied, dedupe on the envelope id, `contact.deleted` unread, a voicemail
read as the call, legacy `body` not carried, `errorCode` dropped, and a
call's conversation dropped. On contact properties (3.5, 13 of 13): the
lists always on a row, an empty value kept, one page only, a partial row on
failure, the read filtered to phones, phones and emails swapped, no
empty-id check, the event's lists not carried, `unavailable`, an absent
lookup or legacy read as `[]`, and the ids dropped from a call or a
message. On conversation state (4.1, 9 of 9): a mark not
replayed, done sent as open, read sent as done, no id check, a bare `CN`
taken, the answer not parsed, sent on v1, its error swallowed, and
`setInboxStatus` dropped from a send. On call artifacts (4.2, 18 of
18): a file fetched on the dated target, no `include` on the backfill or on
`getCall`, a missing voicemail left absent, a voicemail keyed on its own id,
its duration as the call's, `jobs: []` kept, a recording row without its
call, an expired URL not `gone`, partial transcripts, the event's `userId`
dropped, a legacy `null` voicemail carried, no legacy summary, no URL or
call id check, a listed recording parsed without its call, the segment id
dropped, and the summary event unread. On tasks (5.1, 23 of 23): parse
without its presence filter, a read not filled, the backfill unfilled,
create replayed or claiming no status, the PATCH sending one field or
taking one alone, not replayed, or letting a column with its own call
through, delete answering no row, no task id check, the event's status not
read off its type, `updated` carrying an unchanged field, `unlinked`
carrying the links it left, `created` carrying none, `assigned` dropping its
actor, the event's conversation dropped, a replayed removal reported as an
error, the calls not replayed, a cleared due date sent as a PATCH, the open
limit read as billing, a write's revision dropped, and the calls on v1. On
phone numbers (5.2, 36 of 36): the read without `include` or without
business hours, the list asking for business hours or nothing, one page,
restrictions or business hours always on a row, `portRequestId` or
`groupId` under Quo's name, times left strings, no `PN` check, the update
not replayed, not unwrapped or sent as PUT, `schedule: null` dropped, a
setting let through the PATCH, an unknown key refused, an empty update,
`null` name, a bad window, an unknown day, empty hours or schedule, an
offset read as a timezone, settings not replayed, on the number's path,
empty, with an empty or unknown disclosure, or unparsed, members partial on
failure or one page, the available limit unchecked, its path or its filters
wrong, and the number read on v1. On users and the organization (5.3, 21
of 21): the picture or either time always on a row, no `US` check on parse
or on the path, a time left a string, a members read not parsed as users,
the user's numbers without `include`, one page, dropped or unreported on
failure, the users list one page, the user or the workspace not unwrapped
or on v1, a user read's error swallowed, the workspace's `''` kept, its
times strings, no `OR` check, and `Organization` off the claim. On the A2P
registration (5.4, 30 of 30): none read as `gone`, times left strings, no
`RG` check, the get not unwrapped, create replayed or its error swallowed,
update not replayed or sent as PUT, `null` dropped like `undefined`, a nested
part required whole on a patch, the autofill rule missing or blind to the
contact's name, an unknown key, an empty patch or part, or the
acknowledgement let through, submit replayed, its 409 believed, any
submitted one read as done, autofill not retryable, either call on v1, and
each field check missing (E.164, email, URL, six regions, integer, a missing
field, an enum, `null` on a field that takes none). A GET is always
replayed by conduit, so "not replayed" is no mutant here.
