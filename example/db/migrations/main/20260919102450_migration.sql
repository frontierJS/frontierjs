-- Litestone migration
-- Created:   2026-09-19T17:24:50.048Z
-- Changes:
--     + LoginChallenge  (new table)
--     + Flow  (new table)
--     + FlowVersion  (new table)
--     + FlowLayout  (new table)
--     + Run  (new table)
--     + RunStep  (new table)
--     + Wait  (new table)
--     + FlowCredential  (new table)
--     + KvEntry  (new table)
--     + StocktakeSheet  (new table)
--     + StocktakeCount  (new table)
--     ~ credential  [alter]
--         + col  totpLastStep INTEGER
--     ~ product  [rebuild]
--         ~ CHECK constraints changed (an enum's members, or an @check)
--     ~ pay_rate  [rebuild]
--         ~ col  effectiveFrom  default: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" → null
--     ~ user  [alter]
--         + col  isSystemAdmin INTEGER
--     ~ pay_window  [rebuild]
--         ~ col  effectiveFrom  default: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" → null
--     ~ subscription  [rebuild]
--         ~ col  currentPeriodStart  default: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" → null
--     ~ invoice  [rebuild]
--         + col  dueOn TEXT  ⚠ NOT NULL no default
--         - col  dueAt
--     ~ product  trigger product_fts_insert  (recreate)
--     ~ product  trigger product_fts_delete  (recreate)
--     ~ product  trigger product_fts_update  (recreate)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ DESTRUCTIVE — applying this deletes the values in these columns:
-- ║     invoice.dueAt (renamed to "dueOn"?)
-- ║
-- ║ To keep them, replace the rebuild below with a rename:
-- ║     ALTER TABLE "invoice" RENAME COLUMN "dueAt" TO "dueOn";
-- ╚══════════════════════════════════════════════════════════════════════════╝
PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

-- A login that is half done.
-- 
-- The password was right and there is a second factor, so the caller holds a
-- ticket and no session. It is its own model rather than a fifth
-- `VerificationPurpose` for the reason `OauthFlow` below is not one either:
-- nobody is proving control of an ADDRESS here — there is no `identifier` and
-- the address was settled a step ago — and `attempts` is a column the other
-- purposes have no use for. Three answers to what a column means is three
-- tables wearing one name (`FJS-D261`).
-- 
-- `attempts` is the whole of what stands between a six-digit code and a
-- million guesses, so it is counted on the row rather than in a limiter: a
-- process-local count is reset by a redeploy and is not shared by two
-- instances, and this is the one table where both of those are an authorization
-- bypass rather than a slow path.
CREATE TABLE IF NOT EXISTS "login_challenge" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "userId" TEXT NOT NULL,
  "value" TEXT NOT NULL UNIQUE,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_login_challenge_userId" ON "login_challenge" ("userId");
CREATE INDEX IF NOT EXISTS "idx_login_challenge_expiresAt" ON "login_challenge" ("expiresAt");

CREATE TABLE IF NOT EXISTS "flow" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "currentVersion" INTEGER,
  "ownerId" TEXT NOT NULL,
  "runsPerMinute" INTEGER,
  "maxWrites" INTEGER NOT NULL DEFAULT 1000,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ("status" IN ('draft', 'active', 'paused', 'archived'))
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_flow_status" ON "flow" ("status");
CREATE INDEX IF NOT EXISTS "idx_flow_ownerId" ON "flow" ("ownerId");

CREATE TABLE IF NOT EXISTS "flow_version" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "flowId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "definition" TEXT NOT NULL,
  "authorId" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE ("flowId", "version"),
  FOREIGN KEY ("flowId") REFERENCES "flow" ("id") ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS "flow_layout" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "flowId" TEXT NOT NULL UNIQUE,
  "layout" TEXT NOT NULL DEFAULT '{}',
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY ("flowId") REFERENCES "flow" ("id") ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS "run" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "flowVersionId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "trigger" TEXT,
  "context" TEXT,
  "currentStage" INTEGER NOT NULL DEFAULT 0,
  "actorId" TEXT,
  "startedAt" TEXT,
  "endedAt" TEXT,
  "error" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "heartbeatAt" TEXT,
  CHECK ("status" IN ('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  FOREIGN KEY ("flowVersionId") REFERENCES "flow_version" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_run_flowVersionId_startedAt" ON "run" ("flowVersionId", "startedAt");
CREATE INDEX IF NOT EXISTS "idx_run_status_createdAt" ON "run" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_run_status_heartbeatAt" ON "run" ("status", "heartbeatAt");

CREATE TABLE IF NOT EXISTS "run_step" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "runId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "fromCache" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TEXT,
  "durationMs" INTEGER,
  "output" TEXT,
  "error" TEXT,
  "logs" TEXT,
  CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  UNIQUE ("runId", "nodeId"),
  FOREIGN KEY ("runId") REFERENCES "run" ("id") ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS "wait" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "resumeKey" TEXT NOT NULL UNIQUE,
  "runId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "timeoutAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY ("runId") REFERENCES "run" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_wait_timeoutAt" ON "wait" ("timeoutAt");

CREATE TABLE IF NOT EXISTS "flow_credential" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "name" TEXT NOT NULL UNIQUE,
  "provider" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "auth" TEXT NOT NULL DEFAULT 'none',
  "header" TEXT,
  "encoding" TEXT DEFAULT 'json',
  "secret" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ("auth" IN ('none', 'bearer', 'api_key', 'hmac'))
) STRICT;

CREATE TABLE IF NOT EXISTS "kv_entry" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TEXT,
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE ("scope", "key")
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_kv_entry_expiresAt" ON "kv_entry" ("expiresAt");

-- A stocktake: somebody walks the stockroom and writes down what is on the
-- shelf, and the difference posts to the ledger when the sheet is closed.
-- 
-- ─── Why the key is a uuid and the ledger's is an Int ─────────────────────
-- 
-- A count names the sheet it belongs to. In a stockroom the sheet is made on
-- the same phone, in the same minute, with no signal — so at the moment the
-- first count is written there IS no server id, because nothing has been
-- inserted anywhere. `@default(uuid())` puts the key in the browser's hands:
-- `x-mint` crosses with the schema, sierra states the key on the create, and
-- the count that follows references a sheet the server has never heard of and
-- is still correct when both writes drain.
-- 
-- `InventoryMovement` keeps `Int @id` and is right to: nothing references a
-- movement, so nobody ever needs its key before the server has one. The
-- difference is the relation, which is exactly what the advisor's
-- `sync-reference-to-a-server-assigned-id` grades.
CREATE TABLE IF NOT EXISTS "stocktake_sheet" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "closedAt" TEXT,
  "note" TEXT,
  "startedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- One shelf, counted once.
-- 
-- Append-only in spirit and by gate: a second look at the same shelf is a
-- second count, not an edit of the first. That is what makes `server` an
-- honest collision policy here — two people counting one shelf produce two
-- rows, which is the truth about what happened.
CREATE TABLE IF NOT EXISTS "stocktake_count" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "sheetId" TEXT NOT NULL,
  "variantId" INTEGER NOT NULL,
  "counted" INTEGER NOT NULL,
  "expected" INTEGER NOT NULL,
  "damage" TEXT,
  "note" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY ("sheetId") REFERENCES "stocktake_sheet" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("variantId") REFERENCES "product_variant" ("id") ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_stocktake_count_sheetId" ON "stocktake_count" ("sheetId");

-- ─── modified tables ───────────────────────────────────────────────

-- "credential": add columns
ALTER TABLE "credential" ADD COLUMN "totpLastStep" INTEGER;

-- rebuild "product" — full table reconstruction required
CREATE TABLE "product__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "slug" TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "brand" TEXT NOT NULL,
  "fields" TEXT NOT NULL DEFAULT '{}',
  "active" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  CHECK ("brand" IN ('frontierjs', 'junction', 'litestone')),
  CHECK (NOT ("active") OR "description" IS NOT NULL)
) STRICT;

INSERT INTO "product__new" ("id", "name", "slug", "description", "brand", "fields", "active", "createdAt", "deletedAt", "version")
  SELECT "id", "name", "slug", "description", "brand", "fields", "active", "createdAt", "deletedAt", "version" FROM "product";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of product lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "product__new") = (SELECT count(*) FROM "product") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "product";
