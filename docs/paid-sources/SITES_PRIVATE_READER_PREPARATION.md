# 私人跨设备阅读界面：本地准备，真实接入关闭

## 复用旧约定，不迁移本机职责

本轮复用 PR2 `edb0ecb799852a37bd26b7879a7962b10fbd98f3` 的 `scripts/sites-local-contract.mjs`、其测试及 [原合同](SITES_LOCAL_CONTRACT.md)，三个文件逐字保留。合同模块 blob 为 `66896a53ee61efd858efa5aa1abd37e19820c19e`，合同文档 blob 为 `36cb5578aa5c2983460ce4aedc36ea69ffc97f53`；生产源码 `8a3141c43b1b09e92ebd75780f26c58939557906` 中也是相同版本。

新开发分支基于 main `33ec7c3ebc20ce55d5f81259a5dd515912b5ca65`，只补入这三个原样合同文件和独立 `sites/private-reader/`，不合入生产分支的其他历史。本机继续负责采集、SQLite、图片缓存与归档；本轮没有服务器采购、云端内容副本、D1/R2、定时任务或持久连接。既有本地 UI 布局和性能工作文件不改。

## 本轮可验证范围

独立页面支持公众号/小红书的有界订阅列表、作者文章列表、缓存正文和当前浏览器设备的单篇离线 HTML 下载。只用旧合同已有字段，不新增任意 URL/路径、tRPC 选择器或管理命令。公众号使用原游标；小红书沿用没有游标的合同，结果截断时如实提示，不能称全量。

浏览器只请求同源 `/api/subscriptions`，不接收本机地址、认证秘密或服务 bearer。Worker 包装层复用 `createSitesWorker`，并在转发前只允许 capability/authors/items/body/download，拒绝 refresh 和 operation status；页面没有手动刷新按钮。旧合同的进程内刷新实现未挂载、未改写、未启用。

页面分别显示身份未配置、未登录、非本人、本机不可用、读取超时、缓存缺失、当前范围为空等状态。失败不冒充空列表，不自动重试。选择切换会取消旧读请求，迟到结果不能覆盖当前页；权限或连接失败会移除旧正文、图片和列表。正文以文本节点展示，图片仅接受旧合同已验证的 data URI；不挂载缓存 HTML。下载必须由当前用户点击，生成真实 Blob 并保存在当前设备，不写 Windows Vault。

## 默认拒绝与真实接入阻塞

默认 Worker 没有任何 authorize 或 transport 适配器；即使请求携带 Sites 身份 header、服务 bearer、isOwner 字段或环境标记，也保持拒绝。测试中的 owner 对象只存在于 `test/fixtures.mjs`，构建检查禁止将测试目录打包。生产入口不会读取这些测试桩，也没有环境变量开关可将其开启。

未来真实路线仍是：私人 Sites 同源服务端核验 visitor 身份及本人授权 → 经认证的 HTTPS 连接 → 独立认证的本机窄网关 → 原受保护 caller。Sites dispatch 的 visitor 身份不等于 owner 权限，服务访问 bearer 不等于 visitor 身份。不能单凭转发 header、loopback 来源或 JSON 布尔值放行，不能伪造 appRouter 的 isLocal/errorMsg。

目前必须继续保持关闭的事项：

1. 尚未创建目标私人 Site，私有 audience、可信 dispatch 来源与站点内本人身份映射未绑定。
2. 没有已批准并核实的 HTTPS 本机连接、连接身份传递及失效约定；本轮不创建隧道、凭据、监听器，不改端口/防火墙/权限。
3. 没有挂载本机网关或创建真实受保护 caller。生产 a5 的微信缓存 projector 可在未来复用既有 verifiedDownloadBody 与 Cheerio；main 当前没有该已验证下载模块，不能把较弱的 HTML 解析冒充同等校验。
4. 真实跨设备和本人/非本人验收尚未完成，不能把合成链路、DOM 测试或生成 Blob 宣称为手机已取得真实文章。

| 兼容性检查                                              | 生产源码 8a3141c                     | main 33ec7c3                               |
| ------------------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| 原合同与测试                                            | 原样存在                             | 本补丁只按 PR2 原样补入                    |
| 微信 feed.list / article.list / article.byId 字段与游标 | 源码形状兼容                         | 源码形状兼容，仍需未来真实 caller 隔离集成 |
| 微信 verifiedDownloadBody 缓存校验适配                  | 既有模块可供未来显式绑定             | 缺少等价已验证适配，继续拒绝               |
| 小红书 list / notes / body 路由                         | 既有路由形状兼容，不代表来源正式验收 | 未提供，不能在 main 伪造或自动回退         |
| Sites 身份、本机连接与路由挂载                          | 未绑定                               | 未绑定                                     |

## 构建与验证

```text
node --test scripts/sites-local-contract.test.mjs sites/private-reader/test/*.test.mjs
node sites/private-reader/build.mjs
```

仅复用仓库已有 esbuild，不新增依赖。本地构建得到单文件 Worker ESM `sites/private-reader/dist/server/index.js`，内嵌同源浏览器脚本；不包含测试适配器、Node/Nest/Prisma 代码或真实文章。没有 Site identity，因此不生成假的 `.openai/hosting.json`，产物不是已注册或可直接宣布部署的 Site。

真正创建 Site 后，由父线程按 Sites 原生 Worker ESM 工作流绑定身份和 hosting manifest；不能直接把这份默认关闭构建当作生产连接配置。此轮不调用 Sites 创建/发布/secret 工具，也不连接第三方服务。

测试执行实际旧合同客户端、Worker Request/Response、本机合同与合成 caller，覆盖两层独立权限、字段脱敏、PNG 字节、断网 HTML、只读命令门禁、离线/超时/不重试、分页、迟到请求、失去权限后的清空和显式下载。DOM 测试调用实际页面渲染函数，禁止 innerHTML；没有启动预览服务、浏览器、真实 Sites 或跨设备验收，没有复制或打开生产数据库。旧合同自身的合成刷新测试保留，用于证明复用未改变合同，并不表示新增页面开放刷新。
