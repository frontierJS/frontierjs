-- Litestone migration (database: audit)
-- Created:   2026-10-22T20:31:09.707Z
-- Changes:
--     + AuditTrail  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "audit_trail" (
  "operation" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "field" TEXT,
  "transition" TEXT,
  "records" TEXT NOT NULL,
  "before" TEXT,
  "after" TEXT,
  "actorId" TEXT,
  "actorType" TEXT,
  "subjectId" TEXT,
  "episodeId" TEXT,
  "correlationId" TEXT,
  "source" TEXT,
  "origin" TEXT,
  "ip" TEXT,
  "userAgent" TEXT,
  "tenant" TEXT,
  "meta" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_audit_trail_actorId" ON "audit_trail" ("actorId");
CREATE INDEX IF NOT EXISTS "idx_audit_trail_model" ON "audit_trail" ("model");
CREATE INDEX IF NOT EXISTS "idx_audit_trail_correlationId" ON "audit_trail" ("correlationId");
CREATE INDEX IF NOT EXISTS "idx_audit_trail_episodeId" ON "audit_trail" ("episodeId");

COMMIT;
PRAGMA foreign_keys = ON;