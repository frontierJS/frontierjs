-- ============================================================
-- Migration 001 — initial schema
-- All core Basecamp tables.
-- Timestamps are unix ms integers throughout.
-- ============================================================

-- ─── Account / Auth ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS account (
  id           TEXT    PRIMARY KEY,
  type         TEXT    NOT NULL CHECK(type IN ('individual','organization')) DEFAULT 'organization',
  status       TEXT    NOT NULL DEFAULT 'pending_verification',
  slug         TEXT    NOT NULL UNIQUE,
  display_name TEXT    NOT NULL,
  avatar_url   TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  deleted_at   INTEGER
);

CREATE TABLE IF NOT EXISTS user (
  id            TEXT    PRIMARY KEY,
  account_id    TEXT    NOT NULL REFERENCES account(id),
  type          TEXT    NOT NULL DEFAULT 'human' CHECK(type IN ('human','bot','ai')),
  status        TEXT    NOT NULL DEFAULT 'pending_verification',
  email         TEXT    UNIQUE,
  username      TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  avatar_url    TEXT,
  password_hash TEXT,
  totp_secret   TEXT,
  api_key_hash  TEXT,
  scopes        TEXT    NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  deleted_at    INTEGER,
  UNIQUE(account_id, username)
);

-- ─── Workspace ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspace (
  id         TEXT    PRIMARY KEY,
  account_id TEXT    NOT NULL REFERENCES account(id),
  name       TEXT    NOT NULL,
  slug       TEXT    NOT NULL UNIQUE,
  type       TEXT    NOT NULL DEFAULT 'personal',
  owner_id   TEXT    NOT NULL REFERENCES user(id),
  settings   TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS workspace_member (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT    NOT NULL REFERENCES workspace(id),
  user_id      TEXT    NOT NULL REFERENCES user(id),
  role         TEXT    NOT NULL DEFAULT 'viewer',
  invited_by   TEXT,
  invited_at   INTEGER,
  accepted_at  INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  UNIQUE(workspace_id, user_id)
);

-- ─── Credentials ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS credential (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT    NOT NULL REFERENCES workspace(id),
  name         TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  data         TEXT    NOT NULL DEFAULT '{}',
  is_verified  INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  deleted_at   INTEGER,
  UNIQUE(workspace_id, name)
);

-- ─── Fleet — Servers ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS server (
  id                 TEXT    PRIMARY KEY,
  workspace_id       TEXT    NOT NULL REFERENCES workspace(id),
  provider_id        TEXT    REFERENCES credential(id),
  name               TEXT    NOT NULL,
  slug               TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'pending',
  role               TEXT    NOT NULL DEFAULT 'general',
  provider_kind      TEXT    NOT NULL DEFAULT 'custom',
  register_method    TEXT    NOT NULL DEFAULT 'imported',
  region             TEXT    NOT NULL DEFAULT 'custom',
  ip_address         TEXT,
  ipv6_address       TEXT,
  ssh_port           INTEGER NOT NULL DEFAULT 22,
  ssh_user           TEXT    NOT NULL DEFAULT 'root',
  ssh_key_id         TEXT,
  plan               TEXT    NOT NULL DEFAULT '{}',
  actual_specs       TEXT,
  health             TEXT,
  docker_state       TEXT,
  agent_version      TEXT,
  agent_url          TEXT,
  provider_server_id TEXT,
  last_heartbeat_at  INTEGER,
  labels             TEXT    NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  deleted_at         INTEGER,
  UNIQUE(workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS server_event (
  id         TEXT    PRIMARY KEY,
  server_id  TEXT    NOT NULL REFERENCES server(id),
  kind       TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  metadata   TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

-- ─── Networking ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS network (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT    NOT NULL REFERENCES workspace(id),
  name         TEXT    NOT NULL,
  slug         TEXT    NOT NULL,
  type         TEXT    NOT NULL DEFAULT 'mesh',
  cidr         TEXT    NOT NULL DEFAULT '10.0.0.0/16',
  provider     TEXT    NOT NULL DEFAULT 'netbird',
  config       TEXT    NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  deleted_at   INTEGER,
  UNIQUE(workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS server_network (
  id         TEXT    PRIMARY KEY,
  server_id  TEXT    NOT NULL REFERENCES server(id),
  network_id TEXT    NOT NULL REFERENCES network(id),
  ip_address TEXT,
  joined_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  UNIQUE(server_id, network_id)
);

-- ─── Projects ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS project (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT    NOT NULL REFERENCES workspace(id),
  name         TEXT    NOT NULL,
  slug         TEXT    NOT NULL,
  description  TEXT,
  status       TEXT    NOT NULL DEFAULT 'active',
  tags         TEXT    NOT NULL DEFAULT '[]',
  metadata     TEXT    NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  deleted_at   INTEGER,
  UNIQUE(workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS environment (
  id           TEXT    PRIMARY KEY,
  project_id   TEXT    NOT NULL REFERENCES project(id),
  workspace_id TEXT    NOT NULL REFERENCES workspace(id),
  name         TEXT    NOT NULL,
  slug         TEXT    NOT NULL,
  tier         TEXT    NOT NULL DEFAULT 'development',
  is_protected INTEGER NOT NULL DEFAULT 0,
  variables    TEXT    NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  deleted_at   INTEGER,
  UNIQUE(project_id, slug)
);

-- ─── Apps  (table name: service) ─────────────────────────────

CREATE TABLE IF NOT EXISTS service (
  id             TEXT    PRIMARY KEY,
  workspace_id   TEXT    NOT NULL REFERENCES workspace(id),
  environment_id TEXT    NOT NULL REFERENCES environment(id),
  name           TEXT    NOT NULL,
  slug           TEXT    NOT NULL,
  type           TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'unknown',
  source         TEXT    NOT NULL DEFAULT '{}',
  config         TEXT    NOT NULL DEFAULT '{}',
  domain         TEXT,
  port           INTEGER,
  is_public      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  deleted_at     INTEGER,
  UNIQUE(environment_id, slug)
);

-- Join: App ↔ Server
CREATE TABLE IF NOT EXISTS service_server (
  id            TEXT    PRIMARY KEY,
  service_id    TEXT    NOT NULL REFERENCES service(id),
  server_id     TEXT    NOT NULL REFERENCES server(id),
  replica_index INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'unknown',
  container_id  TEXT,
  assigned_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  started_at    INTEGER,
  stopped_at    INTEGER,
  UNIQUE(service_id, server_id, replica_index)
);

-- Join: App ↔ Network
CREATE TABLE IF NOT EXISTS service_network (
  id         TEXT    PRIMARY KEY,
  service_id TEXT    NOT NULL REFERENCES service(id),
  network_id TEXT    NOT NULL REFERENCES network(id),
  ip_address TEXT,
  dns_name   TEXT,
  joined_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  UNIQUE(service_id, network_id)
);

-- ─── Deployments ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deployment (
  id                     TEXT    PRIMARY KEY,
  service_id             TEXT    NOT NULL REFERENCES service(id),
  workspace_id           TEXT    NOT NULL REFERENCES workspace(id),
  status                 TEXT    NOT NULL DEFAULT 'pending',
  trigger                TEXT    NOT NULL DEFAULT 'manual',
  from_image             TEXT,
  to_image               TEXT,
  commit_sha             TEXT,
  commit_message         TEXT,
  branch                 TEXT,
  author                 TEXT,
  built_image            TEXT,
  previous_deployment_id TEXT,
  config_snapshot        TEXT    NOT NULL DEFAULT '{}',
  triggered_by           TEXT    REFERENCES user(id),
  queued_at              INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  started_at             INTEGER,
  finished_at            INTEGER,
  duration_ms            INTEGER,
  created_at             INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at             INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

CREATE TABLE IF NOT EXISTS deployment_step (
  id            TEXT    PRIMARY KEY,
  deployment_id TEXT    NOT NULL REFERENCES deployment(id),
  name          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',
  output        TEXT,
  started_at    INTEGER,
  finished_at   INTEGER,
  duration_ms   INTEGER
);

-- ─── Jobs ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job (
  id              TEXT    PRIMARY KEY,
  workspace_id    TEXT    NOT NULL REFERENCES workspace(id),
  service_id      TEXT    REFERENCES service(id),
  name            TEXT    NOT NULL,
  kind            TEXT    NOT NULL DEFAULT 'one_shot',
  status          TEXT    NOT NULL DEFAULT 'pending',
  command         TEXT,
  cron_expression TEXT,
  next_run_at     INTEGER,
  trigger         TEXT    NOT NULL DEFAULT 'manual',
  trigger_config  TEXT    NOT NULL DEFAULT '{}',
  timeout_seconds INTEGER NOT NULL DEFAULT 300,
  retry_limit     INTEGER NOT NULL DEFAULT 3,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_run_at     INTEGER,
  last_run_status TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  deleted_at      INTEGER
);

CREATE TABLE IF NOT EXISTS job_run (
  id          TEXT    PRIMARY KEY,
  job_id      TEXT    NOT NULL REFERENCES job(id),
  status      TEXT    NOT NULL DEFAULT 'pending',
  trigger     TEXT    NOT NULL DEFAULT 'manual',
  started_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  finished_at INTEGER,
  duration_ms INTEGER,
  exit_code   INTEGER,
  error       TEXT,
  output      TEXT    NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

-- ─── Alerts ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alert_rule (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT    NOT NULL REFERENCES workspace(id),
  name         TEXT    NOT NULL,
  description  TEXT,
  severity     TEXT    NOT NULL DEFAULT 'medium',
  metric_name  TEXT    NOT NULL,
  condition    TEXT    NOT NULL DEFAULT '{}',
  channels     TEXT    NOT NULL DEFAULT '[]',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

CREATE TABLE IF NOT EXISTS alert_event (
  id               TEXT    PRIMARY KEY,
  rule_id          TEXT    NOT NULL REFERENCES alert_rule(id),
  status           TEXT    NOT NULL DEFAULT 'firing',
  severity         TEXT    NOT NULL,
  subject_type     TEXT    NOT NULL,
  subject_id       TEXT    NOT NULL,
  value_at_trigger REAL    NOT NULL,
  message          TEXT    NOT NULL,
  fired_at         INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  resolved_at      INTEGER,
  acknowledged_by  TEXT,
  acknowledged_at  INTEGER
);

-- ─── Audit ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_event (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT,
  actor_id     TEXT,
  actor_type   TEXT    NOT NULL DEFAULT 'user',
  action       TEXT    NOT NULL,
  subject_type TEXT    NOT NULL,
  subject_id   TEXT    NOT NULL,
  diff         TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

-- ─── Indexes ─────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_user_account        ON user(account_id);
CREATE INDEX IF NOT EXISTS idx_user_email          ON user(email);
CREATE INDEX IF NOT EXISTS idx_wsmember_ws         ON workspace_member(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS idx_server_workspace    ON server(workspace_id);
CREATE INDEX IF NOT EXISTS idx_server_status       ON server(status);
CREATE INDEX IF NOT EXISTS idx_server_heartbeat    ON server(last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_server_event        ON server_event(server_id);
CREATE INDEX IF NOT EXISTS idx_project_workspace   ON project(workspace_id);
CREATE INDEX IF NOT EXISTS idx_environment_project ON environment(project_id);
CREATE INDEX IF NOT EXISTS idx_service_env         ON service(environment_id);
CREATE INDEX IF NOT EXISTS idx_service_workspace   ON service(workspace_id);
CREATE INDEX IF NOT EXISTS idx_service_status      ON service(status);
CREATE INDEX IF NOT EXISTS idx_deployment_service  ON deployment(service_id);
CREATE INDEX IF NOT EXISTS idx_deployment_status   ON deployment(status);
CREATE INDEX IF NOT EXISTS idx_deployment_workspace ON deployment(workspace_id);
CREATE INDEX IF NOT EXISTS idx_job_workspace       ON job(workspace_id);
CREATE INDEX IF NOT EXISTS idx_job_next_run        ON job(next_run_at);
CREATE INDEX IF NOT EXISTS idx_job_run_job         ON job_run(job_id);
CREATE INDEX IF NOT EXISTS idx_audit_workspace     ON audit_event(workspace_id);
CREATE INDEX IF NOT EXISTS idx_audit_subject       ON audit_event(subject_type, subject_id);
