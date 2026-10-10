import { createHash } from 'node:crypto';

/** Internal, trusted Feed/ManagementGroup records only; never request JSON. */
export type ArticleExportSource = {
  feedId: string;
  feedName: string;
  groupId?: string | null;
  groupName?: string | null;
};

export function exportIdentity(id: string) {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

export function exportSafeName(value: string, fallback = '文章') {
  const name = Array.from(
    value
      .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '-')
      .replace(/^[. ]+|[. ]+$/g, ''),
  )
    .slice(0, 60)
    .join('');
  return name && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)
    ? name
    : fallback;
}

export function exportSourceFromFeed(feed: {
  id: string;
  mpName: string;
  group?: { id: string; name: string } | null;
}): ArticleExportSource {
  if (!feed.id || !feed.mpName?.trim())
    throw new Error('EXPORT_SOURCE_MISSING');
  return {
    feedId: feed.id,
    feedName: feed.mpName,
    groupId: feed.group?.id,
    groupName: feed.group?.name,
  };
}

export function exportLegacySourceFolders(source: ArticleExportSource) {
  if (
    !source.feedId ||
    !source.feedName?.trim() ||
    !!source.groupId !== !!source.groupName
  )
    throw new Error('EXPORT_SOURCE_MISSING');
  const folder = (name: string, id: string, fallback: string) => {
    const clean = exportSafeName(name, fallback);
    return clean === name ? clean : `${clean}-${exportIdentity(id)}`;
  };
  return [
    source.groupId
      ? folder(source.groupName!, source.groupId, '分组')
      : '未分组',
    folder(source.feedName, source.feedId, '公众号'),
  ];
}

/** Unix seconds from the verified provider/cache publication field only. */
export function exportPublication(publishTime?: number | null) {
  let datePendingReason: string | undefined;
  if (publishTime === undefined || publishTime === null || publishTime === 0)
    datePendingReason = '缺少可信原文发布日期';
  else if (!Number.isSafeInteger(publishTime) || publishTime < 946684800)
    datePendingReason = '原文发布日期不是有效的 Unix 秒时间';
  else if (publishTime > Math.floor(Date.now() / 1000) + 300)
    datePendingReason = '原文发布日期晚于当前时间，待核实';
  const publicationDate = datePendingReason
    ? null
    : new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(publishTime! * 1000));
  return {
    publicationDate,
    ...(datePendingReason ? { datePendingReason } : {}),
  };
}

export function exportSourceFolders(
  source: ArticleExportSource,
  publishTime?: number | null,
) {
  const [group, feed] = exportLegacySourceFolders(source);
  return [
    `${exportPublication(publishTime).publicationDate || '日期待核'}_${group}`,
    feed,
  ];
}

export function exportSourceMarkdown(
  source: ArticleExportSource,
  sourceUrl?: string | null,
  publishTime?: number | null,
) {
  const publication = exportPublication(publishTime);
  const date =
    publication.publicationDate ||
    `日期待核（${publication.datePendingReason}）`;
  const line = (value: string) => value.replace(/[\r\n]/g, ' ');
  return `公众号：${line(source.feedName)}\n\n分组：${line(source.groupName || '未分组')}\n\n原文发布日期（上海时间）：${date}\n\n原文链接：${sourceUrl ? line(sourceUrl) : '未记录'}\n\n`;
}
