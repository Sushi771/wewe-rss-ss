-- Synthetic fixture: ordinary copies of the two original legacy migrations.
-- Internal refresh claims and receipts without credentials or source payloads.
CREATE TABLE "xhs_refresh_jobs" (
  "creator_id" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "owner" TEXT NOT NULL,
  "started_at" INTEGER NOT NULL,
  "state" TEXT NOT NULL CHECK ("state" IN ('running', 'stopped', 'complete')),
  "outcome" TEXT,
  PRIMARY KEY ("creator_id", "generation"),
  FOREIGN KEY ("creator_id") REFERENCES "xhs_creators"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "xhs_refresh_one_unresolved" ON "xhs_refresh_jobs"("creator_id") WHERE "state" IN ('running', 'stopped');
CREATE UNIQUE INDEX "xhs_refresh_source_unresolved" ON "xhs_refresh_jobs"((1)) WHERE "state" IN ('running', 'stopped');
CREATE UNIQUE INDEX "xhs_refresh_operation_id" ON "xhs_refresh_jobs"("owner");
CREATE TABLE "xhs_refresh_failures" (
  "creator_id" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "note_id" TEXT NOT NULL,
  "code" TEXT NOT NULL CHECK ("code" = 'NOTE_BODY_OR_MEDIA_INVALID'),
  PRIMARY KEY ("creator_id", "generation", "note_id")
);

CREATE TABLE "xhs_refresh_batches" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "state" TEXT NOT NULL CHECK ("state" IN ('running','paused','stopped','complete')),
  "created_at" INTEGER NOT NULL
);
CREATE UNIQUE INDEX "xhs_refresh_batches_one_active" ON "xhs_refresh_batches"((1)) WHERE "state" IN ('running','paused');
CREATE TABLE "xhs_refresh_batch_items" (
  "batch_id" TEXT NOT NULL REFERENCES "xhs_refresh_batches"("id") ON DELETE RESTRICT,
  "position" INTEGER NOT NULL,
  "creator_id" TEXT NOT NULL REFERENCES "xhs_creators"("id") ON DELETE RESTRICT,
  "operation_id" TEXT,
  "state" TEXT NOT NULL CHECK ("state" IN ('queued','reserved','complete','partial','cancelled')),
  "outcome" TEXT,
  PRIMARY KEY ("batch_id", "position"),
  UNIQUE ("batch_id", "creator_id"),
  UNIQUE ("operation_id")
);
