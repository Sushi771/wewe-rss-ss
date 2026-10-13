-- Additive ledger only. Deploy under the existing full prewrite backup gate.
CREATE TABLE "cache_insert_batches" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "mp_id" TEXT NOT NULL,
  "article_manifest" TEXT NOT NULL,
  "snapshot_generation" TEXT NOT NULL,
  "guard_generation" TEXT NOT NULL,
  "backup_started_at_ms" BIGINT NOT NULL,
  "coverage_at_ms" BIGINT NOT NULL,
  "created_count" INTEGER NOT NULL,
  "committed_at_ms" BIGINT NOT NULL
);
