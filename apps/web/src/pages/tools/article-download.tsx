import { Button, Checkbox, Input } from '@nextui-org/react';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { getAuthCode } from '@web/utils/auth';
import { serverOriginUrl } from '@web/utils/env';
import {
  browserArticleTaskStatus,
  mergeBrowserArticleTaskStatus,
  type BrowserArticleTaskStatus,
  type TimedArticleVerification,
} from '@wewe-rss/shared';
import {
  ArticleDownloadRequestError,
  verificationFromDownloadError,
} from '@web/utils/article-download-error';
import ArticleVerificationNotice from './article-verification-notice';

type Settings = { directory: string; askEveryTime: boolean };
type SavedArticle = {
  directory: string;
  markdownPath: string;
  alreadySaved: boolean;
  imageCount: number;
  contentSource?: 'wechat2rss-cache';
};
type SingleTask = Partial<SavedArticle> & {
  taskId: string;
  revision: number;
  state: 'waiting' | 'saving' | 'saved' | 'blocked' | 'failed' | 'cancelled';
  message: string;
};
function singleTaskStatus(raw: unknown): SingleTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const task = raw as SingleTask;
  if (
    !/^[a-f0-9]{64}$/.test(task.taskId) ||
    !Number.isSafeInteger(task.revision) ||
    task.revision < 1 ||
    !['waiting', 'saving', 'saved', 'blocked', 'failed', 'cancelled'].includes(
      task.state,
    ) ||
    typeof task.message !== 'string'
  )
    return null;
  if (
    task.state === 'saved' &&
    (task.contentSource !== 'wechat2rss-cache' ||
      typeof task.markdownPath !== 'string')
  )
    return null;
  return task;
}

class GoneBrowserArticleTask extends Error {
  constructor() {
    super(
      '本机任务状态已清理；若未收到保存结果，请检查保存目录后再开始新操作。',
    );
  }
}

