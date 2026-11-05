-- Fixed, non-secret source stop; a pending operation is never assumed safe after a crash.
CREATE TABLE xhs_source_risk (
  id TEXT PRIMARY KEY NOT NULL CHECK(id='source'),
  state TEXT NOT NULL CHECK(state IN ('clear','pending','blocked')),
  code TEXT,
  owner TEXT,
  http_status INTEGER,
  endpoint TEXT,
  updated_at BIGINT NOT NULL
);
INSERT INTO xhs_source_risk(id,state,code,owner,updated_at)
SELECT 'source',
  CASE WHEN EXISTS(SELECT 1 FROM xhs_whole_creator_jobs WHERE state IN ('paused','failed','blocked','partial','cancelled') AND json_extract(document,'$.code') LIKE 'XHS_SOURCE_%_BLOCKED') OR EXISTS(SELECT 1 FROM xhs_subscription_tasks WHERE state IN ('paused','failed','blocked','partial','cancelled') AND json_extract(document,'$.code') LIKE 'XHS_SOURCE_%_BLOCKED') THEN 'blocked' ELSE 'clear' END,
  CASE WHEN EXISTS(SELECT 1 FROM xhs_whole_creator_jobs WHERE state IN ('paused','failed','blocked','partial','cancelled') AND json_extract(document,'$.code') LIKE 'XHS_SOURCE_%_BLOCKED') OR EXISTS(SELECT 1 FROM xhs_subscription_tasks WHERE state IN ('paused','failed','blocked','partial','cancelled') AND json_extract(document,'$.code') LIKE 'XHS_SOURCE_%_BLOCKED') THEN 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' ELSE NULL END,
  NULL, 0;
