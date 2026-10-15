# 文章历史保全与备份退役清单（第一版）

旧数据库中同 ID 的正文、标题、指标或来源链接可能与现库不同。直接按文章数量或 ID 判断“已有覆盖”会丢失旧版本。本模块先把文章历史保存为独立的内容寻址归档，再验证覆盖，最后生成需要具体批次批准的只读退役清单。

入口是 `apps/server/scripts/article_history.py`，三个接口为 `prepareArchive`、`verifyCoverage`、`planRetirements`。此分支只增加脚本、合成测试、文档和独立 CI；通过 JSON 清单接口与空间守卫/PR39 衔接，不修改服务、调度器、数据库 schema 或 PR39 的工作区。

## 用户可见行为

- 每个源库的每一篇文章都有原始 UTF-8 正文、全部非正文文章字段、来源库身份和阅读页。相同正文按 SHA-256 去重；同 ID 的不同正文、元数据不同的版本均保留。SQLite BLOB 元数据用带类型标记的 base64 保存，`NULL` 正文另有标记。
- 阅读页明确是历史版本。原正文中的链接保存在原文和元数据中；跨 ID 不凭标题猜合并，旧 ID/来源链接随旧版本独立保留。阅读页禁用脚本、事件处理器和外部内容。
- 正文和 `pic_url` 封面中的内嵌图片严格解码，本地图在显式允许根目录内复制为内容寻址资产。浏览器真正解码像素。有效 `src` 优先于陈旧的远端 `data-src`。
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
