# Basecamp — the API image.
#
# Built by deploy/build.mjs, which is not optional: the build context has to
# carry a packed copy of every @frontierjs package this app depends on, and a
# hand-run `docker build` from a clean tree has none of them.
#
# ─── why the packages are vendored ───────────────────────────────────────────
#
# Basecamp depends on nine workspace packages as `workspace:*`. Inside a Docker
# build there is no workspace: bun cannot resolve `workspace:*`, and `link:` —
# which `fli new` writes for a local scaffold — fails five times over with
# `FileNotFound: failed linking dependency/workspace to node_modules`. That is
# FJS-241, and its open half is *what an app built from local sources should
# install instead*.
#
# The answer this image takes: `bun pm pack` each package INTO the build
# context and depend on the tarballs. A tarball is byte-for-byte what `npm
# publish` would upload, so the image runs the working tree — not the registry,
# which lags it — and it grades every package's `files:` field on the way past,
# because a source file missing from `files` is invisible in the workspace and
# fatal once installed.
#
# The alternative, pinning the published versions, would build an image of code
# nobody in this repo is editing. CI's `deploy` phase already tests that path
# for a scaffolded app; this one is for the app whose whole purpose is to
# exercise the tree.

# Both FROM lines name BUN_VERSION (api/src/providers/compute/enrollment.ts), the
# Bun every Outpost in the fleet runs; a moving tag ran 1.4.4 beside 1.4.2
# (FJS-3443). compute.test.ts holds them together.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /app

# Dependencies first, so a source edit does not re-resolve the tree. The
# manifest is the GENERATED one — build.mjs rewrites every `workspace:*` to the
# tarball beside it — and vendor/ has to land in the same layer, because the
# specs point at it.
COPY deploy/generated/app-manifest.json ./package.json
COPY deploy/generated/vendor ./deploy/generated/vendor
RUN bun install

# Source. db/ is copied for two reasons that are easy to miss: the schema is
# what boot reads to find its databases, and db/migrations/main/ is what it
# applies. An image without it comes up with no tables and says nothing.
COPY tsconfig*.json ./
COPY api ./api
COPY db  ./db
COPY web ./web

# `web/config/api-paths.js` derives the proxy path list from this file rather
# than holding one, and `vite.config.js` imports it at config load — so the SPA
# build below cannot start without it. It is committed and CI-gated, so this is
# a copy of a checked artefact and not a second source of truth.
COPY app.snapshot.md ./

# The SPA. Built here rather than on the host so the image does not depend on
# what the builder's node_modules happened to hold — the failure that made
# `03-build-web` untrustworthy in the shipped pipeline.
#
# `build:db` is deliberately NOT run here. It asks whether the committed
# migration history builds schema.lite, which is a question about the
# repository, answered by `bun run db:check` on the host and in CI. The image
# applies that history at boot (`api/src/app.ts`), and a history that does not
# build the schema is refused there by name.
RUN bun run build:web

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app

COPY --from=build /app /app

# domain/site/site-checkout.ts runs git for every draft read and save, and an ssh
# remote needs the ssh client; the slim base ships neither, so /drafts fails
# only once deployed. The build itself runs on the App's machine (FJS-D1251).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client \
 && rm -rf /var/lib/apt/lists/*

# The live database is a bind mount, never the image: `fli deploy` and compose
# both mount it at /db, and a DATABASE_URL anywhere else is in the container's
# own layer, so the next swap starts it empty and the app opens on /setup. The
# audit trail is /db/audit.db and the jobs queue /db/basecamp-jobs.db for the
# same reason.
RUN mkdir -p /db

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    FRONTIER_PORT_BE=8120 \
    DATABASE_URL=/db/basecamp.db

EXPOSE 8120

# Migrations run at boot, inside app.ts, through litestone's own apply() — not
# a separate `db:migrate` step, and deliberately not junction's migrate(), which
# globs one level and reports success for a directory it cannot read (FJS-193).
# A failed migration throws, the container exits non-zero, and the health check
# never comes up.
CMD ["bun", "run", "start"]
