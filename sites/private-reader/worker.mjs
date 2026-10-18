import { createSitesWorker } from '../../scripts/sites-local-contract.mjs';

const allowed = new Set(['capability', 'authors', 'items', 'body', 'download']);
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的私人订阅 · WeWe RSS</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#20332e;background:#f5f7f3;line-height:1.65}*{box-sizing:border-box}body{margin:0}.reader{max-width:1160px;margin:auto;padding:32px 24px}header{margin-bottom:24px}h1{font-size:32px;line-height:1.2;margin:8px 0}h2{font-size:20px}.eyebrow{font-size:12px;letter-spacing:.12em;font-weight:650;color:#287462}.muted,footer{color:#52665e;font-size:14px}nav{display:flex;gap:8px;margin-top:20px}button,a{font:inherit}button{background:#fff;border:1px solid #ced9d2;border-radius:10px;padding:9px 14px;color:inherit;cursor:pointer}button[aria-pressed=true],button[aria-current=true]{background:#e0eee6;border-color:#39725c}button:disabled{opacity:.45;cursor:default}button:focus-visible,a:focus-visible{outline:3px solid #4e9780;outline-offset:3px}.columns{display:grid;grid-template-columns:260px minmax(0,1fr);gap:20px}.panel{background:white;border:1px solid #dee6df;border-radius:16px;padding:20px;min-width:0}.choices{list-style:none;padding:0;margin:0 0 16px}.choices li+li{margin-top:8px}.choices button{text-align:left;width:100%;overflow-wrap:anywhere}.content article{border-top:1px solid #dee6df;margin-top:24px;padding-top:16px;overflow-wrap:anywhere}.content article p{white-space:pre-wrap}.content img{display:block;max-width:100%;height:auto;margin:16px 0}footer{margin-top:24px}[role=alert]{border-left:3px solid #8d7148;padding:8px 12px;background:#f5f0e7}@media(max-width:680px){.reader{padding:20px 14px}.columns{grid-template-columns:1fr}.panel{padding:16px}h1{font-size:28px}}
</style><div id="reader-root"><p>私人身份与本机连接尚未配置。</p></div><script src="/reader.js" defer></script></html>`;

/** Local preparation factory. authorize must eventually be supplied by a verified
 * server-side Sites identity AND owner policy; headers/env flags never supply it.
 * transport must independently authenticate the HTTPS local seam. No adapters
 * are provided or enabled in the production default export below. */
export function createPrivateReaderWorker({
  authorize,
  transport,
  browserScript,
} = {}) {
  const api = createSitesWorker({
    authorize,
    transport: {
      async send(command, context) {
        if (!allowed.has(command.action))
          throw Object.assign(new Error('REFRESH_UNCONFIGURED'), {
            code: 'REFRESH_UNCONFIGURED',
          });
        if (typeof transport?.send !== 'function')
          throw Object.assign(new Error('PC_UNAVAILABLE'), {
            code: 'PC_UNAVAILABLE',
          });
        return transport.send(command, context);
      },
    },
  });
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/subscriptions') return api.fetch(request);
      if (url.search || !['GET', 'HEAD'].includes(request.method))
        return new Response('Not found', { status: 404, headers });
      if (url.pathname === '/')
        return new Response(request.method === 'HEAD' ? null : page, {
          headers: {
            ...headers,
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy':
              "default-src 'none'; script-src 'self'; connect-src 'self'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; object-src 'none'",
          },
        });
      if (url.pathname === '/reader.js' && typeof browserScript === 'string')
        return new Response(request.method === 'HEAD' ? null : browserScript, {
          headers: {
            ...headers,
            'Content-Type': 'text/javascript; charset=utf-8',
          },
        });
      return new Response('Not found', { status: 404, headers });
    },
  };
}

const browserScript =
  typeof __READER_BROWSER_JS__ === 'string' ? __READER_BROWSER_JS__ : undefined;
// No owner fixture, secret, URL, env opt-in, header trust or mounted local route.
export default createPrivateReaderWorker({ browserScript });
