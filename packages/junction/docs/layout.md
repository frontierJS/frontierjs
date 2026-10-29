# junction — layout

The file-by-file map of `@frontierjs/junction`, moved out of `CLAUDE.md` so a turn in this package does not pay for it. `CLAUDE.md` keeps the owners and the traps; hazards are `hazards.md`, the why of each file is `internals.md`.

```
index.ts — the four axes and the host; no battery (FJS-D639, test/edge.test.ts)
src/
  core/
    app.ts — createApp; the plugin protocol; configure, start, ready, running, shutdown
    service.ts — createService (the definition, five CRUD verbs), callService
    context.ts — ServiceContext; the request store (enterRequest, reenterAs) and the call store ($, enterCall); the call's private slots (callDb, callSlots)
    directives.ts — QueryDirectives, the $-prefixed key fields; imports nothing
    hooks.ts · hooks-builtin.ts · hooks-resilience.ts — the pipeline and around; the built-in hooks, @frontierjs/junction/hooks; circuitBreaker, rateLimit
    bearer.ts — @frontierjs/junction/bearer: bearerClaim and the token sources, over litestone.ts (FJS-D1333)
    litestone.ts — the Data adapter: withLitestoneDb, withTenantDb, gateAuth, autoValidate, validateInput, toDataPrincipal
    envelope.ts — the result envelope, one owner
    events.ts — AUTO_EVENT_MAP and the publish-hook mark; imports nothing (FJS-1181)
    app-model.ts — one walk over a built app, for every register that renders one; buildRoutes, serializeHookMap
    build-id.ts — which build this is, and which one the browser is on (FJS-D160)
    attachments.ts — the attached service, declared here and bound per environment (FJS-D158)
    errors.ts — named HTTP error classes and retryable
    schema.ts — request validation from the generated JSON Schema
    loader.ts — auto-discovers *.service.ts
    app-root.ts — createApp({ root }) and the folders derived from it (FJS-D1080)
    rate-limit.ts — the one rate limiter
    public-url.ts — assertPublicUrl: whether a URL a stranger chose may be fetched; @frontierjs/junction/public-url (FJS-1579)
    idempotency.ts — claimIdempotency
    metrics.ts — reading a counter, beside db/metrics.lite
    diagnostics.ts — whether to print developer diagnostics
    field-errors.ts — a thrown value carrying one message per field
    config-scope.ts — configuration read at call scope, per tenant
    env.ts — defineEnv
    logger.ts — the leveled logger
  config/index.ts — loadConfig, junction.config.js onto AppConfig
  transport/
    bridge.ts — the transport and service handoff
    http.ts — Bun.serve: routing, body, auth resolution, static, gzip
    router.ts — two-tier route cache
    channels.ts — channels, publish, gradeRecipients
    presence.ts — presence tracking
    send-queue.ts — wsSend, the one owner of a frame
    forwarded.ts — which client address to believe (http.trustProxy)
    middleware.ts · body.ts · health.ts · static.ts · types.ts
  client/
    index.ts — the browser client: WS first, HTTP fallback, client.auth, resource()
    entries.ts — one entry per row, keyed by model (FJS-D138)
  auth/ — types.ts (IAuth, SessionVerifier) · credentials.ts (signedRequest)
  plugins/
    manifest/index.ts · openapi/index.ts · devtools/index.ts (read by `fli gui`'s `:live`; no page)
    webhooks/ — index.ts · payload.ts (what a subscriber may receive)
    declared.ts — the plugins junction.config.js may declare; the one plugins/ module core names (FJS-D256)
    outbox/ — index.ts · engine.ts (ctx.enqueue's row and the relay pass)
    backfill/ — index.ts · engine.ts (the middle step of expand, backfill, contract, FJS-D157)
    export/index.ts (the governed extract, FJS-D228) ·
    metrics/index.ts (keeping what /metrics said) · commitments/index.ts (the sweep under @@commitment, FJS-D368)
    audit/index.ts (the call trail into an app-declared model, its column contract checked at boot, FJS-D873)
  mail/ — index.ts · smtp.ts · received.ts (ReceivedMail, the reply-tag kit)
  cache/index.ts · events/index.ts · scheduler/index.ts · ai/index.ts
  testing/index.ts — createTestApp, request, withTestMeta
tools/
  cli.ts — the package bin; respawns the named tool as its own process
  surface.ts · jobs-snapshot.ts · notifications-snapshot.ts · principal-snapshot.ts — the four app snapshots
  errors-snapshot.ts — errors.snapshot.md, this package's own; takes no app
  atlas.ts — describeAppModel as JSON on stdout
  call.ts — one service method, once, as a person, the answer as JSON on stdout
  app-module.ts — reading a built app off a module
  repl.ts — a REPL against a running app
db/ — outbox.lite · backfill.lite · metrics.lite, shipped for an app to import
test/ — one file per concern
```

## Where to look

| Question | Answer |
| --- | --- |
| How a feature is used | `README.md`, one section per feature |
| How to write an app against junction | `AGENTS.md` |
| Why the code is shaped this way | `docs/internals.md`, by path |
| Correct-but-surprising behavior in the API realm | the `api-hazards` skill |
| Who owns a cross-package seam | the `bridge-index` skill |
| Open defects, rulings, state | `ISSUES.md` · `DECISIONS.md` · `PROJECT_STATE.md` |
