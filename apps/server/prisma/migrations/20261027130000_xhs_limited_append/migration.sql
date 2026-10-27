-- A single explicit follow-up linked to the original uncertain attempt.
CREATE TABLE xhs_limited_recovery_append (
  id TEXT PRIMARY KEY NOT NULL CHECK(id = 'single-round'),
  note_id TEXT NOT NULL, author_id TEXT NOT NULL, owner TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('armed','started','finished','failed','unknown')),
  code TEXT, media_manifest TEXT, expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
