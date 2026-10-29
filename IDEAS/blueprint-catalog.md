---
id: blueprint-catalog
status: proposed
dated: 2026-10-11
---

# Idea — a Blueprint file, and a catalog the size of the others

**Status: IDEA.** Nothing here is built. Basecamp ships 8 blueprints as rows
(`packages/basecamp/db/blueprints.js`). There is no file form, so a blueprint cannot be
exported, shared or imported. This expands `paas-parity.md` row 6 (blueprint shape) and
answers row 7's *export and import are the same structure written as a file* for the
catalog case.

**Read `packages/basecamp/docs/VISION.md` before building.** A blueprint becomes an App
through `apps.fromBlueprint`, and that App deploys like any other. A multi-service shape
that `fli` and Outpost cannot also deploy would break VISION's rule.

## The open catalogs

Every catalog was fetched and counted on 2026-10-11.

| Catalog | Entries | License | File shape |
| --- | --- | --- | --- |
| [Dokploy templates](https://github.com/Dokploy/templates) | 568 | MIT | `blueprints/<id>/`: `docker-compose.yml` + `template.toml` (variables, domains, env, mounted files) + `meta.json` + logo |
| [Coolify](https://github.com/coollabsio/coolify/tree/main/templates/compose) | 386 (27 marked `ignore`) | Apache-2.0 | One `docker-compose.yml`. Metadata in header comments (`# slogan:`, `# category:`, `# port:`); generated values are magic env names (`SERVICE_PASSWORD_X`, `SERVICE_URL_X`, `SERVICE_BASE64_64_X`) |
| [CapRover](https://github.com/caprover/one-click-apps/tree/master/public/v4/apps) | 361 | Apache-2.0 | One YAML: compose-like `services:` (not valid compose) + `caproverOneClickApp:` form, `$$cap_X` substituted anywhere |
| [Runtipi](https://github.com/runtipi/runtipi-appstore) | 274 | GPL-3.0 | `config.json` + compose |
| [CasaOS](https://github.com/IceWhaleTech/CasaOS-AppStore) | 179 | Apache-2.0 | One `docker-compose.yml`, metadata in an `x-casaos:` extension block |
| [Umbrel](https://github.com/getumbrel/umbrel-apps) | 402 | none stated | `umbrel-app.yml` + compose |

**Importable:** Dokploy, Coolify, CapRover and CasaOS. Runtipi's GPL-3.0 would carry over
to anything derived from it. Umbrel states no license, so it is all rights reserved.
The catalogs overlap heavily (n8n is in all of them), so the union is much smaller
than the sum.

**Two other uses of the word.** Dokploy calls its entries *blueprints*, which is
familiarity in Basecamp's favor. Render's *Blueprint* (`render.yaml`) is something else:
infrastructure-as-code for your own app, not a catalog of third-party ones.

## What the industry converged on

Five of the six use a **real docker-compose file** for the services and put the form and
metadata beside it. They differ only in where:

- in header comments (Coolify);
- in a sidecar file (Dokploy, Umbrel, Runtipi);
- in a compose `x-` extension block (CasaOS).

CapRover is the outlier: compose-shaped but not compose, so its files run nowhere else.

Most entries are multi-service. Coolify has 189 of 359, Dokploy 293 of 568 and CapRover
151 of 361. A Blueprint that is one container covers about half of any catalog at best.

## Proposal: the file is a compose file with an `x-` block

One file, a valid `docker-compose.yml`, with the Basecamp half in a top-level extension
block. Compose's spec reserves `x-` keys for exactly this, and Docker ignores them.

```yaml
name: plausible
services:
  plausible:
    image: ghcr.io/plausible/community-edition:${PLAUSIBLE_VERSION:-v3.2.1}
    environment:
      BASE_URL: ${APP_URL}
      SECRET_KEY_BASE: ${SECRET_KEY_BASE}
      DATABASE_URL: postgres://plausible:${POSTGRES_PASSWORD}@plausible-db:5432/plausible
    depends_on: [plausible-db]
  plausible-db:
    image: postgres:16-alpine
    volumes: [db-data:/var/lib/postgresql/data]
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
volumes:
  db-data:

x-blueprint:            # the key name is open; see below
  slug: plausible
  category: Analytics
  description: Privacy-friendly web analytics. No cookies.
  main: plausible       # the service that gets the domain
  port: 8000
  healthCheck: /api/health
  params:
    - { key: PLAUSIBLE_VERSION, label: Version }
    - { key: SECRET_KEY_BASE, label: Secret key base, secret: true, generate: random_hex_64 }
    - { key: POSTGRES_PASSWORD, label: Database password, secret: true, generate: random_hex_16 }
  links:
    - { label: Docs, url: https://plausible.io/docs/self-hosting }
```

Why this shape:

- **An exported blueprint runs without Basecamp.** `docker compose up` with a `.env`
  works, so a shared file is useful to someone who has never seen FJS.
- **Importing is metadata translation, not stack translation.** Coolify, Dokploy and
  CasaOS are already compose. Only the form moves (header comments, `template.toml`,
  `x-casaos` → `x-blueprint`), and Coolify's magic names map onto `generate`.
- **Params are compose's own `${VAR:-default}` interpolation.** That gives CapRover's
  "substitute anywhere" (image tag included) with no second template language.
- **One file, not a sidecar,** because the point is a single thing you export, paste or
  download.

**Export from a running App:** secret values are never written. A param keeps
`secret: true` with an empty value, and a minted value is written as its `generate`
rule, not the value. Hostnames are left blank, as row 7 already says for clone.

## The risk that comes with importing

**An imported file is a stranger's input that will run as root on a fleet machine.**
Counted across Coolify and Dokploy: 53 mount `docker.sock`, 8 are `privileged`, 11 use
host networking, 21 use `cap_add`, 2 use `pid: host`. The importer accepts a declared
SUBSET of compose and refuses everything else by name. Its first refusals are:

- `docker.sock` and other host paths;
- `privileged`, `cap_add`, `network_mode: host`, `pid: host`;
- `build:`.

A key it does not know is refused, never silently dropped. Silently dropping a key would
deploy something different from what the file says.

## Phases

0. **Decide the file and its supported compose subset.** Before any importer, because
   phase 1 is the file's first reader and writer. Runs `decision-rules`.
1. **Read and write the file for single-service blueprints.** `Blueprint` rows ⇄ file,
   which gives export and import at the current shape. Add a `validRegex` column on
   `BlueprintParam` (CapRover and Dokploy both validate). The params are already
   interpolation-shaped once image and env can carry `${…}`. Compose's `command:` maps
   onto the `command String[]` column `App` and `Blueprint` already carry (ntfy's row
   needs `serve`); the string form is split, never run through a shell.
2. **Importers for the single-service subset.** Coolify (170), Dokploy (275) and
   CapRover (110 after the image-tag fix), curated by hand rather than bulk-loaded.
3. **Several volumes.** `volumePath` becomes a list on `App` as well as `Blueprint`,
   because `fromBlueprint` copies column for column. Over 100 main services in each
   catalog have more than one.
4. **Multi-service: one blueprint creates N Apps (weeks).** Needs:
   - start order from `depends_on`;
   - a service name that resolves as a hostname from its siblings;
   - placement that keeps siblings on one machine or one network.

   It touches `App`, `AppServer` and Outpost, and it is where half of every catalog is.
   Compose already describes this, which is the strongest argument for the file shape.
5. **`build:` and CapRover's `dockerfileLines`, last.** Possibly the `inline` source kind
   in `api/src/domain/release/app-source.ts` plus FJS-1496's build.

## Open questions

1. **The file's name and its extension key.** One file is shareable by paste; a folder
   can carry a logo and extra mounted files (Dokploy's shape).
   - **A** — one file, `<slug>.blueprint.yml`, with the block under `x-blueprint:`.
   - **B** — a folder, `<slug>/docker-compose.yml` plus a logo, block under `x-blueprint:`.
   - **C** — one file, with the block under a product key (`x-frontier:` or `x-basecamp:`).
   - **Recommend A** — export, paste and download all want one thing. The key names
     the noun the file is rather than the product that reads it, which is also the
     word Dokploy's catalog already uses. A logo goes in as a URL or a data URI.
2. **One format for blueprints and App export.** `paas-parity.md` row 7 wants an App
   exported and imported as a file.
   - **A** — one format: an App export is a blueprint whose values are filled in,
     with secrets blanked.
   - **B** — two formats: the blueprint file here, and a separate App export.
   - **Recommend A** — an exported App with its values replaced by params IS a
     blueprint, so B is two origins for one truth (§ V *origin*), and the two would
     drift on the first field added to one of them.
3. **The noun for several services.** "Stack" is a CSS layout tier in
   `VOCABULARY.md`, and compose's word, *project*, collides here too.
   - **A** — no new noun: a Blueprint simply has one or more services, and the
     group of Apps it creates goes unnamed until phase 4 shows it needs a name.
   - **B** — "Stack", with a ruling that it means one thing in Basecamp and another in css.
   - **C** — a new word for the deployed group, coined now.
   - **Recommend A** — the template already has a name, and the deployed group's
     needs (does it start, stop or delete as one?) are a phase-4 finding. Coining
     now is § V *concept* paid before the demand exists.
4. **Built-in values** for the app's URL, host and slug, which a param's default or an
   env value can reference.
   - **A** — Coolify's style: one magic name per service, `SERVICE_URL_<SERVICE>`.
   - **B** — Dokploy's style: helper calls such as `${domain}` and `${password:32}`
     inside values.
   - **C** — a small reserved set under one prefix (`BLUEPRINT_URL`, `BLUEPRINT_HOST`,
     `BLUEPRINT_SLUG`, and `<SERVICE>_HOST` for a sibling). A param declared under
     that prefix is refused.
   - **Recommend C** — plain compose interpolation stays plain, with no second template
     language as in B. One prefix means a param can never shadow a built-in. A and B
     both map onto it on import. Generated secrets stay on the param's `generate`.
5. **Where an imported blueprint lands.** `Blueprint` is `@@tenant(none)`, and a table
   mixing shared rows with one workspace's rows is two models wearing one name.
   - **A** — a second, tenant-scoped model for a workspace's own blueprints.
   - **B** — imports go into the shared catalog only, written by the hub tier (gate 7).
   - **C** — B now, and A when a workspace asks for private blueprints.
   - **Recommend C** — B needs no schema change and fits a curated catalog. A is the
     right shape for private blueprints, but nobody has asked for them yet.