ALTER TABLE "product__new" RENAME TO "product";

-- recreate indexes for "product"
CREATE INDEX IF NOT EXISTS "idx_product_deletedAt" ON "product" ("deletedAt") WHERE "deletedAt" IS NULL;

-- rebuild "pay_rate" — full table reconstruction required
CREATE TABLE "pay_rate__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "fromAmount" INTEGER NOT NULL DEFAULT 0 CHECK ("fromAmount" BETWEEN -9007199254740991 AND 9007199254740991),
  "toAmount" INTEGER CHECK ("toAmount" BETWEEN -9007199254740991 AND 9007199254740991),
  "percent" INTEGER NOT NULL CHECK ("percent" BETWEEN -9007199254740991 AND 9007199254740991),
  "effectiveFrom" TEXT NOT NULL,
  "effectiveTo" TEXT,
  CHECK ("kind" IN ('incomeTax', 'employeePension', 'employerPension', 'employerNI')),
  CHECK (toAmount IS NULL OR fromAmount < toAmount),
  CHECK (effectiveTo IS NULL OR effectiveFrom < effectiveTo)
) STRICT;

INSERT INTO "pay_rate__new" ("id", "kind", "fromAmount", "toAmount", "percent", "effectiveFrom", "effectiveTo")
  SELECT "id", "kind", "fromAmount", "toAmount", "percent", "effectiveFrom", "effectiveTo" FROM "pay_rate";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of pay_rate lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "pay_rate__new") = (SELECT count(*) FROM "pay_rate") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "pay_rate";
