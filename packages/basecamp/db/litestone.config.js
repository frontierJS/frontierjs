// db/litestone.config.js
// Litestone configuration — db path, schema source, and migrations output.
// The schema parser reads this when running:
//   bun run litestone          (generate client + DDL)
//   bun run litestone:audit    (schema audit report)
//   bun run litestone studio   (schema browser UI)

export default {
  db:         './basecamp.db',
  schema:     './schema.lite',
  migrations: './migrations',
}
