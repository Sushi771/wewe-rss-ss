-- Preserve existing failure evidence while extending the allowed body codes.
BEGIN IMMEDIATE;
CREATE TABLE "article_failure_events_new" (
  "attempt_id" TEXT NOT NULL,
  "feed_id" TEXT NOT NULL,
  "article_id" TEXT NOT NULL,
  "stage" TEXT NOT NULL CHECK ("stage" IN ('body', 'media')),
  "code" TEXT NOT NULL CHECK ("code" IN ('BODY_PARSE_FAILED', 'BODY_TOO_LARGE', 'BODY_MISSING', 'MEDIA_PENDING')),
  "observed_at" BIGINT NOT NULL,
  PRIMARY KEY ("attempt_id", "article_id", "stage")
);
INSERT INTO "article_failure_events_new" ("attempt_id", "feed_id", "article_id", "stage", "code", "observed_at")
SELECT "attempt_id", "feed_id", "article_id", "stage", "code", "observed_at" FROM "article_failure_events";
DROP TABLE "article_failure_events";
ALTER TABLE "article_failure_events_new" RENAME TO "article_failure_events";
CREATE INDEX "article_failure_events_feed_id_article_id_idx" ON "article_failure_events"("feed_id", "article_id");
COMMIT;
