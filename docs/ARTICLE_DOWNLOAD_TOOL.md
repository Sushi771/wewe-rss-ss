# 工具 → 文章下载

## 当前来源约束（2026-10-10）

公众号单篇下载**仅使用 Wechat2RSS**，不采用优先加兜底模式。正常工具入口只读当前已订阅公众号的缓存，按输入原文的稳定文章 ID 精确匹配一篇。不会抓取微信原文页面、调用停服旧中转或其他正文服务，不复用 SQLite 中来源不明的旧正文，不自动添加整个公众号，也不调用强制更新。浏览器回送的其他渠道正文不能绕过这一约束；对应任务创建和保存返回 WECHAT2RSS_ONLY，旧任务仍可查询和取消。

已核 [Wechat2RSS 官方 API](https://wechat2rss.xlab.app/deploy/api)：/feed/:id.json 提供已有订阅的 JSON Feed，/api/query 查询已有文章；/addurl 等同添加公众号并触发更新，没有任意 URL 单篇取文承诺。本轮复用项目已有私有客户端的 GET /list 和目标 Feed 路径，不伪造端点。Feed 是当前缓存窗口，缓存缺失不能推断文章不存在。若未来要用新增公众号取得任意链接，必须另行由用户选择，因为这会新增整个号的订阅、提交更新任务，并可能受到账号限流或风控。

## 使用

在运行服务的 Windows 电脑上进入「工具 → 文章下载」，粘贴含 \_\_biz、mid、idx 和有效签名的完整 HTTPS 微信原文长链接，选择本机目录，再点击「下载正文和图片」。短链接没有供应商可核验身份映射时明确停止，不直连原页解析，不扫描所有公众号或根据标题猜身份。Wechat2RSS 必须已启用且私有配置有效；凭据仅在后台配置中读取，不返回浏览器或日志。

成功后建立北京时间下载日期目录 YYYY-MM-DD/文章标题-稳定短ID/正文.md 和 image/，Markdown 使用相对图片引用，可以用 Obsidian 打开。目录选择、路径记忆、每次询问的一次性许可、同源/访问密码检查和原排他保存继续保留。新的归档标记记录 source:wechat2rss；旧同篇笔记来源不明时保留原文件，新结果另存不冲突的目录。同来源重复下载仍保留已有笔记及用户编辑，不覆盖。

正文来源与媒体请求分别判断：正文只取 Wechat2RSS；该正文中必要的微信 CDN 图片使用原共享图片归档器下载、校验真实字节并落盘，这不是原文页面抓取。没有可核验媒体地址或任一图片失败时不发布正文或图片，不把省略资源的结果当完整成功。公众号视频/音频及明确嵌入播放器目前没有可靠归档合同，返回 ARTICLE_MEDIA_UNAVAILABLE。普通 iframe 沿用原安全清理策略。小红书独立路径已有视频字节、容器校验和 video/ 保存不受影响。

| 状态码                               | 含义                                 |
| ------------------------------------ | ------------------------------------ |
| WECHAT2RSS_SINGLE_UNCONFIGURED       | 来源未启用或私有配置不可用           |
| WECHAT2RSS_SINGLE_LONG_URL_REQUIRED  | 短链接没有可核验缓存身份映射         |
| WECHAT2RSS_SINGLE_NOT_SUBSCRIBED     | 供应商未订阅该公众号；不自动新增     |
| WECHAT2RSS_SINGLE_CACHE_MISS         | 文章不在当前缓存；不触发更新或换渠道 |
| WECHAT2RSS_SINGLE_BODY_MISSING       | 有记录但缓存正文缺失                 |
| WECHAT2RSS_SINGLE_CACHE_READ_FAILED  | 缓存读取、冲突或字段核验失败         |
| WECHAT2RSS_SINGLE_IDENTITY_MISMATCH  | 原文身份/签名不一致                  |
| WECHAT2RSS_SINGLE_IMAGES_UNAVAILABLE | 图片链接或字节不完整                 |
| ARTICLE_MEDIA_UNAVAILABLE            | 音视频资源尚不能可靠取得并归档       |

这些失败不会写文章库或改变订阅；保留旧文档，不自动重试。后台新专用链路为 article-download.controller.ts → wechat2rss-single-download.ts → Wechat2RssProvider.fetchSingleCachedArticle → wechat2rss-single-cache.ts；选中的原始缓存正文先检查媒体，再复用现有解析器、图片归档器、Markdown 导出器和 LocalArticleStore。

## 指标证据范围

截至本轮只读核对，官方 /api/query 示例只列 biz_id、biz_name、title、desc、created、content，未给出阅读量、点赞、在看、收藏计数及语义合同。现有 JSON Feed 解析器也不映射这些指标。此次没有真实缓存采集，不能据此证明真实字段非 null，不能把缺失值写成 0，也不能把旧渠道的已存指标归因于 Wechat2RSS。未来出现额外字段仍需核对官方或真实语义证据后接入。

## 本轮验证与发布边界

本轮 11 套 173 项 Jest 回归、29 项实际页面处理器/验证显示回归、前后端 `tsc --noEmit`、定点 ESLint、格式与 `git diff --check` 通过。仅使用合成缓存、临时文件和离线本机 HTTP；覆盖唯一来源、缓存精确匹配、未订阅/缺缓存不新增不直连、短链接不猜测、媒体不全停止、旧来源笔记隔离及用户编辑保护。原合成浏览器验收脚本已将来源模拟边界改为 Wechat2RSS，公开原页模拟直接拒绝；本轮仅做语法检查，未执行生产构建或实际浏览器视觉验收。不读取或输出私有凭据，不发真实微信/小红书请求，不改生产库，不提交、推送、重启或部署。本轮真实缓存正文和媒体是否可取得仍待用户实测，不能用离线通过代替。

## 历史开发与交接（以下公开原文及浏览器回送描述已被上述仅 Wechat2RSS 约束取代）

2026-10-05 补充：[本次官方验证地址](SINGLE_ARTICLE_OFFICIAL_VERIFICATION.md)。原文验证重定向中，只有实际返回且通过检查的地址才提供用户点击入口；历史记录缺失地址时不补造、不重放。此入口不代表浏览器会话已接回后台取文。

现有正文整理、图片处理和保存继续复用本项目已验证的实现。已核GitHub候选[wechat-article-exporter](https://github.com/wechat-article/wechat-article-exporter)：其普通单篇请求没有正常登录会话或验证后的取文衔接，不能据此解决当前验证跳转；其Markdown分支也不等于完整的本地图片保存。未导入它的解析、图片或保存代码，不新增导出模块。后续GitHub研究仅围绕实际缺口：正常授权及验证后可重复使用的取文通路。

- 页面：`apps/web/src/pages/tools/article-download.tsx`；路由 `/dash/tools` 和 `/dash/tools/article-download`。
- 接口：`POST /download/article`，JSON`{ "url": "..." }`；成功返回保存路径JSON，错误返回中文`message`和脱敏诊断。开启每次询问时另需本次原生选择产生的一次性`pickToken`，不能通过浏览器JSON指定任意写入路径。设置读写及目录选择为`/download/article/settings`和`/download/article/directory`，沿用访问密码，限制回环Host/连接与同源操作，远程/私人线上模式拒绝本地保存。
- `article-export.ts` 是从 `TrpcRouter.getArticleMarkdown` / `downloadImage` 抽出的既有正文与图片导出代码。原 Markdown、Obsidian 和公众号 ZIP 仍调用相同方法；默认图片下载逻辑不变。
- `offline-archive.ts` 抽出原 `OfflineExportController` 的 ZIP 打包代码，公众号 ZIP 与工具共用。
- `article-download.ts` 只连接单篇 URL 与上述导出方法，复用 `articleIdentity`、`articleContentHtml`、`publicArticleRequestUrl`、`allowedImageUrl`、`decodeInlineImage`。离线 HTML 使用导出方法已本地化的同一正文。
- `article-download-cache.ts`只读查询精确身份，复用`bodyRetryTarget`、`decodeInlineImage`及原Markdown导出器；不写文章数据库，不调用平台或续期。缓存分支拒绝外部图片，并沿用原单篇HTML清理和本地发布流程。
- 工具偏好独立保存在SQLite文件旁的已忽略`.article-download-settings.json`，不改订阅或既有Obsidian配置。文件先在所选日期目录的临时子目录完整准备，最终目录以排他创建保留，文件写入不覆盖。失败只回滚本次创建的文件，既有笔记不删除；完整标记写入后才返回成功。

`article-export.ts`新增受限的图片目录选项，旧调用仍默认`attachments`，工具选`image`；不复制转换或媒体保存实现。路径必须是普通本机绝对目录，拒绝磁盘根目录、UNC和链接目录；已存在同名无标记笔记目录用新名字，已有完整同篇笔记直接返回已保存，不覆盖正文。

安全边界：只接受 HTTPS 微信文章 URL；只保留文章身份和内容签名参数；不传递微信 Cookie、账号令牌或用户输入的会话参数。文章与图片均禁止自动重定向、代理和重试，网络连接时校验并固定 DNS 地址，拒绝内网及保留地址。远程正文上限 5 MB，图片最多 60 张、单张 10 MB、总计 20 MB，复用已有图片容器校验。清除执行型 HTML、正文外链与动态属性，离线 HTML 使用限制性 CSP。现有 `WEWE_ACCEPTANCE_MODE=1` 会阻止工具保存。

一次只允许一个工具下载请求；并行请求返回 409。工具不调用订阅 Provider、微信读书账号或 Obsidian 配置目录；文章库查询为只读。用户已提供的单篇短链接曾返回匿名HTTP302验证跳转，保留停止且未重试；最新订阅目录及10篇正文也未提供该短链的可信身份映射。该URL的真实直接保存Obsidian仍待正常页面的可靠依据，不能造reviewId、转用读书Cookie或用ZIP/人工HTML替代。[订阅10篇正文图片验收](LATEST_TEN_IMAGE_ACCEPTANCE.md)是独立结果，不证明该受阻短链接已恢复。

## 构建与离线回归

沿用项目锁文件、已有依赖和构建命令，无新增项目依赖。本轮执行环境为 Node.js 24.11.1。

```sh
pnpm install --frozen-lockfile
pnpm --filter server build
pnpm --filter web build
pnpm --filter server exec jest --runInBand article-download.spec.ts article-download.controller.spec.ts collection/article-page.spec.ts collection/image-fetch.spec.ts collection/archive-provider-images.spec.ts
```

测试只使用合成正文和 1×1 PNG，在系统临时目录运行；覆盖正文/图片文件、长短链接、身份校验、非法 URL、验证失败、危险 HTML、坏图片、内网 DNS、访问控制、并行请求、临时文件清理，以及原订阅导出行为。Jest 29 无法加载 archiver 8 的原生 ESM，因此 HTTP 单测仅替代 ZIP 打包边界；下面浏览器验收执行真实打包和解压。

本地浏览器回归使用现有 Playwright 安装，或在独立临时目录安装固定版本 `playwright-core@1.58.2`，不修改项目依赖。设置 `PLAYWRIGHT_MODULE_PATH` 为该模块目录；如没有 Playwright 浏览器，可用 `BROWSER_EXECUTABLE` 指定本机 Edge 可执行文件。

```sh
node scripts/acceptance-article-download.cjs
```

该脚本启动仅含工具控制器的临时本地服务和无账号浏览器，正文/图片资源由内存合成fixture提供，阻止真实上游与浏览器外网请求，不启动生产应用、不加载生产配置或数据库。验证实际Markdown与相对图片保存、离线打开、路径记忆/每次询问、目录取消不取文、重复点击、已有编辑笔记保护及失败不留下完整目录；Windows原生目录对话框在自动回归中模拟。截图和报告写入已忽略的`output/playwright/article-local-save/`，不提交原始证据或生成文件。可设置`LOCAL_RELEASE_ROOT`为已核不可变包路径，验证该包的实际服务和前端资源。

## 本轮结果（2026-10-04）

- 当前应用`b3161eb`已部署；原页面将一篇真实缓存正文及13个附件直接保存到默认Obsidian目录，实际图片字节一致且真实Edge全部打开，第二次点击不覆盖笔记。相关78项测试、类型检查、独立包及准确应用CI四项成功；数据库与私有文件不变、没有平台请求。用户受阻短链仍未命中且未重试。详见[缓存实际验收](VERIFIED_CACHE_SAVE_ACCEPTANCE.md)；以下旧构建与匿名取文记录仅为历史。

- 正常Web登录与本工具已组合部署，包`2026-10-04T15-37-00-899Z-7d879ab21c42`全部173项源码输入精确匹配`e2c0556`。组合本地回归39 suites/557 tests通过，包内真实资源的离线保存及图片打开验收通过，实际默认路径及目录按钮可见。后续文档格式提交`2c88f51`未进入该包；它的准确CI四项通过，不能算作e2的CI结果。最新账号识别修补与运行产物的来源另见[集成记录](MANUAL_REFRESH_DOWNLOAD_INTEGRATION.md)。原生目录对话框尚未人工点击验收，真实被阻挡链接未重试。

- 后续直接保存改动：38 suites/531 tests及前后端类型检查/构建通过，覆盖中文/空格路径、北京时间换日、同日同名文章隔离、重复笔记保护、权限错误、失败清理、目录选择取消、路径记忆及每次询问的一次性授权。浏览器合成直接Markdown/图片保存通过，真实本地图片在断网浏览器可打开，取消不取文，重复保存保留编辑过的笔记；零平台请求和零生产库使用。原生目录对话框在自动回归中替代为选择/取消结果，不冒充人工验证成功。
- 浏览器验证状态没有共享给后台；受挑战的用户链接仍不重试，不因本地保存流程通过而宣称真实原文已下载。以下ZIP为此前阶段记录，当前工具输出以上述直接保存方式为准。

- 用户指定链接在2026-10-04 14:19 UTC的一次受控复测返回HTTP302，跳转类别为微信验证页；仅请求原文一次，未跟随跳转、未取图片、未生成ZIP。旧提示合并了非200、非HTML和大小异常，无法从用户先前的提示恢复当时的具体状态；本次证据只证明该链接在当前环境和时点的验证要求。
- 本次修补区分验证/登录/其他跳转、限流、其他HTTP错误、非HTML、网络超时/DNS及文件生成失败；图片阶段保留相同的错误来源。日志只记录错误代码、阶段、HTTP状态和跳转类别，不保存原文URL、Location、响应正文、Cookie或原始异常文本。继续禁用自动跳转和重试，复用原正文图片导出器。服务端全量回归37 suites/519 tests通过。
- 真实下载仍未验收通过。验证要求是当前外部阻碍，错误提示修补不能替代合法的公开正文响应，也不能声称订阅更新恢复。下述真实请求0为原合成验收阶段记录，本次受控复测为1次。

- 服务端全量回归：36 个测试套件、466 项测试全部通过，其中相关导出／图片／工具测试 58 项通过。
- 前后端构建通过；改动文件格式检查、服务端和前端 ESLint 检查通过。
- 浏览器合成验收通过：真正生成并下载 ZIP，解压后断网打开正文和本地 PNG；非法 URL 不调用接口取文，连续点击只发起一个工具下载，验证／图片失败不提供保存按钮，移动端可进入工具页。
- 真实微信平台请求 0，数据库使用 0，生产启动／部署 0。测试结果不代表真实公开文章访问已成功；真实链接验收仍待用户提供具体链接。
- 独立分支 `codex/article-download-tool` 从 `155503b` 创建。订阅刷新模块由主线线程管理，本分支不改 Provider、账号会话或共享任务交接文档，产品和开发说明集中在本页，供父会话统一集成。
