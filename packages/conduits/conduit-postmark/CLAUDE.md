# conduit-postmark — package map

`src/index.ts` target, calls, adapter, the URL-credential verifier, the mail dialect (`postmarkMailDialect`, `toReceivedMail`) · `src/types.ts` · `sink.ts` · `test/postmark.drive.ts`.

## What bites

- **No signature exists.** The verifier compares the URL's Basic credential; a leaked URL is a forgeable webhook, and the app's `MessageID` dedupe plus the IP allow-list are all that stand behind it.
- **A batch is a 200 with per-message codes**; `ErrorCode: 0` is the only success.
- **406 is not 300**: an inactive recipient is Postmark's own suppression, and sending again is refused forever.
- **Nothing is replayed by conduit**: a retried send is a second email.
- **The dialect dedupes on Postmark's `MessageID`, which names the DELIVERY**, not the mail: the mail's Message-ID is `headers['Message-ID']` on the `ReceivedMail`, and one mail cc'd to two of our addresses is two deliveries. A `Delivery` carries no peer address, so the IP allow-list is the route's, not the dialect's.

## Proving a change

`bun run drive` — the drive, 11 rows, against the sink; no fixture, because none exists.
