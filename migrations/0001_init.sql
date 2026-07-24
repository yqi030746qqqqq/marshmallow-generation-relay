CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  request_hash TEXT NOT NULL,
  request_envelope TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'
  )),
  result_envelope TEXT,
  error_json TEXT,
  task_type TEXT,
  task_key TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  scheduled_for INTEGER,
  applied_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  request_expires_at INTEGER NOT NULL,
  result_ttl_seconds INTEGER NOT NULL,
  result_expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_status_created
  ON jobs(status, created_at);

CREATE INDEX IF NOT EXISTS jobs_result_expiry
  ON jobs(result_expires_at);

CREATE INDEX IF NOT EXISTS jobs_task_revision
  ON jobs(task_key, revision);

CREATE TABLE IF NOT EXISTS schedules (
  task_key TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  revision INTEGER NOT NULL,
  run_at INTEGER NOT NULL,
  interval_ms INTEGER,
  request_hash TEXT NOT NULL,
  request_envelope TEXT NOT NULL,
  request_ttl_seconds INTEGER NOT NULL,
  result_ttl_seconds INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_job_id TEXT,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS schedules_due
  ON schedules(enabled, run_at);
