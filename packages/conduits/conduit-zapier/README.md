# @frontierjs/conduit-zapier

Zapier over `@frontierjs/conduit`. New. Zapier reaches an app two ways and
both are a URL the app HOLDS: a **Catch Hook** (Webhooks by Zapier) pasted
into a form's integrations field, and a **REST Hook `target_url`** Zapier
sends when a Zap subscribes to one of the app's own triggers. Neither carries
a credential beyond the URL, so the target is `address_from: 'request'` with
`auth: none` — slack's incoming-webhook shape — and the host is not pinned:
the same field takes an IFTTT or Make URL beside a Zapier one, and this
package posts to any of them. What is Zapier's is how the answer is read, the
reverse unsubscribe, and the subscribe body's reader (`FJS-D1528`).

**Where the app only needs to tell a counterparty that signed up for events
something happened, junction's `plugins/webhooks` is the tool**: signed,
retried, a subscription row the counterparty owns. A Zapier hook is
unsigned and the row is the app's.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `zapierTarget({ id?, destinations? })` → one `TargetDescriptor`, `address_from: 'request'`, `auth: none`; `destinations` OFF in production |
| binder | `bindSend(conduit, target.id)` → `Send` |
| the post | `postHook(send, url, payload, { headers? })` → `{ result: HookReceipt }` or `{ error: ZapierFailure }`; `payload` is an object or an array, JSON on the wire |
| the reverse unsubscribe | `unsubscribe(send, targetUrl)` → `{ result: { already } }`; `DELETE <target_url>`, replayable |
| the subscribe reader | `subscriptionFrom(body, { hosts? })` → `{ ok, subscription: { targetUrl, event? } }` or `{ ok: false, reason }`; the host IS pinned here |
| types | `HookReceipt`, `HookPayload`, `Subscription`, `ZAPIER_HOOK_HOST`, `MAX_PAYLOAD_BYTES`, `MAX_URL_LENGTH` |
| error mapping | `translate(error, status)` — table below; `hookEnvelope` the C4 validator |
| sink | `sink.ts` — Catch Hooks (`/hooks/catch/<user>/<zap>[,<zap>]/`, `/silent/`), REST Hooks (`/hooks/standard/<user>/<key>/`), the reverse unsubscribe |
| drive | `bun run drive` — 17 rows against the sink |

```ts fragment
import { zapierTarget, bindSend, postHook, unsubscribe, subscriptionFrom } from '@frontierjs/conduit-zapier'

await conduit.register(zapierTarget())
const zapier = bindSend(conduit)

// a form's integrations field: one or more pasted hook URLs
for (const url of form.webhookUrls) {
  const r = await postHook(zapier, url, { form: form.name, ...response })
  if (r.error?.kind === 'off') { /* the Zap is off; tell the form's owner */ }
}

// the app's own trigger: Zapier subscribed, the app delivers
const sub = subscriptionFrom(ctx.data)              // on the subscribe route, before the row is written
if (!sub.ok) throw new BadRequest(sub.reason)
const d = await postHook(zapier, row.targetUrl, { event: 'lead.created', ...lead })
if (d.error?.kind === 'gone') await db.zapierSubscription.delete(row.id)   // Zapier unsubscribed
```

## Errors

| Zapier | HTTP | conduit kind | `ZapierFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| taken | 200 `{ status: 'success', attempt, id, request_id }`, or an empty body under `/silent/` | — | — | — |
| a 200 whose body names another `status` | 200 | `invalid_response` | `invalid_response` | no |
| the Zap is turned off or deleted | 404 | `client_error` | `off` | no |
| the REST Hook was unsubscribed; also a reverse unsubscribe of one already gone | 410 | `client_error` | `gone`; `unsubscribe` answers `already: true` | no |
| any other refusal | 4xx | `client_error` | `refused` | no |
| the account's limit (20,000 per 5 minutes, or 1,000 per Zap on a legacy URL) | 429 | `rate_limited` | handed back with `retryAfterMs`; a post is never replayed | — |
| 5xx | 5xx | `server_error` | handed back, `indeterminate: true`; `retryable: false` on a post, since conduit will not replay an unkeyed POST and Zapier names no 5xx that was refused before running | — |
| no answer to a post | — | `timeout` | `indeterminate: true`; **nothing resolves it** — Zap history has no API, and the Zap may have run | no |
| no answer to an unsubscribe | — | — | replayed by conduit; the replay finds the hook gone, `already: true` | — |
| a relative, non-http(s) or credentialed URL; a payload that is not an object or array, or over 10 MB | — | — | `refused` before the send | no |

## The rules this connector is about

**The URL is the credential and the app's row holds it.** `destinations` is
off in production: a pasted URL that resolves to a private or loopback address
is the SSRF primitive, and conduit's grade runs before every attempt. The
drive's negative control registers the target the way production does and
shows the sink's own URL refused before anything leaves.

**A post is never replayed.** Zapier runs the Zap once per request it takes
and collapses nothing — there is no idempotency header — so a 429, a 5xx and a
lost response come back to the caller, and a lost one is `indeterminate` with
no read that resolves it (CONTRACT C6, slack's amendment). An app that must
trigger exactly once puts its own id in the payload and dedupes in the Zap
(a Filter or a Storage step).

**A 404 is late.** Zapier keeps answering 200 for up to several hours after a
Zap is turned off, then 404 until it is on again. `off` is final when it
arrives; the app has no earlier signal.

**A 410 kills the row.** Zapier answers 410 to a REST Hook it unsubscribed
from and documents it as the app's signal to stop. The reverse —
`DELETE <target_url>` — is the app's way to stop after repeated refusals, and
pauses the Zap; it is idempotent at Zapier, so it is `replayable: true`.

**The subscribe reader pins the host where the post does not.** Zapier only
ever sends `hooks.zapier.com` as a `target_url`; a forged subscribe naming a
LAN host would have the app post its events inside its own network on every
trigger. `hosts` widens it for a sink. The subscribe request itself is the
app's own API, authenticated as the app's API is (an API key, OAuth) — not
this package's.

**Conduit drops the trailing slash** Zapier's URLs carry. The sink answers
both spellings; that Zapier does is unverified.

**The receipt body is observed, not documented.** Zapier's help says only
that a Catch Hook answers 200 and cannot be customized; the
`{ status, attempt, id, request_id }` fields are what a live hook answers.
`hookEnvelope` accepts an empty body and any object whose `status` is
`success` or absent, and refuses one that names another status.

## Not built

The **Actions API** (`api.zapier.com/actions/v1/`, stored actions run
asynchronously with a `callback_url`, `idempotency_id` collapsing a run for
72 hours, a JWT-signed callback under `Zapier-Callback-Signature`): it is
*Powered by Zapier*, behind a partner contract and OAuth scope `external`,
and no app here holds one. It would be the first call that needs a vendor
address and the reopen path for pinning the host. The **Partner/Workflow
API** (`/v2/zaps`, templates): same contract. **Zapier MCP**
(`mcp.zapier.com`): an MCP client, a different noun from a conduit target;
AI Actions, which it replaced, has been sunset. The app's own subscribe
and unsubscribe routes, `perform_list` sample endpoint and auth test: they
are the app's API, which junction serves.
