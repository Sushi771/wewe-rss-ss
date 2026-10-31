-- Additive XHS-only projections. No rewrite of feeds/articles or user files.
CREATE TABLE "xhs_metric_snapshots" (
  "owner_kind" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "document" TEXT NOT NULL,
  PRIMARY KEY ("owner_kind", "owner_id")
);
CREATE TABLE "xhs_saved_comments" (
  "note_id" TEXT NOT NULL,
  "comment_id" TEXT NOT NULL,
  "root_id" TEXT,
  "parent_id" TEXT,
  "document" TEXT NOT NULL,
  PRIMARY KEY ("note_id", "comment_id"),
  FOREIGN KEY ("note_id") REFERENCES "xhs_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "xhs_saved_comments_root" ON "xhs_saved_comments"("note_id", "root_id", "comment_id");
CREATE TABLE "xhs_comment_windows" (
  "note_id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "document" TEXT NOT NULL,
  PRIMARY KEY ("note_id", "scope"),
  FOREIGN KEY ("note_id") REFERENCES "xhs_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
