ALTER TABLE "feeds" ADD COLUMN "local_directory" TEXT;
ALTER TABLE "articles" ADD COLUMN "source_url" TEXT;
ALTER TABLE "articles" ADD COLUMN "content_html" TEXT;
ALTER TABLE "articles" ADD COLUMN "metrics" TEXT;
ALTER TABLE "articles" ADD COLUMN "read_count" INTEGER;
ALTER TABLE "articles" ADD COLUMN "like_count" INTEGER;
CREATE UNIQUE INDEX "articles_source_url_key" ON "articles"("source_url");
-- Cover polling never proved that historical articles had all been fetched.
UPDATE "feeds" SET "has_history" = -1 WHERE "has_history" = 0;
