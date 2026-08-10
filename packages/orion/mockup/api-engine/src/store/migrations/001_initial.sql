-- ─────────────────────────────────────────────
-- ORION INITIAL SCHEMA — Migration 001
-- ─────────────────────────────────────────────

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS flows (
  id          TEXT    NOT NULL,
  version     TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  definition  TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active',
  createdBy   TEXT    NOT NULL,
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE INDEX IF NOT EXISTS flowsStatus ON flows (status);
CREATE INDEX IF NOT EXISTS flowsId     ON flows (id, updatedAt DESC);

CREATE TABLE IF NOT EXISTS flowLayouts (
  flowId    TEXT    NOT NULL,
  layout    TEXT    NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (flowId)
);

CREATE TABLE IF NOT EXISTS executionRecords (
  executionId  TEXT    NOT NULL PRIMARY KEY,
  flowId       TEXT    NOT NULL,
  version      TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  trigger      TEXT    NOT NULL,
  startedAt    INTEGER NOT NULL,
  endedAt      INTEGER NOT NULL,
  durationMs   INTEGER NOT NULL,
  nodeStates   TEXT    NOT NULL,
  nodeTimings  TEXT    NOT NULL,
  slowNodes    TEXT    NOT NULL,
  error        TEXT,
  finalContext TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS erFlowId    ON executionRecords (flowId, startedAt DESC);
CREATE INDEX IF NOT EXISTS erStatus    ON executionRecords (status);
CREATE INDEX IF NOT EXISTS erStartedAt ON executionRecords (startedAt);

CREATE TABLE IF NOT EXISTS executionContexts (
  executionId TEXT    NOT NULL PRIMARY KEY,
  context     TEXT    NOT NULL,
  updatedAt   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id            TEXT    NOT NULL PRIMARY KEY,
  workspaceId   TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  provider      TEXT    NOT NULL,
  encryptedData TEXT    NOT NULL,
  iv            TEXT    NOT NULL,
  authTag       TEXT    NOT NULL,
  createdAt     INTEGER NOT NULL,
  updatedAt     INTEGER NOT NULL,
  UNIQUE (workspaceId, name)
);

CREATE INDEX IF NOT EXISTS credsWorkspace ON credentials (workspaceId);

CREATE TABLE IF NOT EXISTS schemaMigrations (
  version   INTEGER NOT NULL PRIMARY KEY,
  appliedAt INTEGER NOT NULL
);

INSERT OR IGNORE INTO schemaMigrations (version, appliedAt) VALUES (1, unixepoch() * 1000);
