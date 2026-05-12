CREATE TABLE IF NOT EXISTS library (
  workshop_id           TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  author                TEXT NOT NULL DEFAULT '',
  preview_url           TEXT NOT NULL DEFAULT '',
  source_path           TEXT NOT NULL,
  source_resolution     TEXT NOT NULL DEFAULT '',
  source_codec          TEXT NOT NULL DEFAULT '',
  source_size           INTEGER NOT NULL DEFAULT 0,
  downloaded_at         INTEGER NOT NULL,

  transcode_status      TEXT NOT NULL DEFAULT 'skipped',
  transcode_progress    INTEGER NOT NULL DEFAULT 0,
  transcode_error       TEXT,
  transcoded_path       TEXT,
  transcoded_resolution TEXT,
  transcoded_codec      TEXT,
  transcoded_size       INTEGER,

  display_mode          TEXT NOT NULL DEFAULT 'fill',
  last_played_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_library_downloaded_at ON library(downloaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_library_transcode_status ON library(transcode_status);

CREATE TABLE IF NOT EXISTS transcode_jobs (
  id              TEXT PRIMARY KEY,
  workshop_id     TEXT NOT NULL REFERENCES library(workshop_id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending',
  worker          TEXT,
  claimed_at      INTEGER,
  last_heartbeat  INTEGER,
  progress        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_transcode_jobs_status ON transcode_jobs(status);
CREATE INDEX IF NOT EXISTS idx_transcode_jobs_workshop_id ON transcode_jobs(workshop_id);
