# widgets/deploy/Dockerfile — the widget surface ships on its own.
#
# It is not in the API's image: a widget is released when the pages embedding it
# are ready, which is not when the API is, and a static origin is a different
# thing to run from an application server.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN cd widgets && bunx sierra widgets --config config/sierra.config.js

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/widgets/dist/embeds ./widgets/dist/embeds
COPY --from=build /app/widgets/deploy ./widgets/deploy
COPY --from=build /app/node_modules ./node_modules
ENV PORT=8310
EXPOSE 8310
CMD ["bun", "run", "widgets/deploy/serve.js"]
