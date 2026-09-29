# 自建微信读书订阅：当前精简交接（2026-09-29）

## 接手事实

- 当前执行入口是 [私人线上自主管理订阅任务](PRIVATE_ONLINE_DELIVERY_TASK.md)与 [自建路线证据](WEREAD_SELF_HOSTED_RESEARCH.md)；[完整客户端审计](WEREAD_CLIENT_FLOW_AUDIT.md)是旧实验事实来源。用户已暂停 Wechat2RSS 采购、授权与部署，改以可审查、可自行构建部署、无第三方开发者闭源中转的微信读书订阅核心为主线；旧付费部署卡和 [Provider 设计](SUBSCRIPTION_PROVIDER_DESIGN.md)仅作历史参考。本轮接手时本地 `main` 为 `695288e`、远端领先一个 README 提交；已快进到 `fd53f81`，原工作区干净。下次接手重新核对工作区与远端。
- 本机实际生产库 `apps/server/data/wewe-rss.db` 只读核对 `quick_check=ok`，12 个订阅、1447 篇文章、44 篇缓存正文；目标 `MP_WXS_3895431412` 原库有 194 篇不同 ID、194 个非空发布时间、20 个 `verified_source_url`，仅可用作比对基线，**不是新来源取到五篇**。`provider_refresh_attempt_time` 列尚未进生产。没有生产写库或服务切换；本轮只有下述两次官方 Gateway 只读请求。
- 用现有在线备份脚本生成一致性备份，报告 `integrityCheck=ok`、12/1447、SHA-256 已核对；备份仅在 Git 忽略的 `output/subscription-implementation/backups/`。又从生产 SQLite 在线复制隔离库，应用新增迁移后比较 `feeds` 和 `articles` 所有旧列逐行摘要，完全一致、`quick_check=ok`。隔离库额外加入一篇测试文章用于 ZIP 验收，绝非真实上游文章。
- 用户此前明确没有现成服务器或域名，现不以租服务器或取得 Wechat2RSS 授权为研究前提；其私有实例未启动。已新建 Git 忽略的 `.env.weread-gateway`，本人已填腾讯官方 Agent API Key；代理不得读取或输出 Key 原值。Windows 旧配置保留，WSL/Docker 不是研究前置。当前窗口实际模型/思考设置无可查询的已应用值，记为未核实。

## 已有证据的缺口与本轮研究

- 真正实测的旧流程：本人墨水屏同类客户端扫码、`/login`、书架与续期成功，目标 `MP_WXS_3895431412` 的 `/mp/chapters` 首屏仍 HTTP 499 / `-2041`；Node Web 人工验证后 `/web/mp/articles` 仍 `-2041`；本人官方 Edge 书架成功、Reader 自发同一 Web 列表首屏为 HTTP 200 / 业务 `-2041`，后续验证码没有成功响应记录。旧 `weread-omni` 只做源码对照，未运行。失败仅覆盖本人账号、目标号、当时时点与已测流程，不能推永久关闭、所有账号/号或所有自建路线。旧脱敏摘要没有保留官方 Reader 请求头，`x-wr-ticket` 是否存在或有效未知。
- 逐项读公开取文源码：`wechrss` 仍走旧 `/mp/chapters`；`weread-mp` 和 `we-mp-rss` 的新模式仍走旧 `/web/mp/articles`，后者近月另一用户取得真实 reviewId，反证“全球永久关闭”，却不是本目标成功。`we-mp-rss` 的 `/api/mp/cover` 只取最新一篇，入库时间是抓取时刻，不能满足五篇及可信发布时间门槛。KOReader 票据说法仅是未附成功输出的假设。PC 微信加 MITM 路线排除；WeWe/Wechat2RSS 的闭源中转或授权依赖不符合新目标。来源与边界见 [研究记录](WEREAD_SELF_HOSTED_RESEARCH.md)。
- **官方 Gateway 两个假设已实测并停止**：其服务端未开源，本项目自建调用侧可直连腾讯而无第三方开发者中转。本人私有 Key 下，目标 `/book/chapterinfo` 请求一次得到成功但 `chapters=[]`，故没有第二个 `/book/info` 请求；准确号名 `scope=4` 搜索一次得 HTTP 499，未见文章结果，也没有重试。首次受限网络尝试仅是传输失败，无 HTTP/业务响应，随后允许联网才有上述两项结果。这些结果不说明其他账号、目标或关键词的情况，更不是 `-2041` 的通用解释。下一条最有依据的源码线索是旧 `/book/articles`：2023 开源实现确实取 `MP_WXS_*`，2026 客户端端点目录仍列出不同服务类的该路径，却没有近期成功回包或本目标五篇证据。仅继续只读核查；无生产写库。

