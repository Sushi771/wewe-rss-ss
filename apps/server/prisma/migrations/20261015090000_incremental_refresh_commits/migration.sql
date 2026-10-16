-- Ordinary refresh commits are independent of timed recovery snapshots.
CREATE TABLE "cache_refresh_commits" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mp_id" TEXT NOT NULL,
    "result_json" TEXT NOT NULL,
    "committed_at_ms" BIGINT NOT NULL
);
CREATE INDEX "cache_refresh_commits_mp_id_idx" ON "cache_refresh_commits"("mp_id");

-- An attempted remote update is never automatically replayed after an unknown result.
CREATE TABLE "refresh_submission_claims" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mp_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reserved_at" INTEGER NOT NULL,
    "previous_at" INTEGER NOT NULL,
    "updated_at_ms" BIGINT NOT NULL
);
