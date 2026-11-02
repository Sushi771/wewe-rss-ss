import { useState } from 'react';
import { trpc } from '@web/utils/trpc';

/** Read saved comments only; opening this view never starts source collection. */
export default function XhsSavedComments({ creatorId, noteId }: { creatorId: string; noteId: string }) {
  const [offset, setOffset] = useState(0);
  const page = trpc.xiaohongshu.engagement.useQuery({ creatorId, noteId, offset, limit: 100 }, { retry: false });
  if (page.isLoading) return <p role="status">正在读取已保存评论…</p>;
  if (page.error || !page.data) return <div role="alert">评论读取失败，已保存内容保留。<button type="button" onClick={() => void page.refetch()}>重试读取</button></div>;
  const { comments, windows, totalSaved, returned } = page.data;
  const roots = comments.filter(comment => comment.rootId === null);
  const replies = comments.filter(comment => comment.rootId !== null);
  const render = (comment: typeof comments[number]) => <li key={comment.id}>
    <span>{comment.authorName || '未知作者'}：{comment.content}</span>{' · 点赞 '}{comment.likes == null ? '未知' : comment.likes}
  </li>;
  return <section aria-label="已保存评论" className="min-w-0 break-words">
    <p>本地已保存 {totalSaved} 条；数量不代表平台评论总数。</p>
    {windows.length === 0 && <p>采集范围尚未确认。</p>}
    {windows.map(window => <p key={window.scope}>{window.scope === 'top' ? '顶层评论' : '回复窗口'}：{window.state === 'returned-end' ? '本窗口已到末页' : window.state === 'failed' ? '读取失败，未完成' : '部分完成'} · {window.pages} 页 · {typeof window.collectedAt === 'number' && Number.isFinite(window.collectedAt) && window.collectedAt > 0 && Number.isFinite(new Date(window.collectedAt).getTime()) ? new Date(window.collectedAt).toLocaleString() : '时间未知'}</p>)}
    {!comments.length && <p>本页没有已保存评论；来源是否为空尚未确认。</p>}
    <ul>{roots.map(root => <li key={root.id}><span>{root.authorName || '未知作者'}：{root.content} · 点赞 {root.likes == null ? '未知' : root.likes}</span>{replies.some(reply => reply.rootId === root.id) && <details><summary>查看本页已保存回复</summary><ul>{replies.filter(reply => reply.rootId === root.id).map(render)}</ul></details>}</li>)}</ul>
    {replies.some(reply => !roots.some(root => root.id === reply.rootId)) && <><p>本页对应顶层评论未显示的已保存回复</p><ul>{replies.filter(reply => !roots.some(root => root.id === reply.rootId)).map(render)}</ul></>}
    <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>上一页</button>
    <button disabled={offset + returned >= totalSaved || returned === 0} onClick={() => setOffset(offset + returned)}>下一页</button>
  </section>;
}
