type Saved = {
  mediaComplete?: boolean;
  alreadySaved: boolean;
  status?: 'new' | 'skipped' | 'repaired' | 'failed';
  markdownPath: string;
  publicationDate?: string | null;
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
  options: {
    signal?: AbortSignal;
    cancelled?: () => boolean;
    onFailed?: (error: Error, saved: Saved | undefined, id: string) => void;
  } = {},
) {
  const ids = [...new Set(rawIds)];
  for (let offset = 0; offset < ids.length; offset += 64) {
    if (options.signal?.aborted || options.cancelled?.())
      return { cancelled: true };
    const batch = ids.slice(offset, offset + 64);
    let receipt: Receipt;
    try {
      receipt = await send(batch, options.signal);
    } catch {
      // A lost transport receipt cannot establish whether server publication
      // happened. Preserve acknowledged earlier batches, stop and never replay.
      return { cancelled: true, unconfirmed: true };
    }

    if (receipt.results.length > batch.length)
      throw new Error('导出回执范围不一致');
    for (const [index, item] of receipt.results.entries()) {
      if (item.id !== batch[index]) throw new Error('导出回执身份不一致');
      const failure =
        item.error || !item.saved
          ? new Error(item.error || 'LOCAL_EXPORT_FAILED')
          : item.saved.mediaComplete === false
            ? new Error('LOCAL_EXPORT_MEDIA_INCOMPLETE')
            : undefined;
      if (failure) {
        if (!options.onFailed) throw failure;
        options.onFailed(failure, item.saved, item.id);
        continue;
      }
      onSaved(item.saved!, item.id);
    }
    if (receipt.cancelled) return { cancelled: true };
    if (receipt.results.length !== batch.length)
      throw new Error('导出回执不完整');
  }
  return { cancelled: false };
}
