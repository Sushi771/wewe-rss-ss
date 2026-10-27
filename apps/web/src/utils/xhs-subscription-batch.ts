export type BatchItem = {
  index: number;
  fingerprint: string;
  state:
    | 'queued'
    | 'needs_context'
    | 'resolving'
    | 'unknown'
    | 'subscribed'
    | 'duplicate'
    | 'failed';
  code?: string;
  authorId?: string;
  creatorId?: string;
};
export type SubscriptionBatch = {
  batchId: string;
  state: 'queued' | 'running' | 'paused' | 'cancelled' | 'completed';
  items: BatchItem[];
};
export type BatchApi = {
  startSubscriptionBatch: {
    mutate: (input: {
      clientRequestId: string;
      text: string;
      groupId?: string;
    }) => Promise<SubscriptionBatch>;
  };
  subscriptionBatch: {
    query: (input: { batchId: string }) => Promise<SubscriptionBatch>;
  };
  resumeSubscriptionBatch: {
    mutate: (input: {
      batchId: string;
      text: string;
    }) => Promise<SubscriptionBatch>;
  };
  cancelSubscriptionBatch: {
    mutate: (input: { batchId: string }) => Promise<SubscriptionBatch>;
  };
};
/** Preliminary URL count only. Server verification and author deduplication are authoritative. */
export function previewBatchText(text: string) {
  const links = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const unique = new Set(links);
  const official = [...unique].filter((raw) => {
    try {
      const standalone = links.length === 1 && text.trim() === raw;
      const value = standalone
        ? raw
        : raw.replace(/[\uFF0C\u3002\uFF01\uFF1F\uFF09\u3011,;!?)]+$/u, '');
      if (raw.includes('?') && value !== raw) return false;
      if (
        value.length > 8192 ||
        /[\\\s]/.test(value) ||
        [...value].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        /^https:\/\/[^/]*:\d+(?:\/|$)/i.test(value)
      )
        return false;
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.port)
        return false;
      if (
        u.hash &&
        !(
          u.hash === '#comment-section' &&
          u.hostname === 'www.xiaohongshu.com' &&
          /^\/(?:explore|discovery\/item)\//.test(u.pathname)
        )
      )
        return false;
      if (u.hostname === 'xhslink.com')
        return (
          /^\/(?:a\/)?[a-zA-Z0-9_-]{1,128}\/?$/.test(u.pathname) && !u.search
        );
      if (u.hostname === 'xhslink.cn')
        return /^\/o\/[a-zA-Z0-9_-]{1,128}\/?$/.test(u.pathname) && !u.search;
      return (
        u.hostname === 'www.xiaohongshu.com' &&
        /^\/(?:user\/profile|explore|discovery\/item)\/[a-zA-Z0-9_-]{1,128}\/?$/.test(
          u.pathname,
        )
      );
    } catch {
      return false;
    }
  }).length;
  return {
    detected: links.length,
    unique: unique.size,
    duplicates: links.length - unique.size,
    official,
  };
}
export const batchStateLabels: Record<SubscriptionBatch['state'], string> = {
  queued: '等待处理',
  running: '正在处理',
  paused: '已暂停，等待处理',
  cancelled: '已取消',
  completed: '处理结束',
};
export const batchItemLabels: Record<BatchItem['state'], string> = {
  queued: '等待处理',
  needs_context: '需要重新粘贴链接',
  resolving: '识别博主中',
  unknown: '结果未确认，请核对',
  subscribed: '订阅成功',
  duplicate: '重复博主，已跳过',
  failed: '未完成',
};
export function batchCodeMessage(code?: string): string {
  switch (code) {
    case 'XHS_URL_INVALID':
      return '链接未通过官方格式校验，请核对原始分享内容。';
    case 'XHS_BATCH_INPUT_INVALID':
      return '请核对分享内容及链接数量限制。';
    case 'XHS_GROUP_INVALID':
      return '订阅文件夹不可用，请核对本地分组。';
    case 'XHS_TASK_RECEIPT_UNCERTAIN':
      return '该项结果未确认，不会重新派发。';
    case 'XHS_TASK_CONFLICT':
      return '存在尚未核对的任务，请先核对后继续。';
    case 'XHS_TASK_CANCELLED':
      return '该项已随批次取消，没有继续派发。';
    case 'XHS_TASK_STATE_CHANGED':
      return '回执状态已变化，请重新读取。';
    case 'XHS_TASK_NOT_RESUMABLE':
      return '该批次当前不能继续，请重新读取回执。';
    case 'XHS_TASK_NOT_FOUND':
      return '未找到该本地批次，请核对批次编号。';
    case 'XHS_RESOLUTION_BLOCKED':
      return '作者识别已暂停，请先核对来源状态。';
    case 'XHS_REQUEST_BUDGET_REQUIRED':
      return '请先设置来源总额度。';
    case 'XHS_REQUEST_BUDGET_EXHAUSTED':
      return '来源总额度已用完，请调整已有额度后继续。';
    case 'XHS_REQUEST_RATE_PAUSED':
      return '正在等待允许的请求间隔，请稍后明确继续。';
    case 'XHS_SESSION_REQUIRED':
    case 'XHS_SESSION_CHANGED':
      return '本机来源连接需重新核对。';
    case 'XHS_ACCESS_CONTEXT_EXPIRED':
    case 'XHS_ACCESS_CONTEXT_UNAVAILABLE':
      return '请重新粘贴原始分享内容后继续。';
    default:
      return code?.startsWith('XHS_SOURCE_')
        ? '来源已暂停，请先核对连接与风险状态。'
        : '该项未完成，请核对原始内容和本地回执。';
  }
}
export function validBatch(value: SubscriptionBatch): boolean {
  return (
    !!value &&
    typeof value.batchId === 'string' &&
    !!value.batchId &&
    value.batchId.length <= 200 &&
    Object.prototype.hasOwnProperty.call(batchStateLabels, value.state) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        Number.isInteger(item.index) &&
        item.index >= 0 &&
        typeof item.fingerprint === 'string' &&
        Object.prototype.hasOwnProperty.call(batchItemLabels, item.state),
    )
  );
}
export const batchStorageKeys = {
  id: 'wewe.xhs.subscriptionBatch.id',
  pending: 'wewe.xhs.subscriptionBatch.pending',
  pendingGroup: 'wewe.xhs.subscriptionBatch.pendingGroup',
};
