-- Append validated local video cache fields without rebuilding old rows.
ALTER TABLE "xhs_notes" ADD COLUMN "kind" TEXT;
ALTER TABLE "xhs_notes" ADD COLUMN "video_bytes" BLOB;
ALTER TABLE "xhs_notes" ADD COLUMN "video_mime_type" TEXT;
ALTER TABLE "xhs_notes" ADD COLUMN "video_expected_bytes" INTEGER;
ALTER TABLE "xhs_notes" ADD COLUMN "video_sha256" TEXT;
