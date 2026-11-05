# @frontierjs/conduit-microsoft

Microsoft's identity platform and Graph mail over `@frontierjs/conduit`: sign
in, keep the grant alive, read a mailbox by delta, hear about changes, write
back, send. The DIALECT only — three targets, the token resolver and its lock,
the calls under `/v1.0/me`, the error table, the subscription keeper, the
notification dialect, the sink. The sync ENGINE (which folders, which rows,
when a thread is re-matched by Message-Id, what a write back means) is the
app's: mail as data is a cursor, and a cursor is out of conduit. Lifted from
ELA's `api/src/providers/microsoft/` (`FJS-D1463`), which ran live on one
Microsoft 365 mailbox.

**No real Microsoft was called from this package.** The sink encodes what ELA
learned live: the rotating refresh token, the two kinds of message id, the
4230-minute subscription, the validationToken handshake, the 410 that resets a
delta. `PROJECT_STATE.md` lists what stays unverified.

## What it covers

| Piece | Where |
| --- | --- |
| targets | `microsoftTargets({ grantRef, name?, graphUrl?, loginUrl?, tenant? })` → `{ graph, mime, login }`. `graph`: bearer `per_caller`, JSON, `Prefer: IdType="ImmutableId"`, 30 s, 2 retries. `mime`: same token, `binary`, `text/plain`, no retry. `login`: no credential on the target (the client id and secret ride in the form), `form`, 15 s, no retry |
| login | `authorizeUrl(…)` (pure), `exchangeCode(ms, creds, { code, redirectUri })`, `refreshGrant(ms, creds, { refreshToken })` |
| resolver | `microsoftTokenResolver(ms, creds, store, opts)` — a `CredentialResolver` with `getFor`/`invalidateFor`; `GrantStore { read, update (compare-and-set), lose }`; `memoryGrantStore()` for a drive |
| reads | `me`, `listFolders`, `folder`, `createFolder`, `deltaStart`, `deltaNext`, `walkDelta`, `conversation`, `message`, `attachments`, `attachmentBytes`, `findByInternetMessageId` |
| writes | `createDraft` (custom `x-*` headers here only), `createReply(id, 'reply'|'replyAll'|'forward')`, `patchMessage`, `sendDraft`, `moveMessage`, `sendMime` (through `mime`) |
| subscriptions | `createSubscription`, `renewSubscription`, `deleteSubscription`, `listSubscriptions`, `ensureSubscription(ms, store, input)`, `newClientState`, `MAX_SUBSCRIPTION_MINUTES` |
| receive | `graphChangeDialect`, `graphLifecycleDialect` (`Dialect<clientState>`), `subscriptionIdOf(delivery)` for the receiver's `credential`, `resourceIdOf`, `handshake(url)` |
| pure | `linkToRequest`, `addressOf`, `addressesOf`, `headerOf`, `MESSAGE_SELECT`, `ATTACHMENT_EXPAND`, `FOLDERS`, `SCOPES` |
| errors | `translate(error, status?, headers?) → MicrosoftFailure` — the table below |
| sink | `sink.ts`: `startMicrosoftSink(opts)` on `port: 0`; `/_sink/reset`, `/_sink/arm`, `/_sink/seen` |
| drive | `bun run drive` — 33 rows, sink only; no conforming Graph exists to run |

`ms` is `bindMicrosoft(conduit, targets, { who?, grant? })` → `{ graph, mime,
login, graphAddress }`, one Send per role: the connector never holds an app,
and every call takes the whole bundle and picks its own role, so `sendMime`
cannot go out on `graph` nor `me` on `login`. The `graph` and `mime` sends
carry `who.grant`, the app's id for the stored grant; under junction the plugin
fills `tenant` and `principal` and the caller states `grant` alone. `login`
carries neither: the target has no credential.

## The rules the drive proves

