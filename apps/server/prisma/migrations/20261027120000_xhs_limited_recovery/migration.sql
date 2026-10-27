-- One bounded user-directed recovery attempt. The original risk row remains intact.
CREATE TABLE xhs_limited_recovery (
  id TEXT PRIMARY KEY NOT NULL CHECK(id = 'single-round'),
  note_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('armed', 'started', 'finished', 'failed', 'unknown')),
  code TEXT,
  prior_code TEXT NOT NULL DEFAULT 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
  media_manifest TEXT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
