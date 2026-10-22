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
// placeholder rather than shipping somewhere nobody meant. Set them, or name the
// box per run: `fli deploy:setup --server myvps` takes any alias in
// ~/.ssh/config, or user@host.
//
// There is no `user` here, so `ssh` is handed the bare server and the alias's own
// User, Port and IdentityFile apply. A `user` set here is prefixed, and wins.
//
// `bun run image` / `image:up` are the local path and do not read this file:
// `deploy/build.mjs` drives compose directly. This is for the remote one.

export default {
  deploy: {
    server: 'basecamp', // ← set this
    path: '/apps/basecamp', // deploy root on the server
    app_id: 'basecamp',

    // This box joins the fleet this Basecamp runs: after the web release, `fli
    // deploy` runs api/src/core/enroll-host.ts in the container and the install it
    // answers on the host (FJS-D1191). `--no-outpost` skips it for one run.
    outpost: true,

    api: {
      // 8120 everywhere: the port scheme's backend slot for project 2
      // (packages/cli/core/ports.js), which is what the Dockerfile EXPOSEs, what
      // compose publishes, and what `bun run api` binds — so the URL is the same
      // whether the stack is containerized or not.
      port: 8120,

      // No apiPrefix in this app, so health is at the bare path. It matters more
      // than it looks: `health()` registers through `app.get()`, which is
      // the one owner of apiPrefix, so an app that grows a prefix moves this
      // too — and a wrong path here does not fail loudly. The deploy polls a 404
      // for twenty seconds and then rolls back an API that was running.
      health: '/health',

      dockerfile: 'deploy/Dockerfile',
      env: '/apps/basecamp/.env.production',

      // Validate the server's env against .env.example before deploying.
      // basecamp refuses to boot in production on the dev ENCRYPTION_KEY
      // (core/db.ts) — better to hear that from the check than from a container
      // that exits on the server.
      envCheck: true
    },

    web: {
      domain: '',
      keep_releases: 3
      // ssl: {
      //   cert: '/etc/ssl/certs/basecamp.pem',
      //   key:  '/etc/ssl/private/basecamp.key',
      // },
    },

    db: {
      // The HOST directory; the deploy mounts it at /db in the container, where
      // the Dockerfile's DATABASE_URL points. A database anywhere else is lost
      // on the next swap, and the health step puts the old container back.
      path: '/data',
      file: 'production.db',
      keep_backups: 5
    }
  }
}
