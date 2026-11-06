-- Isolated proposal: explicit audit/grant storage, separate from old tasks.
-- Not applied to production. This is one new migration, not the six P0 migrations.
CREATE TABLE xhs_unbound_owner_reviews (
 id TEXT PRIMARY KEY NOT NULL,
 plan_digest TEXT UNIQUE NOT NULL,
 original_risk_json TEXT NOT NULL,
 original_outcome TEXT NOT NULL CHECK(original_outcome='unknown'),
 old_task_ids_json TEXT NOT NULL,
 old_job_ids_json TEXT NOT NULL,
 creator_bindings_json TEXT NOT NULL,
 budget_snapshot_json TEXT NOT NULL,
 scope_json TEXT NOT NULL,
 backup_sha256 TEXT NOT NULL,
 approved_at INTEGER NOT NULL
);
CREATE TRIGGER xhs_unbound_review_immutable_update BEFORE UPDATE ON xhs_unbound_owner_reviews
 BEGIN SELECT RAISE(ABORT,'UNBOUND_REVIEW_IMMUTABLE'); END;
CREATE TRIGGER xhs_unbound_review_immutable_delete BEFORE DELETE ON xhs_unbound_owner_reviews
 BEGIN SELECT RAISE(ABORT,'UNBOUND_REVIEW_IMMUTABLE'); END;
CREATE TABLE xhs_unbound_owner_requests (
 operation_id TEXT PRIMARY KEY NOT NULL,
 review_id TEXT NOT NULL REFERENCES xhs_unbound_owner_reviews(id),
 task_id TEXT NOT NULL,
 creator_id TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('profile','list','detail','media')),
 logical_target TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('started','response-received','not-sent','unknown')),
 listed_note_ids_json TEXT,
 UNIQUE(review_id,creator_id,phase,logical_target)
);
