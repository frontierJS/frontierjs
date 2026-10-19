-- Litestone migration
-- Created:   2026-10-19T07:00:56.628Z
-- Changes:
--     ~ verification  [rebuild]
--         + col  secret TEXT
--         + col  registrant TEXT
--         ~ CHECK constraints changed (an enum's members, or an @check)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "verification" — full table reconstruction required
CREATE TABLE "verification__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "purpose" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL UNIQUE,
  "provider" TEXT,
  "subject" TEXT,
  "userId" TEXT,
  "secret" TEXT,
  "registrant" TEXT,
  "code" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("purpose" IN ('passwordReset', 'emailVerify', 'oauthLink', 'magicLink', 'emailChange', 'registration'))
) STRICT;

INSERT INTO "verification__new" ("id", "purpose", "identifier", "value", "provider", "subject", "userId", "code", "attempts", "expiresAt", "createdAt")
  SELECT "id", "purpose", "identifier", "value", "provider", "subject", "userId", "code", "attempts", "expiresAt", "createdAt" FROM "verification";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of verification lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "verification__new") = (SELECT count(*) FROM "verification") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "verification";
ALTER TABLE "verification__new" RENAME TO "verification";

-- recreate indexes for "verification"
CREATE INDEX IF NOT EXISTS "idx_verification_purpose_identifier" ON "verification" ("purpose", "identifier");
CREATE INDEX IF NOT EXISTS "idx_verification_expiresAt" ON "verification" ("expiresAt");

COMMIT;
PRAGMA foreign_keys = ON;
