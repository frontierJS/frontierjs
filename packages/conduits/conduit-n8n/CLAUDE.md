# conduit-n8n — package map

`src/index.ts` targets, binder and every call · `src/errors.ts` the one reader of `raw` · `src/types.ts` · `sink.ts` · `test/n8n.drive.ts` · `test/fixture/start.sh` a real n8n in docker.

## What bites

- **Two descriptors from one builder**; register both. A call through `hook` carries no API key by design, and `trigger` answers `not_registered` until the workflow is ACTIVE.
- **403 arrives as conduit `auth_failed`**, same as 401; `translate` splits `forbidden` off by status. Only 401 should forget a credential.
- **A delete after a deactivate is refused for a moment** (409 `unpublishing`, retryable, `retryAfterMs`). The sink answers it once per deactivate so the row is deterministic. `translate` matches the sentence before the 409, or it reads as `conflict`.
- **A webhook registers a beat after `activate` answers.** A trigger at once can be `not_registered`; the drive's `fire` retries for 3s. The sink registers at once.
- **`activate`/`deactivate` are `replayable: true`**; `createWorkflow`, `trigger`, `retryExecution` and `stopExecution` are unkeyed and never replayed, and come back `indeterminate` on a lost response. Stop is not replayable because a second stop answers 409, not the run.
- **n8n answers a tag name over 24 characters as "Tag already exists".** The connector refuses it locally.
- **`workflows({ tags })` matches a workflow carrying EVERY tag named**, not any; the sink once matched any.
- **`limit` above 250 is refused locally**; the API answers 400 above it.
- **`address` is required**; there is no vendor default to fall back to.

## Proving a change

`bun run drive`: 52 rows against the sink. `eval "$(test/fixture/start.sh)" && bun run drive`: 72, the last 20 against n8n in docker (`docker rm -f fjs-n8n-fixture` after). Never `bun install` or `bunx tsc` here — `../../AGENT_BRIEF.md`.
