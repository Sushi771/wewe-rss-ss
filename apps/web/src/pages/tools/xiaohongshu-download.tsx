import { Button, Checkbox, Input } from '@nextui-org/react';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { getAuthCode } from '@web/utils/auth';
import { serverOriginUrl } from '@web/utils/env';

type Settings = { directory: string; askEveryTime: boolean };
type Capability = {
  available: boolean;
  videoAvailable?: boolean;
  message: string;
};
type Saved = {
  markdownPath: string;
  alreadySaved: boolean;
  imageCount: number;
  videoCount?: number;
};

export default function XiaohongshuDownload() {
  const [url, setUrl] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState<Saved | null>(null);
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
        throw new Error(
          result?.message || '本地操作失败，请检查服务和登录状态。',
        );
      return result;
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api('/settings', undefined, controller.signal),
      api('/xiaohongshu/single', undefined, controller.signal),
    ])
      .then(([preferences, available]) => {
        setSettings(preferences);
        setCapability(available);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : '无法读取本地能力与设置。',
          );
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [api]);

  const operate = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    setSaved(null);
    try {
      await action(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '操作失败。');
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const choose = async (signal: AbortSignal) => {
    const result = await api('/directory', {}, signal);
    if (result.cancelled) {
      setNotice('已取消选择目录，未开始保存。');
      return null;
    }
    setSettings({
      directory: result.directory,
      askEveryTime: result.askEveryTime,
    });
    return result.pickToken as string;
  };

  const download = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !capability?.available) return;
    void operate(async (signal) => {
      const input = new URL(url.trim());
      if (
        input.protocol !== 'https:' ||
        input.hostname !== 'www.xiaohongshu.com' ||
        input.username ||
        input.password ||
        input.port ||
        input.hash ||
        !/^\/(?:explore|discovery\/item)\/[a-zA-Z0-9_-]+$/.test(input.pathname)
      )
        throw new Error('请粘贴小红书公开笔记 HTTPS 长链接，短链接暂未接入。');
      let pickToken: string | undefined;
      if (settings?.askEveryTime) {
        const selected = await choose(signal);
        if (!selected) return;
        pickToken = selected;
      }
      const result = await api(
        '/xiaohongshu/single',
        { url: input.href, ...(pickToken ? { pickToken } : {}) },
        signal,
      );
      if (!result.saved || typeof result.markdownPath !== 'string')
        throw new Error('未收到有效的本地保存结果。');
      setSaved(result);
    });
  };

  return (
    <div className="h-full overflow-y-auto px-5 py-10 sm:px-8">
      <div className="mx-auto max-w-2xl">
        <p className="text-default-500 mb-3 text-sm">工具 / 小红书单篇下载</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          小红书单篇下载
        </h1>
        <p className="text-default-500 mt-3 text-sm leading-6">
          粘贴一篇公开笔记链接，将核验后的完整正文和图片保存到本地 Obsidian
          文件夹，无需订阅博主。
        </p>
        <div
          className="bg-default-50 mt-5 rounded-xl p-4 text-sm"
          role="status"
        >
          {capability?.message || '正在读取单篇取文能力。'}
          <p className="text-default-500 mt-2">
            {capability?.videoAvailable
              ? '视频缓存另核字节和容器结构；真实完整性与可播放性仍须来源验收。'
              : '真实视频来源未接入；短链接解析尚未接入。'}
          </p>
        </div>
        <form onSubmit={download} className="mt-8 space-y-5" aria-busy={busy}>
          <Input
            label="笔记链接"
            labelPlacement="outside"
            type="url"
            placeholder="https://www.xiaohongshu.com/explore/…"
            value={url}
            onValueChange={(value) => {
              if (busy || request.current) return;
              setUrl(value);
              setError('');
              setSaved(null);
              setNotice('');
            }}
            isDisabled={busy}
            isRequired
            autoComplete="off"
            description="支持公开笔记长链接，保存前会核验正文和图片。"
          />
          <div className="bg-default-50 rounded-xl p-4">
            <p className="mb-2 text-sm font-medium">保存路径</p>
            <p className="text-default-600 break-all text-sm">
              {settings?.directory || '正在读取本地保存设置。'}
            </p>
            <Button
              className="mt-3"
              size="sm"
              type="button"
              isDisabled={busy || !settings}
              onPress={() =>
                void operate(async (signal) => {
                  await choose(signal);
                })
              }
            >
              选择保存路径
            </Button>
            <div className="mt-4">
              <Checkbox
                isSelected={settings?.askEveryTime || false}
                isDisabled={busy || !settings}
                onValueChange={(value) => {
                  if (busy) return;
                  void operate(async (signal) => {
                    setSettings(
                      await api('/settings', { askEveryTime: value }, signal),
                    );
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
            isDisabled={
              busy || !settings || !url.trim() || !capability?.available
            }
          >
            {capability?.videoAvailable ? '保存正文和媒体' : '保存正文和图片'}
          </Button>
          {!settings && (
            <Button
              type="button"
              isDisabled={busy}
              onPress={() =>
                void operate(async (signal) => {
                  const [preferences, available] = await Promise.all([
                    api('/settings', undefined, signal),
                    api('/xiaohongshu/single', undefined, signal),
                  ]);
                  setSettings(preferences);
                  setCapability(available);
                })
              }
            >
              重新读取本地设置与能力
            </Button>
          )}
        </form>
        <div className="mt-6" aria-live="polite">
          {busy && (
            <p role="status" className="text-default-500 text-sm">
              请在本机完成可能出现的目录选择窗口。
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
          {saved && (
            <div className="border-success-200 bg-success-50 rounded-xl border p-5">
              <p role="status" className="font-medium">
                {saved.alreadySaved
                  ? '已保存，保留现有笔记'
                  : saved.videoCount
                    ? '正文和媒体缓存已保存到本地'
                    : '正文和图片已保存到本地'}
              </p>
              <p className="text-default-600 mt-2 break-all text-sm">
                {saved.markdownPath}
              </p>
              <p className="text-default-600 mt-2 text-sm">
                {saved.imageCount} 张图片位于同篇目录的
                image/，可直接打开正文.md。
              </p>
              {!!saved.videoCount && (
                <p className="text-default-600 mt-2 text-sm">
                  {saved.videoCount} 个视频文件位于同篇 video/，正文含相对链接。
                  本次已核字节与容器结构，未核解码可播放性。
                </p>
              )}
            </div>
          )}
        </div>
        <p className="text-default-500 mt-8 text-xs leading-6">
          与公众号单篇工具共用本地目录设置。按下载当天分目录，每篇保存正文.md 与
          image/；不会新增博主订阅。
          只有身份、发表时间、全文和全部图片字节通过核验才保存；失败后不会自动重试。
        </p>
      </div>
    </div>
  );
}
