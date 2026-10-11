# 现成缓存快速同步：接口、运行条件与验收

该模块只消费已订阅的 Wechat2RSS 缓存，不调用添加、更新提交、登录、解封或原文抓取接口。当前及未来启用的 Wechat2RSS 本地订阅由原有来源路由识别，不使用单号白名单，也不受旧单号补跑配置限制。制作阶段只在临时副本验证，生产启用、构建部署与 GitHub 同步由主窗口统一集成。

## 启用与依赖

- 私有配置增加 `WECHAT2RSS_CACHE_SYNC=1`，且原有 `WECHAT2RSS_ENABLED=1` 有效。
- `WECHAT2RSS_CACHE_MEDIA=0` 可独立暂停自动正文/图片队列；列表同步继续，媒体保留 pending。默认未设置时沿用原行为。该开关不改变手动更新/下载语义；恢复后仍遵守夜间及 paused 限制。
- 可选 `WECHAT2RSS_CACHE_DB=<本机上游缓存 SQLite 的绝对路径>`。路径只保存在私有配置；不能假设远程实例或任意 Docker 主机具有同样路径/表结构。
- Python 使用已有备份解释器配置 `SQLITE_BACKUP_PYTHON`，否则 Windows 使用 `python`，其他平台使用 `python3`。监测器只使用标准库。
- 缓存监测器只查询 `articles`、`rsses`；连接使用 SQLite URI `mode=ro`，不读凭据表，不执行 schema、数据或持久 PRAGMA 写入，不修改 ACL。
- 原有启动审计通过后才启用同步。验收模式、隔离保护报告模式不自动启用监测。关闭开关并重启即可停用。

Unix 持久只读连接每秒查询 `PRAGMA data_version`，只有版本变化才重新计算文章指纹。Windows 实测长期 SQLite 连接会阻止数据库文件替换，因此改为每秒检查 **DB 与 WAL** 的文件身份、纳秒修改时间和尺寸，变化时短暂打开并关闭只读快照。WAL checkpoint、文件替换、同尺寸正文补全均有离线回归。文件通知/时间戳只是变化线索，最终还要核对文章指纹及 API 缓存内容。

没有本机数据库路径或监测器不可用时，退回只读 API 路径：每 5 秒读取完整分页 `/list`，不是每秒拉所有列表/正文。无法证明该路径有与本机监测相同的发现延迟。

## 同步与数据保护

`/list` 保留并严格解析 `check_time`、`next_update_time`、`paused`。缺失/未设置时间为 `null`；只接受明确时区且日历有效的 RFC3339 时间和真正布尔值，不将字符串/数字强制转为布尔或日期。上游检查推进不等于内容生成，非空旧缓存也不等于本轮完成。

收到变化信号立即唤醒同步，不进入旧的 30 秒等待队列。缓存重查有界递减，并保留每分钟的内容复核，覆盖检查时间先变、内容随后生成，以及时间不变的正文/媒体补全。完整缓存读取每个 tick 最多两号，过期任务优先，避免多号同时变化时无限重读全文。正常 14 号未变化场景为每分钟 12 次列表检查（每页最多 50 号）及约一次/号缓存复核，启动有一次同类核对；不是每秒/每 5 秒拉 14 份全文。

现成缓存必须通过原 Provider 的稳定文章身份、号身份和可信发表时间核验。只读入库预检查跳过无需新增/补全的记录，**无变化不创建备份、不写库、不增加 revision**。需写入时仍复用每号锁、一致性备份、事务和非空保护；只将需新增/补全的文章交给原合并过程，不删除旧文或用空值覆盖正文、图片、时间、指标、笔记。

列表先保存真实元数据，正文/图片使用独立处理队列。图片补全只处理待补记录；原有正文编辑保护仍适用。00:00–05:59（Asia/Shanghai）不读取全文缓存、不启动正文媒体处理，归档循环也不再启动新的 CDN 图片请求；06:00–23:59 可消费已存在缓存。已在夜间边界前启动的网络请求仍受原超时限制。上游 paused 不读取该号缓存、不自动恢复或解除限制。不可达采用退避，恢复后读取当前缓存，不重放主动采集动作。

