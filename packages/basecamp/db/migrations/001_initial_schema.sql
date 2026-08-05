-- ============================================================
-- Basecamp — initial schema
--
-- GENERATED FROM db/schema.lite. Do not edit by hand.
-- Regenerate:  bun db/generate.js
--
-- The previous hand-written SQL is kept at db/legacy-sql/ for reference.
-- It used snake_case columns and INTEGER epoch-ms timestamps; Litestone
-- emits camelCase columns and ISO-8601 TEXT, so the two are NOT compatible.
-- ============================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_verification_identifier" ON "verification" ("identifier");

CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "type" TEXT NOT NULL DEFAULT 'organization',
  "status" TEXT NOT NULL DEFAULT 'pending_verification',
  "slug" TEXT NOT NULL UNIQUE,
  "displayName" TEXT NOT NULL,
  "avatarUrl" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("type" IN ('individual', 'organization'))
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_account_deletedAt" ON "account" ("deletedAt") WHERE "deletedAt" IS NULL;
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "account_updatedAt"
AFTER UPDATE ON "account"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "account" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "network" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'mesh',
  "cidr" TEXT NOT NULL DEFAULT '10.0.0.0/16',
  "provider" TEXT NOT NULL DEFAULT 'netbird',
  "config" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  UNIQUE ("workspaceId", "slug")
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_network_deletedAt" ON "network" ("deletedAt") WHERE "deletedAt" IS NULL;
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "network_updatedAt"
AFTER UPDATE ON "network"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "network" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "email" TEXT NOT NULL UNIQUE,
  "name" TEXT,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "role" TEXT NOT NULL DEFAULT 'user',
  "accountId" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'human',
  "status" TEXT NOT NULL DEFAULT 'pending_verification',
  "username" TEXT,
  "displayName" TEXT,
  "avatarUrl" TEXT,
  "scopes" TEXT NOT NULL DEFAULT '[]',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("kind" IN ('human', 'bot', 'ai')),
  UNIQUE ("accountId", "username"),
  FOREIGN KEY ("accountId") REFERENCES "account" ("id")
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_user_accountId" ON "user" ("accountId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_user_email" ON "user" ("email") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_user_deletedAt" ON "user" ("deletedAt") WHERE "deletedAt" IS NULL;
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "user_updatedAt"
AFTER UPDATE ON "user"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "user" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "workspace" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "accountId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "type" TEXT NOT NULL DEFAULT 'team',
  "ownerId" TEXT NOT NULL,
  "settings" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("type" IN ('personal', 'team', 'enterprise')),
  FOREIGN KEY ("accountId") REFERENCES "account" ("id")
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_workspace_accountId" ON "workspace" ("accountId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_workspace_deletedAt" ON "workspace" ("deletedAt") WHERE "deletedAt" IS NULL;
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "workspace_updatedAt"
AFTER UPDATE ON "workspace"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "workspace" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "credential" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "label" TEXT,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "tokenExpiresAt" TEXT,
  "scope" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_credential_userId_type" ON "credential" ("userId", "type");
CREATE INDEX IF NOT EXISTS "idx_credential_type_value" ON "credential" ("type", "value");

CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "userId" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "expiresAt" TEXT NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_session_userId" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS "idx_session_expiresAt" ON "session" ("expiresAt");

