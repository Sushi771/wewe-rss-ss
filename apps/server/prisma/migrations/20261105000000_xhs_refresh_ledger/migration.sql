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
