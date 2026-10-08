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
  - **A** — `tenant`: `session.tenant`, `switchTenant(id)`, `client.setTenant(id)`, with the header name the app's own.
  - **B** — `workspace`: `session.workspace`, `switchWorkspace(id)`, and `client.setWorkspace` keeps its name.
  - **Recommend A** — the seed's `tenancy` block, `resolveTenancy`, `registry.tenantFor` and `FJS-D399`'s `tenant: { header }` key already say tenant, and `Workspace` is one app's model name; the next app's is `Organization` or `Account`. With the list derived from the schema, Sierra learns the app's own word from it rather than the framework adopting basecamp's.
- **Where the list comes from.** All three call `/workspaces` and rely on the
  tenant model being `@@tenant(none)`. Is the tenant model always derivable from
  the schema (`resolveTenancy(schema)`), so Sierra can ask without the app
  naming the service?
  - **A** — derived: the tenant model is the one the tenancy column relates to on the scoped models (basecamp's `workspaceId` → `Workspace`), and Sierra reads that model's service as the caller; boot refuses by name when no relation names one or two disagree.
  - **B** — declared: the `tenancy` block gains `model Workspace`.
  - **C** — the app names the service to Sierra, `session.tenant({ list: 'workspaces' })`.
  - **Recommend A** — the relation already states which model the column points at, and basecamp's three relations on `workspaceId` show it is there to read; B restates it in a second place, and C leaves the three copies the paper counts as one option each. The refusal is what keeps A from guessing when a schema has no such relation.
- **`FJS-D399`** settled how a CLI names its tenant (`cli/config/`). The browser
  answer should read the same config key, or say why it cannot.
  - **A** — the browser build reads `cli/config/`'s `tenant.header`, the key `FJS-D399` names.
  - **B** — the header name is stated once on the server, which already reads it (`tenantFrom`, `http.callHeaders`), and the browser and the CLI both learn it from the app's manifest.
  - **C** — Sierra states its own `tenant: { header }`, spelled as `FJS-D399` spells it.
  - **Recommend B** — the server is the one place a wrong header name is refused, so it is the origin, and both surfaces derive from it. A makes one surface's build read another surface's config, and C is a third statement of the same name. B amends `FJS-D399`'s key into a read of the manifest, so it lands as a ruling that says so.
