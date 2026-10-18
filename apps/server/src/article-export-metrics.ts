import { metricLabels, Metrics } from './collection/collection-format';

/** Export-only renderer; keep existing collection reports unchanged. */
export function metricsMarkdown(article: {
  title: string;
  sourceUrl?: string | null;
  id: string;
  metrics?: string | null;
}) {
  const metrics: Metrics = JSON.parse(article.metrics || '{}');
  const lines = (Object.keys(metricLabels) as (keyof Metrics)[])
    .filter((key) => metrics[key] != null)
    .map((key) => {
      const metric = metrics[key]!;
      return `| ${metricLabels[key]} | ${metric.display} | ${metric.fileTime} |`;
    });
  return (
    `# ${article.title.replace(/[\r\n]/g, ' ')}\n\n原文：${article.sourceUrl || `https://mp.weixin.qq.com/s/${article.id}`}\n\n` +
    (lines.length
      ? `| 指标 | 数值 | 数据文件时间（UTC） |\n| --- | --- | --- |\n${lines.join('\n')}\n\n` +
        `指标来源：WeChatDownload CSV 导入（仅展示已提供的指标；带“+”为下限，文件时间不是精确采集时间）。\n\n`
      : '')
  );
}
