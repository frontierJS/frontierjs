# packages/conduits

Home of the vendor connectors: one `conduit-<x>/` per third party, each a package that speaks one vendor's API over [`@frontierjs/conduit`](../conduit/). Conduit owns the transport — targets, signers, retries, idempotency, the refusal vocabulary. A connector owns only what is true of its vendor: the descriptors, the error translation, the verbs, the webhook Dialect and the reads that prove a lost write landed.

This folder is the live home (`FJS-D1559`, which superseded `FJS-D1185`). Every connector is a workspace member through the root `packages/conduits/*` glob. The contract each follows is [`packages/conduit/docs/CONTRACT.md`](../conduit/docs/CONTRACT.md).

## Layout

- **The directory is the package name minus its scope**, so `@frontierjs/conduit-stripe` lives at `packages/conduits/conduit-stripe/`. The `conduit-` prefix stays on the folder (aws-sdk-js-v3 `clients/client-s3`, Airbyte `connectors/source-postgres`).
- **Each connector is a full package** with its own `README.md`, `CLAUDE.md` and `PROJECT_STATE.md` (Invariant 17), TypeScript (`FJS-D890`), and a drive against a stub under `test/`.
- **A connector's suite is its drive.** `test/<x>.drive.ts` runs over the shared harness `lib/drive.ts` (a folder with no manifest, so not a member), and `bun run test` is `bun run drive`. It needs no server, credential or network.
- **A connector built on another imports it as a package**: gmail imports `@frontierjs/conduit-oidc` as `workspace:*`, and s3 peers on `@frontierjs/toolbelt/sigv4`.
- **Held out of releases** until each is on npm; `DRIVES.md` has one row for the group and `docs/TESTING.md` one runner row.

## The 29 connectors

| Area | Connector | Covers |
| --- | --- | --- |
| Payments | `conduit-stripe` | Payment intents, refunds, Stripe Tax as a module, the webhook signature |
| | `conduit-easypost` | Address verification, rates, label purchase, trackers, webhooks |
| Email | `conduit-resend` | Send, batch, an `IMail` adapter, the Svix webhook signature |
| | `conduit-postmark` | Send, batch, an `IMail` adapter, the unsigned inbound webhook |
| | `conduit-mailgun` | Send, an `IMail` adapter, raw-MIME inbound (brings the MIME parser) |
| | `conduit-gmail` | Read, watch, send (on `conduit-oidc`) |
| | `conduit-microsoft` | Graph mail: delegated grant, delta sync, change notifications, drafts/replies/send (`FJS-D1463`) |
| SMS, voice, push | `conduit-twilio` | Messaging, Basic through the signer seam, E.164, STOP, `X-Twilio-Signature` |
| | `conduit-telnyx` | SMS/MMS, E.164, STOP/HELP, Ed25519 webhooks |
| | `conduit-quo` | Quo (formerly OpenPhone): texts, webhooks, mirror rows |
| | `conduit-apns` | Apple push: minted ES256 token, the send, unregistered devices |
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
| Google | `conduit-google` | Maps Platform (Places New, Routes, Geocoding) and Firebase Cloud Messaging (HTTP v1) |
| Data | `conduit-plausible` | The read-only, rate-limited stats query |
| | `conduit-airtable` | Airtable records by field id, the one formula builder, the schema's field types (sink-only) |

Basecamp still keeps its own DigitalOcean and Hetzner copies in `packages/basecamp/api/src/providers/compute/`. Moving it onto `conduit-digitalocean` and `conduit-hetzner` is a separate step from the move.
