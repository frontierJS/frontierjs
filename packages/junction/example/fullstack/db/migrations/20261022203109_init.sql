-- Litestone migration
-- Created:   2026-10-22T20:31:09.747Z
-- Changes:
--     + Post  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

-- db/schema.lite — the seed.
-- 
-- Everything downstream derives from this file:
-- 
-- the table            ← autoMigrate(db)
-- CRUD + pagination    ← createService({}) reads the model
-- 401s                 ← @@gate, via the derived gateAuth hook
-- 400s                 ← the field rules below, via the derived autoValidate hook
-- make() defaults      ← generateJsonSchema, shipped to the browser
-- 
-- Model names are PascalCase and singular — ALWAYS. The client accessor is the
-- camelCase of the model name, so `model Post` is reached as `db.post`, and a
-- service named 'posts' (from posts.service.ts) resolves to it.
CREATE TABLE IF NOT EXISTS "post" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "published" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

COMMIT;
PRAGMA foreign_keys = ON;