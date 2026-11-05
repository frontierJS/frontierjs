# conduit-sendgrid — state

**Stub from two callers, sink-only, drive green (14 rows).** 2026-11-05.

- Source: kos `api/src/domain/mail/sendgrid.ts` + `webhooks.ts`; maid.tech
  `api/src/services/integrations/sendgrid/` and `mailer/transports/sendgrid.js`.
  Read, not moved; neither caller is adopted yet.
- Drive green against: the sink. Fixture: none. Real vendor never called.
- Not built: the Email Activity resolving read (paid add-on); attachments past
  base64 encoding; `conduit-cloudflare` applying `dnsRecordsOf` end to end;
  whether *sending domain* becomes a shared verb across the four mail connectors
  (the connectors paper, row 15).
- Finding for `CONTRACT.md`: C8's first family where the signature is ECDSA
  (asymmetric, DER-encoded) over a JSON ARRAY — the verifier answers `events`,
  plural, and dedupe is per entry by `sg_event_id`.
- FJS filed: none.
