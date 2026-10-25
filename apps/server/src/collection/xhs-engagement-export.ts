import type {
  XhsEngagementView,
  XhsMetricSnapshot,
  XhsSavedComment,
} from '@wewe-rss/shared';
const plain = (s: string) => s.replace(/[\\`*_{}\[\]<>#|!]/g, '\\$&');
const when = (n: number) => (n > 0 ? new Date(n).toISOString() : '未知');
export function xhsMetricMarkdown(
  title: string,
  snapshot: XhsMetricSnapshot | null,
  fields: Record<string, string>,
) {
  if (
    !snapshot ||
    !Object.keys(fields).some(
      (k) => snapshot.values[k] !== null && snapshot.values[k] !== undefined,
    )
  )
    return '';
  return (
    `\n\n## ${title}\n\n` +
    Object.entries(fields)
      .map(([k, name]) => `${name}：${snapshot.values[k] ?? '未知'}`)
      .join(' · ') +
    `\n\n采集时间：${when(snapshot.collectedAt)}；历史快照；契约证据：${snapshot.evidence === 'source-only' ? '公开源码，真实响应待核实' : '已核实响应'}。\n`
  );
}
export function xhsEngagementMarkdown(view: XhsEngagementView) {
  let md = xhsMetricMarkdown('互动快照', view.metrics, {
    likes: '点赞',
    collects: '收藏',
    shares: '分享',
    comments: '评论',
  });
  md += xhsMetricMarkdown('博主资料快照', view.creatorMetrics, {
    fans: '粉丝',
    following: '关注',
  });
  if (!view.comments.length && !view.windows.length) return md;
  md += `\n\n## 已保存评论\n\n保存 ${view.totalSaved} 条，本文件包含 ${view.returned} 条。仅为已返回范围，未保证所有评论及回复；隐藏或删除内容可能不可得。\n`;
  for (const w of view.windows)
    md += `\n- ${w.scope === 'top' ? '顶层' : '根评论 ' + plain(w.scope)}：${w.pages} 页；${w.state === 'returned-end' ? '该接口返回结束' : w.state === 'failed' ? '失败，保留部分结果' : '部分'}；${when(w.collectedAt)}${w.code ? '；' + plain(w.code) : ''}\n`;
  const emit = (c: XhsSavedComment, child = false) =>
    `\n${child ? '### 回复' : '### 评论'} ${plain(c.authorName ?? '未知作者')}\n\n${plain(c.content)}\n\n点赞：${c.likes ?? '未知'}；发布时间：${c.publishedAt === null ? '未知' : when(c.publishedAt)}；采集：${when(c.collectedAt)}\n` +
    (child
      ? `\n所属根评论：${plain(c.rootId!)}；精确回复对象${c.parentId ? '：' + plain(c.parentId) : '未知'}。\n`
      : '');
  const roots = view.comments.filter((c) => c.rootId === null),
    seen = new Set<string>();
  for (const root of roots) {
    md += emit(root);
    seen.add(root.id);
    for (const child of view.comments.filter((c) => c.rootId === root.id)) {
      md += emit(child, true);
      seen.add(child.id);
    }
  }
  for (const c of view.comments)
    if (!seen.has(c.id)) md += emit(c, c.rootId !== null);
  return md;
}
