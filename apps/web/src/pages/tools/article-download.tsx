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
  contentSource?: 'saved-article' | 'remote' | 'verified-provider';
};

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
  const browserActive =
    !!browserTask &&
    ['waiting', 'claimed', 'ready', 'saving'].includes(browserTask.state);
  const locked = busy || browserActive;
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
      if (!response.ok || !result)
        throw new ArticleDownloadRequestError(
          result?.message || '本机保存操作失败，请检查服务或登录状态。',
          verificationFromDownloadError(
            result,
            body && typeof body === 'object'
              ? (body as { url?: unknown }).url
              : undefined,
          ),
        );
      return result;
    },
    [],
  );

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
      .then((value) => setBrowserAvailable(value.available === true))
      .catch(() => {}); // Older/disabled deployments simply have no task action.
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [api]);

  const browserTaskId = browserTask?.taskId;
  useEffect(() => {
    if (!browserTaskId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
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
        if (['waiting', 'claimed', 'saving'].includes(status.state))
          timer = setTimeout(() => void poll(), 1000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setBrowserTask(null);
        setError(cause instanceof Error ? cause.message : '任务状态读取失败。');
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
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
      const task = browserArticleTaskStatus(
        await api('/browser-task', { url: url.trim() }, signal),
      );
      if (!task) throw new Error('未收到有效的官方文章接收任务。');
      setBrowserTask(task);
    });
  const saveBrowserTask = () =>
    void operate(async (signal) => {
      if (!browserTaskId) return;
      try {
        let pickToken: string | undefined;
        if (settings?.askEveryTime) {
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
      } finally {
        if (!signal.aborted) {
          const status = browserArticleTaskStatus(
            await api(
              '/browser-task/' + browserTaskId,
              undefined,
              signal,
            ).catch(() => null),
          );
          setBrowserTask(status);
        }
      }
    });

  const download = (event: FormEvent) => {
    event.preventDefault();
    setBrowserTask(null);
    void operate(async (signal) => {
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
      if (!result.saved || typeof result.markdownPath !== 'string')
        throw new Error('未收到有效的本机保存结果。');
      setSaved(result);
    });
  };

  return (
    <div className="h-full overflow-y-auto px-5 py-10 sm:px-8">
      <div className="mx-auto max-w-2xl">
        <p className="text-default-500 mb-3 text-sm">工具 / 文章下载</p>
        <h1 className="text-2xl font-semibold tracking-tight">文章下载</h1>
        <p className="text-default-500 mt-3 text-sm leading-6">
          粘贴一篇公众号文章链接，直接保存正文和图片到本机 Obsidian 文件夹。
        </p>
        <form onSubmit={download} className="mt-8 space-y-5" aria-busy={busy}>
          <Input
            label="文章链接"
            labelPlacement="outside"
            type="url"
            placeholder="https://mp.weixin.qq.com/s/…"
            value={url}
            onValueChange={(value) => {
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
            description="支持公众号文章长链接和短链接。"
          />
          <div className="bg-default-50 rounded-xl p-4">
            <p className="mb-2 text-sm font-medium">保存路径</p>
            <p className="text-default-600 break-all text-sm">
              {settings?.directory || '正在读取本机保存设置…'}
            </p>
            <Button
              className="mt-3"
              size="sm"
              type="button"
              isDisabled={
                busy ||
                (browserActive && browserTask?.state !== 'ready') ||
                !settings
              }
              onPress={() =>
                void operate(async (signal) => {
                  await choose(signal);
                })
              }
            >
              选择下载路径
            </Button>
            <div className="mt-4">
              <Checkbox
                isSelected={settings?.askEveryTime || false}
                isDisabled={locked || !settings}
                onValueChange={(value) => {
                  const previous = settings;
                  if (previous)
                    setSettings({ ...previous, askEveryTime: value });
                  void operate(async (signal) => {
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
          </div>
          <Button
            color="primary"
            type="submit"
            isLoading={busy}
            isDisabled={locked || !settings || !url.trim()}
          >
            {busy ? '正在处理…' : '下载正文和图片'}
          </Button>
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
                上次本机保存未完成，可重新选择路径后保存；不会重新取文。
              </p>
            )}
            {browserTask.state === 'ready' && (
              <Button
                className="mt-3"
                isDisabled={busy}
                onPress={saveBrowserTask}
              >
                保存已接收的正文和图片
              </Button>
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
        <div className="mt-6" aria-live="polite">
          {busy && (
            <p role="status" className="text-default-500 text-sm">
              请完成可能弹出的目录选择；正在准备本机保存。
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
            <div className="border-success-200 bg-success-50 rounded-xl border p-5">
              <p role="status" className="font-medium">
                {saved.alreadySaved
                  ? '今天已保存，未覆盖已有笔记'
                  : '正文和图片已保存到本机'}
              </p>
              <p className="text-default-600 mt-2 break-all text-sm">
                {saved.markdownPath}
              </p>
              {saved.contentSource === 'saved-article' && (
                <p className="text-default-600 mt-2 text-sm">
                  使用本机已保存的正文和图片，未访问原文服务器。
                </p>
              )}
              {saved.contentSource === 'verified-provider' && (
                <p className="text-default-600 mt-2 text-sm">
                  使用本次接收并通过校验的正文和本地图片。
                </p>
              )}
              <p className="text-default-600 mt-2 text-sm">
                图片保存在同篇文章的 image 子目录，可直接用 Obsidian 打开正文。
              </p>
            </div>
          )}
        </div>
        <p className="text-default-500 mt-8 text-xs leading-6">
          按北京时间当天建立日期目录，每篇文章独立保存，不需要解压。此工具不改变订阅；原文要求登录、验证或图片失败时停止保存。浏览器验证不会自动传给后台。
        </p>
      </div>
    </div>
  );
}
