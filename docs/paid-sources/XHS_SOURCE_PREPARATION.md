# 小红书源码买断方式：本机接入准备

2026-10-09，用户明确选择 **Rnote Web＋蒲公英合售源码包（200美元）**，明天先用同一产品的免费测试 Key。本轮落实本机准备；明天正常核对测试产品标识和实际接口版本。尚未审查实际交付包；选择路线不代表收包、部署或真实图文验收已经完成。

## 官方说明与实际待核合同

| 项目       | 当前有依据的事实                                                                                                               | 收到包后仍需核实                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| B 交付范围 | [官方源码页](https://rnote.dev/source)列 Web＋蒲公英打包销售，含源码、Dockerfile、Compose、中文文档和内置 Swagger/API Key 体系 | 实际包版本、校验值、文件清单、构建依赖和启动步骤；尚未取得实物，不以销售说明代替验收               |
| Web 能力   | 官方说明核心是签名层，接口可自行扩展                                                                                           | 包内是否已有作者发布列表、分页和完整笔记详情；不能把签名实现当成完整订阅适配                       |
| 蒲公英依赖 | 官方说明运行时需自备已登录账号 Cookie，不提供账号                                                                              | 包内实际正常登录及凭据保存方式、账号/网络条件与运行依赖；此阶段不读取或搬运浏览器 Cookie           |
| 使用范围   | 官方源码页限定协议分析、安全研究及技术学习，按现状交付，不保证可用性                                                           | 私人正文、图片及视频归档用途是否获许可，供应商维护与持续依赖；购买选择本身不能证明适用许可         |
| 接口合同   | 尚无本轮 B 实际 Compose、Swagger 或脱敏成功响应                                                                                | 服务地址、鉴权字段、作者/笔记 ID、发表时间及单位、分页游标/终止、完整正文、全部媒体和收费/失败语义 |

以上官方说明为公开资料核查，不是供应商代码运行结果。A 的[托管指南](https://www.rnote.dev/docs/guide)、公开 OpenAPI 和响应描述不能自动作为 B 的私有实例合同。

## 已有接缝与本轮可做项

现有本机页面、待接入博主管理、单层文件夹、内部身份/分页去重、SQLite 缓存及原保存器接缝已实现。内部订阅来源 `XHS_SOURCE` 和单篇来源 `XHS_SINGLE_SOURCE` 默认未注册；目前 `sourceConfigured/canRefresh` 仍为 `false`，保存待接入主页不代表已经订阅。已有缓存可查看和保存，不能据此声称取得线上新文。

本轮已实现独立准备工具与离线配置门禁：

```powershell
node scripts/prepare-xhs-self-hosted.cjs --prepare
```

该命令只创建 Git 忽略的 `.xhs-self-hosted/`，其中 `delivery/` 放交付包，`review/` 放审查记录，`test-data/` 和 `logs/` 放隔离验收资料；首次从公开空模板创建 `.env.local`。重复执行保留已有配置，不读取密钥，不启动任何服务。

`XHS_SELF_HOSTED_BASE_URL`、`XHS_SELF_HOSTED_API_KEY` 是 **WeWe 自己的候选变量名称**，不是已确认的供应商 Compose 字段。明天仅在本机私有 `.xhs-self-hosted/.env.local` 填测试 Key；经实际合同审查后填写明确的本地 HTTP(S) 地址。Key 不发到聊天，不放进 URL。未提供默认端口、镜像或私有接口路径。官方[测试产品入口](https://rnote.dev/admin/products)用于正常核对产品，不在准备脚本中调用。

后端构建后，可用以下命令仅校验私有配置格式：

```powershell
pnpm --dir apps/server exec nest build
node scripts/prepare-xhs-self-hosted.cjs --check-config
```

输出只含是否配置和固定错误码，不输出地址或 Key。缺少构建返回 `SERVER_BUILD_REQUIRED`，私有文件不可读返回 `XHS_PREPARATION_CONFIG_READ_FAILED`。本轮只用合成配置回归，没有读取实际私有配置。即使格式有效，`sourceReviewed/verifiedBodySource/canRefresh` 始终为 `false`；它尚未接线到实际 Provider，填 Key 不会自行恢复订阅。

## 测试就绪边界

**目前不能只填 Key 就启用小红书生产刷新。** 纯配置检查器仅处理 WeWe 本机候选配置，其 loopback 门禁不会因公开客户端而放宽。另已实现下面的公开契约 HTTP 候选客户端和单请求脚本；两者用途不同。

运行时 `XiaohongshuService.capability()` 的 `canRefresh` 取决于是否注入 `XHS_SOURCE`；当前 `TrpcModule` 未注册该来源，单篇 `XHS_SINGLE_SOURCE` 也未注册。候选解析器自身固定返回 `canRefresh:false`，并未被应用加载来创建 Provider。这不是待用户勾选的开关，也不能改布尔值就变成可执行适配器。

仍需确认实际 Web＋蒲公英实例或同产品试用服务的地址、路由与鉴权是否采用公开契约。源码自部署分支还需要实际交付包、Dockerfile/Compose、版本/构建审查和正常账号条件；现有项目没有实际 Rnote Compose，不提供猜测的容器启动命令。普通笔记接口不能全局要求蒲公英登录 Cookie；只有实际 PGY 自部署接口确有该依赖时才单独处理。

明天先正常核对同产品试用说明及 Key 的用途。确认其路由合同后，可用下面的单请求脚本少量核真实响应，再补准确归一化字段；不会临时重写 HTTP 层。试用、源码部署以及 WeWe 正式接入分别记录，不能把官网试用可用当成已接回原刷新。

## 已实现的公开契约请求与候选校验

依据[官方指南](https://rnote.dev/docs/guide)和[实时 OpenAPI](https://rnote.dev/openapi.json)，已实现 `RnotePublicClient` 与 `RnotePublicCandidate`。这是明确标为 `rnote-public-v2` 的候选客户端，**不是把公开托管服务认作 Web 源码试用**：官方指南明确本页接口属于托管服务，源码页描述另一套容器交付，未公开承诺路径等价。

| 方法 | 路径                                        | 已处理的契约                                          |
| ---- | ------------------------------------------- | ----------------------------------------------------- |
| GET  | `/api/v2/crawler/user/posted`               | `user_id`、opaque `cursor`、`num` 1–20；默认仅请求3条 |
| GET  | `/api/v2/crawler/note/image`、`/note/video` | 明确的 `note_id`，只执行所选一种，不自动切类型        |
| POST | `/api/v2/pgy/blogger/notes`、`/notes_v2`    | 独立 JSON body、页码和每页1–8；不自动换端点           |
| POST | `/api/v2/pgy/note/detail`                   | 明确的 `note_id`，候选详情严格比较返回 `noteId`       |

地址必须显式提供，没有默认托管地址。只允许明确的官方 HTTPS 主机或 literal loopback 根地址，Key 只放 `X-API-Key` Header。请求限定时、响应大小，拒绝302等重定向，不把 Key 转发到另一地址。HTTP401/402/403/429分别报告认证/余额/权限/限流固定码；同时核 `success` 与 HTTP，保留数值 `retry_after`，不自动重试。错误文案、URL、Key、诊断字段和正文不输出。

已根据 OpenAPI **description** 校验 `data.data.notes/has_more`、图文视频详情数组，以及 PGY `list` 与 `noteList[].noteInfo` 的不同结构；未知业务字段在内存中原样保留。不能因响应 schema 为 `{}` 忽略这些可实现字段。仍待核的是 crawler 真实作者/笔记身份与类型字段、cursor 的准确字段路径、详情时间单位、全部媒体地址/顺序及原字节；PGY 已知 `noteId/userId/title/content/createTime`，但时间单位、图片子项和视频结构仍未完整定义。不会猜发布时间秒/毫秒、把URL数量当完整字节或设置 `evidenceVerified:true`。

无参数执行不读私有配置、不发请求：

```powershell
node scripts/acceptance-rnote-public.cjs
```

明天确认选定试用的公开契约兼容性后，在已有 `.xhs-self-hosted/.env.local` 填明确根地址与 Key、构建后端，再显式执行一次：

```powershell
node scripts/acceptance-rnote-public.cjs --execute --operation posted --id <已确认24位作者ID>
```

`image/video/pgy-notes/pgy-notes-v2/pgy-detail` 也是明确操作选项；没有自动遍历、切源或后续详情请求。脚本最多一次请求，只输出候选数量/字段名及未核状态，不写库、保存媒体或注册生产来源。成功或失败均保留 `productCompatibilityVerified/evidenceVerified/canRefresh:false`。如果试用是不同路由，不把它悄悄替换为托管 App 接口；先据其实际契约调整。

此阶段不创建或填写持久密钥，不执行供应商代码、不启动实例或注册真实来源。收到实际包和文档后，先按包内合同核对配置及受支持启动方式，再由 owner 安排必要授权、薄适配及离线请求/字段回归；没有完整响应证据时保持未接入。复用已有[内部后端合同](BACKEND_CONTRACT.md)和[本机归档接缝](../XIAOHONGSHU_INTEGRATION.md)，不重写已经完成的保存器。

## 收包后的最小真实验收

实际交付包和接口文档可用后，核准确版本、适用许可和正常账号条件，再复用现有接缝完成薄适配。真实访问及启动另按授权执行，遇认证或平台限制停止，不自动换账号、参数或数据源。

首轮只核一个确认博主前三篇：作者及笔记身份、真实发表时间、完整正文、全部图片的数量/顺序/实际字节和本机离线打开；再经原刷新入口验证重复新增为0、旧完整内容不被空值或摘要覆盖。视频的真实来源、完整字节、解码与播放单独验收，现有内部容器检查不等于真实视频可播放。生产迁移和软件切换仍须先做一致性备份及副本演练，不因选择 B 自动部署。
