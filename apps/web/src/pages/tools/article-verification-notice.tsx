import type { TimedArticleVerification } from '@wewe-rss/shared';
import {
  articleVerificationLocation,
  verificationArticleUrl,
} from '@wewe-rss/shared';

export default function ArticleVerificationNotice({
  verification,
  operation = 'download',
}: {
  verification: TimedArticleVerification;
  operation?: 'download' | 'subscription';
}) {
  let current = verification;
  try {
    const articleUrl = verificationArticleUrl(verification.articleUrl);
    current = { ...verification, articleUrl };
    if (current.status === 'available') {
      const checked = articleVerificationLocation(current.url, articleUrl);
      if (checked.status !== 'available') current = checked;
      else if (
        !Number.isFinite(Date.parse(current.expiresAt)) ||
        Date.parse(current.expiresAt) <= Date.now()
      )
        current = { status: 'unavailable', articleUrl, reason: 'expired' };
    }
  } catch {
    return (
      <p className="mt-3 text-sm">本次文章地址无法核对，未提供验证链接。</p>
    );
  }
  return (
    <div className="bg-warning-50 mt-3 rounded-xl p-4 text-sm">
      <p className="break-all">本次待验证文章：{current.articleUrl}</p>
      {current.status === 'available' ? (
        <>
          <a
            href={current.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            onClick={(event) => {
              // Suspended tabs can delay the expiry timer; never open a stale link.
              if (
                verification.status !== 'available' ||
                Date.parse(verification.expiresAt) <= Date.now()
              )
                event.preventDefault();
            }}
            className="bg-warning mt-3 inline-block rounded-lg px-4 py-2 font-medium text-black"
          >
            打开本次官方验证
          </a>
          <p className="text-default-600 mt-3">
            {operation === 'subscription'
              ? '这是本次响应返回的微信官方验证页，请亲自完成验证。地址仅短期保留；浏览器验证成功不代表公众号目录或订阅已恢复，本次不会自动重试。'
              : '这是本次响应返回的微信官方验证页，请亲自完成验证。地址仅短期保留；浏览器验证成功不代表后台下载已恢复，本工具不会自动重试。'}
          </p>
        </>
      ) : (
        <p className="text-default-600 mt-2">
          {current.reason === 'sensitive-location'
            ? '本次验证地址包含可能敏感的凭据参数，暂未交给浏览器；需确认可安全打开后处理。'
            : current.reason === 'expired'
              ? '本次验证地址已过期，已移除；没有自动重试下载。'
              : current.reason === 'unsafe-location'
                ? '本次返回的地址未通过官方地址安全检查，未提供链接；没有跳转到主页替代。'
                : '未取得本次官方验证地址，无法提供链接；没有跳转到主页替代，也未重试请求。'}
        </p>
      )}
    </div>
  );
}
