# @frontierjs/conduit-github

GitHub's REST dialect over `@frontierjs/conduit`: the token's target, the calls
a deploy connect and a Dockerfile read make, the push webhook's signature, and
the one place a 403 is told apart as a rate limit or a missing grant.
Basecamp is its first caller (`api/src/providers/source/github.ts`, an adapter,
and `plugins/git-push.ts`). An app keeps its own nouns and sentences (an
`AccountSend`, its repository-unseen type, what a screen says for a missing
grant) and git's credential path, which is not a REST call.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `githubTarget({ ref, userAgent, accountId?, address?, perCaller? })` — a bearer; pins `X-GitHub-Api-Version` and sends `Accept` and `User-Agent` |
| calls | `verify`, `repository`, `setDeployKey`, `setPushHook`, `readFile`, every one taking `send` first |
| error mapping | `translate(error, status?, headers?, { grant?, now? })` |
| receiving | `verifyGithubSignature({ rawBody, header, secret })`, `parsePush({ headers, body })` |
| sink | `sink.ts`, `startGhSink(opts)`, the stand-in plus chaos |
| drive | `bun run drive` — 57 rows, sink only |

The token is a fine-grained personal access token (`FJS-D1571`) and each call
needs one grant on the repository: a deploy key is Administration write, a hook
Webhooks write, a file Contents read.

## Errors

| GitHub | HTTP | `GithubFailure.kind` | retryable |
| --- | --- | --- | --- |
| a limit: `x-ratelimit-remaining: 0`, a `retry-after`, or a secondary-limit message | **403** or 429 | `rate_limited`, `retryAfterMs` from `retry-after`, else the reset, else 60 s | yes |
| a grant the token lacks (`remaining` above 0) | 403 | `refused_grant`, `grant` and `level` | no |
| bad or revoked token | 401 | `auth_failed` | no |
| no such repository or file, or the token was not given it | 404 | `unseen` — never says which | no |
| deploy key already on a repository | 422 | `key_in_use` | no |
| another 4xx | | `refused` | no |
| 5xx | | `server_error` | GET yes |

Conduit grades every 401 and 403 `auth_failed`, so without `translate` a busy
token reads as *give it Administration › Read and write*. The primary limit
arrives as a 403 with no `retry-after`; the wait is the reset header.

## The rule this connector is about

**GitHub honors no idempotency key, so no write sends one, and a lost answer
is resolved by the list.** `setDeployKey` finds the key by its material and
`setPushHook` the hook by its URL, so a create whose answer was lost is found
on the next read rather than made twice. The hook's secret is written every
time and never read back: GitHub answers it masked.
