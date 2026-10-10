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

export function exportSourceFolders(source: ArticleExportSource) {
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

export function exportSourceMarkdown(
  source: ArticleExportSource,
  sourceUrl?: string | null,
) {
  const line = (value: string) => value.replace(/[\r\n]/g, ' ');
  return `公众号：${line(source.feedName)}\n\n分组：${line(source.groupName || '未分组')}\n\n原文链接：${sourceUrl ? line(sourceUrl) : '未记录'}\n\n`;
}
