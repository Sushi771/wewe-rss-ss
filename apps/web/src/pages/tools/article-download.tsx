import { Button, Input } from '@nextui-org/react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { getAuthCode } from '@web/utils/auth';
import { serverOriginUrl } from '@web/utils/env';

type DownloadFile = { href: string; name: string };

export default function ArticleDownload() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<DownloadFile | null>(null);
  const request = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);

  useEffect(
    () => () => {
      request.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const clearFile = () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setFile(null);
  };

  const download = async (event: FormEvent) => {
    event.preventDefault();
    if (request.current) return;
    clearFile();
    setError('');
    try {
      const input = new URL(url.trim());
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
      setError('请粘贴有效的 HTTPS 微信公众号文章链接（mp.weixin.qq.com/s）。');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const authCode = getAuthCode();
      const response = await fetch(
        `${serverOriginUrl || ''}/download/article`,
        {
          method: 'POST',
          credentials: 'include',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(authCode ? { authorization: authCode } : {}),
          },
          body: JSON.stringify({ url: url.trim() }),
        },
      );
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(
          detail?.message ||
            (response.status === 401
              ? '请先登录，或检查访问密码。'
              : '下载失败，请稍后重试。'),
        );
      }
      if (!response.headers.get('content-type')?.includes('application/zip'))
        throw new Error('未收到有效下载文件，请检查登录状态。');
      const blob = await response.blob();
      if (!blob.size) throw new Error('下载文件为空，请稍后重试。');
      const encoded = response.headers
        .get('content-disposition')
        ?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      let name = '公众号文章.zip';
      if (encoded) {
        try {
          name = decodeURIComponent(encoded);
        } catch {
          /* Use the fallback name. */
        }
      }
      const href = URL.createObjectURL(blob);
      objectUrl.current = href;
      setFile({ href, name });
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : '下载失败，请稍后重试。',
        );
    } finally {
      request.current = null;
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-5 py-10 sm:px-8">
      <div className="mx-auto max-w-2xl">
        <p className="text-default-500 mb-3 text-sm">工具 / 文章下载</p>
        <h1 className="text-2xl font-semibold tracking-tight">文章下载</h1>
        <p className="text-default-500 mt-3 text-sm leading-6">
          粘贴一篇公众号文章链接，将正文和图片保存到本地收藏。
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
              clearFile();
            }}
            isDisabled={busy}
            isRequired
            autoComplete="off"
            description="支持公众号文章长链接和短链接。"
          />
          <Button
            color="primary"
            type="submit"
            isLoading={busy}
            isDisabled={busy || !url.trim()}
          >
            {busy ? '正在准备下载…' : '下载正文和图片'}
          </Button>
        </form>
        <div className="mt-6" aria-live="polite">
          {busy && (
            <p role="status" className="text-default-500 text-sm">
              正在读取正文并保存图片，请稍候。
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
          {file && (
            <div className="border-success-200 bg-success-50 rounded-xl border p-5">
              <p role="status" className="font-medium">
                正文和图片已准备好
              </p>
              <p className="text-default-600 mt-2 text-sm">
                保存 ZIP 并解压，打开 index.html 即可离线阅读；同时包含 Markdown
                和图片文件。
              </p>
              <a
                href={file.href}
                download={file.name}
                className="bg-success-200 text-success-800 mt-4 inline-flex min-h-10 items-center rounded-xl px-4 text-sm font-medium"
              >
                保存下载文件
              </a>
            </div>
          )}
        </div>
        <p className="text-default-500 mt-8 text-xs leading-6">
          此工具独立于订阅，不会添加公众号或改变订阅文章。遇到登录、验证或图片下载失败时，会提示原因并停止生成文件。
        </p>
      </div>
    </div>
  );
}
