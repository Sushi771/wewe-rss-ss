# 技术方案与部署边界

2026-10-09 · 依据当前代码与公开资料 · [返回总览](../PAID_MULTIPLATFORM_PLAN.md)

## 当前核查结果

本轮起始本地分支 `codex/manual-refresh-download-integration`，基线 HEAD `3cb538ea7e483aa50c0423214f5d8b7f15dfd9c1`；本轮开始时工作区干净。origin 的本地跟踪引用为 `4c726ab`，没有重新取远端或发布。新增文档不等于当前 HEAD 有新的远端 CI。

已读 AGENTS 和当前私有交接，并按本轮最新用户方向调整方案。checkout 不存在 `.agents` / `.agents/skills`，Git 无其他 `SKILL.md`；默认用户目录下未发现 Codex memories。Sites 技能仅用于托管边界说明，本轮不创建站点。

2026-10-09 只读环境检查：没有 4000 监听；Docker CLI 不在 PATH，不能据此断言任何 Docker 文件都不存在；`wsl --status` 与 `wsl --list --verbose` 明确返回未安装 WSL。没有启动服务、安装软件、迁移库、启用来源、改定时、清停止或产生平台请求。

## 代码证据与复用矩阵

| 能力           | 具体文件/符号                                                                                                                                                                                                                                                          | 实际边界                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 微信源接口     | [`subscription-provider.ts`](../../apps/server/src/collection/subscription-provider.ts)：`SubscriptionProvider/ProviderArticle/assertProviderPage`                                                                                                                     | 当前 Provider ID 是 wechat2rss/public-album；微信 canonical 验证，不能直接装小红书                              |
| 付费微信适配   | [`providers/wechat2rss.ts`](../../apps/server/src/collection/providers/wechat2rss.ts)；[`provider-article.ts`](../../apps/server/src/collection/provider-article.ts)                                                                                                   | 私有地址、`k` 秘密、限体积响应、JSON Feed 清洗；仅代码/历史离线证据，当前实例未实测                             |
| 明确来源路由   | [`provider-registry.ts`](../../apps/server/src/collection/provider-registry.ts)；[`collection-channel.ts`](../../apps/server/src/collection/collection-channel.ts)：`resolveCollectionRoute`                                                                           | 已保存来源优先，env allowlist 仅适用于未保存来源；未知值拒绝回退                                                |
| 新增入口优先级 | [`trpc.service.ts`](../../apps/server/src/trpc/trpc.service.ts)：`subscriptionAddCapability/addSubscriptionFromArticle`                                                                                                                                                | 省略来源时 native discovery 优先；本轮本地后端增加显式 native/Wechat2RSS 选择，无自动回退，尚未部署             |
| 归档/旧数据    | [`collection.service.ts`](../../apps/server/src/collection/collection.service.ts)：`collectWechat2RssRecent`；`TrpcService.recordCollectionResult`                                                                                                                     | 原刷新先备份，再写尝试/回执；异步受理＋15 分钟请求保留；仅 recent-window，不支持分页全史                        |
| 正文图片       | [`archive-provider-images.ts`](../../apps/server/src/collection/archive-provider-images.ts)；[`image-fetch.ts`](../../apps/server/src/collection/image-fetch.ts)                                                                                                       | 当前白名单是微信 CDN；每图 10MB、每篇 60 图/20MB，格式/结尾检查并非完整图像解码。不能全局放开任意域名来接小红书 |
| 保存/ZIP       | [`article-export.ts`](../../apps/server/src/article-export.ts)：`buildArticleMarkdown`；[`offline-export.controller.ts`](../../apps/server/src/offline-export.controller.ts)；[`article-download.controller.ts`](../../apps/server/src/article-download.controller.ts) | 微信正文选择器和 URL 限制、原本机保存器、按号 ZIP；缓存缺失有路径会请求原文，跨端缓存导出必须加不联网门禁       |
| 数据模型       | [`schema.prisma`](../../apps/server/prisma/schema.prisma)                                                                                                                                                                                                              | Feed/Article 是公众号语义；建议追加独立小红书表，不迁移或重命名旧表                                             |
| 私人访问       | [`private-access.ts`](../../apps/server/src/private-access.ts)；[`trpc.router.ts`](../../apps/server/src/trpc/trpc.router.ts)：`createContext`                                                                                                                         | 应用 cookie/Origin 与 socket 本机检查；仅转发到 loopback 不能证明远端调用获得本机人工权限                       |
| 部署/探针      | [`docker-compose.wechat2rss.yml`](../../docker-compose.wechat2rss.yml)；[预检脚本](../../scripts/acceptance-wechat2rss.cjs)                                                                                                                                            | Compose 绑定本机 18080；镜像固定值是历史版本，采购后重核。脚本默认不联网，`--execute` 才真实读实例，本轮未执行  |

历史微信正文、实际图片和原保存器已验收的能力可以复用；它们不证明小红书图片已支持，也不证明新的付费来源现在可用。无需重写已验证的保存器、全部旧数据或桌面启动工具。

## 供应商证据与采购门槛

2026-10-09 仅查公开页面，以下是供应商说明，非本项目实测。

