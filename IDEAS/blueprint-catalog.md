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

## The Coolify and Dokploy catalogs, counted

Counted 2026-11-14 with the CapRover rules, from `coollabsio/coolify` `templates/compose`
at `93c7e53` and `Dokploy/templates` `blueprints/` at `145076b`. *Convertible* means one
service, no host access, no `build:`, no mounted file, and every service key inside
§ Supported subset or dropped by the converter. The counting script was a session scratch
file and was not kept; 3.5's batch report is the reproducible count.

| Measure | Coolify | Dokploy |
| --- | --- | --- |
| Entries / marked `ignore` | 388 / 34 | 616 / 0 |
| Single-service | 167 | 294 |
| … with no host access and no `build:` | 141 | 250 |
| … and no mounted file and no key outside the subset | **127** | **196** |
| … of those, mounting more than one volume | 27 | 45 |
| … of those, with a variable image tag | 5 | 5 |
| Multi-service | 187 | 322 |
| Refused for host access | 46 | 73 |
| `build:` | 0 | 14 |
| Mount a file whose content the template carries | 35 (`content:` on a bind) | 95 (`[[config.mounts]]`) |

Host access, by kind (an entry can hit several): Coolify `docker.sock` 18, a host path 13,
`cap_add` 10, `privileged` 7, `security_opt` 7, host network 6, `sysctls` 2, `devices` 1,
host pid 1. Dokploy `docker.sock` 31, a host path 29, `security_opt` 16, `cap_add` 13,
`devices` 6, host network 3, `privileged` 2, host pid 2, `sysctls` 2.

**Generated values come in four kinds, not one.** `FJS-D2122`'s kind-plus-length holds,
but `randomHex` alone covers a minority:

| Kind | Coolify | Dokploy |
| --- | --- | --- |
| alphanumeric password | `SERVICE_PASSWORD_X` 831, `_64_` 111 | `${password:n}` 756, 24 lengths (32: 425, 16: 96, 64: 95) |
| hex | `SERVICE_HEX_n_X` 25 (64, 32) | `${hash:n}` 101 (64: 51, 32: 27) |
| base64 | `SERVICE_BASE64_n_X` 67, `SERVICE_REALBASE64_n_X` 21 | `${base64:n}` 141 (32: 77, 64: 37) |
| uuid | — | `${uuid}` 9 |
| username | `SERVICE_USER_X` 511 | `${username}` 38 |
| the app's URL or host | `SERVICE_URL_X` 649, `SERVICE_FQDN_X` 66 | `${domain}` 668 |

Coolify's `SERVICE_BASE64_n` is in fact alphanumeric and `SERVICE_REALBASE64_n` is base64.
A generated username has no length and is a fifth kind, or a default the converter writes.
Two of Dokploy's helpers (`${email}`, `${jwt}`) and `${randomPort}` (3) are left out of the count: a converter refuses them by name until a curated app needs one.

**Mounted files are the one gap the counts add.** 35 Coolify and 95 Dokploy entries write
a config file into the container (8 and 27 of them single-service). § Supported subset
refuses them for now. Whether they become a Blueprint feature is decided after 3.5's report shows how many curated picks need one.

## Supported subset

The reader (1.4) accepts these keys and refuses everything else by name. The converters
(Phase 3) write only these keys. A key the converter can't translate is either dropped
with a printed reason (it changes nothing Basecamp does) or refused (dropping it would
deploy something different). The reader never drops anything, because a file it accepts
must mean exactly what it says.

**Top level**

| Key | Reader | Becomes |
| --- | --- | --- |
| `name` | refused: a second copy of `x-blueprint.slug` | dropped by the converter |
| `services` | accepted; exactly one until Phase 4 | the App |
| `volumes` | accepted; each a bare name, or `{}` | the named volume |
| `x-blueprint` | required | the `Blueprint` row and its `BlueprintParam`s |
| `volumes.<v>.driver` / `external` / `driver_opts` | refused | — |
| `networks`, `configs`, `secrets`, `include` | refused | — |
| any other `x-` key | refused; the converter drops it after YAML has expanded its anchors | — |

