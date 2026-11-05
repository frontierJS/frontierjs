# @frontierjs/conduit-easypost

EasyPost over `@frontierjs/conduit`: address verification, rates, a label
purchase, refunds, trackers, and the webhook signature. New.

**Why EasyPost over Shippo:** Basic with the key as the username reuses the
`basic` signer beside twilio; shipment → buy keeps the quote apart from the
irreversible spend; its webhooks can be signed (`X-Hmac-Signature`), Shippo's
cannot.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `easypostTarget({ ref?, address? })` — `signed`, signer `basic`, JSON; resolver string `EZAK…:` |
| calls | `verifyAddress` (answers `asked` AND `verified`), `createShipment` (quotes as minor units; customs refused locally when a border is crossed), `buyLabel` (read-back on a lost response), `refundLabel`, `createTracker`, `getShipment` |
| error mapping | `translate(error, status)` — table below |
| verifier | `verifyEasyPostSignature({ rawBody, header, secret })` — `hmac-sha256-hex=` over the raw body; no timestamp |
| sink | `sink.ts`; `POST /_sink/track` delivers a signed `tracker.updated` |
| drive | `bun run drive` — 15 rows, sink only; no fixture exists |

## Errors

| `error.code` | HTTP | conduit kind | `EasyPostFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `UNAUTHORIZED` | 401 | `auth_failed` | `auth_failed` | no |
| `ADDRESS.VERIFY.*` | 422 | `client_error` | `address_unresolvable` | no |
| `SHIPMENT.RATE.*`, no rates | 422 / 200 | `client_error` / — | `no_rates` | no |
| `SHIPMENT.CUSTOMS_INFO.REQUIRED` | 422 | `client_error` | `customs_required` (also refused locally) | no |
| `PAYMENT_REQUIRED`, `BALANCE*` | 402 | `client_error` | `payment_required` | no |
| `SHIPMENT.POSTAGE.EXISTS` and other 4xx | 422 | `client_error` | `refused` | no |
| 429 | 429 | `rate_limited` | `rate_limited` | reads replayed; buy handed back |

## The rules this connector is about

**Verification changes the address you print.** `verifyAddress` answers both
spellings and the label is bought against the carrier's. **A buy is spend
with no idempotency header.** On a lost response `buyLabel` reads the
shipment back: a `postage_label` means the money moved and that label is
answered as `recovered`; none means nothing was spent. Never retried blind.
**Money crosses as minor units plus the rate's own currency** (`"7.33"` USD →
733; a CAD rate uses CAD's exponent).