ALTER TABLE "pay_rate__new" RENAME TO "pay_rate";

-- recreate indexes for "pay_rate"
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_pay_rate_kind_fromAmount" ON "pay_rate" ("kind", "fromAmount") WHERE "effectiveTo" IS NULL;

-- "user": add columns
ALTER TABLE "user" ADD COLUMN "isSystemAdmin" INTEGER NOT NULL DEFAULT 0;

-- rebuild "pay_window" — full table reconstruction required
CREATE TABLE "pay_window__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "employeeId" INTEGER NOT NULL,
  "basis" TEXT NOT NULL,
  "rate" INTEGER NOT NULL CHECK ("rate" BETWEEN -9007199254740991 AND 9007199254740991),
  "hoursPerWeek" INTEGER NOT NULL DEFAULT 40,
  "effectiveFrom" TEXT NOT NULL,
  "effectiveTo" TEXT,
  CHECK ("basis" IN ('salary', 'hourly')),
  CHECK (effectiveTo IS NULL OR effectiveFrom < effectiveTo),
  FOREIGN KEY ("employeeId") REFERENCES "employee" ("id") ON DELETE RESTRICT
) STRICT;

INSERT INTO "pay_window__new" ("id", "employeeId", "basis", "rate", "hoursPerWeek", "effectiveFrom", "effectiveTo")
  SELECT "id", "employeeId", "basis", "rate", "hoursPerWeek", "effectiveFrom", "effectiveTo" FROM "pay_window";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of pay_window lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "pay_window__new") = (SELECT count(*) FROM "pay_window") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "pay_window";
ALTER TABLE "pay_window__new" RENAME TO "pay_window";

-- recreate indexes for "pay_window"
CREATE INDEX IF NOT EXISTS "idx_pay_window_employeeId_effectiveFrom" ON "pay_window" ("employeeId", "effectiveFrom");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_pay_window_employeeId" ON "pay_window" ("employeeId") WHERE "effectiveTo" IS NULL;

