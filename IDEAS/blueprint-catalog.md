---
id: blueprint-catalog
status: proposed
dated: 2026-10-11
---

# Idea — a Blueprint file, and a catalog the size of the others

**Status: PLAN.** Nothing here is built. Basecamp ships 9 blueprints as rows
(`packages/basecamp/db/blueprints.js`). There is no file form, so a blueprint cannot be
exported, shared or imported. This expands `paas-parity.md` row 6 (blueprint shape) and
answers row 7's *export and import are the same structure written as a file* for the
catalog case.

**Read `packages/basecamp/docs/vision.md` before building.** A blueprint becomes an App
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
    - { key: SECRET_KEY_BASE, label: Secret key base, secret: true, generate: randomHex, length: 64 }
    - { key: POSTGRES_PASSWORD, label: Database password, secret: true, generate: randomHex, length: 16 }
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

## The CapRover catalog, counted

Counted 2026-11-13 from a sparse clone of `caprover/one-click-apps`
(`public/v4/apps`). The file shape is compose-like YAML plus a `caproverOneClickApp:`
form (see `plausible.yml` there for every feature at once).

| Measure | Count |
| --- | --- |
| Apps | 363 |
| Single-service | 212 |
| … with no host access and no untranslatable `dockerfileLines` | 187 |
| … of those 212, mounting more than one volume | 71 |
| … of those 212, with a variable image tag (`image: x:$$cap_VERSION`) | 183 |
| Multi-service | 151 |
| Reference a sibling as `srv-captain--<name>` | 199 |
| Use `dockerfileLines` / of which only `FROM`, `CMD`, `ENTRYPOINT`, `ENV`, `EXPOSE` | 57 / 36 |
| Refused for host access (`docker.sock`, a host path, `privileged`, `cap_add`, host net or pid) | 23 |
| `$$cap_gen_random_hex(n)` calls, at how many distinct `n` | 315 at 23 lengths (16: 104, 32: 66, 64: 47) |

**What a converter maps:**

| CapRover | Blueprint file |
| --- | --- |
| `$$cap_X` in any value | `${X}`, and a param `X` |
| `$$cap_appname` / `$$cap_root_domain` | `BLUEPRINT_SLUG` / `BLUEPRINT_HOST` (`FJS-D2016`) |
| `srv-captain--$$cap_appname-db` | `${DB_HOST}`, the sibling built-in (Phase 4) |
| `$$cap_gen_random_hex(n)` | a param with `generate: randomHex`, `length: n` (Q6) |
| `variables[].validRegex: /…/` | `validRegex` on the param, slashes stripped |
| `caproverExtra.containerHttpPort` | `port` |
| `caproverExtra.notExposeAsWebApp` | no domain on that service |
| `dockerfileLines` of only `FROM` + `CMD`/`ENTRYPOINT`/`ENV`/`EXPOSE` | `image` + `command` + `environment` + `port` |
| `instructions.start` / `.end`, `description`, `displayName` | `notes`, `description`, `name` |
| `hostname`, `container_name`, `restart` | dropped, each with a reason the report prints |
| anything else | refused by name |

## Phases

### Phase 0 — Groundwork: the subset and the two shape questions

Goal: the file's accepted compose subset is written down, and nothing Phase 1 builds waits on a question.
Done when: § Supported subset exists in this file, and Q6 and Q7 are ruled in `DECISIONS.md`.

- [x] 0.1 Count the CapRover catalog — § The CapRover catalog, counted.
- [ ] 0.2 Count Coolify and Dokploy with the same rules, which turns the 2026-10-11 totals into convertible counts.
- [ ] 0.3 Write § Supported subset: every compose key the reader accepts, what each becomes, and every key it refuses with the reason. Start from the survey's key counts (`environment`, `volumes`, `image`, `depends_on`, `command`, `healthcheck`, `ports`, `user`, `networks`).
- [x] 0.4 Rule Q6 and Q7 — `FJS-D2122` (kind + length), `FJS-D2123` (a basecamp script); Q2 ruled alongside, `FJS-D2124` (one format).

### Phase 1 — The file, one service

Goal: a `<slug>.blueprint.yml` is read into `Blueprint` rows and written back out, and the bundled catalog is files.
Done when: every bundled blueprint goes file → rows → file unchanged, `docker compose -f <file> config` accepts each one, and `bun run test` in `packages/basecamp` is green.

