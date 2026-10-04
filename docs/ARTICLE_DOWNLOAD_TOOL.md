# 工具 → 文章下载

## 使用

在运行服务的Windows电脑上用Edge或Chrome打开「工具」，粘贴单篇公众号文章长短链接，点击「下载正文和图片」。成功后正文和图片直接保存在本机，不需要ZIP或解压。默认路径为`C:\Users\ss\Documents\Obsidian Vault\公众号的文章（待分类）`。

按下载当天北京时间创建`YYYY-MM-DD/文章标题-稳定短ID/正文.md`和同目录`image/`。Markdown使用相对图片链接，可直接用Obsidian打开；移动时保留整个文章目录。同日多篇隔离保存，重复保存保留已有笔记，不覆盖用户修改。

点击“选择下载路径”会由本机服务弹出Windows原生文件夹选择框，选择后记住路径；“每次下载询问路径”默认不勾选，勾选后每次保存前必须重新选择，取消不会发起取文。关闭询问仍保留上次路径。普通网页不能任意写本机文件；此能力仅在本机Windows桌面服务上可用，线上站点/远程访问不能写服务器文件。

工具独立于订阅，不添加公众号，不改变文章库、订阅更新状态或账号配置。只处理一篇公开图文；不支持批量、音视频、登录或验证码操作。遇到不可访问、验证页、身份不一致或任一图片失败时，不提供成功下载文件，可查看页面错误提示。

## 开发与交接

现有正文整理、图片处理和保存继续复用本项目已验证的实现。已核GitHub候选[wechat-article-exporter](https://github.com/wechat-article/wechat-article-exporter)：其普通单篇请求没有正常登录会话或验证后的取文衔接，不能据此解决当前验证跳转；其Markdown分支也不等于完整的本地图片保存。未导入它的解析、图片或保存代码，不新增导出模块。后续GitHub研究仅围绕实际缺口：正常授权及验证后可重复使用的取文通路。

- 页面：`apps/web/src/pages/tools/article-download.tsx`；路由 `/dash/tools` 和 `/dash/tools/article-download`。
- 接口：`POST /download/article`，JSON`{ "url": "..." }`；成功返回保存路径JSON，错误返回中文`message`和脱敏诊断。开启每次询问时另需本次原生选择产生的一次性`pickToken`，不能通过浏览器JSON指定任意写入路径。设置读写及目录选择为`/download/article/settings`和`/download/article/directory`，沿用访问密码，限制回环Host/连接与同源操作，远程/私人线上模式拒绝本地保存。
- `article-export.ts` 是从 `TrpcRouter.getArticleMarkdown` / `downloadImage` 抽出的既有正文与图片导出代码。原 Markdown、Obsidian 和公众号 ZIP 仍调用相同方法；默认图片下载逻辑不变。
- `offline-archive.ts` 抽出原 `OfflineExportController` 的 ZIP 打包代码，公众号 ZIP 与工具共用。
- `article-download.ts` 只连接单篇 URL 与上述导出方法，复用 `articleIdentity`、`articleContentHtml`、`publicArticleRequestUrl`、`allowedImageUrl`、`decodeInlineImage`。离线 HTML 使用导出方法已本地化的同一正文。
- 无文章数据库读写。工具偏好独立保存在SQLite文件旁的已忽略`.article-download-settings.json`，不改订阅或既有Obsidian配置。文件先在所选日期目录的临时子目录完整准备，最终目录以排他创建保留，文件写入不覆盖。失败只回滚本次创建的文件，既有笔记不删除；完整标记写入后才返回成功。

`article-export.ts`新增受限的图片目录选项，旧调用仍默认`attachments`，工具选`image`；不复制转换或媒体保存实现。路径必须是普通本机绝对目录，拒绝磁盘根目录、UNC和链接目录；已存在同名无标记笔记目录用新名字，已有完整同篇笔记直接返回已保存，不覆盖正文。

安全边界：只接受 HTTPS 微信文章 URL；只保留文章身份和内容签名参数；不传递微信 Cookie、账号令牌或用户输入的会话参数。文章与图片均禁止自动重定向、代理和重试，网络连接时校验并固定 DNS 地址，拒绝内网及保留地址。正文上限 5 MB，图片最多 60 张、单张 10 MB、总计 20 MB，复用已有图片容器校验。清除执行型 HTML、正文外链与动态属性，离线 HTML 使用限制性 CSP。现有 `WEWE_ACCEPTANCE_MODE=1` 会阻止工具网络下载。

一次只允许一个工具下载请求；并行请求返回 409。工具不调用订阅 Provider、微信读书账号、生产 SQLite 或 Obsidian 配置目录。暂无真实文章下载验收；须由用户提供具体文章链接后另行验证，不把合成测试通过称为真实平台能力恢复。

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
