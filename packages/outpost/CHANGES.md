# Changes — @frontierjs/outpost

## 2026-09-05 — a release could not run what it built

`deploy()` addressed the image as `${image}@${digest}`, and for a build done on
this machine that digest is the image **Id** — `digestOf` reports `{{.Id}}` and
its own comment says why: an image built here has never been pushed, so it has
no repo digest. `name@sha256:<id>` is not a reference any daemon resolves, so
docker read it as a pull and every `source.kind: 'git'` deploy failed with *pull
access denied for <name>* seconds after building successfully
([`FJS-919`](../../ISSUES.md#fjs-919)).

A bare id is a reference the daemon takes, so the local case addresses the bytes
directly and the registry case keeps `name@digest`. Which one it is is asked of
the daemon rather than guessed at — both are `sha256:…` and nothing in the string
distinguishes them.

**The test asserted the defect.** *a git deploy builds here, then runs what it
built* expected `acme-web@<digest>`, and its injected runner answers every
command with exit 0, so the broken form looked correct. It asserts the id now,
with an image the machine does NOT hold beside it as the control.

Found by `fli tutor:fleet`'s release half, which is the first thing to run this
path against a real daemon — basecamp's own drive injects a fake docker, which
is exactly what that means.

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
