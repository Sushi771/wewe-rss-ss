-- Independent forward candidate for exact canonical union32 only. Not a replacement for historical SQL.

-- Requires all writers quiescent, verified backup/identity and strict schema/extension gate in apply-forward.cjs.

-- Unknown indexes/triggers/views or incoming FK changes must be reviewed; do not apply standalone to an arbitrary database.

PRAGMA foreign_keys=OFF;

BEGIN IMMEDIATE;

CREATE TABLE "__unified33_xhs_subscription_tasks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "creator_id" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "document" TEXT NOT NULL,
  "updated_at" BIGINT NOT NULL
);

INSERT INTO "__unified33_xhs_subscription_tasks" ("id", "creator_id", "state", "document", "updated_at") SELECT "id", "creator_id", "state", "document", "updated_at" FROM "xhs_subscription_tasks";

DROP TABLE "xhs_subscription_tasks";

ALTER TABLE "__unified33_xhs_subscription_tasks" RENAME TO "xhs_subscription_tasks";

CREATE INDEX "xhs_subscription_tasks_creator_id_state_idx" ON "xhs_subscription_tasks"("creator_id", "state");

CREATE TABLE "__unified33_xhs_refresh_jobs" (
  "creator_id" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "owner" TEXT NOT NULL,
  "started_at" BIGINT NOT NULL,
  "state" TEXT NOT NULL CHECK ("state" IN ('running', 'stopped', 'complete')),
  "outcome" TEXT,
  PRIMARY KEY ("creator_id", "generation"),
  FOREIGN KEY ("creator_id") REFERENCES "xhs_creators"("id") ON DELETE RESTRICT
);

INSERT INTO "__unified33_xhs_refresh_jobs" ("creator_id", "generation", "owner", "started_at", "state", "outcome") SELECT "creator_id", "generation", "owner", "started_at", "state", "outcome" FROM "xhs_refresh_jobs";

DROP TABLE "xhs_refresh_jobs";

ALTER TABLE "__unified33_xhs_refresh_jobs" RENAME TO "xhs_refresh_jobs";

CREATE UNIQUE INDEX "xhs_refresh_one_unresolved" ON "xhs_refresh_jobs"("creator_id") WHERE "state" IN ('running', 'stopped');

CREATE UNIQUE INDEX "xhs_refresh_operation_id" ON "xhs_refresh_jobs"("owner");

CREATE UNIQUE INDEX "xhs_refresh_source_unresolved" ON "xhs_refresh_jobs"((1)) WHERE "state" IN ('running', 'stopped');

CREATE TABLE "__unified33_xhs_refresh_batches" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "state" TEXT NOT NULL CHECK ("state" IN ('running','paused','stopped','complete')),
  "created_at" BIGINT NOT NULL
);

INSERT INTO "__unified33_xhs_refresh_batches" ("id", "state", "created_at") SELECT "id", "state", "created_at" FROM "xhs_refresh_batches";

DROP TABLE "xhs_refresh_batches";

ALTER TABLE "__unified33_xhs_refresh_batches" RENAME TO "xhs_refresh_batches";

CREATE UNIQUE INDEX "xhs_refresh_batches_one_active" ON "xhs_refresh_batches"((1)) WHERE "state" IN ('running','paused');

COMMIT;

PRAGMA foreign_keys=ON;
