-- ============================================================
-- Basecamp — initial schema
--
-- GENERATED FROM db/schema.lite. Do not edit by hand.
-- Regenerate:  bun db/generate.js
-- ============================================================

PRAGMA foreign_keys = ON;

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