| 来源          | 当前证据                                                                                                                                                                                                                                             | 接入前门槛                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wechat2RSS    | [购买页](https://wechat2rss.xlab.app/deploy/)写软件订阅 ¥15/月或 ¥150/年，需自行部署；[API 参考](https://wechat2rss.xlab.app/deploy/api)有订阅、异步更新、JSON Feed 和日期过滤；[Q&A](https://wechat2rss.xlab.app/deploy/qa)说明近期窗口、群发及延迟 | 当前镜像版本/授权/正常账号/实例配置；真实原文身份、全文、图片和后续新增。未抓历史和非群发须保留缺口；供应商自身后台重试/扫描也需核清，不能声称整体仅手动一次请求           |
| Rnote A       | [托管文档](https://rnote.dev/docs/guide)列发布列表游标、图文详情和 header 鉴权；[定价页](https://rnote.dev/pricing)用于采购时重核                                                                                                                    | 完整列表/详情 schema 实样、真实分页终止、发表时间、正文图序和图片字节，当前套餐/余额/费率与限流                                                                            |
| Web＋蒲公英 B | [源码页](https://rnote.dev/source)标价 $200 打包，Web 核心是签名层；蒲公英需自备正常账号，源码按现状提供、无可用性保证                                                                                                                               | 用户邮件确认实际作者发布列表/分页/图文详情覆盖；私人归档用途是否在许可范围；启动/维护方式、续费或外部服务依赖、账号/网络条件。未取得源码或运行证据，A 的合同不自动适用于 B |

B 的公开条款限定学习研究用途，这是具体适用范围缺口，应由供应商回复确认；不把购买完成当作适用于本产品。自动登录、自动过验证、互动和发布不纳入本项目，遇限制停止，正常验证由用户处理。源码可下载不等于运行独立或无需维护成本。

## 推荐的增量架构

```text
私人 Sites 页面
  └─ Sites 服务端：owner 权限、最小任务/展示数据（候选）
       ↕ 本机主动 HTTPS 连接（方案候选，未启用）
本机任务桥 → wewe-rss-ss 业务编排 → 明确选定来源
                              ├─ Wechat2RSS 本机私有实例
                              └─ Rnote A 或已确认可用的 B
              ↓
      SQLite 主库＋可信图片缓存 → 原 Markdown/附件/ZIP 接缝
```

推荐评审“本机主动连接 Sites 的最小任务桥”，避免开放主应用全部路由。Sites 的 owner-private 边界、结构化存储/文件存储能力已由技能说明确认；本项目连通、配额、大文件和实时行为未验证。任务桥只领取用户明确提交的未过期任务，周期读取队列不等于定时采集；不允许无人点击自动创建采集任务。此桥属于后续新增功能及持久连接，用户审阅后再做，不改变本轮定时策略。

任务桥不可成为任意本机执行器：只接内部作者 key、受限动作和已确认预算；不接 shell、绝对路径、任意 URL/HTML 或平台会话。领取前核本机来源与用户权限，记录 lease/attempt；过期或状态不确定的收费请求不自动重放。Sites 服务访问秘密与供应商 Key 分开，均不进浏览器。

若跨端需要在电脑离线时读全文，必须把最小正文/图片副本同步到私人云端；Sites 页面本身无法读本机磁盘。建议 SQLite 继续是主库，Sites 仅存任务、展示 DTO 和用户选择的缓存副本。D1/R2 是技能支持的候选，尚未 provision；同步范围、容量、清理和费用待用户确定。若拒绝云端副本，则另行选受保护实时连接，离线仅显示元数据，不能承诺跨端全文。

不选择浏览器直接请求 `http://127.0.0.1:4000`：在手机上指向手机自身，云端 Worker 也不能读主机 loopback。Tailscale 私网本身不会自动使 Sites Worker 成为 tailnet 成员。受保护的窄 HTTPS 网关是备选，需单独授权和验证；本轮不配置隧道或改变监听。

## 平台与保存边界

Wechat2RSS 本机容器与主应用分离，18080 仅 loopback，不对公网暴露管理接口；token 注入服务器私有配置。用现有 Windows 本机运行包作为业务主服务，不为付费来源整体搬到 Linux/VPS。Docker/WSL 的安装和正常账号授权安排在预算及部署同意后，不是本轮自动动作。

小红书先新增平台身份和内容模型，再做薄 adapter。媒体实际域名/签名失效方式需供应商样例；保留平台域名白名单、禁跳内网、限响应、校验实际图片字节。缓存成功后复用 Markdown 转换、附件相对路径、受保护 ZIP；微信 `saveVerifiedArticle` 的 ProviderArticle/URL 校验不能直接接任意小红书数据。已有本机目录及保存设置不改，另加适配而非重做保存器。

Sites Worker 是托管 HTTP 服务，不是 Windows/Nest/Prisma SQLite 的直接运行环境；原库、迁移及磁盘保持本机。不能把当前仓库直接上传 Sites 并宣称部署完成。

## 部署验收与回滚

后续部署需：准确源码/锁文件/镜像版本记录 → SQLite 一致性备份 → 副本迁移与合成回归 → 真实接口小范围验收 → 不可变包启动/失败回退 → 完整身份保护的本机受控切换 → Sites 权限和跨端读取检查。来源先单号启用，不能自动全库换来源。新增表/任务桥开关默认关闭，旧停止及定时保留。

回滚要保留追加表中的新图文与已写附件；不要为退应用版本直接还原旧数据库并丢掉新内容。先确认旧运行包可读追加 schema；不兼容时停止新功能并用向前修补，恢复备份仅经数据差异核验。云端迁移与本机迁移分别记录，Sites 发布失败不等于云迁移未发生。

现有 [VPS 操作卡](../PRIVATE_ONLINE_DEPLOYMENT.md) 是历史方案，不按其中云服务器采购/发布步骤执行。本轮边界为本地文档与采购前最小离线代码；没有部署或真实付费请求。

本轮新增隔离原型入口使用现有 React/NextUI，无 App 路由、tRPC、代理或连接配置；打包为 inline JS/CSS，交付页 CSP 禁止网络连接。构建脚本不启动服务器；此原型不能证明 Sites、媒体下载或真实保存可用。实际浏览器工具未提供，只有状态、结构与构建核验。
