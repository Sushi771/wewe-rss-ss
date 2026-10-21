/** Scope and file guarantees shared by the actual export dialog and its checks. */
export default function ArticleExportGuidance({
  singleFeed,
  scope,
  format,
  zipAvailable,
}: {
  singleFeed: boolean;
  scope: 'selected' | 'filtered' | 'all';
  format: 'obsidian' | 'zip';
  zipAvailable: boolean;
}) {
  return (
    <div className="space-y-2 text-xs text-neutral-500">
      <p>
        {scope === 'selected'
          ? '仅导出已勾选的文章。'
          : scope === 'filtered'
            ? '导出符合当前筛选的全部文章。'
            : singleFeed
              ? '导出本号全部文章，忽略当前筛选。'
              : '导出所有订阅的全部文章，忽略当前筛选。'}
      </p>
      {format === 'obsidian' && (
        <p>每次最多 5000 篇；已有文件会保留并检查是否需要补齐。</p>
      )}
      {!zipAvailable && <p>ZIP 仅支持单个公众号的当前筛选或全部文章。</p>}
      <details>
        <summary className="cursor-pointer">范围与文件说明</summary>
        <div className="mt-2 space-y-2">
          <p>
            加载更多文章不会自动勾选。当前筛选包含日期、关键词和文件夹内所有匹配文章，包括尚未显示的文章。
          </p>
          <p>
            {singleFeed
              ? '“本号全部”只包含当前公众号。'
              : '“全部文章”包含所有订阅。'}
            全部导出不受日期、关键词和文件夹筛选限制。
          </p>
          <p>
            保存到 Obsidian
            时沿用现有目录和格式，再次导出会跳过已有完整文件，或补齐缺失内容。
          </p>
          <p>
            ZIP
            每次重新打包，仅包含当前公众号，不支持单独勾选的文章，也无法检查你以前下载的文件。
          </p>
          <p>
            篇数为当前估算。导出期间文章如有增减，最终数量可能变化；请以完成结果为准。
          </p>
        </div>
      </details>
    </div>
  );
}
