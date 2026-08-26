# site/deploy/Dockerfile — the storefront ships on its own.
#
# It is not in the API's image: a public site is released when its content
# changes, which is not when the API is, and it stays up when the API is down —
# a visitor still gets the catalogue, and only the live prices go quiet.
#
# The build needs the DATABASE, which is the one thing about a prerendered site
# that surprises people: `load()` runs at build time through `api/src/core/db.ts`, so the
# thing producing the HTML reads the same SQLite file the API serves from. A
# deployment that builds this image without the data gets a site with no
# products and an exit code of 0.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN cd site && bunx vite build -c config/vite.config.js

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/site/dist ./site/dist
COPY --from=build /app/site/deploy ./site/deploy
COPY --from=build /app/node_modules ./node_modules
ENV PORT=8710
EXPOSE 8710
CMD ["bun", "run", "site/deploy/serve.js"]
