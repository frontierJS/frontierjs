# Junction Guide

What a service can do and how to add to it, one quick page per idea. The guide
shows what is possible; the README beside this folder explains it.

A page is a skim, not a lesson:

- one or two sentences on what the feature is for
- one example, the smallest that shows it working
- a short list of what else it can do, a line each, with no explanation
- a closing **In depth** link to the doc its `from` note names

Edge cases, refusals, rulings and `FJS-` ids belong in the full doc. If a page
needs a second example to make sense, that material belongs in the full doc and
the page links to it.

This list is the page order. The website builds `/docs/junction/` from it, so a
page that is not listed here is not published. Auth, jobs, integrations,
notifications and agents are their own packages; the last section points at
them and does not restate them.

## Introduction

- [Overview](introduction/overview.md)
<!-- from: README.md § top, Where Junction lives in an app, What is actually mounted -->
- [Getting started](introduction/getting-started.md)
<!-- from: README.md § Install, Quick start -->
- [Project layout](introduction/project-layout.md)
<!-- from: README.md § Structure, Where the services are, Where the routes are -->
- [The REPL](introduction/the-repl.md)
<!-- from: README.md § The REPL -->

## Services

- [A service](services/a-service.md)
<!-- from: README.md § Litestone ORM, Methods the transport answers for you -->
- [Custom methods](services/custom-methods.md)
<!-- from: README.md § The secret sauce 3, `methods:` — the surface, declared -->
- [Declaring the surface](services/the-surface.md)
<!-- from: README.md § `methods:` — the surface, declared -->
- [Search across models](services/search.md)
<!-- from: README.md § One search across models — searchService() -->
- [Service caching](services/caching.md)
<!-- from: README.md § Service caching -->
- [Schema validation](services/validation.md)
<!-- from: README.md § Schema validation -->

## Hooks

- [The pipeline](hooks/the-pipeline.md)
<!-- from: README.md § The secret sauce 2, the hook pipeline -->
- [Before, after and error](hooks/before-after-error.md)
<!-- from: README.md § The hook pipeline -->
- [What is on ctx](hooks/ctx.md)
<!-- from: README.md § The hook pipeline; docs/internals.md -->
- [Running as somebody](hooks/running-as.md)
<!-- from: README.md § Running as somebody -->
- [Compiled pipelines](hooks/compiled-pipelines.md)
<!-- from: README.md § Compiled hook pipelines -->

## Transport

- [The bridge](transport/the-bridge.md)
<!-- from: README.md § The secret sauce 1, the transport bridge -->
- [Raw routes](transport/raw-routes.md)
<!-- from: README.md § Where the routes are, Response helpers -->
- [Response helpers](transport/response-helpers.md)
<!-- from: README.md § Response helpers -->
- [Middleware](transport/middleware.md)
<!-- from: README.md § Middleware -->
- [WebSockets](transport/websockets.md)
<!-- from: README.md § WebSocket routing — app.ws() -->
- [Live updates](transport/live-updates.md)
<!-- from: README.md § Channels — real-time without polling -->
- [The browser client](transport/browser-client.md)
<!-- from: README.md § Browser client, Typed from the schema -->
- [OpenAPI](transport/openapi.md)
<!-- from: README.md § OpenAPI -->

## Identity

- [Auth](identity/auth.md)
<!-- from: README.md § Auth; ../auth/README.md § Setup -->
- [Credentials that are not a bearer token](identity/credentials.md)
<!-- from: README.md § Credentials that are not a bearer token -->
- [Sessions from a cookie](identity/sessions.md)
<!-- from: README.md § Sessions from a cookie -->

## Writes

- [Transactions](writes/transactions.md)
<!-- from: README.md § Transactions -->
- [Effects after the commit](writes/after-commit.md)
<!-- from: README.md § ctx.afterCommit() -->
- [Effects that must not be lost](writes/enqueue.md)
<!-- from: README.md § ctx.enqueue() -->
- [Commitments](writes/commitments.md)
<!-- from: README.md § commitments() — the clock under @@commitment -->
- [Bulk operations](writes/bulk.md)
<!-- from: README.md § Bulk operations -->
- [Idempotency keys](writes/idempotency.md)
<!-- from: README.md § Idempotency-Key -->
- [File uploads](writes/file-uploads.md)
<!-- from: README.md § File uploads -->

## Protection

- [CSRF](protection/csrf.md)
<!-- from: README.md § CSRF protection -->
- [Circuit breaker](protection/circuit-breaker.md)
<!-- from: README.md § Circuit breaker -->
- [API versioning](protection/versioning.md)
<!-- from: README.md § API versioning -->

## Running it

- [Health and metrics](running/health-and-metrics.md)
<!-- from: README.md § Health and metrics, Exporting to a collector, Announcing a second listener -->
- [Webhooks](running/webhooks.md)
<!-- from: README.md § Webhooks -->
- [Mail](running/mail.md)
<!-- from: README.md § Mail -->
- [The scheduler](running/scheduler.md)
<!-- from: README.md § Scheduler -->
- [Testing](running/testing.md)
<!-- from: README.md § Testing -->
- [Deploying](running/deploying.md)
<!-- from: README.md § Deploying, Autoload does not survive bundling -->

## Plugins

- [Plugins](plugins/plugins.md)
<!-- from: README.md § Tier 1 Plugins, Interface-first adapters -->
- [Jobs with Caravan](plugins/caravan.md)
<!-- from: ../caravan/README.md § Quick start, File-based handlers, Recurring work -->
- [Integrations with Conduit](plugins/conduit.md)
<!-- from: ../conduit/README.md § Quick start, Core concepts -->
- [Notifications](plugins/notifications.md)
<!-- from: ../notifications/README.md § Writing a notification, Sending -->
- [Agents with MCP](plugins/mcp.md)
<!-- from: ../mcp/README.md § Mounting it, Using it -->