监测器和列表处理均防重叠。正文媒体使用原有同号锁，因此同号媒体仍在执行时，新列表入库可能等待该锁；这是实际延迟限制，不能称其为即时完成。多号同时变化、备份、SQL 以及文件系统时间戳/调度精度也影响延迟。

## 前端只读契约

两个接口均无 input，复用已有认证 tRPC query；读取不会发起上游请求、下载或写库。

`feed.cacheRevision`：

```ts
{
  revision: string;
} // "<进程 epoch>:<counter>"
```

同一进程中，Wechat2RSS 合并事务真正新增/补全文章后才增加 counter；重启改变 epoch。相同数据、上游元数据变化、检查时间变化和单纯轮询均不增加 counter。前端仅在可见、聚焦、在线时约每秒查询；变化时合并 invalidate 活跃文章列表/摘要与订阅列表，保留筛选、分页、位置和选择，不 reset。该版本只覆盖接入此通知的文章合并路径，不能宣称所有其他编辑/下载路径已自动接入。

`feed.cacheSyncStatus`：

```ts
{
  enabled: boolean;
  signal: 'metadata' | 'sqlite';
  state: string;
  lastMetadataAt: string | null;
  lastSignalAt: string | null; // DB/指纹变化提示的接收时间，非正文完成时间
  lastSyncAt: string | null;
  lastChangedAt: string | null;
  revision: string;
  complete: false;
  feeds: Array<{
    feedId: string;
    upstreamCheckTime: string | null;
    nextUpdateTime: string | null;
    paused: boolean | null;
    lastCacheReadAt: string | null;
    state:
      | 'waiting'
      | 'synced-cache'
      | 'media-pending'
      | 'paused'
      | 'unavailable';
  }>;
}
```

时间采用 ISO；null 表示未知。诊断适合选号/手动更新后读取，不需要高频查询。`synced-cache` 只表示此份缓存已处理，不能据此显示“本轮最新全部到齐”。`complete` 固定为 false，沿用近期窗口而非全历史覆盖的事实。

## 验收与延迟边界

- 离线 Jest：严格元数据、检查推进后延迟内容、原时间不变的正文/媒体指纹、多号、重启/日界、paused、不可达退避、防重叠、慢媒体、无变化备份/通知、真实 SQLite 身份合并与指标保护。
- Python 合成 SQLite/WAL：持久连接 data_version 语义、只读拒写、WAL 提交/checkpoint、Windows 文件替换、同尺寸补全、元数据先变内容后变、无变化不重复通知与轻量检查 CPU 参考。
- 可复现命令：在 server 目录运行 `pnpm test --runInBand --runTestsByPath src/feeds/cache-sync-engine.spec.ts src/feeds/cache-sync-storage.spec.ts src/collection/wechat2rss-list-metadata.spec.ts`；在项目根运行 `python apps/server/scripts/test-watch-wechat2rss-cache.py`。
- 真正端到端验收必须分别记录：现成缓存落地、首个有效变化信号、身份核验完成、真实列表保存、正文保存、图片完成、前端列表可见。合成信号测试、现存缓存隔离副本导入都不能冒充实时上游生成样本。

本补丁采用约 1 秒本机监测；合成样本可检验 2 秒发现目标，但不能据此承诺每次 2 秒入库或前端可见。远程/只读 metadata fallback 不具备同等保证。私有实际样本和分段计时仅保存在隔离验收证据，不写入公开文档。

后续增量已增加 Node fs.watch 目录提示、只读提交快照与 1s 轮询校准，详见[目录事件与批量入库性能验收](CACHE_EVENT_SYNC_ACCEPTANCE.md)。100ms 仍是优化目标，不能保证；发现、入库、正文、图片及前端可见分别计时。原一致性备份、稳定身份和旧数据保护继续保留。
