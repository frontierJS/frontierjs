# Basecamp and Outpost

Basecamp is the control plane: an FJS app you run that holds your fleet as rows and sends the commands. Outpost is the small process each fleet machine runs, so Basecamp has hands on it.

```bash
cd packages/basecamp
bun run dev          # API on :8120 and the UI on :8020
bun run db:seed      # an example fleet: 4 users, 2 workspaces, servers, deployments
```

Then sign in at `http://localhost:8020` as `sam@example.com` with `hunter2hunter2`.

## What else it can do

- Basecamp is built entirely in FrontierJS: Litestone for data, Junction for services, Sierra and Mesa for the UI
- An empty database gets a first-run wizard at `http://localhost:8020`, or `POST /setup` over HTTP
- Access is per workspace: `viewer`, `developer`, `admin` and `owner` map onto the gate ladder
- Outpost answers signed commands (pull, build, deploy, stop, health-check, exec, prune) and reports with a heartbeat
- Outpost is plain Bun with one dependency, not an FJS app, so a fleet server carries no schema or ORM
- Every Outpost route but `GET /health` requires a signature, and the command port serves TLS only
- Each side holds its own Ed25519 key pair, and the private halves never travel
- `bun run dev:outpost` enrolls this laptop as a fleet machine, a real Outpost on 8180/8181
- `fli tutor:fleet` walks one control plane, one machine and one real release end to end
- `bcamp` is Basecamp's own command line, built with `bun run build:cli`

**In depth:** [Basecamp README § Quick start](../../../README.md#quick-start), [Outpost README](../../../../outpost/README.md)
