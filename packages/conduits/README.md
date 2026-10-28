# packages/conduits

Home of the vendor connectors: one `conduit-<x>/` per third party, each a package that speaks one vendor's API over [`@frontierjs/conduit`](../conduit/). Conduit owns the transport — targets, signers, retries, idempotency, the refusal vocabulary. A connector owns only what is true of its vendor: the descriptors, the error translation, the verbs, the webhook Dialect and the reads that prove a lost write landed.

Ruled by [`FJS-D1559`](../../DECISIONS.md#fjs-d1559), which superseded `FJS-D1185`.

## Layout

- **The directory is the package name minus its scope**, so `@frontierjs/conduit-stripe` lives at `packages/conduits/conduit-stripe/`. The `conduit-` prefix stays on the folder (aws-sdk-js-v3 `clients/client-s3`, Airbyte `connectors/source-postgres`).
- **Each connector is a full package** with its own `README.md`, `CLAUDE.md` and `PROJECT_STATE.md` (Invariant 17), TypeScript (`FJS-D890`), and a drive against a sink under `test/`.
- **A connector built on another imports it as a package**: tax imports `@frontierjs/conduit-stripe`, gmail imports `@frontierjs/conduit-oidc`, and s3 imports `@frontierjs/toolbelt/sigv4`.
- **The shape every connector follows is `CONTRACT.md`**, which moves to `packages/conduit/docs/` with the connectors.

## The move

The connectors are still in the sibling workspace `../conduit-connectors/packages/`. Their live state, meaning drive rows, what each drive is proved against and open gaps, is that workspace's `PROJECT_STATE.md`. The move gets its own session, and per `FJS-D1559` it waits on four conditions:

1. `vendor.js` resolves more than one packages directory.
2. Workspace membership is read from the root `workspaces` globs through one owner, with a test that every walker reaches every member. About 30 walkers in `packages/cli/core/` and `scripts/` read one level of `packages/` today.
3. The prototype `link:` callers in `../fjs-prototypes` move in the same change.
4. The sibling's uncommitted work is committed first.

## The 27 connectors

| Area | Connector | Covers |
| --- | --- | --- |
| Payments | `conduit-stripe` | Payment intents, refunds, the webhook signature |
| | `conduit-tax` | Stripe Tax: a calculation at the sale, a transaction at capture |
| | `conduit-shipping` | EasyPost: address verification, rates, label purchase, trackers, webhooks |
| Email | `conduit-resend` | Send, batch, an `IMail` adapter, the Svix webhook signature |
| | `conduit-postmark` | Send, batch, an `IMail` adapter, the unsigned inbound webhook |
| | `conduit-mailgun` | Send, an `IMail` adapter, raw-MIME inbound (brings the MIME parser) |
| | `conduit-gmail` | Read, watch, send (on `conduit-oidc`) |
| | `conduit-microsoft` | Graph mail: delegated grant, delta sync, change notifications, drafts/replies/send. Extracted from ELA (`FJS-D1463`) |
| SMS, voice, push | `conduit-twilio` | Messaging, Basic through the signer seam, E.164, STOP, `X-Twilio-Signature` |
| | `conduit-telnyx` | SMS/MMS, E.164, STOP/HELP, Ed25519 webhooks |
| | `conduit-quo` | Quo (formerly OpenPhone): texts, webhooks, mirror rows for messages, calls, contacts and tasks |
| | `conduit-push` | APNs and FCM: minted ES256 token, service-account exchange, unregistered devices |
| Chat and work | `conduit-slack` | `chat.postMessage` with a bot token, incoming webhooks, the Events API signature |
| | `conduit-mattermost` | Service and per-user targets, the mirror claim, webhooks, slash commands, the socket |
| | `conduit-37signals` | Basecamp: reads, verbs, the event feed, the live stream, the mirror claim |
| Automation | `conduit-n8n` | REST API (workflows, executions) and the webhook trigger (`FJS-D1489`) |
| | `conduit-zapier` | Posting to a pasted hook URL, reverse unsubscribe, the host-pinned subscribe reader (`FJS-D1528`) |
| AI | `conduit-anthropic` | Messages, token counting, a tool loop, SSE streaming |
| | `conduit-openai` | The chat-completions protocol, one target per implementation (OpenAI, Ollama, llama.cpp, Groq, vLLM) |
| Infrastructure | `conduit-cloudflare` | DNS: zones, records, the all-or-nothing batch |
| | `conduit-digitalocean` | Compute: catalog, droplets, money as minor units |
| | `conduit-hetzner` | Compute: catalog, servers, per-location prices |
| | `conduit-s3` | The S3 protocol: put, get, head, delete, list, presign over SigV4 |
| Identity and abuse | `conduit-oidc` | Discovery, JWKS, code+PKCE and refresh, userinfo, the `id_token` verifier |
| | `conduit-turnstile` | Cloudflare Turnstile siteverify |
| Data | `conduit-google-maps` | Places (New) text search and details, Routes drive time |
| | `conduit-plausible` | The read-only, rate-limited stats query |

Basecamp still keeps its own DigitalOcean and Hetzner copies in `packages/basecamp/api/src/providers/compute/`. Moving it onto `conduit-digitalocean` and `conduit-hetzner` is a separate step from the move.
