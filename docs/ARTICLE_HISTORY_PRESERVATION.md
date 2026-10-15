# 文章历史保全与备份退役清单（第一版）

旧数据库中同 ID 的正文、标题、指标或来源链接可能与现库不同。直接按文章数量或 ID 判断“已有覆盖”会丢失旧版本。本模块先把文章历史保存为独立的内容寻址归档，再验证覆盖，最后生成需要具体批次批准的只读退役清单。

归档入口是 `apps/server/scripts/article_history.py`，三个接口为 `prepareArchive`、`verifyCoverage`、`planRetirements`。宿主入口为 `article_history_host.py`，已接入现有 snapshot owner 的私有 stdio 和服务内部维护 API。功能默认关闭，无自动调度或删除执行器；不改数据库 schema、PR39 工作区或正在运行的生产发布。

## 用户可见行为

- 每个源库的每一篇文章都有原始 UTF-8 正文、全部非正文文章字段、来源库身份和阅读页。相同正文按 SHA-256 去重；同 ID 的不同正文、元数据不同的版本均保留。SQLite BLOB 元数据用带类型标记的 base64 保存，`NULL` 正文另有标记。
- 阅读页明确是历史版本。原正文中的链接保存在原文和元数据中；跨 ID 不凭标题猜合并，旧 ID/来源链接随旧版本独立保留。阅读页禁用脚本、事件处理器和外部内容。
- 正文和 `pic_url` 封面中的内嵌图片严格解码，本地图在显式允许根目录内复制为内容寻址资产。浏览器真正解码像素。有效 `src` 优先于陈旧的远端 `data-src`。
- HTML 的旧写法 `<image>` 按 `<img>` 处理，本地和内嵌像素同样归档。图片按钮 `input type=image`、其他未支持的带来源元素、重复属性及未闭合标记按无法证明覆盖处理，`verified=false`、退役候选为空；完整注释和转义后的示例文字不会被当成图片。浏览器对照单独检查图片按钮，不能仅依靠 `document.images`。
- 历史远端图片没有原始像素时标为未知，不请求 CDN、不伪称完整离线图片覆盖。默认阻断退役候选；宿主必须显式记录用户接受这一限制，才能传入 `accept_external_unknown=True`。
- 缺图、损坏、未支持的 `srcset`/CSS/SVG 图片、待补图标记、源文件变化或归档损坏会阻断候选。空 `img` 标签保留在原文，阅读页显示占位，按未知图片引用阻断候选。
- 归档仅覆盖微信文章及选定 feed/group 上下文。不读取 accounts、Cookie、凭据表，不宣称归档覆盖整个数据库的恢复需求。

## 本地使用

需要 Python 3.12+、Node 24、Chrome/Edge。可用 `ARTICLE_HISTORY_CHROME` 指定浏览器可执行文件。命令不会请求上游；浏览器只访问自身临时 loopback 阅读服务，并拦截任何其他页面资源请求。

```powershell
python apps/server/scripts/article_history.py prepare `
  --source C:/review-backups/old.db `
  --source-root C:/review-backups `
  --current C:/protected-snapshot/owner.db `
  --archive C:/article-archives/batch-001 `
  --media-root C:/approved-local-media
