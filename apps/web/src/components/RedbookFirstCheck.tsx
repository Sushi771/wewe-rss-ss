import { useRef, useState } from 'react';
import {
  isRedbookLocalHost,
  redbookFirstCheckRequest,
} from '@web/utils/redbook-first-check';

type Summary = {
  configured: boolean;
  phase: string;
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
  const active = useRef(false);
  const local = isRedbookLocalHost(window.location.hostname);
  const run = async (operation: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setMessage('');
    try {
      await operation();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作未完成。');
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const readSample = async () => {
    const result = await redbookFirstCheckRequest<Sample>('sample', access);
    setSample(result);
    setSummary(result);
  };
  const close = () => {
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
              最多读取一页列表和你选定的一篇正文。图片默认关闭；结果仅供核验，尚未正式归档。登录信息仅在本机内存保留，15
              分钟后失效。关闭页面前可点击“撤销并清空”。
            </p>
            <p className="break-all text-sm">
              待核验主页：{creator?.profileUrl}
            </p>
            <form
              autoComplete="off"
              className="my-3 grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  try {
                    const result = await redbookFirstCheckRequest<Summary>(
                      'session',
                      access,
                      {
                        creatorId: creator?.id,
                        cookies: { a1, web_session: session },
                        expiresAt: Date.now() + 15 * 60000,
                        confirmLocalSession: true,
                      },
                    );
                    setSummary(result);
                    setSample(undefined);
                    setMessage('已保存本机会话。尚未向小红书发送请求。');
                  } finally {
                    setA1('');
                    setSession('');
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
                  void run(async () => {
                    setSummary(
                      await redbookFirstCheckRequest<Summary>('status', access),
                    );
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
                  void run(async () => {
                    setSummary(
                      await redbookFirstCheckRequest<Summary>('list', access, {
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
                  void run(async () => {
                    setSummary(
                      await redbookFirstCheckRequest<Summary>(
                        'detail',
                        access,
                        { confirmRequest: true, noteId },
                      ),
                    );
                    await readSample();
                  })
                }
              >
                确认读取这篇正文
              </button>
              <button
                className={button}
                disabled={busy || !summary?.configured}
                onClick={() => void run(readSample)}
              >
                查看待核验样本
              </button>
            </div>
            <p role="status" className="my-2 text-sm">
              阶段：{summary?.phase || '未建立会话'}；列表{' '}
              {summary?.listRequests || 0}/1，正文{' '}
              {summary?.detailRequests || 0}/1，图片{' '}
              {summary?.imageRequests || 0}/2。
              {summary?.stopCategory && `已停止：${summary.stopCategory}`}{' '}
              {message}
            </p>
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
                  void run(async () => {
                    setSummary(
                      await redbookFirstCheckRequest<Summary>(
                        'images',
                        access,
                        {
                          confirmImages: true,
                          maxImages: imageLimit,
                          maxBytes: 1000000,
                        },
                      ),
                    );
                    await readSample();
                  })
                }
              >
                确认下载这些图片
              </button>
            </div>
            {sample && (
              <details open>
                <summary>
                  待核验样本（已移除登录字段、请求令牌和链接查询参数）
                </summary>
                <pre className="my-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(
                    { list: sample.list, detail: sample.detail },
                    null,
                    2,
                  )}
                </pre>
                {sample.images?.map((image) => (
                  <figure key={image.ordinal}>
                    <img
                      className="max-h-64 max-w-full"
                      src={image.inlineData}
                      alt={`检查图片 ${image.ordinal}`}
                    />
                    <figcaption>
                      第 {image.ordinal} 张 · {image.bytes} 字节
                    </figcaption>
                  </figure>
                ))}
              </details>
            )}
            <details className="my-3">
              <summary>核验后允许正式归档</summary>
              <p className="my-2 text-sm">
                先对照你看到的原笔记填写参考值。待核验样本不会自行成为已验证归档。确认后仍需你另行点击原页面的刷新按钮，单次正式扫描最多三页、理论
                90 条。
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
                  void run(async () => {
                    await redbookFirstCheckRequest('review', access, {
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
                    });
                    setSummary(undefined);
                    setSample(undefined);
                    setText('');
                    setCount('');
                    setTime('');
                    setReview([false, false, false, false]);
                    setAllowArchive(false);
                    await onEnabled();
                    setMessage(
                      '核验通过，本机会话已允许正式归档。尚未执行刷新；会话仍按原时限失效。',
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
                  void run(async () => {
                    await redbookFirstCheckRequest('discard', access);
                    setSummary(undefined);
                    setSample(undefined);
                    setA1('');
                    setSession('');
                    await onEnabled();
                    setMessage('本机会话与待核验样本已清空。');
                  })
                }
              >
                撤销并清空
              </button>
              <button className={button} disabled={busy} onClick={close}>
                关闭
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
