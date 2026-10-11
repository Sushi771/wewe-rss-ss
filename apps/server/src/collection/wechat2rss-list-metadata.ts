/** Missing values remain unknown. Scheduling metadata is never a cache version. */
export type Wechat2RssListMetadata = {
  checkTime: string | null;
  nextUpdateTime: string | null;
  paused: boolean | null;
};

function timestamp(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw === '0001-01-01T00:00:00Z') return null; // Go's unset time.
  if (typeof raw !== 'string')
    throw new Error('WECHAT2RSS_LIST_METADATA_INVALID');
  // RFC3339 with an explicit timezone; reject JS Date's day rollover/coercion.
  const match = raw.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) throw new Error('WECHAT2RSS_LIST_METADATA_INVALID');
  const [year, month, day] = match[1].split('-').map(Number);
  const [hour, minute, second] = match[2].split(':').map(Number);
  const zone =
    match[3] === 'Z' ? [0, 0] : match[3].slice(1).split(':').map(Number);
  if (
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    zone[0] > 23 ||
    zone[1] > 59 ||
    !Number.isFinite(Date.parse(raw))
  )
    throw new Error('WECHAT2RSS_LIST_METADATA_INVALID');
  return new Date(raw).toISOString();
}

export function parseWechat2RssListMetadata(
  item: Record<string, unknown>,
): Wechat2RssListMetadata {
  if (
    item.paused !== undefined &&
    item.paused !== null &&
    typeof item.paused !== 'boolean'
  )
    throw new Error('WECHAT2RSS_LIST_METADATA_INVALID');
  return {
    checkTime: timestamp(item.check_time),
    nextUpdateTime: timestamp(item.next_update_time),
    paused:
      item.paused === undefined || item.paused === null
        ? null
        : (item.paused as boolean),
  };
}