python apps/server/scripts/article_history.py verify --archive C:/article-archives/batch-001
python apps/server/scripts/article_history.py plan --archive C:/article-archives/batch-001
```

路径仅为示例。`current` 优先使用已经验证、受保护且不变的现成 owner 快照。模块不会创建整库副本。目标归档必须是新目录，且在声明的退役根目录之外。已有归档不会被覆盖。输出含私有来源路径/原文/链接，应保存本地私有位置，不上传 GitHub 或共享 CI。

`prepare` 成功不等于允许删除；`verify` 成功只证明当前输入下的文章保全和浏览器解码。CLI `plan` 缺少宿主恢复点和其他表的覆盖证明，默认输出空候选。这是安全的独立诊断入口。

## 接口与宿主清单契约

```python
prepared = prepareArchive(
    sources=[old_db], current=existing_owner_snapshot, archive_root=new_archive,
    source_roots=[review_root], media_roots=[local_media_root],
)
verified = verifyCoverage(prepared["archive"])
plan = planRetirements(
    prepared["archive"],
    protections=[
        {"role": "owner", "identity": owner_identity,
         "verificationSha256": owner_verification_receipt_sha},
        {"role": "previous", "identity": previous_identity,
         "verificationSha256": previous_verification_receipt_sha},
    ],
    non_article_coverage={
        "manifestSha256": prepared["manifestSha256"],
        "verificationSha256": host_other_state_coverage_receipt_sha,
    },
)
```

`database_identity(path)` 返回主文件和 WAL/journal 的路径、device/inode、字节数、纳秒 mtime/ctime。Windows 使用新鲜 `Path.stat()`，拒绝 reparse/symlink 和多硬链接文件。宿主传入的 `verificationSha256` 是宿主独立验证回执的摘要引用，不是本模块验证了 SQLite 全库恢复性的声明。宿主必须持有、核验、固定这些回执，并重新验证迁移/部署/活跃租约等额外保护；不能把用户随意构造的 JSON 当恢复证明。

必须有两个不同的、角色分别为 owner/previous 的已验证恢复点。其他表/状态的覆盖由宿主独立证明，并绑定本次归档 manifest 摘要；文章归档不能替代这个证明。额外必要恢复点可作为同角色附加保护回执传入，都会排除其文件。

返回的清单包含：

| 字段                                 | 含义                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| `manifestSha256`                     | 归档清单的精确摘要                                   |
| `eligible`                           | 本次输入下可交给宿主审核的精确源文件身份、大小和行数 |
| `heldReasons`                        | 阻断原因；任意阻断时整个批次候选为空                 |
| `coverage`                           | 刚刚重跑的覆盖与离线浏览器验证结果                   |
| `protections` / `nonArticleCoverage` | 本次宿主证明引用                                     |
| `batchSha256`                        | 对完整清单（除摘要自身）规范 JSON 的 SHA-256         |
| `requiresSpecificBatchApproval`      | 固定 `true`                                          |
| `executable`                         | 固定 `false`                                         |

本模块没有 `apply`、`delete`、自动清理计划或服务后台任务。PR39/未来宿主若接入执行器，必须针对精确 `batchSha256` 获取具体批次批准，并在执行前重新验证归档、恢复点、源文件身份和所有租约，使用宿主自己的原子文件身份门禁。本版不会实施这一执行器，也不改变既有批准门槛。

## 一致性、完整性和资源限制

同一只读 SQLite 连接在第一条读取前和最后一行物化后采样 `data_version`，每次两行 keyset 分批读取并释放 SELECT，不开启长读事务。前后核验主库/WAL/journal 身份，任何提交或替换均拒绝发布。归档发布前再检查全部源和现库。验证器重新读取源行、逐行核对正文/全部元数据/上下文与 ledger，随后关闭连接才运行浏览器。规划会重新验证归档并重查源/现库/受保护恢复点，不接受旧的浏览器报告。

对象写入新建 `.article-history-building-*` 私有目录，最后才发布 `manifest.json` 并把目录改名到目标。失败的有限临时目录不能取得退役资格；不会为清理失败而删除数据库或其他未知文件。操作者可在确认目录身份后手工处理未完成归档。

默认累计读写预算 128 MiB，最多 64 个源库、每库十万篇文章、单 SQLite 值/文件 32 MiB、每类上下文一万行、浏览器最多 128 个独立阅读页和 180 秒。超限停止并输出无候选；按小批次操作或显式调整读写预算，不自动提高限制。清单自身读取上限 16 MiB。只复制文章对象和必要图片，不复制整库。

本版采用保守保全：将候选源中全部文章对象归档，正文相同可去重。不会仅因为现库有同 ID 就省略历史字段，也不会把没有实际原始像素的外链说成已恢复。暂不做跨 ID 永久链接自动归并、XHS 视频归档、CSS/srcset 图片重写、内容差异 UI、在线抓图或全库恢复执行；这些缺口不得靠本版清单绕过保护。

## 验收

```powershell
$env:ARTICLE_HISTORY_BROWSER_REQUIRED='1'
cd apps/server/scripts
python -m unittest test_article_history -v
```

全部数据库均为测试临时目录中的小型合成库，图片为一个像素。覆盖正文新旧版本、元数据独立版本、跨 feed/旧 ID 独立保留、内嵌/本地图去重、外链未知、损坏与路径穿越、待补图标记、归档篡改、遗漏 ledger、源替换、WAL 写入/检查点/快速改回、预算中止、必要恢复点及默认无候选。独立 CI 在 Windows 和 Linux 上运行真实浏览器，验证有效 PNG 解码成功、签名正确但像素损坏的 PNG 解码失败、零远端资源请求。单元用例中的 browser mock 只用于状态组合，不能代替这一真实集成验证。

## 宿主接入：从真实状态生成证明

服务内部入口位于 `src/collection/sqlite-snapshot-guard.ts`：

```typescript
const result = await reviewArticleHistory([oldDatabasePath]);
// 展示 result.review 的完整路径、大小、SHA、阻断原因和 batchSha256。
// 用户明确批准该批次后，仍只执行重新校验，绝不删除：
const checked = await validateArticleHistoryApproval(result.review, {
  action: 'permanent-delete-exact-files',
  batchSha256: result.review.batchSha256,
  paths: result.review.eligible.map((entry) => entry.identity.main.path),
  approvedAtEpoch: Math.floor(Date.now() / 1000),
});
```

这两个调用通过现有持锁 owner 的私有进程管道运行。Node 使用实际 `sqliteWrites.snapshot` 排他准入，在持有准入期间读取 `activeVerifiedBackupReferences()` 的真实进程内复用缓存，发送运行时引用后再发审核请求。缺少这个同步时宿主拒绝生成候选；磁盘 JSON、调用者自填 SHA 或独立归档模块的成功结果不能代替它。当前普通导出只使用现库，现库始终保护；未来会读取候选备份文件的恢复/导出/迁移工作必须在入队前调用 `pinArticleHistoryReference(token, path)`，完成后调用 `unpinArticleHistoryReference(token)`。不得在已持有写入/备份准入的回调内部再次调用这些维护 API。

宿主从实际 owner 内存记录获取 generation、snapshotGeneration、源身份和已验证快照摘要，重新检查 owner 锁、诊断文件与内存字节、data_version 和 freshness。存在未快照写入或 dirty 状态时立即阻断；审核不调用 `tick`、不强制创建快照、不修改现库。它使用现成 owner 快照及受信进程配置选定的 previous 点，分别执行全文件 SHA 和 SQLite integrity_check / foreign_key_check；两点必须是不同物理文件、无 WAL/SHM/journal。配置者必须选定该数据库的必要恢复点，不能把任意请求携带的路径或磁盘回执当恢复点授权。

非文章覆盖不再由调用者填写摘要：宿主读取候选及两个恢复点的实际 SQLite schema 和全部非 `articles` 表，包括账号、队列、订阅及其他状态；只在内存对原始行做哈希和重复行计数。某候选的所有非文章行及其 multiplicity、全部 schema 必须能由**同一个**保留点覆盖，不能把互不兼容的两个状态拼成证明。不同 schema、独有账号/队列值、重复行缺口等都阻断。原始非文章值不会写入审核报告、归档或日志。

## 引用目录、占用和配置

启用需要受信服务配置 `SQLITE_ARTICLE_HISTORY_REVIEW_ENABLED=1`、`SQLITE_ARTICLE_HISTORY_MAINTENANCE_WINDOW=1` 与 `SQLITE_ARTICLE_HISTORY_HOST_CONFIG`。维护窗口开关是强制前提，操作者需先暂停普通采集和备份文件消费；缺少任一开关都拒绝维护操作。默认值不改变既有服务行为。配置示例只表示接口，不会在本 PR 中应用到任何生产环境：

```json
{
  "sourceRoots": ["C:/review-backups"],
  "recoveryRoots": ["C:/verified-recoveries"],
  "previous": "C:/verified-recoveries/previous/wewe-rss.db",
  "archiveRoot": "C:/private-article-history",
  "referenceFiles": ["C:/app/.local-releases/active.json"],
  "mediaRoots": [],
  "maxReadBytes": 268435456,
  "seconds": 240,
  "archiveBytes": 134217728
}
```

`referenceFiles` 必须包含适用于该实例的发布、迁移、人工保留和排队操作记录；不能用无关空目录宣称没有引用。宿主还会重扫这些文件的父目录、源/恢复根和候选父目录的 JSON 文件，绑定目录清单、文件身份、字节摘要及内存引用 generation。新记录出现、内容变化、缺失记录、未知 JSON 格式、维护锁或不可读目录均阻断，不静默忽略。支持：

- 实际 `.local-releases/active.json` 的 `{"format":1,"id":"..."}`：解析到同目录下的发布子目录，检查 `release.json` ID，保护整棵目录。
- `{"format":"article-history-references-v1","paths":[...]}` 或既有 `sqlite-retention-protected-v1`：保护绝对路径、相对记录所在目录的路径和本地 `file:` URI，目录引用保护整个子树。空 `{}` 和未知格式会拒绝。
- owner/latest 指针中的 `backup` 路径；候选父目录内带明确 `sqlite-recovery-origin-v1` 的 verification 记录，`protected` 来源保持保护；来源不明的旧记录不会取得退役资格。

Windows 使用只查询的 Restart Manager 接口直接核验候选与两个恢复点的占用，不接受外部提供的“无人占用”JSON。查询失败、有人占用或结果过期都阻断。当前 Linux 未实现具有完整跨用户可见性的资源查询，因此宿主候选保持空；独立离线归档/图片验证仍可运行。不要把 Linux 的归档成功解释为已证明可退役。

默认宿主累计读取预算 256 MiB、240 秒，最多 16 个候选；显式配置上限为 16 GiB、300 秒，归档仍有独立预算。超限失败，不自动提高预算、不复制整个数据库。维护审核会占用排他准入，应用写入可能等待或按既有等待上限失败；此功能为显式维护调用，不能放入普通刷新或定时任务。本次仅做小型合成验收，没有对真实大库扫描、发布或启用。

外键检查在初审和批准复验中都实际查询 SQLite，不接受调用方提供的布尔回执。`integrity_check=ok` 仍可能存在外键违规；任意一条 `foreign_key_check` 结果或执行错误都会阻断审核，适用于 owner、previous 及候选库。批准复验重新检查两个恢复点，而不是只相信首次文件摘要；检查沿用读取预算和 SQLite 进度超时。

## 精确批准与验收边界

宿主清单含每个候选的精确文件身份、字节数及全文件 SHA、恢复点证明、非文章覆盖摘要、owner generation、引用目录摘要、即时占用查询、归档 manifest SHA 和完整 `batchSha256`。Windows file index、纳秒时间等超过 JavaScript 安全整数范围的值使用十进制字符串，确保 Node/Python 往返不丢精度。清单有效期 300 秒；只认同一 owner 进程内实际签发的精确清单，新审核替代旧审核，重启后旧批次失效。

批准必须精确匹配 `permanent-delete-exact-files`、批次 SHA、完整路径集合及批准时间。验证阶段重跑归档/浏览器、源全文件 SHA、恢复点完整性、运行时/磁盘引用、资源占用，并在结束时再次检查文件、归档和到期时间。返回值仍是 `executable=false`、`permanentDeletionPerformed=false`；未来执行器还必须核验批准来源、重新检查每个实际文件句柄和活动引用。这里没有永久删除操作，也不会把历史删除批准扩展到新批次。

新增宿主验收使用真实 `SnapshotGuard`、真实 Node `SqliteWriteCoordinator` 和复用缓存、私有 stdio、真实离线浏览器及 Windows 原生占用查询；数据库均为几十 KiB 的合成样本。Node 端到端覆盖清单跨语言往返及具体批准的重新校验。其他用例覆盖独有非文章状态/重复行/缺失表、伪造 owner 诊断、未快照写入、未知引用目录、真实发布指针、相对路径/URI、新引用出现、恢复点变化、未知占用与预算中止。非 legacy 构建显式携带全部宿主脚本；本 PR 不构建或切换生产发布。
