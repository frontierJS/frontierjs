# conduit-mailgun — package map

`src/index.ts` target, calls, adapter, the signature verifier, the mail dialect (`mailgunMailDialect`) · `src/mime.ts` the raw-MIME parser (`fromMime`) over postal-mime — the one a second raw-MIME vendor imports · `src/types.ts` · `sink.ts` · `test/mailgun.drive.ts`.

## What bites

- **The signature signs `timestamp + token`, never the body.** A captured delivery verifies over any body inside the window; the window (`MAILGUN_WINDOW_S`) and the token spent through `seenNonce` are all that stand behind it. The verifier takes both and the dialect passes both.
- **No delivery id exists.** A retry is a new request with a new token, so dedupe is `recipient + Message-ID`, and a mail with no Message-ID keys on a sha256 of its bytes. One mail to two of our addresses is two deliveries on purpose.
- **`parse` is async** — the MIME parser is — and conduit's `Dialect.parse` allows it for this reason. A dialect reading `ev.payload` before the promise settles reads nothing.
- **The credential is `api:<key>`**, the whole Basic pair, because the built-in `basic` signer takes one string and the user is fixed. A bare key is a 401 the sink spells `Forbidden`, not JSON.
- **One `o:tag`.** Conduit's form encoder writes an array as `o:tag[0]`, which Mailgun ignores; the rest of `tags` ride as `v:` variables and come back on events, which is what `events()` filters on.
- **An attachment is refused before the send.** `encoding` is a target fact and this target is `form`; a file needs multipart. The refusal is one sentence in `toMailgunForm`.
- **Three header names are pinned** (`Message-ID`, `In-Reply-To`, `References`) so an app reading `headers['Message-ID']` gets the same answer from this dialect and Postmark's; everything else keeps the sender's spelling. junction's `headerOf` is the safe read either way.

## Proving a change

`bun run drive` — the drive, 13 rows, against the sink; no fixture, because none exists.