**Per service**

| Key | Reader | Becomes |
| --- | --- | --- |
| `image` | accepted; may carry `${PARAM}` (1.1) | `Blueprint.image` |
| `environment` (list or map) | accepted; a `${X}` must name a param or a `BLUEPRINT_` built-in | one App `Variable` per key, interpolated (1.1) |
| `volumes` | a named volume only; one until Phase 2 | `volumePath`, a list after 2.1 |
| `command` | accepted; a string is split as compose splits it | `command` (argv) |
| `ports` | at most one `host:container`, and only for a port reached directly rather than through Caddy (`FJS-D930`) | `port`, `containerPort`, `hasExposedPort: true`. A web app has no `ports:`: its container port is `x-blueprint.port` and placement picks the host port (`FJS-D1557`), so the converter drops a `ports:` entry for the web port with that reason |
| `restart` | refused | dropped by the converter; Outpost runs every container `--restart unless-stopped` |
| `deploy.resources.limits.cpus` / `.memory` | accepted; every other `deploy` key refused | `cpuLimit`, `memLimitMb` |
| `depends_on` | refused until Phase 4 | 4.2 |
| `build` | refused until Phase 5 | 5.1 |
| `healthcheck` | refused; Basecamp checks an HTTP path, so the check moves to `x-blueprint.healthCheck` | the converter translates a `curl`/`wget` against localhost into the path and drops anything else with a reason |
| `expose` | refused | the converter folds a single entry into `x-blueprint.port` |
| `mem_limit`, `cpus` | refused | the converter moves them into `deploy.resources.limits` |
| `hostname`, `container_name`, `logging`, `pull_policy`, `platform`, Coolify's `exclude_from_hc` | refused | dropped by the converter; Basecamp names containers and Outpost owns logs and pulls |
| `labels` | refused | dropped by the converter when every label is a proxy's (`traefik.`, `caddy`, `coolify.`), else refused |
| `privileged`, `cap_add`, `devices`, `security_opt`, `sysctls`, `userns_mode`, `ipc`, `network_mode`, `pid`, `runtime`, `extra_hosts`, `dns` | refused: host access | — |
| a volume naming `docker.sock`, an absolute host path, or `~` | refused: host access | — |
| a volume carrying `content:`, or Dokploy's `../files/` | refused: a mounted file (see above) | — |
| `entrypoint`, `user`, `working_dir`, `stop_grace_period`, `shm_size`, `ulimits`, `tmpfs`, `init`, `tty`, `stdin_open`, `env_file` | refused: no App column | each gets a column when a curated app needs one |
| `cap_drop`, `read_only` | refused | dropping a restriction would deploy something less safe |
| `networks`, `links`, `volumes_from`, `profiles`, `secrets`, `configs` | refused | Phase 4 owns how siblings reach each other |

**`x-blueprint`**: `slug`, `name`, `category`, `description`, `version`, `icon`,
`brandColor`, `port`, `healthCheck`, `notes`, `links`, `params`, and on an import `source`
(`catalog`, `path`, `commit`) and `license`. A param is `key`, `label`, `hint`, `default`,
`required`, `secret`, `generate`, `length` and `validRegex`. `main` is refused until
Phase 4, because one service has nothing to choose between.

## Phases

### Phase 0 — Groundwork: the subset and the two shape questions

Goal: the file's accepted compose subset is written down, and nothing Phase 1 builds waits on a question.
Done when: § Supported subset exists in this file, and Q6 and Q7 are ruled in `DECISIONS.md`.

- [x] 0.1 Count the CapRover catalog — § The CapRover catalog, counted.
- [x] 0.2 Count Coolify and Dokploy with the same rules — § The Coolify and Dokploy catalogs, counted: 127 and 196 convertible.
- [x] 0.3 Write § Supported subset: every compose key the reader accepts, what each becomes, and every key it refuses with the reason.
- [x] 0.4 Rule Q6 and Q7 — `FJS-D2122` (kind + length), `FJS-D2123` (a basecamp script); Q2 ruled alongside, `FJS-D2124` (one format).

