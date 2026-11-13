/** Correct only the known legacy display literal; never rewrite stored task evidence. */
export function historyReviewMessage(t: {
  state: string;
  code?: string;
  message: string;
  historyExcludedIds?: string[];
}) {
  if (
    t.state === 'partial' &&
    t.code === 'XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED' &&
    t.message ===
      '历史待核对：${t.historyExcludedIds!.length} 篇，其余基础采集已完成。' &&
    Array.isArray(t.historyExcludedIds) &&
    t.historyExcludedIds.length > 0 &&
    t.historyExcludedIds.every((id) => typeof id === 'string' && id.length > 0)
  )
    return `历史待核对：${t.historyExcludedIds.length} 篇，其余基础采集已完成。`;
  return t.message;
}
