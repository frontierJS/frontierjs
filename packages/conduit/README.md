# @frontierjs/conduit

**The third parties your app integrates with, declared in one place.**

A counterparty is named once — its address, which credential authorises it, how its bodies are encoded, what happens when it is slow or down — and every call to it goes through that name. Provider APIs, remote outposts, local sidecars.

```
                    app.conduit
                         │
              ┌──────────┴──────────┐
       provider:stripe        outpost:srv-abc
              │                     │
        a third party         an FJS machine
     (http · generic)       (http · hmac-signed)
```

**Both ends.** *Integrating with* is a relationship rather than a direction — a vendor holds two of your secrets and dials you about as often as you dial it — so a Provider has a **Target**, where you send, and a **Receiver**, the route it calls you on (see [Receiving](#receiving)). The one thing that is deliberately *not* conduit's is a counterparty signing with FrontierJS's own scheme and becoming a caller — that is junction's door, `createApp({ credentials })`.

**Conduit is optional and is not a wall.** Nothing stops a raw `fetch`, and junction's own `IMail` and `IAIModel` ship working defaults that dial out directly so an app that never installs this package still sends mail. What conduit gives a call is the ring around it: a resolved credential, retry with a deadline, a circuit breaker, observers, and a line in `/metrics`. An app that has conduit can back those same contracts with it — `packages/basecamp/api/src/core/mailer.ts` is `IMail` over `app.conduit`, and junction's email campaign tier requires conduit by name.

---

## Installation

```bash
bun add @frontierjs/conduit
```

---

## Quick start

```ts
import { conduit }           from '@frontierjs/conduit'
import { createSQLiteStore } from '@frontierjs/conduit/stores/sqlite'
import { Database }          from 'bun:sqlite'

const db = new Database('hub.db')

app.configure(conduit({
  store:   createSQLiteStore(db),
  targets: [
    {
      id:            'provider:hetzner',
      kind:          'provider',
      protocol:      'http',
      address:       'https://api.hetzner.cloud/v1',
      auth:          { type: 'bearer', ref: 'HETZNER_TOKEN' },
      registered_at: Date.now(),
      last_seen_at:  null,
    }
  ],
}))
```

Targets carry a credential *reference*, not the credential. `ref: 'HETZNER_TOKEN'` is resolved at send time — by default from `process.env`. See [Credentials](#credentials).

After `app.configure()`, `app.conduit` is available everywhere:

```ts
const result = await app.conduit.send({
  target: 'provider:hetzner',
  method: 'GET',
  path:   '/servers/123',
})

if (result.error) {
  console.error(result.error.kind, result.error.message)
} else {
  console.log(result.data)
}
```

---

## Core concepts

### Targets

A **target** is a named remote endpoint. Every call goes through a target — you never pass raw URLs to `send()`.

```ts
interface TargetDescriptor {
  id:            string      // "provider:stripe" | "outpost:srv-abc"
  kind:          'provider' | 'outpost' | 'local' | 'broker'   // broker: subscribed to, never sent to
  protocol:      'http' | 'websocket' | 'unix'
  address:       string      // base URL or socket path
  auth:          TargetAuth
  encoding?:     'json' | 'form'   // how bodies go on the wire; default 'json'
  idempotency?:  { header?: string; auto?: boolean }
  resilience?:   TargetResilience // what this one costs when it misbehaves
  registered_at: number      // unix ms
  last_seen_at:  number | null
}
```

Targets can be registered statically at startup (see `opts.targets`) or dynamically at runtime (see `register()`).

### A destination held in a row

Some destinations are not the app's to declare: a Slack or webhook URL a user
pasted, one per row, which is its own credential. Registering one target per
row would put each URL in the registry and in every observer. Declare one
target with `address_from: 'request'` and name the URL on each send:

```ts
{ id: 'hook:slack', kind: 'provider', protocol: 'http', address: '',
  address_from: 'request', auth: { type: 'none' }, registered_at: 0, last_seen_at: null }

await app.conduit.send({ target: 'hook:slack', address: row.url, method: 'POST', body: { text } })
```

Each attempt checks the URL as one a stranger chose (junction's
`assertPublicUrl`): public https only, unless `destinations: { allowHttp,
allowPrivate }` says otherwise for a test receiver on localhost. `allowPrivate`
opens the whole target to every row, so a counterparty on a LAN is never a
row's to name: it is a fixed-address target the operator declares, or an
Outpost vantage (`FJS-D1018`). The breaker is kept per origin, and observers
see the origin, never the path. Such a target takes `none` or `hmac` auth and
follows no redirect, because a stored key would go wherever the row says.

A self-hosted instance a row names — Plausible CE at the client's own domain,
with the client's own key — takes that row's credential, `per_caller`
(`FJS-D1089`): the send names the row with `grant`, the resolver's `getFor`
answers that row's token, and a send with no `grant` is refused by name, since
keyed on the tenant alone two rows would share one cached token.

```ts
{ id: 'provider:plausible', kind: 'provider', protocol: 'http', address: '',
  address_from: 'request', auth: { type: 'bearer', ref: 'PLAUSIBLE', per_caller: true }, registered_at: 0, last_seen_at: null }

await app.conduit.send({ target: 'provider:plausible', address: `${row.address}/api/v2/query`, grant: row.id, method: 'POST', body: q })
```

### Receiving

A Provider that dials you — Stripe posting an event, a carrier posting a receipt — is declared as a **Receiver**. Three parties write it and conduit runs it (`FJS-D899`):

- the **connector** exports the Provider's `Dialect` — how it signs, what its envelope is, what names one delivery. Pure: the clock is passed in.
- the **app** declares the `Receiver` — the path, which credential verifies a delivery, whose tenant an event is about, and what to do with it.
- **conduit** mounts the route and runs the order: credential → verify → parse → owner → receipt → apply → mark.

```ts
// the connector's half
export const stripeDialect: Dialect<string, StripeEvent> = {
  verify:    (d, secret, { now }) => verifyStripeSignature({ rawBody: d.rawBody, header: d.headers['stripe-signature'], secret, now }),
  parse:     (d)                  => isEvent(d.body) ? { id: d.body.id, type: d.body.type, payload: d.body } : null,
  dedupeKey: (_d, ev)             => ev.id,
}

// the app's half
app.conduit.receive({
  provider:   'stripe',
  path:       '/webhooks/stripe',          // under apiPrefix, like app.post
  dialect:    stripeDialect,
  credential: 'STRIPE_WEBHOOK_SECRET',     // a ref → the installed CredentialResolver
  owner:      async ev => shopFor(ev.payload.account),
  apply:      async (ev, { owner }) => { await settle(owner, ev); return 'applied' },
})
```

`credential` is a ref for the ordinary one-key relationship, or a function choosing the key for ONE delivery before the body is believed — a per-subscription secret the path names: `credential: d => keyFor(d.route.hookId)`. `null` refuses.

**What the route answers.** A refusal — forged, stale, a replayed nonce, a key that did not resolve — is a 401 with one sentence, `not verified`; the reason goes to the log (`observers.onReceived`), never to the sender. A body that is not an event is 200 and `ignored`, because a 4xx retries forever. An `apply` that throws is a 500 and the sender retries.

**Dedupe means applied, not seen.** Conduit keeps a receipt per delivery in its store (`conduit_receipts` beside `conduit_targets`), written before `apply` and marked after it. Only an applied receipt makes a redelivery a `duplicate`; a receipt left unapplied by a throw is applied again by the retry. So applying twice must be safe, and the subject's own unique key inside your `apply` is what makes it so — one fact can also arrive as two deliveries with two ids, which no receipt can see. `apply` answers `applied`, `ignored` (recorded and done, marked too) or `parked` (left unapplied on purpose: a receipt that arrived before the send that minted its id).

A dialect whose signed timestamp bounds freshness needs nothing more; one whose scheme carries a nonce (FrontierJS's own) is handed `seenNonce(nonce, keepSeconds)` in `verify`'s context — one memory per receiver, kept for twice the tolerance.

Resilience does not cross: the retry is the sender's, and there is no breaker on the inbound side. A receiver never mints a principal; `apply` runs as whoever you say.

**A Provider that pushes over a socket you dial** — Mattermost's WebSocket — is a receiver that names a `broker` target in place of a path (`FJS-D1127`). Conduit dials it with the target's credential, reconnects without bound, reports `health()` under `conduit:<target>`, and runs each frame through the same order from parse on. No route is mounted, so nobody can post a frame to you; a receiver on a target carrying `path`, `credential` or a dialect `verify` is refused by name. The connector's `FrameDialect` adds `framing`: a `handshake` run after open and before the first frame is believed (handed the secret the dial spent, so the two cannot differ), a `decode` from text to `{ id, body }` or `null`, and an `ack` for a Provider that redelivers. Frames are handed over one at a time in arrival order, because an edit applied before its create is a wrong row and two copies of one frame applied side by side both pass the receipt.

```ts
await app.conduit.register(mattermostSocketTarget({ address: 'https://chat.example' }))
await app.conduit.receive({
  provider: 'mattermost',
  target:   MATTERMOST_SOCKET_TARGET,   // resolves once the first dial is tried
  dialect:  mattermostSocketDialect,    // { framing, parse, dedupeKey }
  apply:    async ev => { await land(ev); return 'applied' },
})
```

`stats().subscriptions[target].dropped` counts frames over `max_response_bytes` and frames the framing could not read; `stats().received[target]` counts outcomes as a route's do.

### Mirroring

A **mirror app** keeps rows whose system of record is a Provider (`IDEAS/mirror-apps.md`). The schema declares the model `@@mirror(key: externalId)` and names no vendor; the connector exports a **claim** naming the models it feeds, and the app binds it in wiring (`FJS-D1125`):

```ts
import { mirror } from '@frontierjs/conduit-mattermost'

app.configure(conduit({ credentials, targets }))
app.conduit.mirror(mirror)          // Post, Channel, ChannelMember, …
```

A claim is `{ provider, models }`, keyed by the schema's PascalCase model name. Each model states `key` (the row field holding the Provider's id), `target` (what its verbs spend), `parse(remote, scope?)` from a Provider object to a row, and any of `create(input)`, `update(key, patch)`, `delete(key)` building a request with no `target`.

Junction's generated `create`, `update`, `patch` and `remove` on a claimed model forward through it. The caller's gate and hooks run first; the row validator steps aside, because the payload is the claim's input and not a row (a `pendingPostId` is no column). The request is sent as the caller — a `per_caller` target spends their own credential — the answer is parsed by the same `parse` the socket uses, upserted by the key as the system (the key left out of the update half, since it is `@immutable`), and re-read as the caller. A `@local` column the caller named — the app's own, like a `starred` — is written through the caller's client, under their policies; every other column of a `@@mirror` model is `@system`, so the caller cannot write it around the Provider (`FJS-D1142`). A delete answering no row removes the local one. A verb the claim does not export runs as it would on any model, and a write naming no single row is refused, since each is a call to the Provider.

A Provider's refusal reaches the caller as a status: a 4xx it gave is 422 (404, 409 and 410 pass through), a credential it refused is 403, its rate limit 429, a timeout 504, an outage 502 or 503. A verb that throws building its request is a 400 and nothing is sent.

Refused by name: a malformed claim and a second claim on one model, when `mirror()` is called; and at boot (or at `mirror()` after start), a claim on a model the schema lacks, on one that is not `@@mirror`, or with a `key` that `@@mirror(key:)` does not name.

### Resilience

One conduit carries a card processor, a mail sink and a health probe, and 10s
with three retries is generous for one, thin for another and absurd for the
third. Every resilience number can be stated on the target, and each falls back to
the conduit-wide option of the same name — state one and the rest are unchanged.

```ts
interface TargetResilience {
  timeout_ms?:         number   // per attempt
  retry_limit?:        number   // retries after the first attempt
  deadline_ms?:        number   // total wall clock for one send()
  max_response_bytes?: number
  failure_threshold?:  number   // consecutive faults before the breaker opens; 0 disables
  reset_ms?:           number   // how long it stays open
  max_concurrent?:     number   // in-flight cap; Infinity removes it
}
```

```ts
{ id: 'provider:stripe', /* … */ resilience: { timeout_ms: 20_000, retry_limit: 1 } }
{ id: 'local:mail',      /* … */ resilience: { timeout_ms: 2_000,  max_concurrent: 8 } }
```

### Retries and idempotency

A non-idempotent method — POST, PATCH — is replayed only when there is an
idempotency key, and the error from one conduit refused to replay says so:
`retryable: false`, because that flag is what the layer above acts on. It carries
`indeterminate: true` where the request went out and its outcome is unknown,
which is the question a payment caller actually has and is not the same as
whether sending it again is safe.

```ts
{ id: 'provider:paypal', /* … */ idempotency: { header: 'PayPal-Request-Id' } }
{ id: 'provider:psp',    /* … */ idempotency: { auto: true } }
```

A caller with no key can still say the request is safe to repeat:

```ts
await conduit.send({ target: 'provider:psp', method: 'POST', path: '/intents',
                     body, replayable: true })
```

That is a different claim from a key — a key says the target collapses
duplicates, `replayable` says repeating costs nothing — and conduit, which sees
a method and a path, can make neither on the caller's behalf.

`header` defaults to `Idempotency-Key`. `auto` mints a key for any
non-idempotent request that carries none, once per `send()` so every attempt
inside one send carries the same one — it is off by default, because minting a
key for a target that ignores it turns one refused retry into four charges.

An unknown field, or a value that cannot mean anything, is refused by name at
`register()` — a resilience field is written by hand, and being quietly ignored is
how a target declared with a 1ms timeout answers a 300ms request as a success.

### Auth

Auth is declared on the target and applied automatically on every request. Callers never touch headers manually.

| type      | behavior |
|-----------|-----------|
| `bearer`  | Adds `Authorization: Bearer <secret>` |
| `api_key` | Adds a custom header: `{ header: 'X-Api-Key', ref: 'STRIPE_KEY' }` |
| `hmac`    | Signs a canonical string with HMAC-SHA256 — see below |
| `signed`  | A vendor's own scheme, as a function a connector supplies; HTTP Basic is the built-in `signer: 'basic'` — see *Signers* |
| `none`    | No auth headers added |

Applied on **every** protocol: HTTP and Unix on each request, WebSocket on the connection upgrade.

#### HMAC signing

The signature covers a canonical string, not just the body:

```
<METHOD>\n<path>\n<query>\n<timestamp>\n<nonce>\n<sha256-hex of body>
```

`<query>` is the query string's pairs sorted and percent-encoded, empty when there is none — so a parameter cannot be changed under a valid signature.

emitted as three headers (prefix configurable via `header_prefix`, default `X-Fjs`):

```
X-Fjs-Signature: v1-sha256=<hex>
X-Fjs-Timestamp: <unix seconds>
X-Fjs-Nonce:     <uuid>
```

This binds each signature to one method, one path and one query, so a captured signature cannot be replayed against a different endpoint on the same target, and the timestamp and nonce let the receiver reject stale or repeated requests. Requests with no body sign the hash of the empty string, so `POST /reboot` and `DELETE /servers/42` are signed like anything else.

**The receiving outpost must do its part:** recompute the same canonical string, compare in constant time, reject signatures outside a freshness window (60s is typical), and remember recent nonces. A signature check that ignores the timestamp gives you no replay protection.

#### Signers

A secret inside the body, SigV4 and a minted JWT are not new `type`s. One
`signed` type names a function in `ConduitOptions.signers`, which a connector
exports for the app to spread in:

```ts
const inBody: Signer = ({ secret, body }) => ({ body: `${body ?? ''}&secret=${secret}` })

createConduit({ signers: { inBody }, targets: [
  { id: 'provider:turnstile', …, encoding: 'form', auth: { type: 'signed', signer: 'inBody', ref: 'TURNSTILE' } },
] })
```

**HTTP Basic is built in** as `signer: 'basic'` and needs no install: the ref
resolves to `user:password` (RFC 7617, UTF-8; a key with no colon is sent as
`key:`). A connector's signer may not take the name. OAuth's client
authentication form-encodes the halves first (RFC 6749 §2.3.1) and is a
different scheme with its own signer.

The signer is handed the resolved `secret`, the `method`, `url`, `path`, `query`,
the serialized `body` and the `headers` already set. It returns `headers` to add
and, where the vendor wants the secret in the payload, a replacement `body`;
auth headers still win over a caller's. A name is refused at `register()` when
no such signer is installed, and so is `follow_redirects` or `address_from`
beside it, for `hmac`'s reason.

**A minted credential's lifetime is the resolver's, and the answer says it.** A JWT
or an OAuth access token is what the resolver's `get(ref)` returns — mint it there,
answer `{ value, expires_at }` with the provider's own number, and
`withCache(resolver, { ttl_ms: Infinity })` holds it exactly that long. A 401
forgets it through `invalidate` and the send replays once on a fresh one, as for
any credential. The signer sees only the string.

**A mint that calls a third party sends through conduit too.** An OAuth token
exchange is a request to someone else's endpoint, so it gets its own `auth:
'none'` target and the resolver sends through it (`FJS-D933`) — the endpoint
then has a breaker, an observer and a timeout. When that send fails, the
resolver throws `new MintError(r.error)`: the send that needed the token is
`auth_failed` with nothing sent, but with the mint's `retryable` and
`retry_after_ms`, and the mint's error as `raw`. Thrown as anything else, a
token endpoint's 503 reads as a permanent `auth_failed` and a job drops the
work. Conduit never replays a failed mint itself; the token target ran its own
retries.

#### WebSocket auth

Credentials go on the **upgrade request**, using Bun's `headers` option on the `WebSocket` constructor. For an `hmac` target the upgrade is signed with method `CONNECT` and the address path.

This authenticates the *connection*. There is no per-frame signature — anything able to write to an established socket can issue any command on it. If you need per-command authentication, terminate the socket per operation or add frame signing on both ends.

### Body encoding

A target declares how its request bodies go on the wire — it is a fact about who is on the other end, not about one call.

| `encoding` | content-type | for |
|---|---|---|
| `json` (default) | `application/json` | most REST APIs |
| `form` | `application/x-www-form-urlencoded` | Stripe, PayPal, Twilio, every OAuth token endpoint |
| `binary` | `application/octet-stream`, or whatever the caller states | raw uploads — an attachment endpoint, object storage |

Under `binary` the body is a `Uint8Array` or `ArrayBuffer` and is passed through untouched; the content-type belongs to the caller, because it is per file rather than per target. Bytes under `json` or `form` are **refused** rather than serialized — `JSON.stringify` turns a PNG into `{"0":137,"1":80,…}` and sends it confidently.

The encoded body is the same value the HMAC signer hashes, so an encoder anywhere else signs bytes the transport did not send.

### Constant headers

`headers` on a target is sent with every request to it — a pinned API version, a required `User-Agent`. It sits below `req.headers`, so a caller can still override one, and below the auth headers, which nothing may displace.

Header precedence is **case-insensitive**: `authorization` from a caller and `Authorization` from the target's auth are the same header, and the auth one wins. (A plain object merge kept both and `fetch` joined them with a comma.)

### Credentials

A `TargetDescriptor` holds a credential **reference**, never the secret:

```ts
auth: { type: 'bearer', ref: 'HETZNER_TOKEN' }
```

The reference is resolved at send time by a `CredentialResolver`, so secret material never enters the registry, `resolve()`, `list()`, the observers, or the management routes.

```ts
type Material = string | { value: string; expires_at?: number }   // epoch ms; a string never expires on its own

interface CredentialResolver {
  get(ref: string): Promise<Material | null>
  invalidate?(ref: string, value: string): void   // the target refused `value` — a 401, or a declared `auth.refusal`
  getFor?(ref: string, who: CredentialCaller): Promise<Material | null>   // a `per_caller` target's (FJS-D848)
  invalidateFor?(ref: string, value: string, who: CredentialCaller): void
}
```

Five are built in:

```ts
import {
  createEnvResolver,     // reads process.env[ref] — the default
  createStaticResolver,  // fixed { ref: secret } map, for the composition root and tests
  createNullResolver,    // resolves nothing; every ref fails closed
  withCache,             // cache around any resolver — until ttl_ms or the answer's expires_at
  byRef,                 // one resolver per ref — credentials with different lifetimes
} from '@frontierjs/conduit'

app.configure(conduit({
  credentials: withCache(createVaultResolver(), { ttl_ms: 300_000 }),
}))
```

`byRef({ APNS_KEY: withCache(apns, { ttl_ms: 50 * 60_000 }), FCM_SA: withCache(fcm, { ttl_ms: 55 * 60_000 }), STRIPE_KEY: createEnvResolver() })` gives each ref its own resolver and its own cache; `invalidate` reaches the entry that answered. A ref the table does not name resolves to nothing.

**Unresolvable refs fail closed.** If `get()` returns `null` or an empty string, the request is not sent — `send()` returns `error.kind === 'auth_failed'` with `retryable: false`. The error names the target and the ref, never the value.

Transports resolve once per attempt, so a retried request calls the resolver up to `retry_limit + 1` times. Wrap anything networked in `withCache`.

**An answer may say when it expires.** `get()` and `getFor()` answer `string | { value, expires_at } | null`, `expires_at` in epoch milliseconds. `withCache` keeps an answer until its `expires_at` or the cache's `ttl_ms`, whichever comes first, so a token minted for `expires_in` seconds is answered as `{ value, expires_at: Date.now() + expires_in * 1000 }` under `ttl_ms: Infinity` — the provider's number, never a TTL copied from its documentation. Five callers finding one token expired share one refresh. An answer already expired is used for the send that asked and not kept; an `expires_at` that is not a finite number fails the send `auth_failed` by name.

**A refused credential is answered once by a fresh one.** When the resolver has `invalidate`, the transport hands it the value the target refused and replays the send once — any method, since a 401 means the request was not acted on — on whatever `get()` returns next. A second refusal is `auth_failed`. The replay is not an attempt: it does not count against `retry_limit`. A 403 is never replayed. `withCache` implements `invalidate` as a compare-and-set: it forgets the value only if it is still the cached one, so twenty sends refused on one stale credential fetch one fresh one, not twenty.

**A target that never says 401 declares what it says instead.** Many systems that only have a login page answer a dead session with that page — a 200 carrying HTML, or a 302 to it. `auth.refusal` names those shapes, and each is then `auth_failed` and replayed exactly as a 401 is:

| `refusal` | means |
|---|---|
| `'markup'` | a 2xx whose body is HTML where a payload was expected — otherwise `invalid_response` |
| `'redirect'` | any 3xx this target does not follow — otherwise `redirected` |

Undeclared, neither shape is a refusal: a captive portal answers 200 HTML too, and is not a credential problem. Refused at `register()` with `auth: 'none'`, on a protocol other than `http`/`unix`, or for a shape not in the table.

#### A credential a login mints

A system with no API key — a username and password that mint a cookie session — is `withCache` with no expiry around a `get()` that logs in (a session that states its lifetime answers `{ value, expires_at }` instead). The login is its own target, so it is observed and policed like any other call:

```ts
const c = createConduit({
  credentials: withCache({
    async get(ref) {
      if (ref !== 'SA_SESSION') return env.get(ref)
      const res = await c.send({
        target: 'sa-login', method: 'POST', path: '/WebServices/UserLogin.asmx/Login',
        body:   { Data: { User: await env.get('SA_USER'), Password: await env.get('SA_PASSWORD') } },
      })
      if (res.error) return null   // fails closed as auth_failed
      return res.meta.headers?.['set-cookie']
        ?.split('\n').map(line => line.split(';')[0]).join('; ') ?? null
    },
  }, { ttl_ms: Infinity }),
  targets: [
    { id: 'sa-login', /* … */ auth: { type: 'none' } },
    { id: 'sa',       /* … */ auth: { type: 'api_key', ref: 'SA_SESSION', header: 'Cookie', refusal: ['markup', 'redirect'] } },
  ],
})
```

A burst against a cold session logs in once (`withCache` collapses concurrent misses); a session that expires is answered by one login and one replay. Service Autopilot answers 200 to a wrong password and hands back a cookie that works for nothing, so a login that "succeeds" is not proof — `refusal` is: each send logs in once, is refused, and fails `auth_failed`, and a corrected password is picked up by the next send. A throw from `get()` is a retryable `connection_failed`; a `null` is a permanent `auth_failed`.

### Protocols

| protocol    | status | used for |
|-------------|--------|----------|
| `http`      | ✅ v1  | Third-party REST APIs, and `@frontierjs/outpost` (with `hmac`) |
| `websocket` | ✅ v1  | FJS-to-FJS control-plane links — Conduit's own frame envelope, reconnecting. Not a generic WS client |
| `unix`      | ✅ v1  | Local sidecar processes |
| `ssh`       | 🔜 future | — |
| `nats`      | 🔜 future | — |

### Results

`send()` never throws. It always returns a `ConduitResult`:

```ts
const result = await app.conduit.send({ ... })

if (result.error) {
  // result.error.kind    — 'target_not_found' | 'timeout' | 'auth_failed' | ...
  // result.error.retryable — whether it's worth retrying
  // result.data          — null
} else {
  // result.data          — parsed JSON response
  // result.meta.status   — HTTP status code
  // result.meta.headers  — the response's headers, lowercased
  // result.meta.duration_ms
}
```

`meta.headers` is where the answers a caller cannot get any other way live — RFC 5988 `Link` for the next page, `ETag`/`Last-Modified` for a conditional request, `X-Total-Count`. It is present on failures too (a 429's `Retry-After`, a 5xx's request id) and absent only when nothing was sent. `set-cookie` holds every line, joined by `\n` — a comma cannot separate them, since an `Expires` date carries one.

**A `304 Not Modified` is a success**, not an error: `data` is `null`, `meta.status` is 304, and the validator headers come back. Send `If-None-Match` off the previous response's `ETag` and serve your own copy when you get one.

`meta.duration_ms` is the **whole call**, every retry included — the same number `conduit.stats()` records, so the two cannot disagree.

This holds for bad input too: a body that will not serialize (a cyclic object, a `BigInt`) returns `invalid_request` rather than throwing out of `send()`.

| `error.kind` | retryable | meaning |
|---|---|---|
| `target_not_found` | no | no target registered under that ID |
| `auth_failed` | no | 401/403 from the target, a shape its `auth.refusal` declares, or a credential ref that would not resolve |
| `invalid_request` | no | body would not serialize, or the method is not a valid HTTP verb |
| `timeout` | yes | exceeded `timeout_ms`, including during the response body read |
| `connection_failed` | yes | could not reach the target, or the conduit has been destroyed |
| `rate_limited` | yes | 429, or a 503 that named a `Retry-After`. Carries `retry_after_ms`, which the retry ladder waits instead of its own backoff, and **does not count toward the circuit breaker** — a rate limit says the target is healthy and we are asking too fast |
| `server_error` | yes | 5xx **only**. The one response-shaped kind the breaker counts |
| `client_error` | no | any other 4xx — the target understood and refused. `raw` carries the body, which on a 4xx is usually the half you can act on: a validation report, a decline code |
| `invalid_response` | no | the target answered and the answer is unusable — HTML where a payload was expected, a body that did not parse as the JSON it claimed, a body past `max_response_bytes`, or a response that failed the `validate` you declared |
| `not_implemented` | no | the target's protocol has no transport yet (`ssh`, `nats`) |
| `circuit_open` | yes | the target's breaker is open — nothing was sent, and the message names the seconds to wait |
| `overloaded` | yes | the target's concurrency cap is full — nothing was sent |
| `aborted` | yes | the caller's `signal` ended the call. **Does not count toward the circuit breaker** — the caller left, the target did not fail. On an unkeyed POST that was in flight it comes back `retryable: false, indeterminate: true`, like a timeout |
| `redirected` | no | a 3xx. Redirects are not followed unless the target sets `follow_redirects: 'same-origin'`, because a followed redirect re-sends the credential to wherever it points |
| `stream_error` | no | a stream failed after it opened — a socket that dropped, or an `http` event stream that ended inside an event |

`stream()` throws a `ConduitStreamError` if the stream cannot be established — target not found, a refused credential, a breaker that is open, a cap that is full, or a status that is not 2xx. Once streaming, chunks arrive as `AsyncIterable<ConduitChunk>`. `err.conduit` is the same `ConduitError` `send()` answers for the same failure, and `err.meta.status` is the status, so one translation reads both.

It also throws if the socket **drops mid-stream**, so a network blip during a log tail terminates the consumer instead of blocking it forever. Chunks already yielded are yours to keep; wrap the `for await` in a `try/catch` to distinguish "the log ended" from "the connection died".

**Over `http` and `unix`, what a chunk holds is decided by the response's `content-type`** (`FJS-D934`). A `text/event-stream` body yields one chunk per event, `data: { event, data, id }` as `@frontierjs/toolbelt/sse` reads it. Any other body yields a `Uint8Array` per read and is never held whole, so `max_response_bytes` does not apply to it. Each chunk's `meta` carries the response's status and headers.

```ts
const body = { model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hello' }] }
for await (const chunk of app.conduit.stream({ target: 'provider:anthropic', method: 'POST', path: '/v1/messages', body })) {
  const { event, data } = chunk.data as { event: string; data: unknown }
  console.log(event, data)
}
```

The stream is opened through the same ladder as `send()`: a 401 remints once, a 429 is `rate_limited` with its `retry_after_ms`, and an idempotent request is retried before its first byte. The per-attempt `timeout_ms` covers the wait for headers only, and the caller's `signal` bounds the stream itself. An open stream holds one of the target's `max_concurrent` slots until it ends, and breaking out of the `for await` closes the body.

SSE has no end marker of its own, so a body that closes between two events reads as a stream that finished. Whether the vendor sent its last event (`message_stop`, `[DONE]`) is the connector's to check.

---

## API

### `app.conduit.send(req)`

Send a request to a registered target. Returns `ConduitResult<T>`.

```ts
const result = await app.conduit.send<ServerResponse>({
  target:     'provider:hetzner',   // required — registered target ID
  method:     'POST',               // HTTP verb or protocol-specific method
  path:       '/servers',           // path on the remote
  query:      { page: 2, tag: ['a', 'b'] },  // ?page=2&tag=a&tag=b
  body:       { name: 'web-01' },   // JSON-serializable
  headers:    { 'X-Custom': '1' },  // merged with auth headers — auth wins
  timeout_ms: 5_000,                // per attempt — overrides the target's resilience
  signal:     ac.signal,            // ends the call — see Canceling below
})
```

**Auth headers take precedence over `headers`.** A caller cannot override or strip the target's credential, so a code path where user data reaches `req.headers` cannot become credential substitution.

`query` merges with any query string already on `path`, and array values produce repeated keys. For GET requests a plain `body` is still flattened into the query string as a shorthand; `query` is applied after and wins on conflict.

#### Retries

`GET`, `HEAD`, `OPTIONS`, `PUT` and `DELETE` are retried on retryable errors, up to `retry_limit`.

**`POST` and `PATCH` are never retried by default.** A timed-out `POST /servers` may have committed on the target, and re-sending it bills for a second server. The timeout is returned to you and the decision is yours.

Backoff is jittered, so N callers hitting the same degraded provider don't retry in lockstep, and the whole call — every attempt plus every sleep — is capped by `deadline_ms`.

#### Canceling

`signal` ends the call: the attempt in flight is closed at the socket, no further attempt starts, and a backoff sleep wakes early. The answer is `aborted`, and it never counts against the target's breaker. A signal that is already aborted sends nothing and takes no concurrency slot.

It is also how a caller sets a deadline for the whole call. `AbortSignal.timeout(400)` bounds every attempt and every sleep, and `AbortSignal.any([quorum.signal, AbortSignal.timeout(400)])` cancels the rest of a fan-out once it has its answer. There is no per-request `deadline_ms`. A caller's budget answered as `timeout` would open the breaker on a healthy target for every other caller (`FJS-1409`), and the target's own `resilience.deadline_ms` is still the ceiling. A per-request `timeout_ms` shorter than the target's own is the same patience: its miss answers `timeout` and the breaker does not count it.

```ts
const ac      = new AbortController()
const signal  = AbortSignal.any([ac.signal, AbortSignal.timeout(400)])
const answers = providers.map(target => app.conduit.send({ target, method: 'GET', path: '/search', query: { q }, signal }))
// …once enough have answered:
ac.abort()   // every loser is closed at its provider, and none is retried
```

`http`, `unix`, `websocket` and the test stub all honor it.

On an HTTP or Unix target, a method that isn't a valid HTTP verb returns `invalid_request` rather than being coerced to `POST`. A typo like `'GTE'` used to become a live write.

#### Load shedding

Retries alone make an outage worse: every call costs `retry_limit + 1` attempts against a dependency that is already struggling, while holding one of your request handlers. A per-target circuit breaker stops that.

```ts
conduit({
  resilience: {
    failure_threshold: 5,       // consecutive failures before opening (0 disables)
    reset_ms:          30_000,  // how long it stays open
    max_concurrent:    10,      // per-target in-flight cap (default: 64)
  }
})
```

Open → requests fail immediately with `circuit_open` and **nothing leaves the process**. After `reset_ms` exactly one trial request is admitted; success closes the breaker, failure reopens it for another full window.

Only failures that implicate the target count — `connection_failed`, `timeout`, `server_error`. An unresolvable credential, an unserializable body or a typo'd method is your bug, and tripping a breaker on it would hide the real error behind `circuit_open` forever.

**Which is why `server_error` is 5xx and nothing else.** It used to be every non-2xx and every unusable body as well, and one word fed three consumers that disagree about it: the retry decision, the `retryable` flag a background job acts on, and this count. Five 404s in a row opened the breaker on a target that had answered every one of them, after which correct requests were shed locally (`FJS-684`). A 404 is not evidence of an outage and neither is an error page; `client_error` and `invalid_response` say so and stay out of the count.

Beyond `max_concurrent`, requests fail fast with `overloaded` rather than queueing — a bounded queue just moves the pile-up somewhere less visible. **The default is 64 rather than unlimited**, because unlimited was not unbounded either: a burst queues inside the connection pool with the per-attempt timer already running, so the wait comes back as the target's own timeout. Measured at 5000 concurrent against a target that answered every request: 10s, 136 timeouts, 533 file descriptors, breaker open. Pass `Infinity` for the old behavior. Breaker state per target shows up in `stats().breakers`, and only for targets that are not healthy-and-idle.

#### Validating responses

`data` is otherwise an unchecked cast: a provider returning `{"error": "quota exceeded"}` under HTTP 200 flows through as a success.

```ts
const result = await app.conduit.send<Server>({
  target: 'provider:hetzner',
  method: 'GET',
  path:   '/servers/42',
  validate: {
    validate: (data) => isServer(data)
      ? { ok: true,  value: data }
      : { ok: false, errors: ['expected a Server'] },
  },
})
```

The interface is structural, not tied to a schema library, so Junction's `createSchema`, zod, valibot or a hand-written predicate all fit with a small adapter. A failure returns a non-retryable `invalid_response` with the raw payload on `error.raw`.

To opt a specific call in, pass an idempotency key — your assertion that the target collapses duplicates. It is forwarded as an `Idempotency-Key` header:

```ts
await app.conduit.send({
  target:          'provider:hetzner',
  method:          'POST',
  path:            '/servers',
  body:            { name: 'web-01' },
  idempotency_key: 'create-web-01',
})
```

### `app.conduit.stream(req)`

Stream responses from a target. Throws `ConduitStreamError` if setup fails.

```ts
try {
  for await (const chunk of app.conduit.stream({ target: 'hub:peer', method: 'logs' }))   // a websocket target {
    console.log(chunk.data, chunk.sequence)
  }
} catch (err) {
  if (err instanceof ConduitStreamError) {
    console.error(err.conduit.kind)
  }
}
```

### `app.conduit.register(descriptor)`

Register or update a target at runtime. Evicts any pooled connection for that target so the next `send()` uses the updated config.

```ts
// Typically called when an outpost sends its first heartbeat
await app.conduit.register({
  id:            `outpost:${serverId}`,
  kind:          'outpost',
  protocol:      'http',
  address:       data.outpost_url,
  auth:          { type: 'hmac', ref: `outpost-secret:${serverId}` },
  registered_at: Date.now(),
  last_seen_at:  Date.now(),
})
```

The outpost's secret itself goes wherever your `CredentialResolver` reads from — not into the descriptor.

### `app.conduit.touch(id)`

The heartbeat path. Refreshes `last_seen_at` without rewriting the descriptor and without evicting the pooled connection — an outpost saying "still here" should not tear down the socket it said it on.

```ts
await app.conduit.touch(`outpost:${serverId}`)
```

Static targets from `opts.targets` keep whatever `last_seen_at` the store already holds across a restart, so rebooting does not wipe heartbeat state.

### `app.conduit.deregister(id)`

Remove a target and evict its pooled connection.

### `app.conduit.resolve(id)`

Look up a target by ID. Returns `TargetDescriptor | null`.

### `app.conduit.list()`

Returns all registered targets, ordered by `registered_at`.

### `app.conduit.receive(receiver)`

Declare the receiving end of a Provider and mount its route — see [Receiving](#receiving). Refused by name for an unknown field, a path without a leading `/`, a dialect missing a function, or a path already declared. A receiver that names a `target` instead subscribes to that broker and mounts nothing; it returns a promise that settles once the first dial has been tried, and one target takes one receiver.

### `app.conduit.mirror(claim)`

Bind a connector's mirror claim — see [Mirroring](#mirroring). `app.conduit.mirrored(accessor)` answers the forward a claimed model's generated verbs use, or `undefined`; `app.conduit.claimed()` lists what is held.

### `app.conduit.accept(path, delivery, now)`

Run one delivery through the receiver declared at `path`; `now` is seconds. The plugin's route calls it; a test calls it directly with a hand-built `Delivery`. Answers `{ status, body, result, reason? }`.

### `app.conduit.destroy()`

Closes all pooled transport connections. Wired to the plugin's `shutdown()`, so it runs on `app.stop()`.

**Terminal.** A conduit is not reusable afterwards: a late in-flight `send()` returns `connection_failed` and `stream()` throws, rather than quietly opening a fresh connection after shutdown.

---

## Plugin options

```ts
conduit({
  // Registry backend. Defaults to in-memory (lost on restart).
  // Pass createSQLiteStore(db) for persistence.
  store?: ConduitStore

  // Resolves a target's auth.ref to secret material at send time.
  // Defaults to createEnvResolver() — refs are read from process.env.
  credentials?: CredentialResolver

  // Targets to register immediately on boot.
  // Use for provider integrations known at startup time.
  targets?: TargetDescriptor[]

  // Request timeout in ms. Default: 10_000.
  // Covers the whole exchange including the response body read, so a
  // server that sends headers and then stalls still times out.
  // Can be overridden per-request via req.timeout_ms.
  timeout_ms?: number

  // Retry limit on retryable errors (5xx, 429, timeout, connection failure).
  // Default: 3. Set to 0 to disable retries.
  // Only applies to idempotent methods — see Retries below.
  retry_limit?: number

  // Total wall-clock budget for one send(), across every attempt and every
  // backoff sleep. Default: 45_000.
  deadline_ms?: number

  // Hard cap on a response body, in bytes. Default: 10 MiB.
  // Reading stops at the cap and the request fails with `invalid_request`
  // rather than buffering an unbounded response.
  max_response_bytes?: number

  // Lifecycle observers for observability and debugging.
  observers?: ConduitObservers

  // Per-target circuit breaker and concurrency cap. See Load shedding.
  resilience?: ResilienceOptions

  // Returns headers to attach to every outbound request.
  // See createTraceContext() below.
  trace?: (req: ConduitRequest) => Record<string, string> | null

  // Expose a management service for listing and deregistering targets.
  // Disabled by default. Enabling it requires an access decision — `hooks`
  // (Junction's HookMap) or an explicit `public: true` — or configure() throws.
  management?: { path?: string; gate?: number; hooks?: HookMap; public?: true }
})
```

---

## Registry backends

### In-memory (default)

Zero dependencies. Targets are lost on process restart. Suitable for stateless apps or local development.

```ts
import { createMemoryStore } from '@frontierjs/conduit/stores/memory'

conduit({ store: createMemoryStore() })
// or just:
conduit() // in-memory is the default
```

### SQLite

Targets survive restarts. Use when outposts register dynamically at runtime and you need them to survive a Hub restart.

```ts
import { createSQLiteStore } from '@frontierjs/conduit/stores/sqlite'
import { Database }          from 'bun:sqlite'

conduit({ store: createSQLiteStore(new Database('hub.db')) })
```

Creates a `conduit_targets` table automatically on first boot.

### Custom

Every `ConduitStore` method is async, so a networked registry — Redis, Postgres, an HTTP service — is implementable. This is what lets more than one replica share a set of dynamically registered outposts.

```ts
interface ConduitStore {
  init():   Promise<void>
  get(id: string): Promise<TargetDescriptor | null>
  set(descriptor: TargetDescriptor): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<TargetDescriptor[]>
  touch(id: string): Promise<void>
}
```

Two requirements: `set()` must preserve the existing `registered_at` on upsert, and `get()`/`list()` must return copies rather than live references.

`stats()` never reads the store — it reports counters maintained in the conduit — so a slow backend does not slow down `/metrics`. The trade-off is that writes made directly to a shared store behind the conduit's back are not reflected in `stats()` until the next `init()`.

---

## Observers

```ts
conduit({
  observers: {
    onRequest(req) {
      // Fires before every send() and stream()
    },
    onResponse(req, result) {
      // Fires after a successful send()
    },
    onError(req, err) {
      // Fires on any error — target_not_found, timeout, auth_failed, etc.
      // Also fires when a stream fails to establish or drops mid-flight.
    },
    onRetry(req, err, attempt) {
      // Fires once per retried attempt, before the backoff sleep.
      // `attempt` is 1-based. Retries happen inside the transport, so
      // this is the only place they are visible.
    },
    onStreamStart(req) {},
    onStreamEnd(req, chunks) {
      // `chunks` is how many were yielded before the stream ended cleanly
    },
    onReconnect(targetId) {
      // Fires when a WebSocket transport attempts reconnection
    },
    onRegistered(descriptor) {
      // Fires after register()
    },
    onDeregistered(targetId) {
      // Fires after deregister()
    },
  }
})
```

Every callback here is an **Observer**: it receives and cannot act. None of them can change a request, suppress an error or halt a send — that tier is a Hook, and Conduit has none. A new `on*` here says which tier it is.

Observers may be `async`. They are **never awaited** — an exporter that takes 200 ms does not add 200 ms to your request — and a throw or rejection is caught and logged rather than failing the caller. `management.hooks` below is the other word and means the other thing: Junction's own hook pipeline, which does decide whether a call proceeds.

### Trace context

**Under the Junction plugin this is on by default.** Every outbound call
carries a `traceparent` and an `X-Request-Id`, so a target's logs join to the
request that caused them:

- a `traceparent` the caller sent is **continued** — same trace, a fresh span,
  so the target's work hangs off yours;
- with none, the trace id is **the correlation id**, so every call made during
  one request shares one trace. A random id per call would make six calls six
  unrelated traces. Junction's correlation id is the inbound trace id or 32 hex
  it minted, which already IS a trace id; any other `X-Request-Id` a caller
  stated is folded to one;
- the `X-Request-Id` sent is junction's correlation id, which is the inbound
  trace id whenever the caller sent a `traceparent`, so the target's log line,
  yours and the trace share one id;
- outside a request — a job, a script — a fresh trace is minted, which is the
  right answer rather than a missing one.

The default sits *under* your own options, so wiring a tracer replaces it whole:

```ts
import { createTraceContext, parseTraceparent } from '@frontierjs/conduit'

conduit({
  trace: createTraceContext({
    current: () => parseTraceparent(myTracer.activeHeader()),
    correlation_header: 'X-Correlation-Id',
  }),
})

conduit({ trace: () => null })   // off
```

A malformed upstream trace is discarded and replaced rather than propagated —
collectors drop a bad `traceparent`, so passing one through loses the span
entirely. Only version `00` is read: a later version may append fields, and
forwarding ids out of a format this does not understand is worse than starting
fresh.

Precedence: trace headers sit under `req.headers`, which sit under auth. A caller can override a traceparent; nobody can displace a credential.

---

## Management service

Conduit can register a Junction service named `conduit-targets` that exposes:

| method | route | |
|---|---|---|
| `find` | `GET {apiPrefix}/conduit-targets` | list all registered targets |
| `get` | `GET {apiPrefix}/conduit-targets/:id` | look up a single target by ID |
| `remove` | `DELETE {apiPrefix}/conduit-targets/:id` | deregister a target |

Junction's `apiPrefix` defaults to `''`, so out of the box these sit at `/conduit-targets`.

Responses carry credential **refs**, never secret material — see [Credentials](#credentials).

**Enabling it requires an access decision.** These routes enumerate every target in the system and can deregister them, so "forgot to add the hook" is not a reachable state — `conduit({ management: {} })` throws at `configure()`.

Grade it on your app's own access ladder — the service is over no model, so a declared level is the one grade Junction enforces and anything listing the service (an MCP tool list) can read:

```ts
conduit({ management: { gate: 7 } })   // every route needs level 7
```

…or attach auth to the service:

```ts
conduit({
  management: { hooks: { before: { all: [authenticate()] } } }
})
```

…or opt out explicitly, if your app already authenticates every service:

```ts
app.hooks({ before: { all: [authenticate()] } })   // covers this service too
conduit({ management: { public: true } })
```

`public: true` is exactly as open as it sounds. It exists so that serving these routes unauthenticated is something you typed, not something you forgot.

Use a custom path if needed:

```ts
conduit({ management: { path: 'ops-conduit-targets', public: true } })
```

The path must be a **single path segment** — Junction routes services as `{apiPrefix}/{service}` and `{service}` matches one segment. A path containing `/` throws at `configure()` rather than registering a service that silently 404s on every request.

---

## Testing

Use `createTestConduit` for unit and integration tests. It gives you a fully wired conduit with stub transports — no real HTTP calls, no database.

```ts
import { createTestConduit } from '@frontierjs/conduit/testing'

const { conduit, stubs } = await createTestConduit({
  'outpost:srv-abc': {
    '/pull':         { ok: true },
    '/deploy':       { deployed: true },
    '/health-check': { healthy: true },
  },
  'provider:hetzner': {
    '/servers/42': { id: 42, status: 'running' },
  },
})

// Run the code under test
await deploymentEngine.run(conduit, 'srv-abc')

// Assert on recorded calls
expect(stubs['outpost:srv-abc'].calls).toHaveLength(3)
expect(stubs['outpost:srv-abc'].calls[0].path).toBe('/pull')
expect(stubs['outpost:srv-abc'].calls[1].path).toBe('/deploy')

// Reset between test cases
stubs['outpost:srv-abc'].reset()
```

It is `await`ed because the store is async. Stubbed targets are registered in the store as well as intercepted, so `resolve()`, `list()` and `stats()` see them — code that calls `send()` alongside `resolve()` is testable in one place.

### Simulating failure

Stubs are not success-only. This is what makes retry logic, the error taxonomy and timeout handling testable:

```ts
const stub = stubs['outpost:srv-abc']

stub.mockError('POST /deploy', 'timeout', { retryable: true })
stub.mock('/slow', { ok: true }, { delay_ms: 500 })     // exercise timeouts
stub.mockStream('/logs', ['line-1', 'line-2'])          // stream chunks
stub.mockDefaultError('target_not_found')               // fail unexpected calls loudly
```

Mocks are keyed on **method + path** when you qualify them, so `GET /servers/42` and `DELETE /servers/42` are different mocks. A bare path (`'/health'`) still matches any method, and a method-qualified entry wins over a bare one.

### Mixing stubs with real targets

```ts
const { conduit } = await createTestConduit(
  { 'outpost:stubbed': { '/ping': { pong: true } } },
  { targets: [hetznerDescriptor] },   // registered, not stubbed
)
```

Observers work in tests too:

```ts
const errors: ConduitError[] = []

const { conduit } = await createTestConduit(
  { 'outpost:srv-abc': {} },
  { observers: { onError: (_req, err) => errors.push(err) } }
)
```

---

## What Conduit is not

**Not a queue.** `send()` is synchronous — you call it and await the result. Retry on failure, durability across restarts, and job scheduling belong in a separate queue layer that *uses* Conduit after dequeuing a job. In FrontierJS that layer is `@frontierjs/caravan`, and the durable handoff into it is junction's `ctx.enqueue`.

**Not a service mesh.** It does not proxy application traffic between services.

**Not a generic WebSocket client.** A `websocket` target speaks Conduit's own frame envelope and the far side has to implement it; `@frontierjs/outpost` is not reached this way — it is an `http` target with `hmac` auth. A third-party socket is reachable only to be LISTENED to: a `broker` target whose connector supplies the framing. Nothing is sent over it but the handshake and the acks.

**Not a boundary anything enforces.** Declaring a target is how you get the ring around a call, not a rule the framework applies to every outbound byte.

**Not part of Junction core.** If your app talks to no third party, don't install this package.

---

## File layout

```
@frontierjs/conduit
├── package.json
├── README.md
├── LICENSE
├── src/
│   ├── index.ts               public exports (no test doubles, no bun:sqlite)
│   ├── types.ts               all types and interfaces
│   ├── conduit.ts             createConduit() core factory + counters
│   ├── receive.ts             the receiving end — Dialect, Receiver, the one order
│   ├── mirror.ts              the mirror claim and the Provider half of a forward
│   ├── plugin.ts              Junction plugin (app.configure)
│   ├── router.ts              target ID → transport resolution + pool
│   ├── credentials.ts         CredentialResolver implementations
│   ├── resilience.ts          per-target circuit breaker + concurrency gate
│   ├── trace.ts               W3C traceparent propagation
│   ├── testing.ts             createTestConduit() test factory
│   ├── stores/
│   │   ├── memory.ts          in-memory ConduitStore (default)
│   │   └── sqlite.ts          SQLite-backed ConduitStore
│   └── transports/
│       ├── base.ts            BaseTransport + canonical auth signing
│       ├── http.ts            fetch-based HTTP with retry + deadline
│       ├── websocket.ts       persistent WS with reconnect + ping
│       ├── unix.ts            HttpTransport over a unix socket
│       ├── stub.ts            test double — records calls, mocks responses and failures
│       └── not_implemented.ts fails clearly for ssh/nats (future)
├── conduit.test.ts            unit + transport suite
└── junction-integration.test.ts   plugin against a real Junction app
```
