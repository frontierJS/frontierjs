# conduit-quo — state

**Sink-only, drive green (115 rows).** Receiving was extracted from the quo
prototype. Sending and webhook management are new. Call flattening was
rebuilt from Quo's payload spec (`docs/PLAN.md` Phase 1). 2026-10-19.
`retryMessage` added (2.1); `listDeliveries` and `getDelivery` (2.2);
`retryDelivery` and `healDeliveries` (2.3); `sendTestEvent` (2.4); `getWebhook` and
`updateWebhook` (2.5), so webhook coverage is 10 of 10. Mirror rows for
`Message`, `Conversation`, `Contact` and `Call` (3.1). Backfill reads over all
four (3.2), 2026-10-20. Contact create, update and delete as claim verbs
(3.3), 2026-10-20. Receive writing rows (3.4), and a test delivery
ignored, 2026-10-20. Contact numbers and emails as lists on the Contact
row, `getContactProperties`, and Quo's own number match beside message and
call rows (3.5), 2026-10-20. `markRead`, `markDone` and `markOpen` (4.1),
2026-10-20. Call artifacts and their bytes (4.2): summary and voicemail
columns on Call, a `Recording` row, transcripts beside the event, and
`fileBytes` through a third, keyless target, 2026-10-20. Phase 4 is done.
Tasks (5.1): a `Task` row with verbs, six calls, two reads and twelve
events as rows, 2026-10-21. Phone numbers (5.2): a `PhoneNumber` row with an
`update` verb, its settings and members as reads of their own, and the
available numbers, 2026-10-21. Users and the organization (5.3): `User` and
`Organization` rows, read only, with a number's members as partial `User`
rows, 2026-10-22. The A2P registration (5.4): get, create, update and
submit as plain answers, no row (owner), 2026-10-22. Every step of the plan
is built.

- Source: `fjs-prototypes/quo/api/src/providers/quo/` (both verifiers and the
  envelopes). Sending and webhooks were written from Quo's v1 and
  `2026-03-30` OpenAPI specs.
