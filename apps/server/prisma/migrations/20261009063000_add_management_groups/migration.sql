-- Append local grouping metadata. Never rebuild old tables or cached notes.
CREATE TABLE "management_groups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL CHECK ("platform" IN ('wechat', 'xiaohongshu'))
);
ALTER TABLE "feeds" ADD COLUMN "group_id" TEXT REFERENCES "management_groups" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "xhs_creators" ADD COLUMN "group_id" TEXT REFERENCES "management_groups" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "management_groups_platform_idx" ON "management_groups"("platform");
CREATE INDEX "feeds_group_id_idx" ON "feeds"("group_id");
CREATE INDEX "xhs_creators_group_id_idx" ON "xhs_creators"("group_id");
