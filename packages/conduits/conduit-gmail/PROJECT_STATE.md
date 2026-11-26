# conduit-gmail — state

**New, sink-only, drive green (41 Gmail rows, 42 `calendar.` and `oauth.` rows).** Google's facts read on 2026-10-12
(the plan's § 2.9: `reason` strings, unit costs, 6,000 units/min per user, the
seven-day watch, the push's string `historyId`, the Subject threading rule).

- Drive green against: the sink. Fixture: none exists — there is no
  conforming Gmail server to run.
- Real vendor: never called; no grant in the environment. Unverified against a
  real project: the `send` size limit (Google no longer prints it; 25 MB
  refused locally as the floor), whether a project's quotas match the
  limits page, the exact 403 `reason` for a Workspace policy refusal, and
  whether `labelFilterAction` on the wire is refused or ignored.
- Source: ELA `mime.js`, `google.sync.js` (parsing and discovery),
  `google.history.js`, `google.pubsub.js` (decode), `google.gmail.js` (calls),
  ported without googleapis, OAuth, Feathers or Prisma.
- Gaps: the per-user unit limit spelled as a 403 is never retried by conduit
  (`FJS-2721`, `FJS-2286` seen again); the batch endpoint needs a second
  `encoding` on one target (not built); conduit-oidc's `verifyIdToken` refuses
  Google's push token on `azp` (worked around in `src/push.ts`, reported for
  conduit-oidc).
- Amendments to `CONTRACT.md`: C3 (four 403s under one conduit kind), C6 (a
  resolving read by a header the connector minted), C8 (a service-account
  token whose `azp` is the publisher, not the audience).
- Google's facts (`reason` strings, unit costs, quota, watch expiry, push shape, threading rule) were checked against developers.google.com on 2026-10-12.
- FJS filed: none by this package; `FJS-2721` and `FJS-2286` named again.

## Calendar (`./calendar`, `sink-calendar.ts`)

Built 2026-11-26 for `IDEAS/google-calendar.md` Phase 1; drive green, sink
only. Facts checked against developers.google.com on 2026-11-26 (README §
Calendar). **Unverified, they need a real token (plan step 0.3):** the 204 on
delete; whether a deleted id re-inserted answers 409 (third-party report only);
what `GET` answers for a deleted event (the sink says 200, `cancelled`); the
`sendUpdates` default; the per-call ceiling on freeBusy `items` and the longest
range; the sensitive or restricted class of the three scopes (Cloud Console
consent screen only); the 403 `reason` for a missing scope; a patch of a
cancelled event (the sink says 410); that `quotaExceeded` on Calendar never
clears within a minute (kept `quota`, not retried).
