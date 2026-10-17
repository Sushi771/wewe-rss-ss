-- Additive only: no existing Account, Feed or Article columns/rows are touched.
CREATE TABLE "xhs_creators" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profile_url" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "external_author_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_status" TEXT NOT NULL DEFAULT 'pending',
    "last_checked_at" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "xhs_creators_profile_url_key" ON "xhs_creators"("profile_url");
CREATE UNIQUE INDEX "xhs_creators_external_author_id_key" ON "xhs_creators"("external_author_id");
CREATE TABLE "xhs_notes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "creator_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "publish_time" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "content_html" TEXT,
    CONSTRAINT "xhs_notes_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "xhs_creators"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "xhs_notes_creator_id_publish_time_idx" ON "xhs_notes"("creator_id", "publish_time");