- Drive green against: the sink. Fixture: none exists. Quo was never called.
- Mutation controls: 30 of 30 on the A2P registration (5.4); 21 of 21 on users and the organization (5.3); 36 of 36 on phone numbers (5.2); 23 of 23 on tasks (5.1); 18 of 18 on call artifacts (4.2); 9 of 9 on conversation state (4.1); 13 of 13 on contact properties (3.5); 18 of 18 on receive writing rows (3.4); the 98 before it were not re-run, and six of them targeted the flattening 3.4 replaced (`CLAUDE.md` § Proving a change).
- Typecheck: clean in this package's files; the 7 errors left are inside frontierjs packages, and the run needs `--typeRoots` at frontierjs's `node_modules`.
- Unverified against a real account:
  - whether v1 tolerates the `Quo-Api-Version` header. Two targets mean it
    is never sent there.
  - whether a legacy retry repeats the envelope id.
  - what a send to someone who texted STOP answers. Quo's spec names no code
    for it.
  - the `createdAt[gt]` / `to[all]` query spelling, taken from the spec's
    deepObject schema.
  - what a retry of a message that is not `failed` (queued, delivered)
    answers. The sink says 422; the spec names nothing.
  - the delivery log, from the spec alone: whether `requestBody` is the
    parsed payload (the sink's reading) or the raw string (the spec gives it
    no type); the cursor's format (the sink mints its own, and the connector
    treats it as opaque); and the `sending` → `failed` turn after ~27 hours,
    which the sink models with `/_sink/exhaust`.
  - a delivery retry: that Quo takes one in any state (the spec names no
    refusal but a 404), that its attempt is signed with the current key
    and a FRESH timestamp (if not, a retry older than the receiver's
    window never verifies), and that a failed manual attempt leaves the
    status where it was (the sink's reading).
  - a test event, from the spec alone: whether Quo sends it to a hook not
    subscribed to that type, or disabled (the sink sends it either way);
    whether the delivered body is byte for byte the answer's (the sink's
    is); and that the log shows it with `eventId` and `resourceId` null.
  - a webhook update: that the key survives a `url` change (the sink keeps
    it; the spec names no rotation there), what a cleared `resourceIds`
    reads back as (the sink says `['*']`), and whether a legacy webhook,
    made in the app or on v1, can be updated at all (the spec's read
    lists legacy shapes with narrower event sets).
  - the mirror rows: the call, conversation and contact rows are graded
    against the spec's examples and the sink's lists, never a real answer.
  - the backfill: the cursor's format (the sink mints its own, and the
    connector treats it as opaque); whether Quo ignores or refuses a bound
    it does not name on `/messages` (the spec forbids nothing there);
    whether a conversation's `updatedAt` moves when a text or call lands
    in it (the sink's reading, and the reason the read uses it); whether
    `/conversations` lists a deleted one; and the order `/contacts` lists
    in, which the spec does not state.
  - the contact verbs: that `(source, externalId)` is unique on PATCH as on
    create (the spec's 409 example names only create), whether a `null`
    `source` shares one pair with every other (the sink says yes), what an
    empty PATCH answers (the claim sends one when a patch names only `@local`
    columns), and that a second DELETE is a 404.
  - receive writing rows: that every test sample's `orgId` starts
    `ORsampleorg` (the spec's example; if Quo changes it, sample rows land
    and nothing says so); what the dated context's `userId` names on a
    message (the row leaves it out); that `contact.updated` fires on a
    create made through the API; and whether a legacy subscription sends
    contact events at all (the connector reads none).
  - contact properties: that a phone number's `value` is E.164 as Quo holds
    it (the spec's example is; the row keeps it as sent), that adding a
    property fires `contact.updated` (the sink's reading), and that a
    message or call context's `contacts.ids` are the same ids
    `GET /contacts` lists (the spec's example is `CT123`, the list's
    example 24 hex digits).
  - conversation state: whether done also clears the unread mark (the sink
    keeps the two apart), whether a mark moves `updatedAt` (the sink leaves
    it), and that whatever arrives makes a conversation unread and open
    again (the sink's reading of an inbox). Quo reports the state nowhere, so
    none of the three can be read back even with an account.
  - call artifacts: that the event's recording id is the read's `CR…` (the
    spec's event example is `RE…`; the row checks presence alone, and two
    spellings would be two rows); that the transcript event is the whole
    call's dialogue rather than one segment's; that a file URL is
    unauthenticated and refuses a second credential (Quo says signed, and
    the sink refuses one); what an expired URL answers (the sink says 403);
    whether a legacy recording or voicemail URL is fetched the same way.
  - tasks, from the spec alone: whether the PATCH takes one field alone
    (its prose says "and/or", its schema requires both; both are sent);
    that a deleted task is still read, `deleted`; what removing a link or
    an assignee that is not there answers (the sink says 400); that an API
    create sends `task.created` and not also `task.assigned`; who the
    actor of an API write is; whether unlinking clears the activity and the
    number too (the row clears the conversation alone); the first
    `revision` (the sink says 1).
  - phone numbers, from the spec alone: whether a day left out of a
    schedule PATCH keeps its window (the sink's reading; the connector
    sends only the days named); that the list refuses
    `include=businessHours` rather than ignoring it (the spec says the
    section is "only available on this endpoint"); whether a settings PATCH
    moves the number's `updatedAt` (the sink leaves it); the list's order
    (the spec states none); and which numbers `/available` offers, and
    whether `countryCode` has a default.
  - users and the organization, from the spec alone: the user list's order
    (the sink's is by id); what an unknown user's numbers answer (the spec
    names no 404; the sink answers `[]`); what a member's `groupId` names,
    which the row leaves out; whether `pictureUrl` is signed and expires;
    and that `subscriptionStatus: 'expired'` is the state in which a send is
    the `0201402` refusal.
  - the A2P registration, from the spec alone: what a submit of one already
    submitted answers (the sink says 409; the connector reads the
    registration on any 409); whether a `rejected` or `failed` one is
    resubmitted as it stands or must first return to a draft that a patch
    can change (the PATCH takes a draft alone, and the spec says nothing of
    how a rejection is corrected); whether the submit's 402 is the one
    answer for a lapsed subscription too; what `messaging` autofill writes,
    and how long it runs (the sink's 60 ms is a stand-in); what `type` a
    submit sets; and the `statusMessages` codes a carrier sends.
  - the legacy call object, summary and transcript. Their fields are read
    from Quo's support page, because the v1 spec documents no webhook
    payloads.
- Contract: C1 amended for two generations on one origin (`CONTRACT.md`).
- FJS filed: `FJS-3369` (a replayed mirrored delete reported 404 and kept the
  local row; closed in conduit), `FJS-3411` (a mirrored write's refusal
  loses the Provider's reason). Two candidates are in the root `PROJECT_STATE.md` row.
