// frontier.config.js
//
// The DEPLOY block — what `fli deploy` reads (`packages/cli/core/utils.js`
// § loadFrontierConfig). Its sibling is `api/config/junction.config.js`, which
// is what the app reads about itself; this one is what the tooling reads about
// where the app goes. Two files, two audiences, and the split is why they are
// not one.
//
// Every value here is the one basecamp's own container already uses
// (`deploy/Dockerfile`, `deploy/docker-compose.yml`), so the two descriptions of
// this app cannot disagree — a deploy config that restates a port by hand is a
// second answer to a question the Dockerfile already answered.
//
// TWO FIELDS ARE NOT FILLED IN, and deliberately: `server` and `domain` are
// facts about a deployment, and this repo has none. `fli deploy` refuses on the
// placeholder rather than shipping somewhere nobody meant. Set them, or pass
// them to `fli make:deploy --server --domain`.
//
// `bun run image` / `image:up` are the local path and do not read this file:
// `deploy/build.mjs` drives compose directly. This is for the remote one.

export default {
  deploy: {
    server: 'your-server.com',   // ← set this
    user:   'deploy',            // SSH user on the server
    path:   '/apps/basecamp',    // deploy root on the server
    app_id: 'basecamp',

    api: {
      // 8120 everywhere: the port scheme's backend slot for project 2
      // (packages/cli/core/ports.js), which is what the Dockerfile EXPOSEs, what
      // compose publishes, and what `bun run api` binds — so the URL is the same
      // whether the stack is containerised or not.
      port: 8120,

      // No apiPrefix in this app, so health is at the bare path. It matters more
      // than it looks: `healthPlugin()` registers through `app.get()`, which is
      // the one owner of apiPrefix, so an app that grows a prefix moves this
      // too — and a wrong path here does not fail loudly. The deploy polls a 404
      // for twenty seconds and then rolls back an API that was running.
      health: '/health',

      dockerfile: 'deploy/Dockerfile',
      env:        '/apps/basecamp/.env.production',

      // Validate the server's env against .env.example before deploying.
      // basecamp refuses to boot in production on the dev ENCRYPTION_KEY
      // (core/db.ts) — better to hear that from the check than from a container
      // that exits on the server.
      envCheck: true,
    },

    web: {
      domain: 'your-app.com',   // ← set this
      keep_releases: 3,
      // ssl: {
      //   cert: '/etc/ssl/certs/basecamp.pem',
      //   key:  '/etc/ssl/private/basecamp.key',
      // },
    },

    db: {
      // Matches the container: DATABASE_URL is /data/basecamp.db and /data is a
      // volume, because a database inside the image is lost on the next swap
      // and the loss is silent — the app simply comes up empty.
      path:         '/data',
      file:         'basecamp.db',
      keep_backups: 5,
    },
  },
}
