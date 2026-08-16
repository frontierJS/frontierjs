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

FROM oven/bun:1 AS build
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

# The SPA. Built here rather than on the host so the image does not depend on
# what the builder's node_modules happened to hold — the failure that made
# `03-build-web` untrustworthy in the shipped pipeline.
#
# `build:db` is deliberately NOT run here. It is a drift check — has the
# committed migration diverged from schema.lite — which is a question about the
# repository and is answered by `bun run db:check` on the host and in CI. It
# also cannot run here: db/generate.js imports litestone by relative workspace
# path ON PURPOSE, so that the emitter is the tree's and never the stale copy
# `bun install` leaves under node_modules/.bun. That path does not exist in an
# image, and it should not.
RUN bun run build:web

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=build /app /app

# The live database is a bind mount, never the image: point DATABASE_URL at
# /data or every write is lost on the next container swap. Audit is a directory
# for the same reason — @@log(audit) writes jsonl beside it.
RUN mkdir -p /data /data/audit

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8120 \
    DATABASE_URL=/data/basecamp.db

EXPOSE 8120

# Migrations run at boot, inside app.ts, through litestone's own apply() — not
# a separate `db:migrate` step, and deliberately not junction's migrate(), which
# globs one level and reports success for a directory it cannot read (FJS-193).
# A failed migration throws, the container exits non-zero, and the health check
# never comes up.
CMD ["bun", "run", "start"]