CREATE TABLE IF NOT EXISTS "workspace_member" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'viewer',
  "invitedBy" TEXT,
  "invitedAt" TEXT,
  "acceptedAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("role" IN ('viewer', 'billing', 'developer', 'admin', 'owner')),
  UNIQUE ("workspaceId", "userId"),
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_workspace_member_workspaceId_userId" ON "workspace_member" ("workspaceId", "userId");
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "workspace_member_updatedAt"
AFTER UPDATE ON "workspace_member"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "workspace_member" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "secret" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'generic',
  "data" TEXT NOT NULL DEFAULT '{}',
  "isVerified" INTEGER NOT NULL DEFAULT 0,
  "createdBy" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("kind" IN ('ssh_key', 'provider_key', 'registry_auth', 'tls_cert', 'generic')),
  UNIQUE ("workspaceId", "name"),
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_secret_deletedAt" ON "secret" ("deletedAt") WHERE "deletedAt" IS NULL;
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "secret_updatedAt"
AFTER UPDATE ON "secret"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "secret" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "server" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "role" TEXT NOT NULL DEFAULT 'general',
  "providerKind" TEXT NOT NULL DEFAULT 'custom',
  "providerId" TEXT,
  "providerServerId" TEXT,
  "registerMethod" TEXT NOT NULL DEFAULT 'imported',
  "region" TEXT NOT NULL DEFAULT 'custom',
  "ipAddress" TEXT,
  "ipv6Address" TEXT,
  "sshPort" INTEGER NOT NULL DEFAULT 22,
  "sshUser" TEXT NOT NULL DEFAULT 'root',
  "sshKeyId" TEXT,
  "agentVersion" TEXT,
  "agentUrl" TEXT,
  "lastHeartbeatAt" TEXT,
  "plan" TEXT NOT NULL DEFAULT '{}',
  "actualSpecs" TEXT,
  "health" TEXT,
  "dockerState" TEXT,
  "labels" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("status" IN ('pending', 'provisioning', 'installing', 'ready', 'online', 'unreachable', 'draining', 'stopped', 'destroyed')),
  CHECK ("role" IN ('general', 'build', 'database', 'gateway', 'worker')),
  UNIQUE ("workspaceId", "slug"),
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_server_workspaceId" ON "server" ("workspaceId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_server_status" ON "server" ("status") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_server_lastHeartbeatAt" ON "server" ("lastHeartbeatAt") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_server_deletedAt" ON "server" ("deletedAt") WHERE "deletedAt" IS NULL;
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "server_updatedAt"
AFTER UPDATE ON "server"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "server" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "project" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "tags" TEXT NOT NULL DEFAULT '[]',
  "metadata" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  UNIQUE ("workspaceId", "slug"),
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_project_workspaceId" ON "project" ("workspaceId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_project_deletedAt" ON "project" ("deletedAt") WHERE "deletedAt" IS NULL;
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "project_updatedAt"
AFTER UPDATE ON "project"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "project" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "alert_rule" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "severity" TEXT NOT NULL DEFAULT 'medium',
  "metricName" TEXT NOT NULL,
  "condition" TEXT NOT NULL DEFAULT '{}',
  "channels" TEXT NOT NULL DEFAULT '[]',
  "isActive" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_alert_rule_workspaceId" ON "alert_rule" ("workspaceId");
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "alert_rule_updatedAt"
AFTER UPDATE ON "alert_rule"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "alert_rule" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "audit_event" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT,
  "actorId" TEXT,
  "actorType" TEXT NOT NULL DEFAULT 'user',
  "action" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "diff" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_audit_event_workspaceId" ON "audit_event" ("workspaceId");
CREATE INDEX IF NOT EXISTS "idx_audit_event_subjectType_subjectId" ON "audit_event" ("subjectType", "subjectId");

CREATE TABLE IF NOT EXISTS "server_event" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "serverId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY ("serverId") REFERENCES "server" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_server_event_serverId" ON "server_event" ("serverId");

CREATE TABLE IF NOT EXISTS "server_network" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "serverId" TEXT NOT NULL,
  "networkId" TEXT NOT NULL,
  "ipAddress" TEXT,
  "joinedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE ("serverId", "networkId"),
  FOREIGN KEY ("serverId") REFERENCES "server" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("networkId") REFERENCES "network" ("id") ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS "environment" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "projectId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "tier" TEXT NOT NULL DEFAULT 'development',
  "isProtected" INTEGER NOT NULL DEFAULT 0,
  "variables" TEXT NOT NULL DEFAULT '[]',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("tier" IN ('development', 'test', 'preview', 'staging', 'production')),
  UNIQUE ("projectId", "slug"),
  FOREIGN KEY ("projectId") REFERENCES "project" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_environment_projectId" ON "environment" ("projectId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_environment_deletedAt" ON "environment" ("deletedAt") WHERE "deletedAt" IS NULL;
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "environment_updatedAt"
AFTER UPDATE ON "environment"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "environment" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "alert_event" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "ruleId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'firing',
  "severity" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "valueAtTrigger" REAL NOT NULL DEFAULT 0,
  "message" TEXT NOT NULL,
  "firedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "resolvedAt" TEXT,
  "acknowledgedBy" TEXT,
  "acknowledgedAt" TEXT,
  FOREIGN KEY ("ruleId") REFERENCES "alert_rule" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_alert_event_ruleId" ON "alert_event" ("ruleId");
CREATE INDEX IF NOT EXISTS "idx_alert_event_status" ON "alert_event" ("status");

