-- Litestone migration
-- Created:   2026-11-21T06:01:48.940Z
-- Class:     expand
-- Changes:
--     ~ app  [alter]
--         + idx  (projectId)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "app": add indexes
CREATE INDEX IF NOT EXISTS "idx_app_projectId" ON "app" ("projectId") WHERE "deletedAt" IS NULL;

COMMIT;
PRAGMA foreign_keys = ON;