// db/litestone.config.js
// The litestone CLI's paths — `bunx litestone <command>` from the package root
// finds this file in ./db/. The app itself reads the database path from
// `database main` in schema.lite, not from here.

export default {
  db:         './basecamp.db',
  schema:     './schema.lite',
  migrations: './migrations',
}
