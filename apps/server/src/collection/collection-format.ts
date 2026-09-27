import { load } from 'cheerio';

export const metricLabels = {
  read: '阅读',
  like: '点赞',
  share: '分享',
  comment: '评论',
  wow: '在看',
  favorite: '收藏',
};
export type Metrics = Partial<
  Record<
    keyof typeof metricLabels,
    { value: number; display: string; fileTime: string }
  >
>;

/** RFC 4180 quoting, including commas and newlines inside quoted titles. */
export function parseCsv(text: string): Record<string, string>[] {
  if (text.includes('\uFFFD'))
    throw new Error('CSV 不是有效 UTF-8，请在 Excel 另存为 CSV UTF-8 后导入');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else cell += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell);
      cell = '';
      closed = false;
      if (c !== ',') {
        if (row.some((v) => v.trim())) rows.push(row);
        row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
    } else if (c === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new Error('CSV 引号格式错误');
      cell += c;
    }
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号');
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  const headers = rows.shift()?.map((h) => h.trim().toLowerCase()) || [];
  if (!headers.length || new Set(headers).size !== headers.length)
    throw new Error('CSV 表头为空或重复');
  return rows.map((values, index) => {
    if (values.length !== headers.length)
      throw new Error(`CSV 第 ${index + 2} 行列数不匹配`);
    return Object.fromEntries(headers.map((h, i) => [h, values[i].trim()]));
  });
}

export function canonicalArticleUrl(raw: string) {
  const decoded = load('<span></span>')('span').html(raw).text();
  const url = new URL(decoded.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hostname !== 'mp.weixin.qq.com' ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('仅接受 mp.weixin.qq.com 的文章链接');
  }
  const biz = url.searchParams.get('__biz') || '';
  const mid =
    url.searchParams.get('mid') || url.searchParams.get('appmsgid') || '';
  const idx =
    url.searchParams.get('idx') || url.searchParams.get('itemidx') || '';
  const number = Buffer.from(biz, 'base64').toString('ascii');
  if (
    url.pathname !== '/s' ||
    !/^\d{5,15}$/.test(number) ||
    !/^\d+$/.test(mid) ||
    !/^[1-9]\d*$/.test(idx)
  ) {
    throw new Error(
      '需要含 __biz、mid、idx 的完整文章链接，请使用 WeChatDownload 导出的 CSV',
    );
  }
  const clean = new URL('https://mp.weixin.qq.com/s');
  for (const [k, v] of [
    ['__biz', biz],
    ['mid', mid],
    ['idx', idx],
    ['sn', url.searchParams.get('sn') || ''],
  ]) {
    if (v) clean.searchParams.set(k, v);
  }
  return {
    id: `WX_${number}_${mid}_${idx}`,
    mpId: `MP_WXS_${number}`,
    url: clean.toString(),
  };
}

export function parsePublishTime(raw: string): number {
  if (/^\d{10}$/.test(raw)) return Number(raw);
  if (/^\d{13}$/.test(raw)) return Math.floor(Number(raw) / 1000);
  const match = raw.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!match) throw new Error(`不支持的发布时间：${raw}`);
  const [, y, m, d, h = '0', min = '0', s = '0'] = match;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${min}:${s}+08:00`;
  const value = Date.parse(iso);
  const date = new Date(value + 8 * 3600000);
  if (
    !Number.isFinite(value) ||
    date.getUTCDate() !== Number(d) ||
    date.getUTCMonth() + 1 !== Number(m)
  )
    throw new Error(`无效日期：${raw}`);
  return Math.floor(value / 1000);
}

const metricColumns: Record<keyof Metrics, string[]> = {
  read: ['read_num', 'read_count', '阅读量', '阅读数'],
  like: ['like_num', 'like_count', '点赞数', '点赞量'],
  share: ['share_num', 'share_count', '分享数', '分享量'],
  comment: ['comment_count', 'comment_num', '评论数'],
  wow: ['wow_num', '在看数', '在看量'],
  favorite: ['favorite_count', 'favorite_num', '收藏数', '收藏量'],
};

export function readMetrics(
  row: Record<string, string>,
  fileTime: string,
): Metrics {
  const metrics: Metrics = {};
  for (const key of Object.keys(metricColumns) as (keyof Metrics)[]) {
    const raw = metricColumns[key]
      .map((h) => row[h])
      .find((v) => v !== undefined)
      ?.trim();
    if (!raw || ['-', '--', '{}', 'null', 'N/A'].includes(raw)) continue;
    const m = raw.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)(万)?(\+)?$/);
    if (!m) throw new Error(`无法识别${metricLabels[key]}指标：${raw}`);
    const value = Number(m[1]) * (m[2] ? 10000 : 1);
    if (!Number.isSafeInteger(value) || value > 2147483647)
      throw new Error(`指标超出范围：${raw}`);
    metrics[key] = { value, display: raw, fileTime };
  }
  return metrics;
}

export function mergeMetrics(oldMetrics: Metrics, incoming: Metrics): Metrics {
  const merged = { ...oldMetrics };
  for (const key of Object.keys(incoming) as (keyof Metrics)[]) {
    if (!merged[key] || incoming[key]!.fileTime >= merged[key]!.fileTime)
      merged[key] = incoming[key];
  }
  return merged;
}

export function metricsMarkdown(article: {
  title: string;
  sourceUrl?: string | null;
  id: string;
  metrics?: string | null;
}) {
  const metrics: Metrics = JSON.parse(article.metrics || '{}');
  const lines = (Object.keys(metricLabels) as (keyof Metrics)[]).map((key) => {
    const metric = metrics[key];
    return `| ${metricLabels[key]} | ${metric?.display ?? '未提供'} | ${metric?.fileTime ?? ''} |`;
  });
  return (
    `# ${article.title.replace(/[\r\n]/g, ' ')}\n\n原文：${article.sourceUrl || `https://mp.weixin.qq.com/s/${article.id}`}\n\n` +
    `| 指标 | 数值 | 数据文件时间（UTC） |\n| --- | --- | --- |\n${lines.join('\n')}\n\n` +
    `数据来源：WeChatDownload 导入（未提供的指标留空；带“+”为下限，文件时间不是精确采集时间）。\n\n`
  );
}

export function csvCell(value: unknown) {
  let str = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(str)) str = `'${str}`;
  return `"${str.replace(/"/g, '""')}"`;
}