-- rebuild "subscription" — full table reconstruction required
CREATE TABLE "subscription__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "reference" TEXT NOT NULL UNIQUE,
  "customerId" INTEGER NOT NULL,
  "planVersionId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'trialing',
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "currentPeriodStart" TEXT NOT NULL,
  "currentPeriodEnd" TEXT NOT NULL,
  "trialEndsAt" TEXT,
  "cancelledAt" TEXT,
  "cancelAtPeriodEnd" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "userId" TEXT,
  CHECK ("status" IN ('trialing', 'active', 'pastDue', 'cancelled')),
  FOREIGN KEY ("customerId") REFERENCES "customer" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("planVersionId") REFERENCES "plan_version" ("id") ON DELETE RESTRICT
) STRICT;

INSERT INTO "subscription__new" ("id", "reference", "customerId", "planVersionId", "status", "quantity", "currentPeriodStart", "currentPeriodEnd", "trialEndsAt", "cancelledAt", "cancelAtPeriodEnd", "createdAt", "userId")
  SELECT "id", "reference", "customerId", "planVersionId", "status", "quantity", "currentPeriodStart", "currentPeriodEnd", "trialEndsAt", "cancelledAt", "cancelAtPeriodEnd", "createdAt", "userId" FROM "subscription";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of subscription lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "subscription__new") = (SELECT count(*) FROM "subscription") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "subscription";
ALTER TABLE "subscription__new" RENAME TO "subscription";

-- recreate indexes for "subscription"
CREATE INDEX IF NOT EXISTS "idx_subscription_customerId" ON "subscription" ("customerId");
CREATE INDEX IF NOT EXISTS "idx_subscription_planVersionId" ON "subscription" ("planVersionId");

-- "invoice": the blocked rebuild, hand-written — `dueOn` is NOT NULL with no
-- default, so the copy below states the value for it (`FJS-604`).
--
-- `date("dueAt")` and not a bare RENAME, which is what the generator offers and
-- would be wrong here: `dueAt` held an INSTANT and `dueOn` holds a DAY
-- (`FJS-D288`), so renaming the column keeps `2026-09-16T23:30:00.000Z` in a
-- column every reader now compares as `YYYY-MM-DD`. `date()` truncates in UTC,
-- which is this app's own `timeZone` floor and the only calendar SQLite has.
-- rebuild "invoice" — full table reconstruction required
CREATE TABLE "invoice__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "customerId" INTEGER NOT NULL,
  "subscriptionId" INTEGER,
  "subtotal" INTEGER NOT NULL CHECK ("subtotal" BETWEEN -9007199254740991 AND 9007199254740991),
  "tax" INTEGER NOT NULL DEFAULT 0 CHECK ("tax" BETWEEN -9007199254740991 AND 9007199254740991),
  "total" INTEGER NOT NULL CHECK ("total" BETWEEN -9007199254740991 AND 9007199254740991),
  "periodStart" TEXT NOT NULL,
  "periodEnd" TEXT NOT NULL,
  "issuedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "dueOn" TEXT NOT NULL,
  "paidAt" TEXT,
  "userId" TEXT,
  CHECK ("status" IN ('draft', 'issued', 'paid', 'void')),
  CHECK (total = subtotal + tax),
  FOREIGN KEY ("customerId") REFERENCES "customer" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("subscriptionId") REFERENCES "subscription" ("id") ON DELETE RESTRICT
) STRICT;

INSERT INTO "invoice__new" ("id", "number", "status", "customerId", "subscriptionId", "subtotal", "tax", "total", "periodStart", "periodEnd", "issuedAt", "dueOn", "paidAt", "userId")
  SELECT "id", "number", "status", "customerId", "subscriptionId", "subtotal", "tax", "total", "periodStart", "periodEnd", "issuedAt", date("dueAt"), "paidAt", "userId" FROM "invoice";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of invoice lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "invoice__new") = (SELECT count(*) FROM "invoice") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "invoice";
ALTER TABLE "invoice__new" RENAME TO "invoice";

-- recreate indexes for "invoice" — a rebuild drops them with the old table, and
-- the generator writes this section only for the rebuilds it emits itself.
CREATE INDEX IF NOT EXISTS "idx_invoice_customerId" ON "invoice" ("customerId");
CREATE INDEX IF NOT EXISTS "idx_invoice_subscriptionId" ON "invoice" ("subscriptionId");

