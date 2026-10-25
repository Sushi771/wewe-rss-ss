-- Explicit offline-tested admission state; no default live request allowance.
CREATE TABLE xhs_request_budgets (
 id TEXT PRIMARY KEY NOT NULL,
 request_limit INTEGER NOT NULL CHECK(request_limit >= 0),
 used INTEGER NOT NULL DEFAULT 0 CHECK(used >= 0),
 next_at BIGINT NOT NULL DEFAULT 0,
 interval_ms INTEGER NOT NULL CHECK(interval_ms >= 0)
);
CREATE TABLE xhs_whole_creator_jobs (
 id TEXT PRIMARY KEY NOT NULL,
 creator_id TEXT NOT NULL,
 state TEXT NOT NULL,
 document TEXT NOT NULL,
 updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX xhs_whole_creator_one_active ON xhs_whole_creator_jobs(creator_id)
 WHERE state IN ('queued','running');
