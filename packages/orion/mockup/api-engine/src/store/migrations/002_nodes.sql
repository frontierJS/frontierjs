-- ─────────────────────────────────────────────
-- MIGRATION 002 — NODE SUPPORT TABLES
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS waitingExecutions (
  resumeKey    TEXT    NOT NULL PRIMARY KEY,
  executionId  TEXT    NOT NULL,
  flowId       TEXT    NOT NULL,
  nodeId       TEXT    NOT NULL,
  resumeCtxKey TEXT    NOT NULL,
  timeoutAt    INTEGER,
  createdAt    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS weExecutionId ON waitingExecutions (executionId);
CREATE INDEX IF NOT EXISTS weTimeoutAt   ON waitingExecutions (timeoutAt) WHERE timeoutAt IS NOT NULL;

CREATE TABLE IF NOT EXISTS kvStore (
  workspaceId TEXT    NOT NULL,
  scope       TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  expiresAt   INTEGER,
  updatedAt   INTEGER NOT NULL,
  PRIMARY KEY (workspaceId, scope, key)
);

CREATE INDEX IF NOT EXISTS kvWorkspaceScope ON kvStore (workspaceId, scope);
CREATE INDEX IF NOT EXISTS kvExpiresAt      ON kvStore (expiresAt) WHERE expiresAt IS NOT NULL;

INSERT OR IGNORE INTO schemaMigrations (version, appliedAt) VALUES (2, unixepoch() * 1000);
