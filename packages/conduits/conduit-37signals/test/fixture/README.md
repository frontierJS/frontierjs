# Fixtures — Basecamp response bodies, scrubbed

Captured 2026-10-16 for `IDEAS/conduit-37signals.md` step 0.2: raw HTTP bodies
from `curl` with the `basecamp` CLI's token (`basecamp auth token`), not the
CLI's own output. Staged at the connectors root until step 2.1 scaffolded
this package, because a directory under `packages/` with no `package.json`
breaks the root `drive` loop.

**Kobami's account is client data**, so every file but the two `.well-known`
documents is scrubbed: text is a numbered placeholder (`Title 34`,
`Person 4`, `person-1@example.com`), ids are remapped with their order kept
(event ids stay strictly increasing), the account is `999`, signed tokens and
`position` are `BAhfixture--000…`, and `projects.json` and `events-replay.json`
are trimmed to their first 2 and 12 items. A dock entry's `name` and `enabled` are
kept: `name` is the tool's type key, and a project can carry a second, disabled
`todoset`, so the todoset is the one with both.

| File | Request | Status |
| --- | --- | --- |
| `authorization.json` | `GET 3.basecampapi.com/authorization.json` | 200 |
| `launchpad-authorization-401.json` | the same token at `launchpad.37signals.com/authorization.json` | 401 |
| `protected-resource.json` | `GET 3.basecampapi.com/.well-known/oauth-protected-resource` | 200, unscrubbed |
| `authorization-server.json` | `GET app.basecamp.com/.well-known/oauth-authorization-server` | 200, unscrubbed |
| `profile.json` | `GET /{account}/my/profile.json` | 200 |
| `projects.json` | `GET /{account}/projects.json` (page 1 of 4: pages are 15, 30, 50, 2) | 200 |
| `project.json` | `GET /{account}/projects/{id}.json` | 200 |
| `todolist.json` | `GET /{account}/buckets/{b}/todolists/{id}.json` | 200 |
| `todo.json` | `GET /{account}/buckets/{b}/todos/{id}.json` | 200 |
| `message.json` | `GET /{account}/buckets/{b}/messages/{id}.json` | 200 |
| `comment.json` | `GET /{account}/buckets/{b}/comments/{id}.json` (on a todo) | 200 |
| `chat-line.json` | `GET /{account}/buckets/{b}/chats/{c}/lines/{id}.json` | 200 |
| `events-replay.json` | `GET /{account}/events.json?since=0` | 200 |
| `events-head.json` | `GET /{account}/events.json` (no cursor: enters at the present) | 200 |
| `events-invalid-position.json` | `GET /{account}/events.json?since=2026-10-16` | 400 |
| `headers.json` | 14 requests' response headers (step 0.3): pages, `304`s, the feed walk, no `User-Agent`. Etags, positions and the account are scrubbed with sameness kept: one etag or position is one placeholder everywhere | mixed |
| `not-found.json` | `GET /{account}/buckets/{b}/todos/1.json` | 404 |
