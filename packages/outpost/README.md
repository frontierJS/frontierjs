# @frontierjs/outpost

**The process a fleet server runs.** Basecamp is the control plane; this is its
hands on a machine. One per `Server` row (`FJS-D29` — infrastructure takes place
nouns), and it does two things and nothing else:

- **answers commands** — pull, build, deploy, stop, health-check, exec, prune —
  every one of them signed;
- **reports** — a heartbeat that says where to reach it, and the machine's
  volumes and disk on a slower clock.

It is not an FJS application. Its job is to run Docker commands and report
health, and an FJS app would put a schema, a migration runner and an ORM on
every fleet server to do that.

## Running one

```sh
OUTPOST_SERVER_ID=<the Server row's id> \
OUTPOST_SECRET=<the fleet secret> \
BASECAMP_URL=https://basecamp.internal \
bunx outpost
```

Those three have no default and the process refuses to start without them: an
Outpost that cannot name its server reports as nobody, and one with no secret
would either refuse every command or accept every one. Everything else has a
default — `OUTPOST_PORT` (8180 dev, 7180 test — the number comes from
`packages/cli/core/ports.js`, project id 8), `OUTPOST_PUBLIC_URL`,
`OUTPOST_HEARTBEAT_MS`, `OUTPOST_REPORT_MS`, `OUTPOST_WORK_DIR`.

`OUTPOST_PUBLIC_URL` is stated rather than derived, because this process cannot
see the address the world reaches it at. It is what the heartbeat registers as
the Conduit target, and until that lands Basecamp refuses every release for the
machine — with a message saying so, rather than a green deploy that ran nothing.

## The protocol

Basecamp reaches it at `outpost:<server-id>` over Conduit. Every route but
`GET /health` requires a signature; `/exec` runs a shell command as this
process's user, so the default is refuse and a route opts out rather than in.

| | |
| --- | --- |
| `POST /pull` | `{ image }` → `{ digest }` |
| `POST /deploy` | `{ deployment_id, app_id, image, digest, source, config }` → `{ containerId, digest, commit_sha }` |
| `POST /stop` | `{ app_id }` → `{ stopped }` |
| `POST /health-check` | `{ app_id }` → `{ healthy }` |
| `POST /exec` | `{ command, timeout_s }` or `{ step }` → `{ exit_code, stdout, stderr }` |
| `POST /system/prune` | `{ targets, keep_images }` → `{ freed_bytes, removed, volumes, usage }` |
| `POST /volumes/prune` | `{ names }` → `{ removed }` |
| `DELETE /volumes/<name>` | → `{ removed }`, or 409 with the container holding it |
| `GET /health` | unsigned liveness — says nothing about the machine |

**The signature is `@frontierjs/toolbelt/signature`** — the same module Conduit
signs with and Basecamp verifies with. Method, path, timestamp, nonce and a hash
of the body, so a captured signature cannot be replayed, moved to another
endpoint, or kept while the body is swapped underneath it.

## Where the bytes come from

V1 builds on the target: a `source.kind === 'git'` deploy clones, builds, and
answers the digest of what it built, which Basecamp records on
`Deployment.builtImage` and addresses every later step by. That is honest while
the Outpost is co-resident with Basecamp — one machine, the CapRover shape. The
end state is build-once-promote-a-digest, which needs a builder and somewhere to
put the artefact: `IDEAS/deploy-plane.md`.

**Only `sha256:<64 hex>` counts as a digest.** A tag is a name, and two builds
share it — an image inspect that answers anything else is reported as no digest
at all rather than as a plausible one.

## Testing

`bun run test` — 19 tests, no Docker and no network. `createDocker({ run })`
takes the runner and `createReporter({ fetch })` takes the client, so what is
asserted is what the machine was ASKED to do and what left the process. A
package that could only be tested against a real daemon would be tested rarely
and wrongly.
