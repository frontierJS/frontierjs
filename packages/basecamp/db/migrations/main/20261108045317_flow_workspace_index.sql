-- Litestone migration
-- Created:   2026-11-08T04:53:17.263Z
-- Changes:
--     ~ flow  [alter]
--         + idx  (workspaceId)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "flow": add indexes
CREATE INDEX IF NOT EXISTS "idx_flow_workspaceId" ON "flow" ("workspaceId") WHERE "deletedAt" IS NULL;

COMMIT;
PRAGMA foreign_keys = ON;