### Phase 1 — The file, one service

Goal: a `<slug>.blueprint.yml` is read into `Blueprint` rows and written back out, and the bundled catalog is files.
Done when: every bundled blueprint goes file → rows → file unchanged, `docker compose -f <file> config` accepts each one, and `bun run test` in `packages/basecamp` is green.

- [x] 1.1 `image` and env values carry `${PARAM}`, interpolated by `apps.fromBlueprint` (183 of CapRover's 212 single-service apps put the version in the tag). `Blueprint.environment` holds the env (`FJS-D2140`), and only its keys become Variables (`FJS-D2157`). `$$` is a literal `$`, and bare `$NAME`, `${X-y}` and `${X:?y}` are refused by name. `BLUEPRINT_SLUG` works; `BLUEPRINT_HOST` and `BLUEPRINT_URL` are refused until 1.7.
- [x] 1.2 `validRegex String?` on `BlueprintParam`, checked by the deploy form and by `fromBlueprint`.
- [x] 1.3 The generator per Q6: kind plus length, the 9 rows moved in the same change. The kinds are `randomHex`, `randomAlphanumeric` and `randomBase64`, plus `uuid`, which takes no length and is the kind with no length that `FJS-D2122` foresaw. They come from § The Coolify and Dokploy catalogs, counted. `mint` in `apps.service.ts` grows; no second minter. **The unit changes:** today's number is bytes (`randomHex32` is 64 characters), and `length` counts characters, so the 9 rows move as `randomHex32` → `length: 64`. Converters 3.3 and 3.4 check their catalog's unit and do not assume it. Tests: one mints at length 24 and asserts 24 hex characters, and one refuses `uuid` with a `length` by name. The pairing is two `@@check`s on `BlueprintParam`. Migration `20261114173127_blueprint_param_length_environment`.
- [ ] 1.4 The reader: file → `Blueprint` + `BlueprintParam` rows. It is the one place a blueprint file is validated. It refuses § Supported subset's refusals and any unknown key by name, and it refuses a param under the `BLUEPRINT_` prefix.
- [ ] 1.5 The writer: rows → file. Secrets are blank and a minted value is written as its rule (§ Export from a running App).
- [ ] 1.6 The 9 rows in `db/blueprints.js` become `db/blueprints/<slug>.blueprint.yml`; `db:seed` and `db:catalog-sync` read the directory, and `blueprints.js` is deleted. Each file writes its `KEY: ${KEY}` environment out, which `blueprints.js` derives today.
- [ ] 1.7 `BLUEPRINT_HOST` and `BLUEPRINT_URL` at release (`FJS-D2156`): the Variable keeps the template, and `domain/release/variables.ts` fills it each release from the primary Domain, else the ingress name. Before Phase 3, because most Coolify and Dokploy apps name their own URL.
- [ ] 1.8 (owner) Before the next yuma release, clear the catalog's `blueprint_param` rows so the migration applies (`FJS-D2158`). A row still holding `randomHex16/32/64` fails the new enum check. **Open:** `db:catalog-sync` skips a slug that already exists, so it restores neither the params nor the `environment` the migration leaves as `{}`, and under `FJS-D2157` an App made from such a row gets no env. Either the 9 blueprint rows go too (an App made from one loses its `blueprintId`, `onDelete: SetNull`), or `catalog-sync` refreshes an existing row's params and `environment`. Found 2026-11-14 on the local dev db, which is in this state now: params cleared, 9 blueprints left.

### Phase 2 — Several volumes

Goal: a blueprint, and the App made from it, mounts more than one volume.
Done when: a two-volume blueprint deploys on the test camp and `docker inspect` shows both mounts.

Before the converters, because 71 of CapRover's 212 single-service apps need it, and a converter written first would be rewritten when the column changes.

- [ ] 2.1 `volumePath String?` becomes a list on `App` and `Blueprint`, with every caller moved in one change; Outpost passes one `-v` per entry.
- [ ] 2.2 The reader and writer carry compose's own `volumes:` list.

### Phase 3 — Converters: CapRover, Coolify, Dokploy

Goal: a file from any of the three catalogs becomes a `.blueprint.yml`, and a first curated batch is in the catalog.
Done when: for each catalog, the batch report converts at least 85% of the convertible count it computes itself, by § Supported subset's rules (the paper's 187, 127 and 196 are the sanity check), and 5 curated imports deploy on the test camp and pass their health check.

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
8. ~~**Where a fixed env value lives.**~~ **Answered 2026-11-14 (`FJS-D2140`): B — `Blueprint.environment Json` (key → value, which may carry `${PARAM}`), and params stay the values a person is asked for.** A compose `environment:` entry is often a value
   nobody should be asked for (`TMPDIR=/var/lib/plausible/tmp`,
   `DATABASE_URL=postgres://u:${PASS}@db/x`). Today every env var on the 9 built-ins is
   a `BlueprintParam`, and `Blueprint` has no column for a fixed one.
   - **A** — every entry is a param, and a fixed one carries its value as `defaultValue`.
   - **B** — `Blueprint.environment Json` (key → value, which may carry `${PARAM}`),
     and params stay the values a person is asked for.
   - **C** — every entry is a param, plus an `isAsked Boolean` that hides the fixed ones.
   - **Recommend B** — the file's `environment:` and `x-blueprint.params` map one to one
     onto the column and the rows, so file → rows → file round-trips with no guessing.
     A puts about 20 rows on Coolify's Plausible form, and the writer can't tell which
     params the file asked for. C is a "param" that is never a parameter.