- [ ] 1.1 `image` and env values carry `${PARAM}`, interpolated by `apps.fromBlueprint` (183 of CapRover's 212 single-service apps put the version in the tag).
- [ ] 1.2 `validRegex String?` on `BlueprintParam`, checked by the deploy form and by `fromBlueprint`.
- [ ] 1.3 The generator per Q6: kind plus length, the 9 rows moved in the same change. A test mints at length 24 and asserts 24 hex characters.
- [ ] 1.4 The reader: file → `Blueprint` + `BlueprintParam` rows. It is the one place a blueprint file is validated. It refuses § Supported subset's refusals and any unknown key by name, and it refuses a param under the `BLUEPRINT_` prefix.
- [ ] 1.5 The writer: rows → file. Secrets are blank and a minted value is written as its rule (§ Export from a running App).
- [ ] 1.6 The 9 rows in `db/blueprints.js` become `db/blueprints/<slug>.blueprint.yml`; `db:seed` and `db:catalog-sync` read the directory, and `blueprints.js` is deleted.

### Phase 2 — Several volumes

Goal: a blueprint, and the App made from it, mounts more than one volume.
Done when: a two-volume blueprint deploys on the test camp and `docker inspect` shows both mounts.

Before the converters, because 71 of CapRover's 212 single-service apps need it, and a converter written first would be rewritten when the column changes.

- [ ] 2.1 `volumePath String?` becomes a list on `App` and `Blueprint`, with every caller moved in one change; Outpost passes one `-v` per entry.
- [ ] 2.2 The reader and writer carry compose's own `volumes:` list.

### Phase 3 — Converters: CapRover, Coolify, Dokploy

Goal: a file from any of the three catalogs becomes a `.blueprint.yml`, and a first curated batch is in the catalog.
Done when: the batch report converts at least 150 CapRover single-service apps, and 5 curated imports deploy on the test camp and pass their health check.

A converter only translates. It writes a file and never writes rows, so the Phase 1 reader stays the only gate (Invariant 4).

- [ ] 3.1 The converter's frame per Q7: input file or URL, `--from caprover|coolify|dokploy`, output a `.blueprint.yml` plus a report of what was dropped and what was refused.
- [ ] 3.2 CapRover, per § What a converter maps. Golden fixtures: `plausible`, one with `validRegex`, one with a `FROM`+`CMD` `dockerfileLines`, one refused for `docker.sock`.
- [ ] 3.3 Coolify: header comments → `x-blueprint`; `SERVICE_PASSWORD_X`, `SERVICE_URL_X` and `SERVICE_BASE64_n_X` → `generate` and built-ins.
- [ ] 3.4 Dokploy: `template.toml` → `x-blueprint`; `${password:n}` and `${domain}` → `generate` and built-ins.
- [ ] 3.5 Batch report: run each converter over its whole catalog and print converted, and refused by reason. This is the measure behind Done when.
- [ ] 3.6 Curate the first batch from the owner's list. Each file carries `source:` (catalog, path, commit) and its license, and is deployed once before it is committed.

### Phase 4 — Several services: one blueprint creates N Apps

Goal: a multi-service blueprint deploys as a group of Apps that reach each other by service name.
Done when: CapRover's `plausible` (app, Postgres, ClickHouse) converts, deploys on the test camp and records a pageview.

Weeks of work. It touches `App`, `AppServer` and Outpost, and it is where half of every catalog is. Compose already describes this, which is the strongest argument for the file shape.

- [ ] 4.1 A service name resolves as a hostname from its siblings, and `<SERVICE>_HOST` is filled (`FJS-D2016`).
- [ ] 4.2 Start order from `depends_on`.
- [ ] 4.3 Placement keeps siblings on one machine or one network.
- [ ] 4.4 `fromBlueprint` creates N Apps. Whether the group needs a name is decided here (Q3).
- [ ] 4.5 The converters drop their single-service limit, and 3.5's report runs again.

### Phase 5 — Builds: `build:` and the rest of `dockerfileLines`

Goal: the 21 CapRover apps whose `dockerfileLines` do more than pick an image and a command, and compose `build:` entries, deploy.
Done when: one such app deploys on the test camp.

- [ ] 5.1 Possibly the `inline` source kind in `api/src/domain/release/app-source.ts`, plus `FJS-1496`'s build. Scope it when Phase 4 is done.

## Open questions

1. ~~**The file's name and its extension key.**~~ **Answered 2026-11-07 (`FJS-D2014`): A — one file, `<slug>.blueprint.yml`, with the block under `x-blueprint:`.** One file is shareable by paste; a folder
   can carry a logo and extra mounted files (Dokploy's shape).
   - **A** — one file, `<slug>.blueprint.yml`, with the block under `x-blueprint:`.
   - **B** — a folder, `<slug>/docker-compose.yml` plus a logo, block under `x-blueprint:`.
   - **C** — one file, with the block under a product key (`x-frontier:` or `x-basecamp:`).
   - **Recommend A** — export, paste and download all want one thing. The key names
     the noun the file is rather than the product that reads it, which is also the
     word Dokploy's catalog already uses. A logo goes in as a URL or a data URI.
2. ~~**One format for blueprints and App export.**~~ **Answered 2026-11-13 (`FJS-D2124`): A — one format: an App export is a blueprint whose values are filled in, with secrets blanked.** `paas-parity.md` row 7 wants an App
   exported and imported as a file.
   - **A** — one format: an App export is a blueprint whose values are filled in,
     with secrets blanked.
   - **B** — two formats: the blueprint file here, and a separate App export.
   - **Recommend A** — an exported App with its values replaced by params IS a
     blueprint, so B is two origins for one truth (§ V *origin*), and the two would
     drift on the first field added to one of them.
3. ~~**The noun for several services.**~~ **Answered 2026-11-07 (`FJS-D2015`): A — no new noun: a Blueprint simply has one or more services, and the group of Apps it creates goes unnamed until phase 4 shows it needs a name.** "Stack" is a CSS layout tier in
   `VOCABULARY.md`, and compose's word, *project*, collides here too.
   - **A** — no new noun: a Blueprint simply has one or more services, and the
     group of Apps it creates goes unnamed until phase 4 shows it needs a name.
   - **B** — "Stack", with a ruling that it means one thing in Basecamp and another in css.
   - **C** — a new word for the deployed group, coined now.
   - **Recommend A** — the template already has a name, and the deployed group's
     needs (does it start, stop or delete as one?) are a phase-4 finding. Coining
     now is § V *concept* paid before the demand exists.
4. ~~**Built-in values**~~ **Answered 2026-11-07 (`FJS-D2016`): C — a small reserved set under one prefix (`BLUEPRINT_URL`, `BLUEPRINT_HOST`, `BLUEPRINT_SLUG`, and `<SERVICE>_HOST` for a sibling). A param declared under that prefix is refused.** for the app's URL, host and slug, which a param's default or an
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
5. ~~**Where an imported blueprint lands.**~~ **Answered 2026-11-07 (`FJS-D2017`): C — B now, and A when a workspace asks for private blueprints.** `Blueprint` is `@@tenant(none)`, and a table
   mixing shared rows with one workspace's rows is two models wearing one name.
   - **A** — a second, tenant-scoped model for a workspace's own blueprints.
   - **B** — imports go into the shared catalog only, written by the hub tier (gate 7).
   - **C** — B now, and A when a workspace asks for private blueprints.
   - **Recommend C** — B needs no schema change and fits a curated catalog. A is the
     right shape for private blueprints, but nobody has asked for them yet.
6. ~~**How a param mints a value of a given length.**~~ **Answered 2026-11-13 (`FJS-D2122`): B — `generate` names the kind only (`randomHex`), and a `generateLength Int?` column (`length:` in the file) is required when `generate` is set, between 1 and 256.** CapRover calls
   `$$cap_gen_random_hex(n)` at 23 different lengths. The enum offers `randomHex16`,
   `randomHex32` and `randomHex64`. The length is counted in hex characters, not bytes.
   - **A** — keep the three, and the converter rounds each length to the nearest one.
   - **B** — `generate` names the kind only (`randomHex`), and a `generateLength Int?`
     column (`length:` in the file) is required when `generate` is set, between 1 and 256.
   - **C** — the length goes inside the value, as in `randomHex:24`.
   - **Recommend B** — it is the existing field plus one integer that the schema
     range-checks. A is silently wrong: an app that needs exactly 24 characters gets 32.
     C puts a number inside a string that something has to parse. All three catalogs
     pass the length as an argument beside the kind. The ntfy token generator
     (`FJS-3657`) becomes a second kind with no length.
7. ~~**Where the converters run and what they write.**~~ **Answered 2026-11-13 (`FJS-D2123`): A — a script in the basecamp package, `bun run blueprint:convert`, that writes `db/blueprints/<slug>.blueprint.yml` for review and commit.**
   - **A** — a script in the basecamp package, `bun run blueprint:convert`, that writes
     `db/blueprints/<slug>.blueprint.yml` for review and commit.
   - **B** — a `fli` command that does the same.
   - **C** — a Basecamp screen that imports a CapRover, Coolify or Dokploy file at runtime.
   - **Recommend A** — Phase 3 curates by hand, so conversion is a reviewed, offline,
     in-git job. A keeps three third-party parsers out of the framework CLI. C feeds a
     stranger's file to a fleet machine at runtime, against `FJS-D2017`'s curated
     catalog. Reopen as B if re-syncing a catalog becomes routine.


