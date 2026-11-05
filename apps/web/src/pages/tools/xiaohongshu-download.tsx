import { FailureNotice } from '@web/components/OperationNotice';
import { Button, Checkbox, Input } from '@nextui-org/react';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { getAuthCode } from '@web/utils/auth';
import { serverOriginUrl } from '@web/utils/env';
import { toast } from 'sonner';

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
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState<Saved | null>(null);
  const request = useRef<AbortController | null>(null);
  const api = useCallback(
    async (endpoint: string, body?: unknown, signal?: AbortSignal) => {
      const authCode = getAuthCode();
      const response = await fetch(
        `${serverOriginUrl || ''}/download/article${endpoint}${endpoint === '/settings' || endpoint === '/directory' ? '?target=xiaohongshu' : ''}`,
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
      })
      .finally(() => {
        if (!controller.signal.aborted) setInitialLoading(false);
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
        toast.error('小红书操作未完成，请先核对已保存内容和详情。');
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
    <div className="min-w-0">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">小红书单篇下载</h2>
        <div
          className="bg-default-50 mt-5 rounded-xl p-4 text-sm"
          role="status"
        >
          {capability
            ? capability.available
              ? '可以下载'
              : '暂不可下载'
            : initialLoading
              ? '正在读取设置…'
              : '设置读取失败，请重新读取。'}
        </div>
        <form onSubmit={download} className="mt-5 space-y-4" aria-busy={busy}>
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
          />
          <div className="border-divider rounded-lg border p-3">
            <p className="mb-2 text-sm font-medium">保存路径</p>
            <p className="text-default-600 break-all text-sm">
              {settings?.directory ||
                (initialLoading
                  ? '正在读取本地保存设置。'
                  : '本地保存设置未能读取，请重新读取。')}
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
            className="w-full sm:w-auto"
            color="primary"
            type="submit"
            isLoading={busy}
            isDisabled={
              busy || !settings || !url.trim() || !capability?.available
            }
          >
            {capability?.videoAvailable ? '保存正文和媒体' : '保存正文和图片'}
          </Button>
          {(!settings || !capability) && !initialLoading && (
            <Button
              type="button"
              isDisabled={busy || initialLoading}
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
              重新读取下载设置
            </Button>
          )}
        </form>
        <div className="mt-6" aria-live="polite">
          {busy && (
            <p role="status" className="text-default-500 text-sm">
              正在处理…
            </p>
          )}
          {notice && (
            <p role="status" className="text-default-500 text-sm">
              {notice}
            </p>
          )}
          {error && (
            <div
              role="alert"
              className="bg-danger-50 text-danger rounded-xl p-4 text-sm"
            >
              操作未完成，请检查下载状态。
              <FailureNotice error={error} />
            </div>
          )}
          {saved && (
            <div className="border-success-200 bg-success-50 rounded-lg border p-3">
              <p role="status" className="font-medium">
                {saved.alreadySaved
                  ? '已保存，保留现有笔记'
                  : saved.videoCount
                    ? '正文和图片、视频已保存到本机'
                    : '正文和图片已保存到本地'}
              </p>
              <p className="text-default-600 mt-2 break-all text-sm">
                {saved.markdownPath}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
