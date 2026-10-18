type Saved = {
  mediaComplete?: boolean;
  alreadySaved: boolean;
  status?: string;
  markdownPath: string;
  publicationDate?: string;
  datePendingReason?: string;
  legacyLayoutRetained?: boolean;
  mediaStatus?: string;
  missingImageCount?: number;
};
type Receipt = {
  results: Array<{ id: string; saved?: Saved; error?: string }>;
  cancelled: boolean;
};

/** Bounded transport groups only; the server retains the existing atomic
 * per-article publication and releases every batch lock before returning. */
export async function exportArticleBatches(
  rawIds: readonly string[],
  send: (ids: string[], signal?: AbortSignal) => Promise<Receipt>,
  onSaved: (saved: Saved, id: string) => void,
  options: { signal?: AbortSignal; cancelled?: () => boolean } = {},
) {
  const ids = [...new Set(rawIds)];
  for (let offset = 0; offset < ids.length; offset += 64) {
    if (options.signal?.aborted || options.cancelled?.())
      return { cancelled: true };
    const batch = ids.slice(offset, offset + 64);
    let receipt: Receipt;
    try {
      receipt = await send(batch, options.signal);
    } catch (error) {
      if (options.signal?.aborted) return { cancelled: true };
      throw error;
    }
    if (receipt.results.length > batch.length)
      throw new Error('导出回执范围不一致');
    for (const [index, item] of receipt.results.entries()) {
      if (item.id !== batch[index]) throw new Error('导出回执身份不一致');
      if (item.error || !item.saved)
        throw new Error(item.error || '本篇导出失败');
      if (item.saved.mediaComplete === false)
        throw new Error('本篇正文或图片未完整归档，已有文件保留');
      onSaved(item.saved, item.id);
    }
    if (receipt.cancelled) return { cancelled: true };
    if (receipt.results.length !== batch.length)
      throw new Error('导出回执不完整');
  }
  return { cancelled: false };
}
