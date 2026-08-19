# Changes — @frontierjs/outpost

## 2026-08-19 — the package exists (`FJS-257`)

19 tests, 0 fail. Unpublished.

Basecamp has spoken a complete Outpost protocol since before this package
existed — `deployment.engine.ts`, `fleet.engine.ts`, `volumes` and `cleanup` all
send to `outpost:<server-id>` over Conduit — and there was no process on the
other end. So the shapes here are read off those call sites rather than
invented, and the first test written found the first defect: the bodies are
snake_case on the wire (`app_id`) and a route that passed one straight through
addressed a container called `fjs-undefined`.

Signed with `@frontierjs/toolbelt/signature`, which is also what Conduit signs
with and what Basecamp now verifies with (`FJS-349`).
