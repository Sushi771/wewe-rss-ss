import { useEffect, useRef, useState } from 'react';
import {
  isRedbookLocalHost,
  REDBOOK_DIAGNOSTIC_TTL_MS,
  formatRedbookTime,
  redbookDiagnosticDetail,
  isRedbookDiagnosticImage,
  redbookFirstCheckRequest,
} from '@web/utils/redbook-first-check';

type Summary = {
  configured: boolean;
  phase: string;
  expiresAt?: number;
  listRequests?: number;
  detailRequests?: number;
  imageRequests?: number;
  notes?: { noteId: string }[];
  stopCategory?: string | null;
};
type Sample = Summary & {
  list?: unknown;
  detail?: unknown;
  images?: { ordinal: number; inlineData: string; bytes: number }[];
};
const checks = [
  '已对照博主主页核实作者归属',
  '已对照原笔记核实全文',
  '已对照原笔记核实全部图片及顺序',
  '已核实原笔记发布时间',
];

export default function RedbookFirstCheck({
  creator,
  onEnabled,
}: {
  creator?: { id: string; displayName: string; profileUrl: string };
  onEnabled: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState('');
  const [a1, setA1] = useState('');
  const [session, setSession] = useState('');
  const [summary, setSummary] = useState<Summary>();
  const [sample, setSample] = useState<Sample>();
  const [noteId, setNoteId] = useState('');
  const [imagesAllowed, setImagesAllowed] = useState(false);
  const [imageLimit, setImageLimit] = useState(1);
  const [text, setText] = useState('');
  const [count, setCount] = useState('');
  const [time, setTime] = useState('');
  const [review, setReview] = useState([false, false, false, false]);
  const [allowArchive, setAllowArchive] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [archiveExpiresAt, setArchiveExpiresAt] = useState<number>();
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = null;
    };
  }, []);
  const local =
    typeof window !== 'undefined' &&
    isRedbookLocalHost(window.location.hostname);
  const detail = redbookDiagnosticDetail(sample?.detail);
  const previewImages = sample?.images?.filter(isRedbookDiagnosticImage) || [];
  const run = async (
    operation: (
      request: typeof redbookFirstCheckRequest,
      isCurrent: () => boolean,
    ) => Promise<void>,
  ) => {
    if (!mounted.current || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const isCurrent = () =>
      mounted.current &&
      active.current === controller &&
      !controller.signal.aborted;
    const request = async <T,>(
      action: Parameters<typeof redbookFirstCheckRequest>[0],
      password: string,
      payload: object = {},
    ): Promise<T> => {
      if (!isCurrent()) throw new Error('操作已关闭。');
      const result = await redbookFirstCheckRequest<T>(
        action,
        password,
        payload,
        controller.signal,
      );
      if (!isCurrent()) throw new Error('操作已关闭。');
      return result;
    };
    setBusy(true);
    setMessage('');
    try {
      await operation(request, isCurrent);
    } catch (error) {
      if (isCurrent())
        setMessage(error instanceof Error ? error.message : '操作未完成。');
    } finally {
      if (isCurrent()) {
        active.current = null;
        setBusy(false);
      }
    }
  };
  const readSample = async (request: typeof redbookFirstCheckRequest) => {
    const result = await request<Sample>('sample', access);
    setSample(result);
    setSummary(result);
  };
  const notifyEnabled = async (isCurrent: () => boolean, success: string) => {
    if (!isCurrent()) return;
    try {
      await onEnabled();
      if (isCurrent()) setMessage(success);
    } catch {
      if (isCurrent())
        setMessage(success + ' 页面状态同步失败，请关闭后手动查询来源状态。');
    }
  };
  const close = () => {
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setArchiveExpiresAt(undefined);
    setOpen(false);
    setAccess('');
    setA1('');
    setSession('');
    setSample(undefined);
    setText('');
    setCount('');
    setTime('');
    setReview([false, false, false, false]);
    setAllowArchive(false);
    setImagesAllowed(false);
    setNoteId('');
    setSummary(undefined);
    setMessage('');
  };
  const button = 'rounded border px-3 py-2 disabled:opacity-40';
  return (
    <>
      <button
        className={button}
        disabled={!local || !creator}
        onClick={() => setOpen(true)}
      >
        本机首次小量检查
      </button>
      {!local && <span className="text-xs">请使用本机地址打开此入口。</span>}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="redbook-first-title"
            className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl bg-white p-5 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100"
          >
            <h2 id="redbook-first-title" className="text-lg font-semibold">
              首次小量检查 · {creator?.displayName}
            </h2>
            <p className="my-2 text-sm">
              最多读取一页列表和你选定的一篇正文。图片默认关闭；结果仅供核验，尚未正式归档。诊断登录信息仅在本机内存保留，最多
              24
              小时，到下方绝对截止时间即失效；读取状态和样本不会续期。平台提前失效或要求验证时立即停止，不自动重试。关闭窗口只清除此窗口中的输入和结果；清除服务端会话请点“撤销并清空”。
            </p>
            <p className="break-all text-sm">
              待核验主页：{creator?.profileUrl}
            </p>
            <form
              autoComplete="off"
              className="my-3 grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async (request, isCurrent) => {
                  try {
                    const result = await request<Summary>('session', access, {
                      creatorId: creator?.id,
                      cookies: { a1, web_session: session },
                      expiresAt: Date.now() + REDBOOK_DIAGNOSTIC_TTL_MS,
                      confirmLocalSession: true,
                    });
                    setSummary(result);
                    setArchiveExpiresAt(undefined);
                    setSample(undefined);
                    setMessage('已保存本机会话。尚未向小红书发送请求。');
                  } finally {
                    if (isCurrent()) {
                      setA1('');
                      setSession('');
                    }
                  }
                });
              }}
            >
              <label>
                订阅平台的访问密码（平时打开 WeWe 使用的密码）
                <input
                  className="ml-2 rounded border bg-transparent p-2"
                  type="password"
                  autoComplete="off"
                  value={access}
                  onChange={(e) => setAccess(e.target.value)}
                  disabled={busy}
                />
              </label>
              <p className="text-sm">
                以下是你自己账号的两个登录字段，只在这个本机入口填写，不要发到聊天。
              </p>
              <label>
                小红书 a1
                <input
                  className="ml-2 rounded border bg-transparent p-2"
                  type="password"
                  autoComplete="off"
                  value={a1}
                  onChange={(e) => setA1(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label>
                小红书 web_session
                <input
                  className="ml-2 rounded border bg-transparent p-2"
                  type="password"
                  autoComplete="off"
                  value={session}
                  onChange={(e) => setSession(e.target.value)}
                  disabled={busy}
                />
              </label>
              <button
                className={button}
                disabled={
                  busy || !access || !a1 || !session || !!summary?.configured
                }
              >
                仅保存本机会话
              </button>
            </form>
            <div className="flex flex-wrap gap-2">
              <button
                className={button}
                disabled={busy || !access}
                onClick={() =>
                  void run(async (request) => {
                    setSummary(await request<Summary>('status', access));
                  })
                }
              >
                读取本机状态
              </button>
              <button
                className={button}
                disabled={
                  busy || summary?.phase !== 'ready' || !!summary?.listRequests
                }
                onClick={() =>
                  void run(async (request) => {
                    setSummary(
                      await request<Summary>('list', access, {
                        confirmRequest: true,
                      }),
                    );
                  })
                }
              >
                确认读取一页列表
              </button>
              <select
                aria-label="选择一篇待检查笔记"
                className="rounded border bg-transparent p-2"
                value={noteId}
                onChange={(e) => setNoteId(e.target.value)}
                disabled={busy}
              >
                <option value="">选择笔记</option>
                {summary?.notes?.map((note) => (
                  <option key={note.noteId} value={note.noteId}>
                    {note.noteId}
                  </option>
                ))}
              </select>
              <button
                className={button}
                disabled={
                  busy ||
                  summary?.phase !== 'listed' ||
                  !noteId ||
                  !!summary?.detailRequests
                }
                onClick={() =>
                  void run(async (request) => {
                    setSummary(
                      await request<Summary>('detail', access, {
                        confirmRequest: true,
                        noteId,
                      }),
                    );
                    await readSample(request);
                  })
                }
              >
                确认读取这篇正文
              </button>
              <button
                className={button}
                disabled={busy || !summary?.configured}
                onClick={() => void run((request) => readSample(request))}
              >
                查看待核验样本
              </button>
            </div>
            <p role="status" className="my-2 text-sm">
              阶段：
              {summary?.phase ||
                (archiveExpiresAt ? '已启用手工归档（未刷新）' : '未建立会话')}
              ；列表 {summary?.listRequests || 0}/1，正文{' '}
              {summary?.detailRequests || 0}/1，图片{' '}
              {summary?.imageRequests || 0}/2。
              {summary?.stopCategory && `已停止：${summary.stopCategory}`}{' '}
              {message}
            </p>
            {(summary?.expiresAt || archiveExpiresAt) && (
              <p className="my-2 text-sm">
                {archiveExpiresAt ? '正式手工归档会话截止：' : '诊断会话截止：'}
                {formatRedbookTime(archiveExpiresAt ?? summary?.expiresAt)}
                {archiveExpiresAt &&
                  '。正式会话最多 2 小时，且不超过原诊断截止时间；平台提前失效仍须停止。'}
              </p>
            )}
            <div className="my-3 flex flex-wrap items-center gap-2">
              <label>
                <input
                  type="checkbox"
                  checked={imagesAllowed}
                  onChange={(e) => setImagesAllowed(e.target.checked)}
                  disabled={busy}
                />{' '}
                单独允许下载少量图片（总计最多 1 MB）
              </label>
              <select
                aria-label="图片检查数量"
                value={imageLimit}
                onChange={(e) => setImageLimit(Number(e.target.value))}
                disabled={busy}
              >
                <option value={1}>1 张</option>
                <option value={2}>2 张</option>
              </select>
              <button
                className={button}
                disabled={
                  busy ||
                  !imagesAllowed ||
                  summary?.phase !== 'sample-ready' ||
                  !!summary?.imageRequests
                }
                onClick={() =>
                  void run(async (request) => {
                    setSummary(
                      await request<Summary>('images', access, {
                        confirmImages: true,
                        maxImages: imageLimit,
                        maxBytes: 1000000,
                      }),
                    );
                    await readSample(request);
                  })
                }
              >
                确认下载这些图片
              </button>
            </div>
            {sample && (
              <section
                aria-label="待核验诊断样本"
                className="my-3 space-y-2 rounded border p-3"
              >
                <h3 className="font-semibold">待核验结果（尚未正式归档）</h3>
                <p className="text-sm">
                  内容来自已脱敏的诊断响应，不能证明真实性或全文、全图完整性。
                  下方人工参考值须独立对照原笔记填写，不会从本结果自动填入。
                </p>
                {detail ? (
                  <>
                    <h4 className="break-words font-medium">
                      {detail.title || '（响应标题为空）'}
                    </h4>
                    <p className="break-all text-sm">
                      笔记 ID：{detail.noteId}
                    </p>
                    <p className="text-sm">
                      响应发布时间：{formatRedbookTime(detail.publishedAtMs)}
                    </p>
                    <p className="whitespace-pre-wrap break-words">
                      {detail.text || '（响应正文为空）'}
                    </p>
                    <p className="text-sm">
                      正文响应声明图片数：{detail.declaredImageCount}
                      ；可预览已下载图片：{previewImages.length}；
                      已下载预览合计：
                      {previewImages.reduce(
                        (bytes, image) => bytes + image.bytes,
                        0,
                      )}{' '}
                      字节。 最多下载 2 张仅供检查，不代表全部图片已保存或核验。
                    </p>
                  </>
                ) : (
                  <p className="text-sm">
                    尚无可按已知结构展示的正文。可展开脱敏响应查看，不会猜测字段或自动再请求正文。
                  </p>
                )}
                {previewImages.map((image) => (
                  <figure key={image.ordinal}>
                    <img
                      className="max-h-64 max-w-full"
                      src={image.inlineData}
                      alt={'待核验图片 ' + image.ordinal}
                    />
                    <figcaption>
                      第 {image.ordinal} 张 · {image.bytes} 字节
                    </figcaption>
                  </figure>
                ))}
                <details>
                  <summary>
                    脱敏响应字段（已移除登录字段、请求令牌和链接查询参数）
                  </summary>
                  <pre className="my-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(
                      { list: sample.list, detail: sample.detail },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </section>
            )}
            <details className="my-3">
              <summary>核验后允许正式归档</summary>
              <p className="my-2 text-sm">
                先独立对照原笔记填写全文、全部图片数量和发布时间，并核实作者。确认只启用手工归档，正式会话最多
                2
                小时且不超过诊断原截止时间。提交后关闭此窗口，确认原页面选中该博主，再手动点“刷新此博主”开始正式扫描（单次最多三页、理论
                90
                条）。本步骤不会自动刷新；订阅前全史、全部正文与全部图片是否归档仍需分别验收。
              </p>
              <label className="block">
                原笔记全文
                <textarea
                  className="block w-full rounded border bg-transparent p-2"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="block">
                原笔记全部图片数量
                <input
                  className="m-2 rounded border bg-transparent p-2"
                  type="number"
                  min={0}
                  max={60}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="block">
                原笔记发布时间（北京时间）
                <input
                  className="m-2 rounded border bg-transparent p-2"
                  type="datetime-local"
                  step={1}
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  disabled={busy}
                />
              </label>
              {checks.map((label, i) => (
                <label className="block" key={label}>
                  <input
                    type="checkbox"
                    checked={review[i]}
                    onChange={(e) =>
                      setReview(
                        review.map((value, j) =>
                          i === j ? e.target.checked : value,
                        ),
                      )
                    }
                    disabled={busy}
                  />{' '}
                  {label}
                </label>
              ))}
              <label className="block">
                <input
                  type="checkbox"
                  checked={allowArchive}
                  onChange={(e) => setAllowArchive(e.target.checked)}
                  disabled={busy}
                />{' '}
                我允许后续手动刷新进行正式归档
              </label>
              <button
                className={button}
                disabled={
                  busy ||
                  summary?.phase !== 'sample-ready' ||
                  !review.every(Boolean) ||
                  !allowArchive ||
                  count === '' ||
                  !time
                }
                onClick={() =>
                  void run(async (request, isCurrent) => {
                    const enabled = await request<{ expiresAt?: number }>(
                      'review',
                      access,
                      {
                        observedText: text,
                        observedImageCount: Number(count),
                        publishedAt: Math.floor(
                          new Date(`${time}+08:00`).getTime() / 1000,
                        ),
                        authorIdentityChecked: review[0],
                        fullTextChecked: review[1],
                        allImagesChecked: review[2],
                        publicationTimeChecked: review[3],
                        allowFutureArchive: allowArchive,
                      },
                    );
                    setSummary(undefined);
                    setArchiveExpiresAt(enabled.expiresAt);
                    setSample(undefined);
                    setText('');
                    setCount('');
                    setTime('');
                    setReview([false, false, false, false]);
                    setAllowArchive(false);
                    await notifyEnabled(
                      isCurrent,
                      '核验已提交，手工归档会话已启用，未执行刷新。请关闭此窗口，选中该博主并手动点“刷新此博主”；正式会话最多 2 小时，且不超过原诊断截止时间。',
                    );
                  })
                }
              >
                提交核验并允许后续手动刷新
              </button>
            </details>
            <div className="flex gap-2">
              <button
                className={button}
                disabled={busy || !access}
                onClick={() =>
                  void run(async (request, isCurrent) => {
                    await request('discard', access);
                    setSummary(undefined);
                    setSample(undefined);
                    setA1('');
                    setSession('');
                    setArchiveExpiresAt(undefined);
                    await notifyEnabled(
                      isCurrent,
                      '本机会话与待核验样本已清空。',
                    );
                  })
                }
              >
                撤销并清空
              </button>
              <button className={button} onClick={close}>
                关闭
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
