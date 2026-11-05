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
