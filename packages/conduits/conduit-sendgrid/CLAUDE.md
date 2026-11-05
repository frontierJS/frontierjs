# conduit-sendgrid — package map

`src/index.ts` target, `toSendgridPayload`, `sendEmail`, `createSendgridMailer`,
`translate` (the one reader of `error.raw`), `verifySendgridSignature`, the
domain verbs and `dnsRecordsOf` · `src/types.ts` · `sink.ts` ·
`test/sendgrid.drive.ts`.

## What bites

- **A 202 has no body.** The id is `meta.headers['x-message-id']`; a sandbox
  send is a 200 with no id, answered as `id: ''`.
- **Nothing is replayed by conduit**: a send is unkeyed and a retry is a second
  email. The resolving read is the Email Activity API, named and not built.
- **The domain verbs return CNAMEs and write nothing.** A DNS writer here would
  be a second owner of the edge seam (Invariants 4 and 5); `conduit-cloudflare`
  applies them with `proxied: false`.
- **`custom_args` come back FLAT on an event**, so `messageId` is a top-level key.

## Proving a change

`bun run drive`: 14 rows.