-- ─── the columns a diff cannot see ─────────────────────────────────
--
-- `DateTime` and `String` both emit TEXT, so the differ above reports NOTHING
-- for a column that changed from an instant to a day — only `invoice.dueOn`,
-- which was also renamed, and the three whose DEFAULT went with it. Every
-- column below is `String @date` in the schema and holds an ISO instant in any
-- database written before `FJS-D288`, which would then sort and compare against
-- `YYYY-MM-DD` as a longer string that is never equal to it.
--
-- `date()` is idempotent — `date('2026-09-14')` is `2026-09-14` — so this runs
-- safely over rows that are already days, and it is UTC, which is the app's own
-- `timeZone` floor.
--
-- Runs after every rebuild above, because a rebuild copies the raw value.

UPDATE "employee"     SET "startedOn"          = date("startedOn")          WHERE "startedOn"          IS NOT NULL;
UPDATE "employee"     SET "endedOn"            = date("endedOn")            WHERE "endedOn"            IS NOT NULL;
UPDATE "pay_window"   SET "effectiveFrom"      = date("effectiveFrom")      WHERE "effectiveFrom"      IS NOT NULL;
UPDATE "pay_window"   SET "effectiveTo"        = date("effectiveTo")        WHERE "effectiveTo"        IS NOT NULL;
UPDATE "pay_rate"     SET "effectiveFrom"      = date("effectiveFrom")      WHERE "effectiveFrom"      IS NOT NULL;
UPDATE "pay_rate"     SET "effectiveTo"        = date("effectiveTo")        WHERE "effectiveTo"        IS NOT NULL;
UPDATE "pay_run"      SET "periodStart"        = date("periodStart")        WHERE "periodStart"        IS NOT NULL;
UPDATE "pay_run"      SET "periodEnd"          = date("periodEnd")          WHERE "periodEnd"          IS NOT NULL;
UPDATE "pay_run"      SET "payDate"            = date("payDate")            WHERE "payDate"            IS NOT NULL;
UPDATE "payslip"      SET "periodStart"        = date("periodStart")        WHERE "periodStart"        IS NOT NULL;
UPDATE "payslip"      SET "periodEnd"          = date("periodEnd")          WHERE "periodEnd"          IS NOT NULL;
UPDATE "subscription" SET "currentPeriodStart" = date("currentPeriodStart") WHERE "currentPeriodStart" IS NOT NULL;
UPDATE "subscription" SET "currentPeriodEnd"   = date("currentPeriodEnd")   WHERE "currentPeriodEnd"   IS NOT NULL;
UPDATE "invoice"      SET "periodStart"        = date("periodStart")        WHERE "periodStart"        IS NOT NULL;
UPDATE "invoice"      SET "periodEnd"          = date("periodEnd")          WHERE "periodEnd"          IS NOT NULL;
UPDATE "invoice_line" SET "periodStart"        = date("periodStart")        WHERE "periodStart"        IS NOT NULL;
UPDATE "invoice_line" SET "periodEnd"          = date("periodEnd")          WHERE "periodEnd"          IS NOT NULL;

-- ─── generated triggers (drop + recreate) ──────────────────────────

DROP TRIGGER IF EXISTS "product_fts_insert";
CREATE TRIGGER "product_fts_insert" AFTER INSERT ON "product" BEGIN
  INSERT INTO "product_fts"(rowid, name, description) VALUES (new.id, new.name, new.description);
END;
DROP TRIGGER IF EXISTS "product_fts_delete";
CREATE TRIGGER "product_fts_delete" AFTER DELETE ON "product" BEGIN
  INSERT INTO "product_fts"("product_fts", rowid, name, description) VALUES ('delete', old.id, old.name, old.description);
END;
DROP TRIGGER IF EXISTS "product_fts_update";
CREATE TRIGGER "product_fts_update" AFTER UPDATE ON "product" BEGIN
  INSERT INTO "product_fts"("product_fts", rowid, name, description) VALUES ('delete', old.id, old.name, old.description);
  INSERT INTO "product_fts"(rowid, name, description) VALUES (new.id, new.name, new.description);
END;

COMMIT;
PRAGMA foreign_keys = ON;