## 保留的实现与验证（前轮）

- 新增 `PRIVATE_ONLINE_MODE=1`：至少 24 字符登录码换取 HttpOnly、Secure、SameSite 严格会话 cookie，匿名 RSS、文章 API、图片代理、ZIP 下载和私有页面被挡住；登录页/静态资源可加载。线上禁用旧微信读书账号管理/登录接口，不把上游凭据交给普通站点使用者。
- 新增 `GET /download/feed/:id.zip` 与“下载本号 ZIP”：浏览器得到附件响应，Markdown 引用相对路径 `attachments/` 图片；每号 `README.md` 明示完整/未完整数。只有有缓存正文且附件成功落地的篇目计为完整；旧库很多正文缺失，不能宣称全部可离线阅读。线上隐藏旧服务器目录导出入口。
- Wechat2RSS Provider 在保存正文前受限下载并内嵌允许的图片，图片失败则保留旧正文、新正文标为缺失以便重试；容器网络的固定服务名 `wechat2rss` 纳入私有地址校验。真实上游字段、图片和目标号仍待实测。
- 新增单机 Docker Compose 线上配置：主应用与固定 digest 上游分别持久化，只绑定 `127.0.0.1`；Tailscale Serve 提供私人 HTTPS。部署脚本在迁移前备份并停应用；备份脚本对 SQLite 在线备份、上游数据短暂停机归档。本机无 Docker；GitHub Actions 的 `private-image` 已成功构建 `Dockerfile.private-online`，尚未做容器运行验收。
- 前轮曾形成 DigitalOcean + Tailscale + Wechat2RSS 的 [部署操作卡](PRIVATE_ONLINE_DEPLOYMENT.md)；该方案现已暂停，仅作历史工程资料，尚未购买或部署。
- 本机 HTTP 验收使用迁移后的隔离库和测试文章：匿名内容路由 401、私有页 302 登录、错误登录 401、成功登录后 RSS 200、ZIP 200；下载的 47 MB ZIP 经过解压检查，570 个条目中 157 个 Markdown 图片引用对应 ZIP 内相对路径文件。所选旧号 195 篇中 28 篇离线完整、167 篇明确标未完整（含一篇测试夹具）。这仅证明副本上的下载与保护链路。
- 服务端完整 Jest **18 套 / 148 项通过**，服务端与网页构建、两端 lint、格式与 Git diff 检查通过。隔离库上的本机 HTTP 验收在服务重启后复测，六类匿名入口被拒、旧账号接口 403、RSS 200、ZIP 200。远端 [CI 运行 36521304651](https://github.com/Sushi771/wewe-rss-ss/actions/runs/36521304651) 的 `lint-test` 和 `private-image` 均成功；Docker 镜像已构建，尚未在目标服务器运行。

## 下一步与门槛

1. 隔离探针与 10 项 Mock 测试通过，两个官方入口的真实结果见 [实验记录](WEREAD_SELF_HOSTED_RESEARCH.md)；目前均未取得五篇。下一项聚焦 `/book/articles` 的近期真实公众号回包、维护者复测或官方说明；历史源码与端点目录不足以启动第三次私人网络实验。取得能核对身份、文章 ID 和发布时间的新证据后，才设计一次本人授权的低频验证；同一受限请求不重试。
2. 首先证明目标号至少 **5 篇真实不同文章**的公众号身份、稳定文章身份、原文链接和**发布时间**；五篇是样本而非上限。达标后再验证分页、正文、图片和持续新增。章节 `updateTime` 不是发布时间，旧库/Mock/请求受理不是新来源成功。近期订阅与订阅前全史独立记录。
3. 只有上述真实门槛通过，才将新模块接入现有 Provider；先在 SQLite 一致性副本测试重复更新、旧字段保护、离线 ZIP 与重启，再核验备份并决定生产切换。最终还需干净环境构建部署、私有凭据、依赖版本追溯、故障诊断、回归测试及全部旧文章/导出保留；当前无线上可用入口。
4. 每个实质单元跑相关测试、查敏感文件、提交推送并核远端 CI。有可执行研究就继续；仅余用户正常登录/官方验证或其他外部条件时保存检查点、列明缺口，不再反复修改报告或自动转回付费方案，也不创建空转后继任务。
