# conduit-resend — package map

`src/index.ts` target, calls, `toResendPayload`, `createResendMailer` ·
`src/errors.ts` the one reader of `error.raw` · `src/verify.ts` Svix, pure ·
`sink.ts` · `test/resend.drive.ts`.

## What bites

- **Nothing here is replayed by conduit**, and that is correct: a retried send
  is a second email. A 429's `retryAfterMs` is handed to the caller.
- **Two 429s, two meanings.** `rate_limit_exceeded` clears in a second;
  `daily_quota_exceeded` is `quota`, not retryable today.
- **`MailMessage` is declared here**, structurally junction's, so this package
  imports nothing from junction. Keep the two in step by hand.
- **Arm after reset.** `/_sink/reset` clears what is armed.

## Proving a change

`bun run drive`: 12 rows. No fixture exists.
