-- 旧行保留 null，不把旧缓存或缺失正文推断为一次新的采集结果。
ALTER TABLE "articles" ADD COLUMN "last_body_status" TEXT;