CREATE TABLE IF NOT EXISTS "app" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'container',
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "source" TEXT NOT NULL DEFAULT '{}',
  "config" TEXT NOT NULL DEFAULT '{}',
  "domain" TEXT,
  "port" INTEGER,
  "isPublic" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("type" IN ('container', 'worker', 'database', 'daemon', 'cron', 'static', 'function')),
  CHECK ("status" IN ('unknown', 'stopped', 'starting', 'running', 'stopping', 'deploying', 'error')),
  UNIQUE ("environmentId", "slug"),
  FOREIGN KEY ("environmentId") REFERENCES "environment" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_app_workspaceId" ON "app" ("workspaceId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_app_environmentId" ON "app" ("environmentId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_app_status" ON "app" ("status") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_app_deletedAt" ON "app" ("deletedAt") WHERE "deletedAt" IS NULL;
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "app_updatedAt"
AFTER UPDATE ON "app"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "app" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "app_server" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "appId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "replicaIndex" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "containerId" TEXT,
  "assignedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "startedAt" TEXT,
  "stoppedAt" TEXT,
  UNIQUE ("appId", "serverId", "replicaIndex"),
  FOREIGN KEY ("appId") REFERENCES "app" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("serverId") REFERENCES "server" ("id") ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS "app_network" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "appId" TEXT NOT NULL,
  "networkId" TEXT NOT NULL,
  "ipAddress" TEXT,
  "dnsName" TEXT,
  "joinedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE ("appId", "networkId"),
  FOREIGN KEY ("appId") REFERENCES "app" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("networkId") REFERENCES "network" ("id") ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS "deployment" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "appId" TEXT NOT NULL,
  "environmentId" TEXT,
  "workspaceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "fromImage" TEXT,
  "toImage" TEXT,
  "commitSha" TEXT,
  "commitMessage" TEXT,
  "branch" TEXT,
  "author" TEXT,
  "builtImage" TEXT,
  "previousDeploymentId" TEXT,
  "configSnapshot" TEXT NOT NULL DEFAULT '{}',
  "triggeredBy" TEXT,
  "queuedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "startedAt" TEXT,
  "finishedAt" TEXT,
  "durationMs" INTEGER,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("status" IN ('pending', 'building', 'pushing', 'deploying', 'success', 'failed', 'cancelled', 'rolled_back')),
  FOREIGN KEY ("appId") REFERENCES "app" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("environmentId") REFERENCES "environment" ("id"),
  FOREIGN KEY ("triggeredBy") REFERENCES "user" ("id")
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_deployment_appId" ON "deployment" ("appId");
CREATE INDEX IF NOT EXISTS "idx_deployment_workspaceId" ON "deployment" ("workspaceId");
CREATE INDEX IF NOT EXISTS "idx_deployment_status" ON "deployment" ("status");
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "deployment_updatedAt"
AFTER UPDATE ON "deployment"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "deployment" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "job" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "appId" TEXT,
  "environmentId" TEXT,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'one_shot',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "command" TEXT,
  "cronExpression" TEXT,
  "nextRunAt" TEXT,
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "triggerConfig" TEXT NOT NULL DEFAULT '{}',
  "timeoutSeconds" INTEGER NOT NULL DEFAULT 300,
  "retryLimit" INTEGER NOT NULL DEFAULT 3,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "lastRunAt" TEXT,
  "lastRunStatus" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("kind" IN ('one_shot', 'scheduled', 'triggered', 'workflow')),
  CHECK ("status" IN ('pending', 'running', 'failed', 'cancelled')),
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("appId") REFERENCES "app" ("id"),
  FOREIGN KEY ("environmentId") REFERENCES "environment" ("id")
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_job_workspaceId" ON "job" ("workspaceId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_job_nextRunAt" ON "job" ("nextRunAt") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_job_deletedAt" ON "job" ("deletedAt") WHERE "deletedAt" IS NULL;
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "job_updatedAt"
AFTER UPDATE ON "job"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "job" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS "deployment_step" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "deploymentId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "output" TEXT,
  "startedAt" TEXT,
  "finishedAt" TEXT,
  "durationMs" INTEGER,
  CHECK ("status" IN ('pending', 'running', 'success', 'failed', 'skipped')),
  FOREIGN KEY ("deploymentId") REFERENCES "deployment" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_deployment_step_deploymentId" ON "deployment_step" ("deploymentId");

CREATE TABLE IF NOT EXISTS "job_run" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "jobId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "startedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "finishedAt" TEXT,
  "durationMs" INTEGER,
  "exitCode" INTEGER,
  "error" TEXT,
  "output" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("status" IN ('pending', 'running', 'success', 'failed', 'timeout')),
  FOREIGN KEY ("jobId") REFERENCES "job" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_job_run_jobId" ON "job_run" ("jobId");