-- Preserve the existing publish-time/id order while avoiding a global sort.
CREATE INDEX "articles_publish_time_id_idx" ON "articles"("publish_time", "id");
