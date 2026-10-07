---
id: current-tenant
status: proposed
dated: 2026-10-07
---

# Idea — Sierra keeps the current tenant beside the session

**Status: PROPOSED.** Accepted as a direction in the app layout audit
([Where Code Lives](https://claude.ai/artifact/3dvt1QFJo4LCqXpfyYRsjP), row 5);
the shape below is not ruled.

## The gap

Sierra owns WHO the caller is: `session`, its boot restore, sign-in and sign-out.
Nothing owns WHERE they are. Under `strategy row`, every scoped call names its
tenant in `X-Workspace-Id`, and the browser client already carries the header
(`client.setWorkspace(id)`). Choosing the value, remembering it and dropping it
when a membership ends is left to the app, and three apps have written it:

| App | File | What it does |
| --- | --- | --- |
| basecamp | `web/src/session.js` | lists workspaces, restores the remembered one only if the caller still belongs to it, falls back to `/auth/workspace`, re-checks after a membership change |
| linear | `web/src/lib/workspace.js` | the same, plus the teams the sidebar lists |
| notion | `web/src/lib/workspace.js` | the same, copied from linear |

Each copy found the same ordering trap on its own: read the remembered id
BEFORE adopting a default, or the default overwrites it and the switch undoes
itself on the next load (basecamp's comment). Each also lists workspaces before
adopting one, because `Workspace` is `@@tenant(none)` and adopting first sends
calls that name a tenant nobody checked.

## The proposal

Sierra keeps `session.tenant` beside `session.user`. It is the browser half of
the server's `resolveTenancy` / `registry.tenantFor`:

- **Restore:** the remembered id, kept only if the caller's tenant list still
  names it, then the server's default.
- **Switch:** `switchTenant(id)` sets the header through the client and announces
  the change, so the shell reloads scoped stores.
- **Revoke:** after a membership write, re-read the list, and move off a tenant
  that no longer contains the caller.
- **Persistence:** keyed per app, like the theme and the token, because one
  origin serves two apps in dev.

What stays the app's: what it shows per tenant (linear's teams), and the
switcher's markup.

## Open questions

- **The noun.** `workspaceId` is basecamp's word and the header's. The server
  says *tenant*. Pick one before code (`decision-rules`). The client's
  `setWorkspace` is renamed with it.
- **Where the list comes from.** All three call `/workspaces` and rely on the
  tenant model being `@@tenant(none)`. Is the tenant model always derivable from
  the schema (`resolveTenancy(schema)`), so Sierra can ask without the app
  naming the service?
- **`FJS-D399`** settled how a CLI names its tenant (`cli/config/`). The browser
  answer should read the same config key, or say why it cannot.