- **The grant row carries the lock.** Microsoft rotates the refresh token on
  every refresh and the spent one is dead, so two processes refreshing one
  grant leave the row holding a burned token. `GrantStore.update` is a
  compare-and-set on `refreshing: { by, until }`; the loser polls the row for
  the winner's token. Two resolvers over one store, racing, ask the identity
  platform once.
- **The row is written before the token is answered.** A caller that gets the
  access token and crashes must not leave the app holding a refresh token the
  provider already burned.
- **A 401 forgets and replays once**, through conduit's `invalidateFor`; the
  resolver remembers the dead value rather than writing the row.
- **`invalid_grant` is `grant_lost`** and fails closed: every later send is
  `auth_failed` without asking the provider again until `forget(key)` after a
  new sign-in. The AADSTS code rides along (`50173` revoked, `70000` already
  redeemed, `70008` expired).
- **A delta first round carries `receivedDateTime ge <since>`** and Graph
  bakes it into every later token; `$select=id,conversationId` keeps the page
  to ids and the conversation fetch brings the rest. A `410` is `sync_reset`:
  the folder starts over. A `nextLink`/`deltaLink` off the graph origin is
  refused unsent.
- **Attachments are metadata** (`ATTACHMENT_EXPAND`) and the bytes are a
  separate call; without the inner `$select` Graph inlines every file.
- **Two ids.** Every call answers immutable ids; a notification's
  `resourceData.id` is the REST id, and a GET by it answers the immutable one.
  A move changes the REST id and not the immutable one.
- **A subscription is proved by `clientState`**, a secret per subscription,
  minted here and compared constant-time in the dialect; `ensureSubscription`
  saves the fresh one BEFORE the create, because a notification can beat the
  create's answer. A lapsed subscription answers 404 on renew and is created
  again.
- **Custom headers go on a NEW draft only and only `x-*`**; anything else is
  refused unsent. A sent draft gets a NEW id and keeps its Message-Id and
  headers, so `findByInternetMessageId` is the resolving read for a lost send.

## Errors

| Status / code | `kind` | retryable | What the app does |
| --- | --- | --- | --- |
| token `invalid_grant` | `grant_lost` | no | mark the row; the person signs in again |
| token `invalid_client`, 401 | `auth_failed` | no | the app's client secret is wrong |
| 401 `InvalidAuthenticationToken` | `auth_failed` | replayed once by conduit | nothing; a second 401 is a dead grant |
| 403 | `forbidden` | no | a scope or a mailbox policy; the credential is kept |
| 404 | `gone` | no | the message, folder or subscription is not there |
| 410 `SyncStateNotFound` | `sync_reset` | no | start the folder's delta over |
| 429 `ApplicationThrottled` | `rate_limited` | yes, `retryAfterMs` | conduit retried already; wait that long |
| other 4xx | `refused` | no | our request was wrong |
| lost answer to a write | conduit's kind, `indeterminate` | — | the resolving read (§ above) |

## Receiving

Conduit's receiver answers its own body, so Graph's validationToken handshake
cannot ride it. The app mounts the notification path twice: `handshake(url)`
first, answering the challenge, and `app.conduit.receive({ provider:
'microsoft', dialect: graphChangeDialect, credential: d => clientStateFor(subscriptionIdOf(d)), apply })`
for everything else. One event per delivery; `payload.notifications` is the
batch, `resourceIdOf(n)` the REST id to fetch.

## Sink

`startMicrosoftSink({ port: 0, mailboxes, accessTokenTtl, batchMs })`: the
login endpoints under `/{tenant}/oauth2/v2.0/*`, Graph under `/v1.0/*`, ten
items a page, change notifications batched and POSTed to the subscription's
URL. In-process: `mailbox(address).deliver/draft/answer/send/move/markRead`,
`expireAccessTokens`, `expireDeltaTokens`, `revoke`, `failNext`, `dropNext`,
`lapse`, `lifecycle`, `settle`, `knobs`. Over HTTP: `/_sink/arm` takes
`{ failNext, dropNext, expireAccessTokens, expireDeltaTokens, revoke, lapse, knobs }`.
`bun run sink` starts one with a message in the inbox.
