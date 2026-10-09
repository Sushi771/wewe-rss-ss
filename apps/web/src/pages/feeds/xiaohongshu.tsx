import { Button, Input, Switch } from '@nextui-org/react';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@web/utils/trpc';

/** Production page uses only authenticated server records, never demo fixtures. */
export default function Xiaohongshu() {
  const utils = trpc.useUtils();
  const capability = trpc.xiaohongshu.capability.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const creators = trpc.xiaohongshu.list.useQuery(undefined, { retry: false });
  const [creatorId, setCreatorId] = useState(''),
    [noteId, setNoteId] = useState('');
  const [displayName, setDisplayName] = useState(''),
    [profileUrl, setProfileUrl] = useState('');
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const active = useRef(false);
  const receipts = useRef<Record<string, string>>({});
  const current = creators.data?.items.find((c) => c.id === creatorId);
  const notes = trpc.xiaohongshu.notes.useQuery(
    { creatorId },
    { enabled: !!current, retry: false },
  );
  const body = trpc.xiaohongshu.body.useQuery(
    { creatorId, noteId },
    { enabled: !!current && !!noteId, retry: false },
  );
  const add = trpc.xiaohongshu.add.useMutation();
  const edit = trpc.xiaohongshu.edit.useMutation();
  const remove = trpc.xiaohongshu.remove.useMutation();
  const refresh = trpc.xiaohongshu.refresh.useMutation();
  const exportNotes = trpc.xiaohongshu.export.useMutation();
  useEffect(() => {
    if (creators.data && !creators.data.items.some((c) => c.id === creatorId)) {
      setCreatorId(creators.data.items[0]?.id || '');
      setNoteId('');
    }
  }, [creators.data, creatorId]);
  const run = async (operation: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setMessage('');
    try {
      await operation();
    } catch {
      setMessage(
        '操作未完成，请核对数据源及本地归档状态；输入和已有内容保留。',
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const updateCreator = async (id: string) => {
    const result = await refresh.mutateAsync({ id });
    receipts.current[id] = result.message + ' 新增完整图文：' + result.added;
    await Promise.all([
      utils.xiaohongshu.list.invalidate(),
      utils.xiaohongshu.notes.invalidate(),
    ]);
    setMessage(receipts.current[id]);
    return result.status;
  };
  const handleAdd = () =>
    run(async () => {
      const result = await add.mutateAsync({ displayName, profileUrl });
      setMessage(result.message);
      await utils.xiaohongshu.list.invalidate();
      setCreatorId(result.creator.id);
      setNoteId('');
      setDisplayName('');
      setProfileUrl('');
    });
  const handleRefreshAll = () =>
    run(async () => {
      if (!capability.data?.canRefresh) return;
      for (const c of creators.data?.items || []) {
        if (!c.enabled) continue;
        const status = await updateCreator(c.id);
        if (status !== 'complete') break; // Partial/blocked state stops later creators.
      }
    });
  const handleDownload = () =>
    run(async () => {
      if (!current) return;
      const result = await exportNotes.mutateAsync({ creatorId: current.id });
      const bytes = Uint8Array.from(atob(result.base64), (char) =>
        char.charCodeAt(0),
      );
      const url = URL.createObjectURL(
        new Blob([bytes], { type: result.mimeType }),
      );
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = result.filename;
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
      setMessage(`已生成 ${result.notes} 篇缓存完整图文的离线包。`);
    });
  return (
    <main className="mx-auto w-full max-w-7xl space-y-4 p-4">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">小红书博主</h1>
        <p role="status">
          {capability.error
            ? '来源状态查询失败；不会自动更新。'
            : capability.data?.message || '正在确认来源状态…'}
        </p>
        <p className="text-default-500 text-sm">
          保存主页仅加入待接入名单，不代表上游订阅成功。视频不归档；已有完整图文可离线下载。
        </p>
      </header>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          handleAdd();
        }}
      >
        <Input
          aria-label="博主备注名称"
          value={displayName}
          onValueChange={setDisplayName}
          isDisabled={busy}
          maxLength={120}
        />
        <Input
          aria-label="小红书公开主页链接"
          value={profileUrl}
          onValueChange={setProfileUrl}
          isDisabled={busy}
          maxLength={2000}
          placeholder="不含登录参数的公开主页链接"
        />
        <Button
          type="submit"
          isDisabled={busy || !displayName.trim() || !profileUrl.trim()}
        >
          保存待接入博主
        </Button>
      </form>
      <Button
        onPress={handleRefreshAll}
        isDisabled={
          busy ||
          !capability.data?.canRefresh ||
          !creators.data?.items.some((c) => c.enabled)
        }
      >
        更新全部已启用博主
      </Button>
      {creators.error && (
        <p role="alert">
          博主列表读取失败；首次启用前需完成数据库迁移。未显示示例数据。
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="grid min-w-0 gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="space-y-2" aria-label="小红书博主列表">
          {creators.data?.items.length === 0 && <p>尚未保存待接入博主。</p>}
          {creators.data?.items.map((c) => (
            <section
              key={c.id}
              className="border-default-200 space-y-2 rounded-lg border p-3"
            >
              <button
                type="button"
                className="w-full break-words text-left"
                aria-pressed={creatorId === c.id}
                onClick={() => {
                  setCreatorId(c.id);
                  setNoteId('');
                  setMessage(receipts.current[c.id] || '');
                }}
              >
                {c.displayName}
              </button>
              <p className="text-xs">
                小红书 · {c.externalAuthorId ? '身份已核验' : '待接入'} ·{' '}
                {c.lastStatus === 'partial'
                  ? '窗口未完成'
                  : c.lastStatus === 'complete'
                    ? '最近窗口已完成'
                    : '尚未更新'}
              </p>
              <Switch
                aria-label={`启用 ${c.displayName}`}
                isSelected={c.enabled}
                isDisabled={busy}
                onValueChange={(enabled) =>
                  run(async () => {
                    await edit.mutateAsync({ id: c.id, enabled });
                    await utils.xiaohongshu.list.invalidate();
                  })
                }
              >
                启用
              </Switch>
              <Button
                size="sm"
                color="danger"
                variant="light"
                isDisabled={busy || c._count.notes > 0}
                onPress={() => {
                  if (
                    window.confirm(
                      '移除此待接入博主？已有归档的博主请使用暂停。',
                    )
                  )
                    run(async () => {
                      await remove.mutateAsync({ id: c.id });
                      await utils.xiaohongshu.list.invalidate();
                    });
                }}
              >
                移除
              </Button>
            </section>
          ))}
        </aside>
        <section className="min-w-0 space-y-4" aria-label="小红书内容列表">
          {current ? (
            <>
              <h2 className="break-words font-semibold">
                {current.displayName}
              </h2>
              <div className="flex flex-wrap gap-2">
                <Button
                  isDisabled={
                    busy || !current.enabled || !capability.data?.canRefresh
                  }
                  onPress={() =>
                    run(async () => {
                      await updateCreator(current.id);
                    })
                  }
                >
                  更新此博主
                </Button>
                <Button
                  isDisabled={
                    busy ||
                    !notes.data?.items.some((n) => n.status === 'complete')
                  }
                  onPress={handleDownload}
                >
                  下载缓存完整图文
                </Button>
              </div>
              {notes.error && (
                <p role="alert">内容列表读取失败，已有归档未改动。</p>
              )}
              {notes.data?.items.length === 0 && (
                <p>尚无已归档笔记；接入真实数据源后才能更新。</p>
              )}
              <ul className="space-y-2">
                {notes.data?.items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      disabled={n.status !== 'complete'}
                      className="w-full break-words text-left"
                      onClick={() => setNoteId(n.id)}
                    >
                      {n.title} ·{' '}
                      {new Date(n.publishTime * 1000).toLocaleDateString()} ·{' '}
                      {n.status === 'complete' ? '完整图文' : '视频未归档'}
                    </button>
                  </li>
                ))}
              </ul>
              {body.error && (
                <p role="alert">正文未能读取；未向远端请求图片。</p>
              )}
              {body.data && (
                <article className="space-y-3">
                  <h3>{body.data.title}</h3>
                  <p className="whitespace-pre-wrap break-words">
                    {body.data.text}
                  </p>
                  {body.data.images.map((src, index) => (
                    <img
                      key={index}
                      src={src}
                      alt={`第 ${index + 1} 张归档图片`}
                      className="h-auto max-w-full"
                    />
                  ))}
                </article>
              )}
            </>
          ) : (
            <p>选择一个待接入博主。</p>
          )}
        </section>
      </div>
    </main>
  );
}
