# @frontierjs/toolbelt

> **Status: stub.** Folder claimed, nothing implemented. This file is the intent, not a description of behaviour.

The shared kit. Small, common helpers that more than one FrontierJS package — or a random app built on top of one — would otherwise re-implement.

Toolbelt is allowed to know about the framework. Where [`@frontierjs/utils`](../utils/) is pure and context-free, toolbelt is where a helper lives once it needs to touch a runtime concern: an env var, a path, a clock, a filesystem, a Junction `ctx`, a `.lite` schema shape.

```
@frontierjs/utils      pure functions, no I/O, no framework knowledge
@frontierjs/toolbelt   shared helpers that may touch runtime + framework
```

If you can't decide which one a helper belongs in, ask whether it could be tested without mocking anything. Yes → `utils`. No → `toolbelt`.

---

## Realm

Cross-cutting. Not a realm noun — toolbelt introduces no Model, Service, or Resource, and nothing in the mental model derives from it.

---

## Dependency direction

Toolbelt is a **leaf against the core packages**: `litestone`, `junction`, `sierra` and `mesa` must never import it, or the `Litestone ← Junction ← Sierra` chain (Invariant 1) picks up a shortcut around itself. Apps and satellite packages (`basecamp`, `orion`, `caravan`, `conduit`, `notifications`, `cli`) may.

Toolbelt itself may depend on `@frontierjs/utils` and on framework packages as **peer** deps only — a helper for Junction should not drag Junction into an app that never installs it.

---

## Candidate contents

Nothing here is committed to. Listed so the boundary is legible:

- config + env reading with declared defaults
- path resolution against the canonical app layout (`db/ api/ web/`, `config/` per sub-project) — probed, never derived from where `vite.config.js` sits (Invariant 3)
- id / slug / token generation
- retry, backoff, timeout wrappers
- structured logging shims
- test helpers used by more than one package's suite

---

## Install

```bash
bun add @frontierjs/toolbelt
```

## Usage

Not yet. When the first export lands, it gets an example here and an entry in `CHANGES.md`.

---

## Open questions

- Does `toolbelt` earn subpath exports (`@frontierjs/toolbelt/junction`) so an app pays only for what it imports, or is a single flat entry simpler while it is small?
- Which existing duplication moves here first? `CLAUDE.md` § *Open questions* names the live candidates — the HMR algorithm copied into sierra ×2 and jetty, and jetty's copy of sierra's `resources/`.
- Is there a rule that stops toolbelt becoming the junk drawer? Proposed: **anything with exactly one caller does not belong here.**
