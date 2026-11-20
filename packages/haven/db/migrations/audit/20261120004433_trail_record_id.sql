-- Litestone migration (database: audit)
-- Created:   2026-11-20T00:44:33.585Z
-- Class:     contract
-- Changes:
--     ~ audit_trail  [rebuild]
--         + col  recordId TEXT
--         - col  records
--         + idx  (model, recordId)
--         - idx  idx_audit_trail_model
--
-- One entry per row (FJS-D1744). An entry keeps the first id of its array as
-- recordId, and each further id is copied into an entry of its own after the
-- row count is checked, so no id the trail held is lost.
PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "audit_trail" — full table reconstruction required
CREATE TABLE "audit_trail__new" (
  "operation" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "field" TEXT,
  "transition" TEXT,
  "recordId" TEXT,
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

INSERT INTO "audit_trail__new" ("operation", "model", "field", "transition", "recordId", "before", "after", "actorId", "actorType", "subjectId", "episodeId", "correlationId", "source", "origin", "ip", "userAgent", "tenant", "meta", "createdAt", "id")
  SELECT "operation", "model", "field", "transition",
         CASE WHEN json_valid("records") AND json_type("records", '$[0]') IS NOT NULL THEN CAST(json_extract("records", '$[0]') AS TEXT) END,
         "before", "after", "actorId", "actorType", "subjectId", "episodeId", "correlationId", "source", "origin", "ip", "userAgent", "tenant", "meta", "createdAt", "id" FROM "audit_trail";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of audit_trail lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "audit_trail__new") = (SELECT count(*) FROM "audit_trail") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

INSERT INTO "audit_trail__new" ("operation", "model", "field", "transition", "recordId", "before", "after", "actorId", "actorType", "subjectId", "episodeId", "correlationId", "source", "origin", "ip", "userAgent", "tenant", "meta", "createdAt")
  SELECT t."operation", t."model", t."field", t."transition", CAST(j."value" AS TEXT),
         t."before", t."after", t."actorId", t."actorType", t."subjectId", t."episodeId", t."correlationId", t."source", t."origin", t."ip", t."userAgent", t."tenant", t."meta", t."createdAt"
    FROM "audit_trail" AS t, json_each(t."records") AS j
   WHERE json_valid(t."records") AND j."key" > 0
   ORDER BY t."id", j."key";

DROP TABLE "audit_trail";
ALTER TABLE "audit_trail__new" RENAME TO "audit_trail";

-- recreate indexes for "audit_trail"
CREATE INDEX IF NOT EXISTS "idx_audit_trail_actorId" ON "audit_trail" ("actorId");
CREATE INDEX IF NOT EXISTS "idx_audit_trail_model_recordId" ON "audit_trail" ("model", "recordId");
CREATE INDEX IF NOT EXISTS "idx_audit_trail_correlationId" ON "audit_trail" ("correlationId");
CREATE INDEX IF NOT EXISTS "idx_audit_trail_episodeId" ON "audit_trail" ("episodeId");
CREATE INDEX IF NOT EXISTS "idx_audit_trail_createdAt" ON "audit_trail" ("createdAt");

COMMIT;
PRAGMA foreign_keys = ON;