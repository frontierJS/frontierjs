# @frontierjs/conduit-n8n

n8n over `@frontierjs/conduit`. New. An app that READS its n8n — which
workflows exist, is one active, did the run land — or starts one and wants
the reply. **Where the app only needs to tell n8n something happened,
junction's `plugins/webhooks` is the tool**: signed, retried, a subscription
row n8n owns. This package is the other direction (`FJS-D1489`).

n8n is two listeners on one origin, so the builder returns two descriptors:
`api` (`/api/v1`, header `X-N8N-API-KEY`) and `hook` (`/webhook/<path>`, no
API key — only what the workflow's Webhook node asks for). There is no vendor
address; every instance is its own and `address` is required.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `n8nTargets({ address, ref?, id?, hook? })` → `{ api, hook }`; `hook: { header, ref }` is the Webhook node's *Header Auth*, `hook: { basic: ref }` its *Basic Auth* (the ref holds `user:password`), absent is *None* |
| binder | `bindN8n(conduit, targets)` → `{ api: Send, hook: Send }`; every call takes the bundle and picks |
| workflows | `workflows(n8n, { active, name, tags, limit, cursor })`, `allWorkflows`, `workflow(id)`, `createWorkflow(def)`, `updateWorkflow(id, def)`, `deleteWorkflow(id)`, `activate(id)`, `deactivate(id)` |
| executions | `executions(n8n, { status, workflowId, includeData, limit, cursor })`, `execution(id)`, `deleteExecution(id)`, `waitForExecution(id, { timeoutMs, intervalMs })`, `stopExecution(id)`, `retryExecution(id, { loadWorkflow })` |
| tags | `tags(n8n, { limit, cursor })`, `createTag(name)`, `updateTag(id, name)`, `deleteTag(id)`, `workflowTags(id)`, `setWorkflowTags(id, tagIds)` |
| the trigger | `trigger(n8n, path, { method, body, query, headers, test })` → `{ status, body }` |
| types | `N8nWorkflow`, `N8nWorkflowDefinition`, `N8nNode`, `N8nExecution`, `N8nStoppedExecution`, `N8nTag`, `N8nPage`, `WEBHOOK_NODE`, `MAX_LIMIT`, `MAX_TAG_NAME`, `UNSETTLED` |
| error mapping | `translate(error, status)` — table below |
| sink | `sink.ts` — both listeners, in-memory workflows and executions, n8n's own refusal sentences |
| drive | `bun run drive` — 52 rows against the sink; `test/fixture/start.sh` starts n8n in docker and adds 20 against the real thing |

```ts fragment
import { n8nTargets, bindN8n, trigger, executions } from '@frontierjs/conduit-n8n'

const targets = n8nTargets({ address: app.attachments.n8n.N8N_URL })
await conduit.register(targets.api); await conduit.register(targets.hook)
const n8n = bindN8n(conduit, targets)

const r = await trigger(n8n, 'intake', { body: { leadId } })
if (r.error?.indeterminate) { /* the read that resolves it: */ await executions(n8n, { workflowId, limit: 1 }) }

// trigger → result: n8n writes the run after it answers, so the id is read, then waited on
const id = (await executions(n8n, { workflowId, limit: 1 })).result?.data[0]?.id
const run = await waitForExecution(n8n, id, { timeoutMs: 30_000 })
if (run.result?.status === 'error') await retryExecution(n8n, id)
```

## Errors

| vendor | HTTP | conduit kind | `N8nFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| bad key | 401 | `auth_failed` | `auth_failed` | no |
| key lacks the scope, or the license | 403 | `auth_failed` | `forbidden` | no |
| `{ message }` validation | 400 | `client_error` | `refused` | no |
| activate: no trigger, poller or webhook node | 400 | `client_error` | `no_trigger` | no |
| delete right after a deactivate | 409 | `client_error` | `unpublishing` | yes, `retryAfterMs: 1000` |
| tag name taken; stop on a run that is not `running` or `waiting`; retry of a run that succeeded | 409 | `client_error` | `conflict` | no |
| Webhook node's Basic Auth missing or wrong | 401 | `auth_failed` | `auth_failed` | no |
| `waitForExecution` past `timeoutMs` | — | — | `timeout`, names the last status | yes |
| unknown workflow or execution id | 404 | `client_error` | `not_found` | no |
| webhook path with no ACTIVE workflow on it | 404 | `client_error` | `not_registered` (+ n8n's `hint`) | no |
| Webhook node's Header Auth unmet | 403 | `auth_failed` | `forbidden` | no |
| 429 | 429 | `rate_limited` | handed back with `retryAfterMs` on a write; a read is replayed by conduit | — |
| 5xx | 5xx | `server_error` | a read, a PUT, a DELETE, `activate`/`deactivate` are replayed; `createWorkflow` and `trigger` are handed back | — |
| no answer to `createWorkflow`, `trigger`, `stopExecution` or `retryExecution` | — | `timeout` | `indeterminate: true` | no |

## The rules this connector is about

**Two listeners, two descriptors, one key that never crosses.** The API key
reaches every workflow on the instance; the webhook listener never sees it.
`hook` carries `{ type: 'none' }` or the header the app's Webhook nodes were
set to ask for, and the drive proves no webhook call carried the key.

**`activate` is a replayable POST; `trigger` is not.** Activating an active
workflow answers it unchanged, so a lost activate is retried by conduit. A
trigger starts one execution per request and n8n collapses nothing, so a lost
one is `indeterminate` and `executions({ workflowId, limit: 1 })` is the read
that says whether it landed (CONTRACT C6). An app that must start a run
exactly once puts its own id in the body and dedupes in the workflow.

**Stop and retry are not replayed either.** A second stop answers 409 naming
the status, not the run, so a replay would report a stop that landed as a
failure; `execution(id)` says. A retry is a new run with `retryOf: id`, and
two retries of one run are two runs; `executions({ workflowId })` and the
`retryOf` field say whether a lost one landed.

**A delete right after a deactivate is `unpublishing`.** n8n tears the
webhooks down after it answers the deactivate and refuses a delete in that
window with a 409, "try again in a few moments", and no wait named; the
connector names one. Found against n8n 2.44.6, not in its docs.

**A webhook registers a beat after `activate` answers.** A trigger sent at
once can come back `not_registered`; retry it briefly.

## Not built

Webhook node *JWT Auth* (no caller). The credentials, users, variables and
projects endpoints: credentials write secrets INTO the vendor and want a
`decision-rules` pass first. Archive, publish and version history, whose
meaning against `activate` is not yet probed. Execution tags, audit, source
control.
