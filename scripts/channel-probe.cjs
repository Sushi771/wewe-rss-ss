#!/usr/bin/env node
// Read-only readiness probe. Never calls credential or download tools.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'WeWe-RSS',
  'WeChatDownload-4.7',
);
const executable = path.join(root, 'windows', '微信公众号批量下载工具4.7.exe');
const archive = path.join(root, 'wechatDownload4.7.zip');
// Packaged Codex can redirect LocalAppData into its package's LocalCache.
// Check the actual physical path too; the logical path alone can mislead users.
const physicalRoot = path.join(
  os.homedir(),
  'AppData',
  'Local',
  'Packages',
  'OpenAI.Codex_2p2nqsd0c76g0',
  'LocalCache',
  'Local',
  'WeWe-RSS',
  'WeChatDownload-4.7',
);
const physicalExecutable = path.join(
  physicalRoot,
  'windows',
  '微信公众号批量下载工具4.7.exe',
);
const physicalArchive = path.join(physicalRoot, 'wechatDownload4.7.zip');
const endpoint = 'http://127.0.0.1:4545/mcp';
const expectedSha256 =
  '2f9dfb81f47ab82122f29beea05756d2f51cabc5eda4e1a24ecdc6f2e5292f48';
const supportedTools = [
  'single_article_download',
  'get_public_account_id',
  'batch_download_articles',
  'export_article_data',
];

async function request(method, id, params, sessionId) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      id,
      ...(params ? { params } : {}),
    }),
    signal: AbortSignal.timeout(4000),
  });
  // Response contents can include private data. Return only allowlisted metadata below.
  const body = await response.text();
  let data;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const value = JSON.parse(line.slice(5).trim());
        if (value.id === id) data = value;
      } catch {}
    }
  } else {
    try {
      data = JSON.parse(body);
    } catch {}
  }
  return {
    status: response.status,
    data,
    sessionId: response.headers.get('mcp-session-id'),
  };
}

async function main() {
  const report = {
    checkedAt: new Date().toISOString(),
    executablePresent: fs.existsSync(executable),
    archivePresent: fs.existsSync(archive),
    physicalExecutablePath: physicalExecutable,
    physicalExecutablePresent: fs.existsSync(physicalExecutable),
    physicalArchivePath: physicalArchive,
    physicalArchivePresent: fs.existsSync(physicalArchive),
    archiveSha256: null,
    matchesOfficial47Archive: null,
    mcpReachable: false,
    advertisedTools: [],
    realAccountCollectionVerified: false,
    note: '就绪探测不代表已取得凭据或已完成真实公众号采集。',
  };
  if (report.archivePresent) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    report.archiveSha256 = hash.digest('hex');
    report.matchesOfficial47Archive = report.archiveSha256 === expectedSha256;
  }
  try {
    const init = await request('initialize', 1, {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wewe-rss-readiness-probe', version: '1.0' },
    });
    report.mcpHttpStatus = init.status;
    report.mcpReachable = init.status === 200 && Boolean(init.data?.result);
    if (report.mcpReachable) {
      const list = await request('tools/list', 2, {}, init.sessionId);
      report.advertisedTools = supportedTools.filter((name) =>
        list.data?.result?.tools?.some((tool) => tool.name === name),
      );
    }
  } catch (error) {
    report.mcpErrorCode = error.cause?.code || error.name;
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(() => {
  console.error('本地采集就绪探测失败；未输出请求或凭据。');
  process.exitCode = 1;
});