export default function ArticleDownload() {
  const [url, setUrl] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verification, setVerification] =
    useState<TimedArticleVerification | null>(null);
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState<SavedArticle | null>(null);
  const [browserAvailable, setBrowserAvailable] = useState(false);
  const [browserTask, setBrowserTask] =
    useState<BrowserArticleTaskStatus | null>(null);
  const [browserStatusUnreadable, setBrowserStatusUnreadable] = useState(false);
  const [statusReadAttempt, setStatusReadAttempt] = useState(0);
  const [statusReading, setStatusReading] = useState(false);
  const [browserDestinationBound, setBrowserDestinationBound] = useState(false);
  const [singleTask, setSingleTask] = useState<SingleTask | null>(null);
  const browserActive =
    !!browserTask &&
    ['waiting', 'claimed', 'ready', 'saving'].includes(browserTask.state);
  const singleActive =
    !!singleTask && ['waiting', 'saving'].includes(singleTask.state);
  const locked = busy || browserActive || singleActive;
  const request = useRef<AbortController | null>(null);

  const api = useCallback(
    async (endpoint: string, body?: unknown, signal?: AbortSignal) => {
      const authCode = getAuthCode();
      const response = await fetch(
        `${serverOriginUrl || ''}/download/article${endpoint}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'include',
          signal,
          headers: {
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
            ...(authCode ? { authorization: authCode } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      const result = await response.json().catch(() => null);
      if (!response.ok || !result) {
        if (
          body === undefined &&
          /^\/browser-task\/[a-f0-9-]{36}$/.test(endpoint) &&
          response.status === 410 &&
          result?.code === 'TASK_GONE'
        )
          throw new GoneBrowserArticleTask();
        throw new ArticleDownloadRequestError(
          result?.message || '本机保存操作失败，请检查服务或登录状态。',
          verificationFromDownloadError(
            result,
            body && typeof body === 'object'
              ? (body as { url?: unknown }).url
              : undefined,
          ),
        );
      }
      return result;
    },
    [],
  );

  const forgetGoneTask = useCallback((taskId: string, cause: unknown) => {
    if (!(cause instanceof GoneBrowserArticleTask)) return false;
    // A definitive missing record differs from a transient failed read. It does
    // not establish whether an earlier atomic save committed; never resave it.
    setBrowserTask((current) => (current?.taskId === taskId ? null : current));
    setBrowserStatusUnreadable(false);
    setError(cause.message);
    return true;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api('/settings', undefined, controller.signal)
      .then(setSettings)
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : '无法读取保存设置。',
          );
      });
    void api('/browser-task', undefined, controller.signal)
      .then((value) => {
        setBrowserAvailable(value.available === true);
        setBrowserDestinationBound(value.destinationBound === true);
      })
      .catch(() => {}); // Older/disabled deployments simply have no task action.
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await api(
          '/single-tasks',
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const tasks: SingleTask[] = Array.isArray(response.tasks)
          ? response.tasks
              .map(singleTaskStatus)
              .filter((t: SingleTask | null): t is SingleTask => !!t)
          : [];
        setSingleTask((current) => {
          const candidate =
            tasks.find((t) => t.taskId === current?.taskId) ||
            tasks.find((t) => ['waiting', 'saving'].includes(t.state)) ||
            tasks[0];
          if (!candidate) return current;
          if (
            candidate.taskId === current?.taskId &&
            candidate.revision < current.revision
          )
            return current;
          return candidate;
        });
      } catch {
        /* A local status failure never cancels a durable server task. */
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api]);

  const browserTaskId = browserTask?.taskId;
  useEffect(() => {
    if (!browserTaskId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      setStatusReading(true);
      try {
        const status = browserArticleTaskStatus(
          await api(
            '/browser-task/' + browserTaskId,
            undefined,
            controller.signal,
          ),
        );
        if (!status || status.taskId !== browserTaskId)
          throw new Error('未收到有效的官方文章任务状态。');
        if (controller.signal.aborted) return;
        setBrowserTask((current) =>
          mergeBrowserArticleTaskStatus(current, status),
        );
        setBrowserStatusUnreadable(false);
        if (['waiting', 'claimed', 'saving'].includes(status.state))
          timer = setTimeout(() => void poll(), 1000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (forgetGoneTask(browserTaskId, cause)) return;
        // A failed local status read does not cancel capture or discard its body.
        // Keep the task locked until an explicit read establishes its state.
        setBrowserStatusUnreadable(true);
        setError(cause instanceof Error ? cause.message : '任务状态读取失败。');
      } finally {
        if (!controller.signal.aborted) setStatusReading(false);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, browserTaskId, statusReadAttempt, forgetGoneTask]);

  useEffect(() => {
    if (!browserTaskId) return;
    return () => {
      // Cancel only when leaving/replacing the task, never when retrying a read.
      void api('/browser-task/' + browserTaskId + '/cancel', {}).catch(
        () => {},
      );
    };
  }, [api, browserTaskId]);

  const browserTaskDeadline = browserTask?.expiresAt;
  useEffect(() => {
    if (!browserTaskId || !browserTaskDeadline) return;
    const timer = setTimeout(
      () =>
        setBrowserTask((current) =>
          current?.taskId === browserTaskId &&
          ['waiting', 'claimed', 'ready'].includes(current.state)
            ? { ...current, state: 'expired', code: 'TASK_EXPIRED' }
            : current,
        ),
      Math.max(0, Date.parse(browserTaskDeadline) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [browserTaskId, browserTaskDeadline]);

  useEffect(() => {
    if (verification?.status !== 'available') return;
    const timer = setTimeout(
      () => {
        setVerification({
          status: 'unavailable',
          articleUrl: verification.articleUrl,
          reason: 'expired',
        });
      },
      Math.max(0, Date.parse(verification.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [verification]);

  const operate = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setVerification(null);
    setNotice('');
    setSaved(null);
    try {
      await action(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : '保存失败。');
        if (cause instanceof ArticleDownloadRequestError)
          setVerification(cause.verification);
      }
    } finally {
      request.current = null;
      setBusy(false);
    }
  };

  const choose = async (signal: AbortSignal) => {
    const result = await api('/directory', {}, signal);
    if (result.cancelled) {
      setNotice('已取消选择路径，未发起文章下载。');
      return null;
    }
    setSettings({
      directory: result.directory,
      askEveryTime: result.askEveryTime,
    });
    return result.pickToken as string;
  };

  const startBrowserTask = () =>
    void operate(async (signal) => {
      setBrowserTask(null);
      setBrowserStatusUnreadable(false);
      let pickToken: string | undefined;
      // Fixed-directory disclosure is issued only after the user's native choice.
      if (browserDestinationBound && settings?.askEveryTime) {
        const selected = await choose(signal);
        if (!selected) return;
        pickToken = selected;
      }
      const task = browserArticleTaskStatus(
        await api(
          '/browser-task',
          { url: url.trim(), ...(pickToken ? { pickToken } : {}) },
          signal,
        ),
      );
      if (!task) throw new Error('未收到有效的官方文章接收任务。');
      setBrowserTask(task);
    });
  const saveBrowserTask = () =>
    void operate(async (signal) => {
      if (!browserTaskId) return;
      if (browserTask?.code === 'SAVE_DIRECTORY_CHANGED') return;
      let gone = false;
      let saveError: Error | undefined;
      try {
        let pickToken: string | undefined;
        if (!browserTask?.destinationBound && settings?.askEveryTime) {
          const selected = await choose(signal);
          if (!selected) return;
          pickToken = selected;
        }
        setBrowserTask((current) =>
          current ? { ...current, state: 'saving', code: undefined } : current,
        );
        const result = await api(
          '/browser-task/' + browserTaskId + '/save',
          pickToken ? { pickToken } : {},
          signal,
        );
        if (!result.saved || typeof result.markdownPath !== 'string')
          throw new Error('未收到有效的本机保存结果。');
        setSaved(result);
      } catch (cause) {
        saveError =
          cause instanceof Error ? cause : new Error('本机保存未完成。');
      } finally {
        if (!signal.aborted) {
          const status = browserArticleTaskStatus(
            await api(
              '/browser-task/' + browserTaskId,
              undefined,
              signal,
            ).catch((cause) => {
              gone = forgetGoneTask(browserTaskId, cause);
              return null;
            }),
          );
          if (status?.taskId === browserTaskId) {
            setBrowserTask((current) =>
              mergeBrowserArticleTaskStatus(current, status),
            );
            setBrowserStatusUnreadable(false);
          } else if (!gone) {
            // Save may already have committed. Read the same task before retrying
            // a save instead of inferring failure or starting another capture.
            setBrowserStatusUnreadable(true);
          }
        }
      }
      if (gone) throw new GoneBrowserArticleTask();
      if (saveError) throw saveError;
    });

  const download = (event: FormEvent) => {
    event.preventDefault();
    if (locked) return;
    void operate(async (signal) => {
      setBrowserTask(null);
      let input: URL;
      try {
        input = new URL(url.trim());
        if (
          input.protocol !== 'https:' ||
          input.hostname !== 'mp.weixin.qq.com' ||
          !/^\/s(?:\/|$)/.test(input.pathname) ||
          input.username ||
          input.password ||
          input.port
        )
          throw new Error();
      } catch {
        throw new Error(
          '请粘贴有效的 HTTPS 微信公众号文章链接（mp.weixin.qq.com/s）。',
        );
      }
      let pickToken: string | undefined;
      if (settings?.askEveryTime) {
        const selected = await choose(signal);
        if (!selected) return;
        pickToken = selected;
      }
      const result = await api(
        '',
        { url: url.trim(), ...(pickToken ? { pickToken } : {}) },
        signal,
      );
      if (result.pending === true) {
        const task = singleTaskStatus(result.task);
        if (!task) throw new Error('未收到有效的下载任务回执。');
        setSingleTask(task);
        return;
      }
      if (!result.saved || typeof result.markdownPath !== 'string')
        throw new Error('未收到有效的本机保存结果。');
      if (result.contentSource !== 'wechat2rss-cache')
        throw new Error('未收到 Wechat2RSS 来源确认，未认定为本次下载成功。');
      setSaved(result);
    });
  };

  return (
    <div className="px-5 py-5 sm:px-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-xl font-semibold">公众号文章下载</h1>
        <p className="text-default-500 mt-1 text-sm">
          通过 Wechat2RSS 下载；需要时会订阅该公众号。
        </p>
        <form onSubmit={download} className="mt-4 space-y-3" aria-busy={busy}>
          <Input
            label="文章链接"
            labelPlacement="outside"
            type="url"
            placeholder="粘贴公众号文章链接"
            value={url}
            onValueChange={(value) => {
              if (locked || request.current) return;
              setUrl(value);
              setError('');
              setVerification(null);
              setBrowserTask(null);
              setSaved(null);
              setNotice('');
            }}
            isDisabled={locked}
            isRequired
            autoComplete="off"
          />
          <div className="border-divider rounded-lg border px-3 py-2">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-default-500 text-xs">保存到</p>
                <p className="text-default-600 break-all text-sm">
                  {settings?.directory || '正在读取本机保存设置…'}
                </p>
              </div>
              <Button
                className="shrink-0"
                aria-label="选择下载路径"
                size="sm"
                type="button"
                isDisabled={
                  busy ||
                  singleActive ||
                  (browserActive &&
                    (browserTask?.destinationBound ||
                      browserTask?.state !== 'ready')) ||
                  !settings
                }
                onPress={() => {
                  if (browserActive && browserTask?.destinationBound) return;
                  void operate(async (signal) => {
                    await choose(signal);
                  });
                }}
              >
                更改
              </Button>
            </div>
            {browserActive && browserTask?.destinationBound && (
              <p className="mt-2 text-sm">
                本次任务的保存目录已固定。若需更改，请取消任务，重新确认目录并取得新的接收许可后创建任务。
              </p>
            )}
            {!settings && (
              <Button
                className="ml-2 mt-3"
                size="sm"
                type="button"
                isDisabled={busy}
                onPress={() =>
                  void operate(async (signal) => {
                    setSettings(await api('/settings', undefined, signal));
                  })
                }
              >
                重新读取保存设置
              </Button>
            )}
          </div>
          <Button
            color="primary"
            type="submit"
            isLoading={busy}
            isDisabled={locked || !settings || !url.trim()}
          >
            {busy ? '正在处理…' : '下载正文和图片'}
          </Button>
          <details className="text-default-500 text-sm">
            <summary className="cursor-pointer">下载设置</summary>
            <div className="pt-2">
              <Checkbox
                isSelected={settings?.askEveryTime || false}
                isDisabled={locked || !settings}
                onValueChange={(value) => {
                  if (locked) return;
                  void operate(async (signal) => {
                    const previous = settings;
                    if (previous)
                      setSettings({ ...previous, askEveryTime: value });
                    try {
                      setSettings(
                        await api('/settings', { askEveryTime: value }, signal),
                      );
                    } catch (cause) {
                      setSettings(previous);
                      throw cause;
                    }
                  });
                }}
              >
                每次下载询问路径
              </Checkbox>
            </div>
          </details>
          {browserAvailable && (
            <Button
              type="button"
              isDisabled={locked || !settings || !url.trim()}
              onPress={startBrowserTask}
            >
              通过已打开的官方文章接收
            </Button>
          )}
        </form>
        {singleTask && (
          <div
            className="border-divider mt-3 rounded-lg border p-3 text-sm"
            aria-live="polite"
          >
            <p role="status">{singleTask.message}</p>
            {singleTask.state === 'waiting' && (
              <>
                <p className="text-default-500 mt-1 text-xs">
                  关闭页面后继续；再次打开可查看结果。
                </p>
                <Button
                  size="sm"
                  className="mt-2"
                  isDisabled={busy}
                  onPress={() =>
                    void operate(async (signal) => {
                      const task = singleTaskStatus(
                        await api(
                          '/single-task/' + singleTask.taskId + '/cancel',
                          {},
                          signal,
                        ),
                      );
                      if (!task) throw new Error('未收到有效的取消结果。');
                      setSingleTask(task);
                    })
                  }
                >
                  取消下载
                </Button>
              </>
            )}
            {['blocked', 'failed'].includes(singleTask.state) && (
              <Button
                size="sm"
                className="mt-2"
                isDisabled={busy}
                onPress={() =>
                  void operate(async (signal) => {
                    const task = singleTaskStatus(
                      await api(
                        '/single-task/' + singleTask.taskId + '/resume',
                        {},
                        signal,
                      ),
                    );
                    if (!task) throw new Error('未收到有效的接续结果。');
                    setSingleTask(task);
                  })
                }
              >
                继续原下载
              </Button>
            )}
            {singleTask.state === 'saved' && (
              <p className="text-default-600 mt-1 break-all">
                {singleTask.markdownPath}
              </p>
            )}
          </div>
        )}
        {browserTask && (
          <div className="bg-default-50 mt-5 rounded-xl p-4" aria-live="polite">
            <p role="status">
              {
                {
                  waiting: '等待您主动从官方文章页回送',
                  claimed: '正在接收当前官方文章',
                  ready: '正文和图片已通过接收校验，等待保存',
                  saving: '正在保存到本机',
                  saved: '本机保存已完成',
                  cancelled: '任务已取消，未继续接收',
                  expired: '任务已过期，未继续接收',
                  failed: '文章接收校验未通过，未保存',
                }[browserTask.state]
              }
            </p>
            {['waiting', 'claimed'].includes(browserTask.state) && (
              <>
                <p className="mt-2 break-all text-xs">
                  任务编号：{browserTask.taskId}
                </p>
                <p className="text-default-500 mt-2 text-sm">
                  此任务不会访问原文或恢复订阅；请仅在已经打开的对应官方文章页操作。
                </p>
              </>
            )}
            {browserTask.code === 'SAVE_RETRY_REQUIRED' && (
              <p className="mt-2 text-sm">
                {browserTask.destinationBound
                  ? '上次本机保存未完成，请核对本次固定目录后重试。若需更改目录，请取消本次任务，重新确认目录并取得新的接收许可后创建任务。'
                  : '上次本机保存未完成，可重新选择路径后保存；不会重新取文。'}
              </p>
            )}
            {browserTask.code === 'SAVE_DIRECTORY_CHANGED' && (
              <p className="mt-2 text-sm">
                保存目录已改变，本次任务不能写入新目录。请取消任务，重新确认目录并取得新的接收许可后创建任务。
              </p>
            )}
            {browserTask.state === 'ready' && (
              <Button
                className="mt-3"
                isDisabled={
                  busy ||
                  browserStatusUnreadable ||
                  statusReading ||
                  browserTask.code === 'SAVE_DIRECTORY_CHANGED'
                }
                onPress={saveBrowserTask}
              >
                保存已接收的正文和图片
              </Button>
            )}
            {browserStatusUnreadable && browserActive && (
              <div className="mt-3">
                <p className="text-default-500 text-sm">
                  本机任务状态暂未读到；任务仍保留，请先重新读取再保存。
                </p>
                <Button
                  className="mt-2"
                  type="button"
                  isDisabled={busy || statusReading}
                  onPress={() => {
                    if (statusReading) return;
                    setError('');
                    setStatusReading(true);
                    setStatusReadAttempt((attempt) => attempt + 1);
                  }}
                >
                  重新读取本机任务状态
                </Button>
              </div>
            )}
            {browserActive && (
              <Button
                className="ml-2 mt-3"
                isDisabled={busy || browserTask.state === 'saving'}
                onPress={() =>
                  void operate(async (signal) => {
                    const status = browserArticleTaskStatus(
                      await api(
                        '/browser-task/' + browserTask.taskId + '/cancel',
                        {},
                        signal,
                      ),
                    );
                    if (!status) throw new Error('未收到有效的取消结果。');
                    setBrowserTask(status);
                  })
                }
              >
                取消接收任务
              </Button>
            )}
          </div>
        )}
        <div
          className={busy || notice || error || saved ? 'mt-3' : ''}
          aria-live="polite"
        >
          {busy && (
            <p role="status" className="text-default-500 text-sm">
              请完成可能弹出的目录选择；正在处理本机操作。
            </p>
          )}
          {notice && (
            <p role="status" className="text-default-500 text-sm">
              {notice}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="bg-danger-50 text-danger rounded-xl p-4 text-sm"
            >
              {error}
            </p>
          )}
          {error && verification && (
            <ArticleVerificationNotice verification={verification} />
          )}
          {saved && (
            <div className="border-success-200 bg-success-50 rounded-lg border p-3">
              <p role="status" className="font-medium">
                {saved.alreadySaved
                  ? '今天已保存，未覆盖已有笔记'
                  : '正文和图片已保存到本机'}
              </p>
              <p className="text-default-600 mt-2 break-all text-sm">
                {saved.markdownPath}
              </p>
              <p className="text-default-600 mt-2 text-sm">
                可直接用 Obsidian 打开；图片保存在文章目录内。
              </p>
            </div>
          )}
        </div>
        <details className="text-default-500 mt-3 text-sm">
          <summary className="cursor-pointer">使用帮助</summary>
          <div className="space-y-2 pt-2 text-xs leading-5">
            <p>
              直接粘贴公众号文章链接，由后台核对 Wechat2RSS 中的文章。
              若服务没有该链接对应的正文，会显示具体原因。
            </p>
            <p>
              正文和图片保存为 Markdown 及本地资源，按下载日期和文章分目录。
              重复下载保留已有笔记，已编辑内容不会被覆盖。
            </p>
            <p>
              公众号未订阅、文章不在当前缓存或正文和媒体不完整时会显示原因。
              必要时会通过 Wechat2RSS 订阅该公众号并等待更新，不需要另点订阅。
              服务不保证取得所有历史文章；无法精确核验目标时不会保存其他文章。
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}