9. ~~**When `BLUEPRINT_HOST` and `BLUEPRINT_URL` are filled.**~~ **Answered 2026-11-14 (`FJS-D2156`): A — at release: the Variable keeps the template, and `domain/release/variables.ts` fills it each release from the primary Domain, else the ingress name.** No Domain exists when
   `fromBlueprint` runs, yet Coolify names the app's URL 649 times and Dokploy 668.
   - **A** — at release: the Variable keeps the template, and `domain/release/variables.ts`
     fills it each release from the primary Domain, else the ingress name.
   - **B** — at creation, from the ingress name `<appId>.<ingress zone>`, refused when the
     workspace has no zone.
   - **C** — keep them refused until Phase 3 needs them.
   - **Recommend A** — it is the only one still right after a Domain is added, and
     `variables.ts` already owns what a container's environment is. Coolify resolves at
     deploy time too.
10. ~~**Which params reach the container.**~~ **Answered 2026-11-14 (`FJS-D2157`): A — compose's rule: only `environment:` keys become Variables, and a param is an input. The 9 built-ins gain `KEY: ${KEY}` per param in the same change.** As built, every param becomes a Variable and
    an `environment:` entry with the same key overrides it.
    - **A** — compose's rule: only `environment:` keys become Variables, and a param is
      an input. The 9 built-ins gain `KEY: ${KEY}` per param in the same change.
    - **B** — as built.
    - **Recommend A** — the file means what it says, and 1.5's writer has one answer for
      where a param goes. Under B a version-only param leaks into the env.
11. ~~**The 9 catalog rows on a live hub.**~~ **Answered 2026-11-14 (`FJS-D2158`): B — the owner clears the catalog's param rows by hand before the next yuma release, and `db:catalog-sync` reseeds them.** The new migration rebuilds `blueprint_param`,
    and a row still holding `randomHex16/32/64` fails the new enum check.
    - **A** — the rebuild's copy maps each old value to `randomHex` and its length.
    - **B** — the owner clears the catalog's param rows by hand before the next yuma
      release, and `db:catalog-sync` reseeds them.
    - **Recommend A** — yuma migrates with no hand step, and each param keeps its output.
