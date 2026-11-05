-- Failure evidence is additive and does not change existing article identities.
CREATE TABLE "article_failure_events" (
  "attempt_id" TEXT NOT NULL,
  "feed_id" TEXT NOT NULL,
  "article_id" TEXT NOT NULL,
  "stage" TEXT NOT NULL CHECK ("stage" IN ('body', 'media')),
  "code" TEXT NOT NULL CHECK ("code" IN ('BODY_PARSE_FAILED', 'BODY_TOO_LARGE', 'MEDIA_PENDING')),
  "observed_at" BIGINT NOT NULL,
  PRIMARY KEY ("attempt_id", "article_id", "stage")
);
CREATE INDEX "article_failure_events_feed_id_article_id_idx" ON "article_failure_events"("feed_id", "article_id");
