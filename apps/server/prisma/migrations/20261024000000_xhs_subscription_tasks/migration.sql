CREATE TABLE "xhs_subscription_tasks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "creator_id" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "document" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL
);
CREATE INDEX "xhs_subscription_tasks_creator_id_state_idx" ON "xhs_subscription_tasks"("creator_id", "state");
